from __future__ import annotations

import json
import os
import sys
import threading
import time
from collections import defaultdict
from pathlib import Path
from typing import Any, Optional

import cv2
import numpy as np
import yaml
from openvino import Core
try:
    import onnxruntime as ort
except Exception:
    ort = None

from backend.config.settings import get_data_root, settings
from backend.core.calibration_manager import get_shared_calibration_manager
from backend.core.model_crypto import decrypt_bytes, is_packaged_runtime, load_model_key

_PREPROCESS_INTERP_ENV = os.getenv("MACHINE_DARTS_PREPROCESS_INTERP", "nearest").strip().lower()
_PREPROCESS_INTERP = cv2.INTER_LINEAR if _PREPROCESS_INTERP_ENV != "nearest" else cv2.INTER_NEAREST

def _resolve_models_settings_path() -> Path:
    """Return the path to models.json, working both frozen and as a script."""
    if is_packaged_runtime():
        return get_data_root() / "settings" / "models.json"
    # Script: backend/core/tip_scoring.py -> parents[1] = backend/ -> data/settings/
    return Path(__file__).resolve().parents[1] / "data" / "settings" / "models.json"

_SETTINGS_PATH = _resolve_models_settings_path()
_SETTINGS_LOCK = threading.Lock()
_SERVICE_LOCK = threading.Lock()
_SERVICE: Optional["TipScoringService"] = None

# Models in this denylist are hidden from discovery/selection even if present on disk.
_DISABLED_TIP_MODEL_IDS: set[str] = {
}
_PREFERRED_DEFAULT_TIP_MODEL_ID = "1280-11n-p-13052026_encrypted"


def _tip_models_root() -> Path:
    env_root = os.getenv("MACHINE_DARTS_MODELS_DIR", "").strip()
    if env_root:
        p = Path(env_root).expanduser().resolve()
        if p.exists():
            return p

    candidates: list[Path] = []
    packaged_runtime = is_packaged_runtime()
    # Common runtime layouts for packaged binaries
    exe_dir = Path(sys.executable).resolve().parent
    bases: list[Path] = [exe_dir]
    for i in range(1, 6):
        try:
            bases.append(exe_dir.parents[i - 1])
        except Exception:
            break
    if packaged_runtime:
        for base in bases:
            candidates.append(base / "build" / "secure-models" / "models" / "tip")
            candidates.append(base / "resources" / "build" / "secure-models" / "models" / "tip")
            candidates.append(base / "_up_" / "_up_" / "build" / "secure-models" / "models" / "tip")
            candidates.append(base / "models" / "tip")
            candidates.append(base / "resources" / "models" / "tip")
            candidates.append(base / "_up_" / "_up_" / "models" / "tip")
    else:
        # Dev/source layout
        candidates.append(Path(__file__).resolve().parents[2] / "models" / "tip")
    # PyInstaller extraction dir (if data files are bundled into onefile)
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidates.append(Path(meipass) / "build" / "secure-models" / "models" / "tip")
        candidates.append(Path(meipass) / "models" / "tip")
    # Last-resort current working dir
    candidates.append(Path.cwd().resolve() / "models" / "tip")

    for p in candidates:
        try:
            if p.exists():
                return p
        except Exception:
            continue
    # Return preferred dev path when none exist so callers still get a stable path string.
    return Path(__file__).resolve().parents[2] / "models" / "tip"


def _default_tip_model_id() -> str:
    models = list_available_tip_models()
    if not models:
        return ""
    preferred_ids = {m["id"] for m in models}
    if _PREFERRED_DEFAULT_TIP_MODEL_ID in preferred_ids:
        return _PREFERRED_DEFAULT_TIP_MODEL_ID
    non_int8 = [m for m in models if "int8" not in m["id"].lower()]
    if non_int8:
        return non_int8[0]["id"]
    return models[0]["id"]


def _default_model_settings() -> dict[str, Any]:
    return {
        "version": 1,
        "openvino": {
            "device": "AUTO",
            "performance_hint": "LATENCY",
        },
        "features": {
            "enable_model_stats": True,
        },
        "tip": {
            "active_model_id": _default_tip_model_id(),
            "confidence_threshold": 0.3,
            "iou_threshold": 0.9,
            "duplicate_tip_px_threshold": 4.0,
        },
    }


def _read_settings() -> dict[str, Any]:
    payload = _default_model_settings()
    try:
        candidates = [_SETTINGS_PATH]
        if is_packaged_runtime():
            # Backward-compatible fallback: older builds wrote under install dir.
            candidates.append(Path(sys.executable).resolve().parent / "backend" / "data" / "settings" / "models.json")
        for path in candidates:
            if not path.exists():
                continue
            disk = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(disk, dict):
                if isinstance(disk.get("openvino"), dict):
                    payload["openvino"].update(disk["openvino"])
                if isinstance(disk.get("features"), dict):
                    payload["features"].update(disk["features"])
                if isinstance(disk.get("tip"), dict):
                    payload["tip"].update(disk["tip"])
                if "version" in disk:
                    payload["version"] = disk["version"]
            break
    except Exception:
        pass
    payload["openvino"]["performance_hint"] = "LATENCY"
    return payload


def _write_settings(payload: dict[str, Any]) -> None:
    _SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    _SETTINGS_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def list_available_tip_models() -> list[dict[str, Any]]:
    root = _tip_models_root()
    if not root.exists():
        return []
    out: list[dict[str, Any]] = []
    for folder in sorted([p for p in root.iterdir() if p.is_dir()], key=lambda p: p.name):
        if folder.name in _DISABLED_TIP_MODEL_IDS:
            continue
        xml_files = sorted(folder.glob("*.xml"))
        encrypted_xml_files = sorted(folder.glob("*.xml.enc"))
        onnx_files = sorted(folder.glob("*.onnx"))
        if not xml_files and not encrypted_xml_files and not onnx_files:
            continue
        is_onnx = not xml_files and not encrypted_xml_files and bool(onnx_files)
        is_encrypted = not xml_files and bool(encrypted_xml_files)
        metadata_file = folder / "metadata.yaml"
        imgsz = None
        if metadata_file.exists():
            try:
                meta = yaml.safe_load(metadata_file.read_text(encoding="utf-8")) or {}
                if isinstance(meta.get("imgsz"), list):
                    imgsz = [int(v) for v in meta["imgsz"][:2]]
            except Exception:
                pass
        out.append(
            {
                "id": folder.name,
                "path": str(folder),
                "xml": str(xml_files[0] if xml_files else encrypted_xml_files[0]) if not is_onnx else None,
                "onnx": str(onnx_files[0]) if is_onnx else None,
                "encrypted": is_encrypted,
                "runtime": "onnx" if is_onnx else "openvino",
                "imgsz": imgsz,
            }
        )
    return out


def list_available_openvino_devices() -> list[str]:
    return [str(item.get("id") or "").strip() for item in list_available_openvino_device_details() if str(item.get("id") or "").strip()]


def list_available_openvino_device_details() -> list[dict[str, Any]]:
    try:
        core = Core()
        devices = [str(device).strip() for device in core.available_devices if str(device).strip()]
    except Exception:
        core = None
        devices = []

    ordered_ids: list[str] = []
    seen: set[str] = set()

    def add_device(device_id: str) -> None:
        normalized = str(device_id or "").strip().upper()
        if not normalized or normalized in seen:
            return
        seen.add(normalized)
        ordered_ids.append(normalized)

    add_device("AUTO")
    add_device("CPU")
    for device in devices:
        add_device(device)
        if core is None or device.upper() == "CPU":
            continue
        try:
            subdevices = core.get_property(device, "AVAILABLE_DEVICES")
        except Exception:
            subdevices = []
        if isinstance(subdevices, dict):
            subdevices = list(subdevices.keys())
        if isinstance(subdevices, (list, tuple, set)):
            for subdevice in subdevices:
                raw_subdevice = str(subdevice or "").strip()
                if not raw_subdevice:
                    continue
                add_device(raw_subdevice if "." in raw_subdevice else f"{device}.{raw_subdevice}")

    details: list[dict[str, Any]] = []
    for device_id in ordered_ids:
        if device_id == "AUTO":
            details.append(
                {
                    "id": "AUTO",
                    "label": "AUTO - Let OpenVINO choose",
                    "full_name": "Automatic device selection",
                    "device_type": None,
                    "kind": "auto",
                    "is_integrated": None,
                    "is_discrete": None,
                }
            )
            continue

        full_name = device_id
        device_type: str | None = None
        try:
            if core is not None:
                full_name = str(core.get_property(device_id, "FULL_DEVICE_NAME") or device_id).strip() or device_id
        except Exception:
            full_name = device_id
        try:
            if core is not None:
                raw_type = str(core.get_property(device_id, "DEVICE_TYPE") or "").strip()
                device_type = raw_type.split(".")[-1].upper() if raw_type else None
        except Exception:
            device_type = None

        kind = "other"
        badge: str | None = None
        if device_id.startswith("GPU"):
            kind = "gpu"
            if device_type == "DISCRETE":
                badge = "dGPU"
            elif device_type == "INTEGRATED":
                badge = "iGPU"
            else:
                badge = "GPU"
        elif device_id.startswith("CPU"):
            kind = "cpu"
            badge = "CPU"
        elif device_type:
            badge = device_type.title()

        label = device_id
        if full_name and full_name != device_id:
            label = f"{label} - {full_name}"
        if badge and badge not in label:
            label = f"{label} ({badge})"

        details.append(
            {
                "id": device_id,
                "label": label,
                "full_name": full_name,
                "device_type": device_type,
                "kind": kind,
                "is_integrated": device_type == "INTEGRATED",
                "is_discrete": device_type == "DISCRETE",
            }
        )

    return details


def get_model_settings() -> dict[str, Any]:
    with _SETTINGS_LOCK:
        payload = _read_settings()
        models = list_available_tip_models()
        active_id = str(payload["tip"].get("active_model_id") or "")
        valid_ids = {m["id"] for m in models}
        if active_id not in valid_ids:
            payload["tip"]["active_model_id"] = _default_tip_model_id()
            _write_settings(payload)
        runtime = {
            "selected_device": str(payload["openvino"].get("device", "AUTO")),
            "effective_device": None,
            "selected_performance_hint": str(payload["openvino"].get("performance_hint", "LATENCY")),
            "effective_performance_hint": None,
        }
    service = get_tip_scoring_service()
    runtime.update(service.get_runtime_info())
    return {
        "settings": payload,
        "available_tip_models": models,
        "available_openvino_devices": list_available_openvino_devices(),
        "available_openvino_device_details": list_available_openvino_device_details(),
        "runtime": runtime,
    }


def is_model_stats_enabled() -> bool:
    with _SETTINGS_LOCK:
        payload = _read_settings()
    try:
        return bool(payload.get("features", {}).get("enable_model_stats", False))
    except Exception:
        return False


def update_model_settings(incoming: dict[str, Any]) -> dict[str, Any]:
    with _SETTINGS_LOCK:
        payload = _read_settings()
        openvino_in = incoming.get("openvino", {}) if isinstance(incoming, dict) else {}
        features_in = incoming.get("features", {}) if isinstance(incoming, dict) else {}
        tip_in = incoming.get("tip", incoming) if isinstance(incoming, dict) else {}
        if isinstance(openvino_in, dict) and "device" in openvino_in:
            payload["openvino"]["device"] = str(openvino_in["device"]).upper()
        if isinstance(openvino_in, dict) and "performance_hint" in openvino_in:
            payload["openvino"]["performance_hint"] = str(openvino_in["performance_hint"]).upper()
        if isinstance(features_in, dict) and "enable_model_stats" in features_in:
            payload["features"]["enable_model_stats"] = bool(features_in["enable_model_stats"])
        if isinstance(tip_in, dict):
            if "active_model_id" in tip_in:
                payload["tip"]["active_model_id"] = str(tip_in["active_model_id"])
            if "confidence_threshold" in tip_in:
                payload["tip"]["confidence_threshold"] = float(tip_in["confidence_threshold"])
            if "iou_threshold" in tip_in:
                payload["tip"]["iou_threshold"] = float(tip_in["iou_threshold"])
            if "duplicate_tip_px_threshold" in tip_in:
                payload["tip"]["duplicate_tip_px_threshold"] = float(tip_in["duplicate_tip_px_threshold"])

        payload["tip"]["confidence_threshold"] = min(0.99, max(0.01, float(payload["tip"]["confidence_threshold"])))
        payload["tip"]["iou_threshold"] = min(0.99, max(0.01, float(payload["tip"]["iou_threshold"])))
        payload["tip"]["duplicate_tip_px_threshold"] = min(
            20.0, max(1.0, float(payload["tip"].get("duplicate_tip_px_threshold", 4.0)))
        )
        if payload["openvino"]["device"] not in set(list_available_openvino_devices()):
            payload["openvino"]["device"] = "AUTO"
        if payload["openvino"].get("performance_hint") not in {"THROUGHPUT", "LATENCY"}:
            payload["openvino"]["performance_hint"] = "LATENCY"

        models = list_available_tip_models()
        valid_ids = {m["id"] for m in models}
        if payload["tip"]["active_model_id"] not in valid_ids:
            payload["tip"]["active_model_id"] = _default_tip_model_id()

        _write_settings(payload)
    service = get_tip_scoring_service()
    service.reload_from_settings()
    return get_model_settings()


class OpenVinoTipDetector:
    def __init__(
        self,
        model_dir: Path,
        conf_threshold: float = 0.4,
        iou_threshold: float = 0.5,
        device: str = "CPU",
        performance_hint: str = "LATENCY",
    ):
        self._lock = threading.Lock()
        self._core = Core()
        self._compiled = None
        self._request = None
        self._input = None
        self._output = None
        self._model_dir = model_dir
        self._conf_threshold = float(conf_threshold)
        self._iou_threshold = float(iou_threshold)
        self._device = str(device or "CPU").upper()
        self._performance_hint = str(performance_hint or "LATENCY").upper()
        self._batch_size = 1
        self._in_h = 0
        self._in_w = 0
        self._work_canvas: Optional[np.ndarray] = None
        self._work_input: Optional[np.ndarray] = None
        self._meta_end2end: bool = False
        self._meta_kpt_dim: int = 3
        self._resolved_execution_devices: list[str] = []
        self._resolved_performance_hint: str = self._performance_hint
        self._load_model()

    @staticmethod
    def _sigmoid(x: np.ndarray) -> np.ndarray:
        return 1.0 / (1.0 + np.exp(-x))

    @staticmethod
    def _nms_numpy(boxes: np.ndarray, scores: np.ndarray, iou_thr: float) -> list[int]:
        if boxes.size == 0:
            return []
        x1 = boxes[:, 0]
        y1 = boxes[:, 1]
        x2 = boxes[:, 2]
        y2 = boxes[:, 3]
        areas = np.maximum(0.0, x2 - x1) * np.maximum(0.0, y2 - y1)
        order = scores.argsort()[::-1]
        keep: list[int] = []
        while order.size > 0:
            i = int(order[0])
            keep.append(i)
            if order.size == 1:
                break
            xx1 = np.maximum(x1[i], x1[order[1:]])
            yy1 = np.maximum(y1[i], y1[order[1:]])
            xx2 = np.minimum(x2[i], x2[order[1:]])
            yy2 = np.minimum(y2[i], y2[order[1:]])
            w = np.maximum(0.0, xx2 - xx1)
            h = np.maximum(0.0, yy2 - yy1)
            inter = w * h
            union = areas[i] + areas[order[1:]] - inter + 1e-9
            iou = inter / union
            order = order[np.where(iou <= iou_thr)[0] + 1]
        return keep

    def _load_model(self) -> None:
        metadata_file = self._model_dir / "metadata.yaml"
        if metadata_file.exists():
            try:
                meta = yaml.safe_load(metadata_file.read_text(encoding="utf-8")) or {}
                self._meta_end2end = bool(meta.get("end2end", False))
                kpt_shape = meta.get("kpt_shape")
                if isinstance(kpt_shape, list) and len(kpt_shape) >= 2:
                    self._meta_kpt_dim = int(kpt_shape[1])
            except Exception:
                self._meta_end2end = False
                self._meta_kpt_dim = 3

        xml_files = sorted(self._model_dir.glob("*.xml"))
        if xml_files:
            model_xml = xml_files[0]
            model = self._core.read_model(str(model_xml))
        else:
            encrypted_xml_files = sorted(self._model_dir.glob("*.xml.enc"))
            encrypted_bin_files = sorted(self._model_dir.glob("*.bin.enc"))
            if not encrypted_xml_files or not encrypted_bin_files:
                raise FileNotFoundError(f"No OpenVINO tip model found in {self._model_dir}")
            key = load_model_key()
            xml_bytes = decrypt_bytes(encrypted_xml_files[0].read_bytes(), key)
            bin_bytes = decrypt_bytes(encrypted_bin_files[0].read_bytes(), key)
            model = self._core.read_model(xml_bytes, weights=bin_bytes)
            print(f"[model] loaded encrypted model from memory: {self._model_dir.name}")
        inp = model.input(0)
        in_shape = list(inp.shape)
        # Try to reshape to batch=3 so all camera frames can be inferred in one call.
        # End-to-end exports include postprocess/NMS in the graph and are not safe
        # to batch-reshape after export.
        if not self._meta_end2end and len(in_shape) == 4 and int(in_shape[0]) == 1:
            try:
                in_shape[0] = 3
                model.reshape({inp.get_any_name(): in_shape})
            except Exception:
                pass
        # Keep OpenVINO from consuming all CPU so dart detection stays responsive.
        compile_cfg: dict[str, str] = {"PERFORMANCE_HINT": self._performance_hint}
        num_streams = os.getenv("MACHINE_DARTS_OV_NUM_STREAMS", "1").strip()
        if num_streams:
            compile_cfg["NUM_STREAMS"] = num_streams
        cpu_threads = os.getenv("MACHINE_DARTS_OV_INFERENCE_THREADS", "").strip()
        if cpu_threads and self._device in {"CPU", "AUTO"}:
            compile_cfg["INFERENCE_NUM_THREADS"] = cpu_threads

        self._compiled = self._core.compile_model(model, self._device, compile_cfg)
        try:
            exec_devices = self._compiled.get_property("EXECUTION_DEVICES")
            if isinstance(exec_devices, (list, tuple)):
                self._resolved_execution_devices = [str(d).strip() for d in exec_devices if str(d).strip()]
            elif exec_devices:
                self._resolved_execution_devices = [str(exec_devices).strip()]
            else:
                self._resolved_execution_devices = []
        except Exception:
            self._resolved_execution_devices = []
        try:
            perf_hint = self._compiled.get_property("PERFORMANCE_HINT")
            if perf_hint:
                self._resolved_performance_hint = str(perf_hint).strip().upper()
        except Exception:
            self._resolved_performance_hint = self._performance_hint

        self._request = self._compiled.create_infer_request()
        self._input = self._compiled.input(0)
        self._output = self._compiled.output(0)
        compiled_shape = list(self._input.shape)
        self._batch_size = int(compiled_shape[0]) if len(compiled_shape) == 4 else 1
        self._in_h = int(compiled_shape[2]) if len(compiled_shape) == 4 else 0
        self._in_w = int(compiled_shape[3]) if len(compiled_shape) == 4 else 0
        self._work_canvas = np.zeros((self._batch_size, self._in_h, self._in_w, 3), dtype=np.uint8)
        self._work_input = np.zeros((self._batch_size, 3, self._in_h, self._in_w), dtype=np.float32)

    def runtime_info(self) -> dict[str, Any]:
        resolved = ", ".join(self._resolved_execution_devices).strip()
        return {
            "requested_device": self._device,
            "resolved_execution_devices": list(self._resolved_execution_devices),
            "resolved_device_label": resolved if resolved else self._device,
            "resolved_performance_hint": self._resolved_performance_hint,
        }

    def set_thresholds(self, conf_threshold: float, iou_threshold: float) -> None:
        self._conf_threshold = float(conf_threshold)
        self._iou_threshold = float(iou_threshold)

    def _preprocess_into(self, slot: int, frame: np.ndarray) -> dict[str, float]:
        h = self._in_h
        w = self._in_w
        src_h, src_w = frame.shape[:2]
        scale = min(w / float(src_w), h / float(src_h))
        new_w = int(round(src_w * scale))
        new_h = int(round(src_h * scale))
        canvas = self._work_canvas[slot]
        canvas.fill(0)
        pad_x = (w - new_w) // 2
        pad_y = (h - new_h) // 2
        # Resize directly into the preallocated canvas ROI to avoid a temporary
        # resized allocation on every frame.
        roi = canvas[pad_y : pad_y + new_h, pad_x : pad_x + new_w]
        cv2.resize(frame, (new_w, new_h), dst=roi, interpolation=_PREPROCESS_INTERP)
        # Leave canvas as uint8 BGR. We convert whole batch to float RGB NCHW in
        # one OpenCV call (blobFromImages), which is much faster than per-frame
        # Python/Numpy transpose+astype.
        meta = {"scale": scale, "pad_x": float(pad_x), "pad_y": float(pad_y), "src_w": float(src_w), "src_h": float(src_h)}
        return meta

    @staticmethod
    def _map_back_xyxy_one(box_xyxy: np.ndarray, meta: dict[str, float]) -> tuple[float, float, float, float]:
        x1 = (float(box_xyxy[0]) - meta["pad_x"]) / meta["scale"]
        y1 = (float(box_xyxy[1]) - meta["pad_y"]) / meta["scale"]
        x2 = (float(box_xyxy[2]) - meta["pad_x"]) / meta["scale"]
        y2 = (float(box_xyxy[3]) - meta["pad_y"]) / meta["scale"]
        x1 = float(np.clip(x1, 0.0, meta["src_w"] - 1.0))
        y1 = float(np.clip(y1, 0.0, meta["src_h"] - 1.0))
        x2 = float(np.clip(x2, 0.0, meta["src_w"] - 1.0))
        y2 = float(np.clip(y2, 0.0, meta["src_h"] - 1.0))
        return x1, y1, x2, y2

    @staticmethod
    def _map_back_point(x: float, y: float, meta: dict[str, float]) -> tuple[float, float]:
        rx = (x - meta["pad_x"]) / meta["scale"]
        ry = (y - meta["pad_y"]) / meta["scale"]
        return float(np.clip(rx, 0, meta["src_w"] - 1)), float(np.clip(ry, 0, meta["src_h"] - 1))

    def _decode_candidates_from_pred(
        self,
        pred: np.ndarray,
        meta: dict[str, float],
        max_candidates: int = 5,
    ) -> list[dict[str, float]]:
        if pred.ndim != 2:
            return []
        if pred.shape[0] < pred.shape[1]:
            pred = pred.transpose(1, 0)
        if pred.shape[1] < 5:
            return []

        use_end2end_layout = self._meta_end2end and pred.shape[1] >= 9

        # Keep a single float32 view through decode path to avoid repeated astype copies.
        pred_f = pred if pred.dtype == np.float32 else pred.astype(np.float32, copy=False)

        if use_end2end_layout:
            # End2end pose export layout:
            # [x1,y1,x2,y2,conf,class,kpt_x,kpt_y,kpt_conf]
            boxes = pred_f[:, 0:4]
            conf = pred_f[:, 4]
            if np.any(conf < 0.0) or np.any(conf > 1.0):
                conf = self._sigmoid(conf)

            has_kpt_xy = pred_f.shape[1] >= 8
            kpt_xy = pred_f[:, 6:8] if has_kpt_xy else None
            if pred_f.shape[1] >= 9:
                kpt_conf = pred_f[:, 8]
                if np.any(kpt_conf < 0.0) or np.any(kpt_conf > 1.0):
                    kpt_conf = self._sigmoid(kpt_conf)
            else:
                kpt_conf = np.ones_like(conf, dtype=np.float32)
        else:
            # Classic pose export layout:
            # [x,y,w,h,conf,kpt_x,kpt_y,kpt_conf]
            xywh = pred_f[:, 0:4]
            conf = pred_f[:, 4]
            if np.any(conf < 0.0) or np.any(conf > 1.0):
                conf = self._sigmoid(conf)

            has_kpt_xy = pred_f.shape[1] >= 7
            kpt_xy = pred_f[:, 5:7] if has_kpt_xy else None
            if pred_f.shape[1] >= 8:
                kpt_conf = pred_f[:, 7]
                if np.any(kpt_conf < 0.0) or np.any(kpt_conf > 1.0):
                    kpt_conf = self._sigmoid(kpt_conf)
            else:
                kpt_conf = np.ones_like(conf, dtype=np.float32)

            boxes = np.empty_like(xywh)
            boxes[:, 0] = xywh[:, 0] - xywh[:, 2] / 2.0
            boxes[:, 1] = xywh[:, 1] - xywh[:, 3] / 2.0
            boxes[:, 2] = xywh[:, 0] + xywh[:, 2] / 2.0
            boxes[:, 3] = xywh[:, 1] + xywh[:, 3] / 2.0

        scores = conf * kpt_conf
        valid = np.where(scores >= self._conf_threshold)[0]
        if valid.size == 0:
            valid = np.where(conf >= self._conf_threshold)[0]
        if valid.size == 0:
            return []

        boxes = boxes[valid]
        scores = scores[valid]
        conf = conf[valid]
        kpt_conf = kpt_conf[valid]
        if has_kpt_xy and kpt_xy is not None:
            kpt_xy = kpt_xy[valid]

        keep = self._nms_numpy(boxes, scores, self._iou_threshold)
        if not keep:
            return []

        candidates: list[dict[str, float]] = []
        for idx in keep[: max(1, int(max_candidates))]:
            mapped_box = self._map_back_xyxy_one(boxes[idx], meta)
            if has_kpt_xy and kpt_xy is not None:
                tip_x, tip_y = self._map_back_point(float(kpt_xy[idx, 0]), float(kpt_xy[idx, 1]), meta)
            else:
                tip_x = float((mapped_box[0] + mapped_box[2]) / 2.0)
                tip_y = float((mapped_box[1] + mapped_box[3]) / 2.0)
            candidates.append(
                {
                    "x": tip_x,
                    "y": tip_y,
                    "confidence": float(conf[idx]),
                    "score_confidence": float(scores[idx]),
                    "kpt_confidence": float(kpt_conf[idx]),
                    "x1": float(mapped_box[0]),
                    "y1": float(mapped_box[1]),
                    "x2": float(mapped_box[2]),
                    "y2": float(mapped_box[3]),
                }
            )
        return sorted(candidates, key=lambda c: float(c["score_confidence"]), reverse=True)

    def detect_tip_candidates(self, frame: np.ndarray, max_candidates: int = 5) -> list[dict[str, float]]:
        out = self.detect_tip_candidates_batch([frame], max_candidates=max_candidates)
        return out[0] if out else []

    def detect_tip_candidates_batch_timed(
        self,
        frames: list[Optional[np.ndarray]],
        max_candidates: int = 5,
    ) -> tuple[list[list[dict[str, float]]], dict[str, float]]:
        timings = {"preprocess_ms": 0.0, "inference_ms": 0.0, "decode_ms": 0.0}
        if not frames:
            return [], timings

        results: list[list[dict[str, float]]] = [[] for _ in frames]
        if self._work_canvas is not None:
            self._work_canvas.fill(0)
        if self._batch_size <= 1:
            for i, frame in enumerate(frames):
                if frame is None or frame.size == 0:
                    continue
                t0 = time.perf_counter()
                meta = self._preprocess_into(0, frame)
                blob = cv2.dnn.blobFromImage(
                    self._work_canvas[0],
                    scalefactor=1.0 / 255.0,
                    size=(self._in_w, self._in_h),
                    mean=(0.0, 0.0, 0.0),
                    swapRB=True,
                    crop=False,
                    ddepth=cv2.CV_32F,
                )
                timings["preprocess_ms"] += (time.perf_counter() - t0) * 1000.0
                inp = blob
                t0 = time.perf_counter()
                with self._lock:
                    raw = self._request.infer({self._input.any_name: inp})[self._output]
                timings["inference_ms"] += (time.perf_counter() - t0) * 1000.0
                pred = raw[0]
                t0 = time.perf_counter()
                results[i] = self._decode_candidates_from_pred(pred, meta, max_candidates=max_candidates)
                timings["decode_ms"] += (time.perf_counter() - t0) * 1000.0
            return results, timings

        slot_to_frame_idx: list[int] = []
        metas: dict[int, dict[str, float]] = {}
        for idx, frame in enumerate(frames[: self._batch_size]):
            slot = len(slot_to_frame_idx)
            if frame is None or frame.size == 0:
                self._work_canvas[slot].fill(0)
                self._work_input[slot].fill(0)
                continue
            t0 = time.perf_counter()
            metas[slot] = self._preprocess_into(slot, frame)
            timings["preprocess_ms"] += (time.perf_counter() - t0) * 1000.0
            slot_to_frame_idx.append(idx)

        if not slot_to_frame_idx:
            return results, timings

        t0 = time.perf_counter()
        blob = cv2.dnn.blobFromImages(
            list(self._work_canvas),
            scalefactor=1.0 / 255.0,
            size=(self._in_w, self._in_h),
            mean=(0.0, 0.0, 0.0),
            swapRB=True,
            crop=False,
            ddepth=cv2.CV_32F,
        )
        self._work_input[:] = blob
        timings["preprocess_ms"] += (time.perf_counter() - t0) * 1000.0

        inp = blob
        t0 = time.perf_counter()
        with self._lock:
            raw = self._request.infer({self._input.any_name: inp})[self._output]
        timings["inference_ms"] += (time.perf_counter() - t0) * 1000.0

        for slot, frame_idx in enumerate(slot_to_frame_idx):
            pred = raw[slot]
            meta = metas[slot]
            t0 = time.perf_counter()
            results[frame_idx] = self._decode_candidates_from_pred(pred, meta, max_candidates=max_candidates)
            timings["decode_ms"] += (time.perf_counter() - t0) * 1000.0
        return results, timings

    def detect_tip_candidates_batch(
        self,
        frames: list[Optional[np.ndarray]],
        max_candidates: int = 5,
    ) -> list[list[dict[str, float]]]:
        results, _ = self.detect_tip_candidates_batch_timed(frames, max_candidates=max_candidates)
        return results


class OnnxTipDetector:
    def __init__(
        self,
        model_dir: Path,
        conf_threshold: float = 0.4,
        iou_threshold: float = 0.5,
        performance_hint: str = "LATENCY",
    ):
        if ort is None:
            raise RuntimeError("onnxruntime is not installed")
        self._lock = threading.Lock()
        self._model_dir = model_dir
        self._conf_threshold = float(conf_threshold)
        self._iou_threshold = float(iou_threshold)
        self._performance_hint = str(performance_hint or "LATENCY").upper()
        self._batch_size = 1
        self._in_h = 736
        self._in_w = 1280
        self._work_canvas: Optional[np.ndarray] = None
        self._work_input: Optional[np.ndarray] = None
        self._meta_end2end = False
        self._meta_kpt_dim = 3
        self._session = None
        self._input_name = ""
        self._output_name = ""
        self._load_model()

    _sigmoid = staticmethod(OpenVinoTipDetector._sigmoid)
    _nms_numpy = staticmethod(OpenVinoTipDetector._nms_numpy)
    _map_back_xyxy_one = staticmethod(OpenVinoTipDetector._map_back_xyxy_one)
    _map_back_point = staticmethod(OpenVinoTipDetector._map_back_point)

    def _load_model(self) -> None:
        metadata_file = self._model_dir / "metadata.yaml"
        if metadata_file.exists():
            try:
                meta = yaml.safe_load(metadata_file.read_text(encoding="utf-8")) or {}
                self._meta_end2end = bool(meta.get("end2end", False))
                kpt_shape = meta.get("kpt_shape")
                if isinstance(kpt_shape, list) and len(kpt_shape) >= 2:
                    self._meta_kpt_dim = int(kpt_shape[1])
            except Exception:
                self._meta_end2end = False
                self._meta_kpt_dim = 3

        onnx_files = sorted(self._model_dir.glob("*.onnx"))
        if not onnx_files:
            raise FileNotFoundError(f"No ONNX tip model found in {self._model_dir}")
        session_options = ort.SessionOptions()
        session_options.inter_op_num_threads = 1
        if self._performance_hint == "LATENCY":
            session_options.intra_op_num_threads = int(os.getenv("MACHINE_DARTS_ONNX_INFERENCE_THREADS", "4") or "4")
        else:
            session_options.intra_op_num_threads = int(os.getenv("MACHINE_DARTS_ONNX_INFERENCE_THREADS", "4") or "4")
        self._session = ort.InferenceSession(
            str(onnx_files[0]),
            sess_options=session_options,
            providers=["CPUExecutionProvider"],
        )
        inp = self._session.get_inputs()[0]
        out = self._session.get_outputs()[0]
        self._input_name = str(inp.name)
        self._output_name = str(out.name)
        shape = [int(v) if isinstance(v, int) or str(v).isdigit() else 1 for v in inp.shape]
        if len(shape) == 4:
            self._batch_size = max(1, int(shape[0]))
            self._in_h = int(shape[2])
            self._in_w = int(shape[3])
        self._work_canvas = np.zeros((self._batch_size, self._in_h, self._in_w, 3), dtype=np.uint8)
        self._work_input = np.zeros((self._batch_size, 3, self._in_h, self._in_w), dtype=np.float32)

    def runtime_info(self) -> dict[str, Any]:
        return {
            "requested_device": "ONNX-CPU",
            "resolved_execution_devices": ["ONNX-CPU"],
            "resolved_device_label": "ONNX Runtime CPU",
            "resolved_performance_hint": self._performance_hint,
        }

    def detect_tip_candidates_batch_timed(
        self,
        frames: list[Optional[np.ndarray]],
        max_candidates: int = 5,
    ) -> tuple[list[list[dict[str, float]]], dict[str, float]]:
        timings = {"preprocess_ms": 0.0, "inference_ms": 0.0, "decode_ms": 0.0}
        if not frames:
            return [], timings

        results: list[list[dict[str, float]]] = [[] for _ in frames]
        if self._work_canvas is not None:
            self._work_canvas.fill(0)

        for i, frame in enumerate(frames):
            if frame is None or frame.size == 0:
                continue
            t0 = time.perf_counter()
            meta = OpenVinoTipDetector._preprocess_into(self, 0, frame)
            blob = cv2.dnn.blobFromImage(
                self._work_canvas[0],
                scalefactor=1.0 / 255.0,
                size=(self._in_w, self._in_h),
                mean=(0.0, 0.0, 0.0),
                swapRB=True,
                crop=False,
                ddepth=cv2.CV_32F,
            )
            timings["preprocess_ms"] += (time.perf_counter() - t0) * 1000.0
            t0 = time.perf_counter()
            with self._lock:
                raw = self._session.run([self._output_name], {self._input_name: blob})[0]
            timings["inference_ms"] += (time.perf_counter() - t0) * 1000.0
            pred = raw[0]
            t0 = time.perf_counter()
            results[i] = OpenVinoTipDetector._decode_candidates_from_pred(
                self,
                pred,
                meta,
                max_candidates=max_candidates,
            )
            timings["decode_ms"] += (time.perf_counter() - t0) * 1000.0
        return results, timings

    def detect_tip_candidates_batch(
        self,
        frames: list[Optional[np.ndarray]],
        max_candidates: int = 5,
    ) -> list[list[dict[str, float]]]:
        results, _ = self.detect_tip_candidates_batch_timed(frames, max_candidates=max_candidates)
        return results


class TipScoringService:
    def __init__(self):
        self._lock = threading.Lock()
        self._detector: Optional[OpenVinoTipDetector | OnnxTipDetector] = None
        self._active_model_id: str = ""
        self._selected_device: str = "AUTO"
        self._effective_device: str = "AUTO"
        self._selected_performance_hint: str = "LATENCY"
        self._effective_performance_hint: str = "LATENCY"
        self._duplicate_tip_px_threshold: float = 4.0
        self._tracked_tips: dict[int, list[tuple[float, float]]] = defaultdict(list)
        self._cal_manager = get_shared_calibration_manager(
            num_cameras=len(settings.camera_indices),
            calibration_dir=settings.calibration_data_dir,
        )
        self.reload_from_settings()

    def reload_from_settings(self) -> None:
        with self._lock:
            payload = _read_settings()
            available = list_available_tip_models()
            models = {m["id"]: m for m in available}
            selected_device = str(payload.get("openvino", {}).get("device", "AUTO") or "AUTO").upper()
            performance_hint = str(payload.get("openvino", {}).get("performance_hint", "LATENCY") or "LATENCY").upper()
            preferred_id = str(payload["tip"].get("active_model_id") or "")
            if preferred_id not in models:
                preferred_id = _default_tip_model_id()
            if not preferred_id:
                self._active_model_id = ""
                self._detector = None
                self._selected_device = selected_device
                self._effective_device = selected_device
                self._selected_performance_hint = performance_hint
                self._effective_performance_hint = performance_hint
                return

            conf_thr = float(payload["tip"].get("confidence_threshold", 0.3))
            iou_thr = float(payload["tip"].get("iou_threshold", 0.9))
            self._duplicate_tip_px_threshold = float(payload["tip"].get("duplicate_tip_px_threshold", 4.0))
            load_order: list[str] = []
            if preferred_id:
                load_order.append(preferred_id)
            for mid in models.keys():
                if mid != preferred_id:
                    load_order.append(mid)

            loaded_id = ""
            loaded_detector: Optional[OpenVinoTipDetector | OnnxTipDetector] = None
            loaded_device = selected_device
            loaded_performance_hint = performance_hint
            last_error: Exception | None = None
            for model_id in load_order:
                model_dir = Path(models[model_id]["path"])
                model_runtime = str(models[model_id].get("runtime") or "openvino").lower()
                device_order = ["ONNX-CPU"] if model_runtime == "onnx" else [selected_device]
                if model_runtime != "onnx" and selected_device != "CPU":
                    device_order.append("CPU")
                for device in device_order:
                    try:
                        if model_runtime == "onnx":
                            loaded_detector = OnnxTipDetector(
                                model_dir=model_dir,
                                conf_threshold=conf_thr,
                                iou_threshold=iou_thr,
                                performance_hint=performance_hint,
                            )
                        else:
                            loaded_detector = OpenVinoTipDetector(
                                model_dir=model_dir,
                                conf_threshold=conf_thr,
                                iou_threshold=iou_thr,
                                device=device,
                                performance_hint=performance_hint,
                            )
                        detector_runtime = loaded_detector.runtime_info()
                        loaded_id = model_id
                        loaded_device = str(detector_runtime.get("resolved_device_label") or device)
                        loaded_performance_hint = str(
                            detector_runtime.get("resolved_performance_hint") or performance_hint
                        ).upper()
                        break
                    except Exception as exc:
                        last_error = exc
                        print(f"[WARN] Failed to load tip model '{model_id}' on device '{device}': {exc}")
                if loaded_detector is not None:
                    break

            if loaded_detector is None:
                # Keep detection loop alive even when scoring model fails.
                self._active_model_id = ""
                self._detector = None
                self._selected_device = selected_device
                self._effective_device = selected_device
                self._selected_performance_hint = performance_hint
                self._effective_performance_hint = performance_hint
                if last_error is not None:
                    print(f"[WARN] Tip scoring disabled; no loadable tip model found: {last_error}")
                return

            self._detector = loaded_detector
            self._active_model_id = loaded_id
            self._selected_device = selected_device
            self._effective_device = loaded_device
            self._selected_performance_hint = performance_hint
            self._effective_performance_hint = loaded_performance_hint
            # Persist fallback model so next startup does not crash on the same bad model.
            if loaded_id != preferred_id:
                payload["tip"]["active_model_id"] = loaded_id
                _write_settings(payload)

            # Keep shared calibration manager instance across subsystems.
            self._cal_manager = get_shared_calibration_manager(
                num_cameras=len(settings.camera_indices),
                calibration_dir=settings.calibration_data_dir,
            )

    def reload_calibration(self) -> None:
        """Refresh in-memory calibration used for tip scoring without reloading models."""
        with self._lock:
            self._cal_manager = get_shared_calibration_manager(
                num_cameras=len(settings.camera_indices),
                calibration_dir=settings.calibration_data_dir,
            )

    def get_runtime_info(self) -> dict[str, Any]:
        with self._lock:
            return {
                "selected_device": self._selected_device,
                "effective_device": self._effective_device,
                "selected_performance_hint": self._selected_performance_hint,
                "effective_performance_hint": self._effective_performance_hint,
                "active_model_id": self._active_model_id,
            }

    @staticmethod
    def _distance(a: tuple[float, float], b: tuple[float, float]) -> float:
        return float(np.hypot(a[0] - b[0], a[1] - b[1]))

    def _is_duplicate_tip(self, cam_idx: int, tip_x: float, tip_y: float) -> bool:
        pts = self._tracked_tips.get(cam_idx, [])
        if not pts:
            return False
        p = (float(tip_x), float(tip_y))
        return any(self._distance(p, old) <= self._duplicate_tip_px_threshold for old in pts)

    def reset_tracks(self) -> None:
        with self._lock:
            self._tracked_tips = defaultdict(list)

    def commit_tracked_tips(self, tips: list[tuple[int, float, float]]) -> None:
        with self._lock:
            for cam_idx, x, y in tips:
                self._tracked_tips[int(cam_idx)].append((float(x), float(y)))

    def score_frames(self, frames: list[Optional[np.ndarray]]) -> dict[str, Any]:
        with self._lock:
            detector = self._detector
        if detector is None:
            return {"ok": False, "reason": "no_tip_model"}

        total_t0 = time.perf_counter()
        selection_ms = 0.0
        calibration_ms = 0.0
        vote_ms = 0.0
        raw_candidate_count = 0
        duplicate_rejected_count = 0
        miss_candidate_count = 0
        non_miss_candidate_count = 0
        candidates: list[dict[str, Any]] = []
        selected_new_tips: list[tuple[int, float, float]] = []
        batch_candidates, detect_timings = detector.detect_tip_candidates_batch_timed(frames, max_candidates=6)
        for cam_idx, tip_candidates in enumerate(batch_candidates):
            raw_candidate_count += len(tip_candidates)
            tip = None
            t0 = time.perf_counter()
            for c in tip_candidates:
                with self._lock:
                    is_dup = self._is_duplicate_tip(cam_idx, c["x"], c["y"])
                if not is_dup:
                    tip = c
                    break
                duplicate_rejected_count += 1
            selection_ms += (time.perf_counter() - t0) * 1000.0
            if tip is None:
                continue
            try:
                t0 = time.perf_counter()
                score_info = self._cal_manager.score(cam_idx, tip["x"], tip["y"])
                board_position = self._cal_manager.describe_board_point(cam_idx, tip["x"], tip["y"])
                calibration_ms += (time.perf_counter() - t0) * 1000.0
                score_value = int(score_info.get("score", 0)) if isinstance(score_info, dict) else 0
            except Exception:
                score_info = {"score": 0, "zone": "error"}
                board_position = None
                score_value = 0
            zone = str(score_info.get("zone", "") or "").lower() if isinstance(score_info, dict) else ""
            is_miss = bool(score_value <= 0 or zone in {"miss", "unknown", "error", ""})
            if is_miss:
                miss_candidate_count += 1
            else:
                non_miss_candidate_count += 1
            candidates.append(
                {
                    "camera_index": cam_idx,
                    "tip": {"x": tip["x"], "y": tip["y"]},
                    "confidence": tip["score_confidence"],
                    "score": score_info,
                    "board": board_position,
                    "score_value": score_value,
                    "is_miss": is_miss,
                }
            )
            selected_new_tips.append((cam_idx, float(tip["x"]), float(tip["y"])))

        if not candidates:
            if raw_candidate_count <= 0:
                reason = "no_tip_candidates"
            elif duplicate_rejected_count >= raw_candidate_count:
                reason = "duplicate_tip_too_close"
            else:
                reason = "no_scoring_candidates"
            return {
                "ok": False,
                "reason": reason,
                "diagnostics": {
                    "raw_candidate_count": int(raw_candidate_count),
                    "duplicate_rejected_count": int(duplicate_rejected_count),
                },
                "timings": {
                    "preprocess_ms": round(float(detect_timings.get("preprocess_ms", 0.0)), 2),
                    "inference_ms": round(float(detect_timings.get("inference_ms", 0.0)), 2),
                    "decode_ms": round(float(detect_timings.get("decode_ms", 0.0)), 2),
                    "selection_ms": round(selection_ms, 2),
                    "calibration_ms": round(calibration_ms, 2),
                    "vote_ms": round(vote_ms, 2),
                    "total_ms": round((time.perf_counter() - total_t0) * 1000.0, 2),
                },
            }

        groups: dict[int, list[dict[str, Any]]] = defaultdict(list)
        t0 = time.perf_counter()
        for c in candidates:
            groups[int(c["score_value"])].append(c)

        # Majority vote; tie-break by average confidence.
        winner_value = max(
            groups.keys(),
            key=lambda k: (len(groups[k]), float(np.mean([x["confidence"] for x in groups[k]]))),
        )
        winner_group = groups[winner_value]

        def bed_key(candidate: dict[str, Any]) -> tuple[str, str, int]:
            score = candidate.get("score", {}) if isinstance(candidate.get("score"), dict) else {}
            return (
                str(score.get("zone", "") or "").lower(),
                str(score.get("segment", "") or ""),
                int(candidate.get("score_value", 0) or 0),
            )

        bed_groups: dict[tuple[str, str, int], list[dict[str, Any]]] = defaultdict(list)
        for candidate in winner_group:
            bed_groups[bed_key(candidate)].append(candidate)

        heatmap_group = max(
            bed_groups.values(),
            key=lambda items: (len(items), float(np.mean([x["confidence"] for x in items]))),
        )
        representative = max(heatmap_group, key=lambda x: x["confidence"])
        vote_ms += (time.perf_counter() - t0) * 1000.0
        voted_zone = str(representative.get("score", {}).get("zone", "") or "").lower()
        miss_reason: Optional[str] = None
        if int(winner_value) <= 0 or voted_zone in {"miss", "unknown", "error", ""}:
            if non_miss_candidate_count <= 0 and miss_candidate_count > 0:
                miss_reason = "outside_scoring_zone"
            elif len(candidates) > 1 and len(winner_group) <= 1:
                miss_reason = "low_consensus_miss"
            else:
                miss_reason = "miss"
        voted_score = dict(representative["score"])
        board_points = [
            item.get("board")
            for item in heatmap_group
            if isinstance(item.get("board"), dict)
        ]
        if board_points:
            board_payload = dict(representative.get("board", {}) if isinstance(representative.get("board"), dict) else {})
            for out_key, in_key in (("x", "x"), ("y", "y"), ("display_x", "display_x"), ("display_y", "display_y")):
                vals = [
                    float(point[in_key])
                    for point in board_points
                    if point.get(in_key) is not None
                ]
                if vals:
                    board_payload[out_key] = float(np.mean(vals))
            board_payload["camera_count"] = len(board_points)
            board_payload["camera_indices"] = [
                int(item.get("camera_index", -1))
                for item in heatmap_group
                if isinstance(item.get("board"), dict)
            ]
            voted_score["board"] = board_payload
        return {
            "ok": True,
            "active_model_id": self._active_model_id,
            "voted_score_value": int(winner_value),
            "voted_score": voted_score,
            "votes": len(winner_group),
            "miss_reason": miss_reason,
            "diagnostics": {
                "raw_candidate_count": int(raw_candidate_count),
                "duplicate_rejected_count": int(duplicate_rejected_count),
                "miss_candidate_count": int(miss_candidate_count),
                "non_miss_candidate_count": int(non_miss_candidate_count),
            },
            "candidates": candidates,
            "selected_new_tips": selected_new_tips,
            "timings": {
                "preprocess_ms": round(float(detect_timings.get("preprocess_ms", 0.0)), 2),
                "inference_ms": round(float(detect_timings.get("inference_ms", 0.0)), 2),
                "decode_ms": round(float(detect_timings.get("decode_ms", 0.0)), 2),
                "selection_ms": round(selection_ms, 2),
                "calibration_ms": round(calibration_ms, 2),
                "vote_ms": round(vote_ms, 2),
                "total_ms": round((time.perf_counter() - total_t0) * 1000.0, 2),
            },
        }


def get_tip_scoring_service() -> TipScoringService:
    global _SERVICE
    with _SERVICE_LOCK:
        if _SERVICE is None:
            _SERVICE = TipScoringService()
        return _SERVICE


def reload_tip_scoring_calibration() -> None:
    """Public helper for calibration routes to apply updates immediately."""
    service = get_tip_scoring_service()
    service.reload_calibration()
