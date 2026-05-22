from __future__ import annotations

import sys
import threading
import os
from pathlib import Path

import cv2
import numpy as np
import yaml
from openvino import Core

from backend.core.model_crypto import decrypt_bytes, is_packaged_runtime, load_model_key


class CalibrationPointDetector:
    """Direct OpenVINO calibration-point detector for YOLO-exported models."""

    _PREFERRED_MODEL_NAMES = (
        "1280-m-d-24042026_openvino_model",
    )

    def __init__(self, model_dir: str | None = None, conf_threshold: float = 0.5, iou_threshold: float = 0.5):
        self._lock = threading.Lock()
        self._compiled = None
        self._request = None
        self._input = None
        self._output = None

        self._model_dir = Path(model_dir) if model_dir else self._find_default_model_dir()
        self._metadata = self._load_metadata(self._model_dir)
        self._class_names: dict[int, str] = self._parse_class_names(self._metadata)
        self._task = str(self._metadata.get("task", "") or "").strip().lower()
        self._kpt_shape = self._parse_kpt_shape(self._metadata)
        self._conf_threshold = float(conf_threshold)
        self._iou_threshold = float(iou_threshold)

    @staticmethod
    def _find_default_model_dir() -> Path:
        if is_packaged_runtime():
            exe_dir = Path(sys.executable).resolve().parent
            candidates: list[Path] = []
            bases: list[Path] = [exe_dir]
            for i in range(1, 6):
                try:
                    bases.append(exe_dir.parents[i - 1])
                except Exception:
                    break
            for base in bases:
                candidates.append(base / "build" / "secure-models" / "models" / "calibration")
                candidates.append(base / "resources" / "build" / "secure-models" / "models" / "calibration")
                candidates.append(base / "_up_" / "_up_" / "build" / "secure-models" / "models" / "calibration")
                candidates.append(base / "models" / "calibration")
                candidates.append(base / "resources" / "models" / "calibration")
                candidates.append(base / "_up_" / "_up_" / "models" / "calibration")
            calib_root = next((p for p in candidates if p.exists()), candidates[0])
        else:
            root = Path(__file__).resolve().parents[2]
            calib_root = root / "models" / "calibration"
        if not calib_root.exists():
            raise FileNotFoundError(f"Calibration models directory not found: {calib_root}")
        candidates = sorted(
            [d for d in calib_root.iterdir() if d.is_dir() and (list(d.glob("*.xml")) or list(d.glob("*.xml.enc")))],
            key=lambda p: p.name,
        )
        if not candidates:
            raise FileNotFoundError(f"No OpenVINO calibration model (*.xml) found under: {calib_root}")

        requested = str(os.getenv("MACHINE_DARTS_CALIBRATION_MODEL", "")).strip()
        if requested:
            requested_path = Path(requested)
            direct_candidate = requested_path if requested_path.is_absolute() else calib_root / requested
            if direct_candidate.is_dir() and (list(direct_candidate.glob("*.xml")) or list(direct_candidate.glob("*.xml.enc"))):
                return direct_candidate
            requested_name = requested_path.name
            for candidate in candidates:
                if candidate.name == requested_name:
                    return candidate

        for preferred_name in CalibrationPointDetector._PREFERRED_MODEL_NAMES:
            for candidate in candidates:
                if candidate.name == preferred_name:
                    return candidate
        return candidates[-1]

    @staticmethod
    def _load_metadata(model_dir: Path) -> dict:
        meta_file = model_dir / "metadata.yaml"
        if not meta_file.exists():
            return {}
        try:
            payload = yaml.safe_load(meta_file.read_text(encoding="utf-8")) or {}
            return payload if isinstance(payload, dict) else {}
        except Exception:
            pass
        return {}

    @staticmethod
    def _parse_class_names(payload: dict) -> dict[int, str]:
        names = payload.get("names", {}) if isinstance(payload, dict) else {}
        if isinstance(names, dict):
            out: dict[int, str] = {}
            for k, v in names.items():
                out[int(k)] = str(v)
            return out
        return {}

    @staticmethod
    def _parse_kpt_shape(payload: dict) -> tuple[int, int]:
        shape = payload.get("kpt_shape", []) if isinstance(payload, dict) else []
        if isinstance(shape, (list, tuple)) and len(shape) >= 2:
            try:
                return max(0, int(shape[0])), max(0, int(shape[1]))
            except Exception:
                pass
        return 0, 0

    def _ensure_model(self) -> None:
        with self._lock:
            if self._request is not None:
                return
            xml_files = sorted(self._model_dir.glob("*.xml"))
            core = Core()
            if xml_files:
                model = core.read_model(str(xml_files[0]))
            else:
                encrypted_xml_files = sorted(self._model_dir.glob("*.xml.enc"))
                encrypted_bin_files = sorted(self._model_dir.glob("*.bin.enc"))
                if not encrypted_xml_files or not encrypted_bin_files:
                    raise FileNotFoundError(f"OpenVINO model not found in {self._model_dir}")
                key = load_model_key()
                xml_bytes = decrypt_bytes(encrypted_xml_files[0].read_bytes(), key)
                bin_bytes = decrypt_bytes(encrypted_bin_files[0].read_bytes(), key)
                model = core.read_model(xml_bytes, weights=bin_bytes)
                print(f"[model] loaded encrypted calibration model from memory: {self._model_dir.name}")
            compiled = core.compile_model(model, "CPU", {"PERFORMANCE_HINT": "LATENCY"})
            request = compiled.create_infer_request()
            self._compiled = compiled
            self._request = request
            self._input = compiled.input(0)
            self._output = compiled.output(0)

    @staticmethod
    def _sigmoid(x: np.ndarray) -> np.ndarray:
        return 1.0 / (1.0 + np.exp(-x))

    @staticmethod
    def _xywh_to_xyxy(xywh: np.ndarray) -> np.ndarray:
        out = np.empty_like(xywh)
        out[:, 0] = xywh[:, 0] - xywh[:, 2] / 2.0
        out[:, 1] = xywh[:, 1] - xywh[:, 3] / 2.0
        out[:, 2] = xywh[:, 0] + xywh[:, 2] / 2.0
        out[:, 3] = xywh[:, 1] + xywh[:, 3] / 2.0
        return out

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

    def _preprocess(self, frame: np.ndarray) -> tuple[np.ndarray, dict]:
        in_shape = self._input.shape  # [N,C,H,W]
        h = int(in_shape[2])
        w = int(in_shape[3])

        src_h, src_w = frame.shape[:2]
        scale = min(w / float(src_w), h / float(src_h))
        new_w = int(round(src_w * scale))
        new_h = int(round(src_h * scale))

        resized = cv2.resize(frame, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
        canvas = np.zeros((h, w, 3), dtype=np.uint8)
        pad_x = (w - new_w) // 2
        pad_y = (h - new_h) // 2
        canvas[pad_y:pad_y + new_h, pad_x:pad_x + new_w] = resized

        inp = canvas[:, :, ::-1].astype(np.float32) / 255.0  # BGR -> RGB
        inp = np.transpose(inp, (2, 0, 1))[None, ...]
        meta = {"scale": scale, "pad_x": pad_x, "pad_y": pad_y, "src_w": src_w, "src_h": src_h}
        return inp, meta

    @staticmethod
    def _map_back_xyxy(boxes_xyxy: np.ndarray, meta: dict) -> np.ndarray:
        out = boxes_xyxy.copy()
        out[:, [0, 2]] = (out[:, [0, 2]] - float(meta["pad_x"])) / float(meta["scale"])
        out[:, [1, 3]] = (out[:, [1, 3]] - float(meta["pad_y"])) / float(meta["scale"])
        out[:, [0, 2]] = np.clip(out[:, [0, 2]], 0, float(meta["src_w"] - 1))
        out[:, [1, 3]] = np.clip(out[:, [1, 3]], 0, float(meta["src_h"] - 1))
        return out

    def _empty(self) -> dict:
        return {
            "cal": [],
            "cal1": [],
            "cal2": [],
            "cal3": [],
            "20": [],
            "3": [],
            "bull": [],
            "bullseye": [],
            "bull_boxes": [],
            "bullseye_boxes": [],
        }

    def detect(self, frame: np.ndarray) -> dict:
        if frame is None or frame.size == 0:
            return self._empty()

        self._ensure_model()
        inp, meta = self._preprocess(frame)

        with self._lock:
            outputs = self._request.infer({self._input.any_name: inp})
        raw = outputs[self._output]

        pred = raw[0]
        if pred.ndim != 2:
            return self._empty()

        # Common YOLO exports are either [C,N] or [N,C].
        if pred.shape[0] <= 32 and pred.shape[1] > pred.shape[0]:
            pred = pred.transpose(1, 0)
        elif pred.shape[1] > 64:
            pred = pred.transpose(1, 0)

        if pred.shape[1] < 6:
            return self._empty()

        detected = self._empty()
        bullseye_aliases = {"bullseye", "bull_seye", "44"}

        # End2end layout: [x1,y1,x2,y2,conf,cls]
        if pred.shape[1] == 6:
            boxes_xyxy = self._map_back_xyxy(pred[:, 0:4], meta)
            conf = pred[:, 4].astype(np.float32)
            cls = pred[:, 5].astype(np.int32)

            for cls_id in np.unique(cls):
                idx = np.where((cls == cls_id) & (conf >= self._conf_threshold))[0]
                if idx.size == 0:
                    continue
                class_boxes = boxes_xyxy[idx]
                class_scores = conf[idx]
                keep = self._nms_numpy(class_boxes, class_scores, self._iou_threshold)
                for k in keep:
                    x1, y1, x2, y2 = class_boxes[k].tolist()
                    score = float(class_scores[k])
                    cx = float((x1 + x2) / 2.0)
                    cy = float((y1 + y2) / 2.0)
                    class_name = self._class_names.get(int(cls_id), str(int(cls_id)))
                    if class_name == "bull":
                        detected["bull"].append((cx, cy, score))
                        detected["bull_boxes"].append((x1, y1, x2, y2, score))
                    elif class_name in bullseye_aliases:
                        detected["bullseye"].append((cx, cy, score))
                        detected["bullseye_boxes"].append((x1, y1, x2, y2, score))
                    elif class_name in detected:
                        detected[class_name].append((cx, cy, score))
            return detected

        num_named_classes = (max(self._class_names.keys()) + 1) if self._class_names else 0
        kpt_count, kpt_dims = self._kpt_shape
        kpt_values = kpt_count * kpt_dims
        pose_class_end = 4 + num_named_classes

        if (
            self._task == "pose"
            and num_named_classes > 0
            and kpt_count > 0
            and kpt_dims >= 2
            and pred.shape[1] >= pose_class_end + kpt_values
        ):
            boxes_xyxy = self._xywh_to_xyxy(pred[:, 0:4])
            boxes_xyxy = self._map_back_xyxy(boxes_xyxy, meta)

            cls_scores = pred[:, 4:pose_class_end]
            if np.any(cls_scores < 0.0) or np.any(cls_scores > 1.0):
                cls_scores = self._sigmoid(cls_scores)

            kpts = pred[:, pose_class_end:pose_class_end + kpt_values].reshape((-1, kpt_count, kpt_dims))
            if kpt_dims >= 3:
                keypoint_conf = kpts[:, 0, 2].astype(np.float32)
                if np.any(keypoint_conf < 0.0) or np.any(keypoint_conf > 1.0):
                    keypoint_conf = self._sigmoid(keypoint_conf)
            else:
                keypoint_conf = np.ones((pred.shape[0],), dtype=np.float32)

            threshold = self._conf_threshold
            if float(np.max(cls_scores)) < threshold:
                threshold = 0.2

            for cls_id in range(num_named_classes):
                class_scores = cls_scores[:, cls_id].astype(np.float32)
                combined_scores = class_scores * np.maximum(keypoint_conf, 0.05)
                idx = np.where((class_scores >= threshold) & (keypoint_conf >= 0.05))[0]
                if idx.size == 0:
                    continue
                class_boxes = boxes_xyxy[idx]
                scores = combined_scores[idx]
                keep = self._nms_numpy(class_boxes, scores, self._iou_threshold)
                if not keep:
                    continue

                class_name = self._class_names.get(cls_id, str(cls_id))
                max_per_class = 1 if class_name in {"bull", "bullseye", "20", "3"} else 20
                if len(keep) > max_per_class:
                    order = np.argsort(scores[keep])[::-1][:max_per_class]
                    keep = [keep[i] for i in order]

                for k in keep:
                    x1, y1, x2, y2 = class_boxes[k].tolist()
                    conf = float(scores[k])
                    px = float((x1 + x2) / 2.0)
                    py = float((y1 + y2) / 2.0)
                    if class_name == "bull":
                        detected["bull"].append((px, py, conf))
                        detected["bull_boxes"].append((x1, y1, x2, y2, conf))
                    elif class_name in bullseye_aliases:
                        detected["bullseye"].append((px, py, conf))
                        detected["bullseye_boxes"].append((x1, y1, x2, y2, conf))
                    elif class_name in detected:
                        detected[class_name].append((px, py, conf))

            return detected

        # Non-end2end YOLO layout: [x,y,w,h,obj?,cls...]
        boxes_xyxy = self._xywh_to_xyxy(pred[:, 0:4])
        boxes_xyxy = self._map_back_xyxy(boxes_xyxy, meta)

        # Try a few layouts and pick best by max score.
        layouts: list[tuple[np.ndarray | None, np.ndarray]] = []
        if pred.shape[1] >= 7:
            layouts.append((pred[:, 4], pred[:, 5:]))   # obj first
            layouts.append((pred[:, -1], pred[:, 4:-1]))  # obj last
        layouts.append((None, pred[:, 4:]))  # no obj

        best_scores = None
        best_max = -1.0
        for obj_col, cls_cols in layouts:
            if cls_cols.size == 0:
                continue
            cls_scores = cls_cols
            obj_scores = obj_col
            if np.any(cls_scores < 0.0) or np.any(cls_scores > 1.0):
                cls_scores = self._sigmoid(cls_scores)
            if obj_scores is not None:
                if np.any(obj_scores < 0.0) or np.any(obj_scores > 1.0):
                    obj_scores = self._sigmoid(obj_scores)
                cls_scores = cls_scores * obj_scores[:, None]
            cand_max = float(np.max(cls_scores))
            if cand_max > best_max:
                best_max = cand_max
                best_scores = cls_scores

        if best_scores is None:
            return detected

        threshold = self._conf_threshold
        if float(np.max(best_scores)) < threshold:
            threshold = 0.2

        num_classes = best_scores.shape[1]
        for cls_id in range(num_classes):
            class_scores = best_scores[:, cls_id]
            idx = np.where(class_scores >= threshold)[0]
            if idx.size == 0:
                continue
            class_boxes = boxes_xyxy[idx]
            scores = class_scores[idx]
            keep = self._nms_numpy(class_boxes, scores, self._iou_threshold)
            if not keep:
                continue

            class_name = self._class_names.get(cls_id, str(cls_id))
            max_per_class = 1 if class_name in {"bull", "bullseye", "20", "3"} else 20
            if len(keep) > max_per_class:
                order = np.argsort(scores[keep])[::-1][:max_per_class]
                keep = [keep[i] for i in order]

            for k in keep:
                x1, y1, x2, y2 = class_boxes[k].tolist()
                conf = float(scores[k])
                cx = float((x1 + x2) / 2.0)
                cy = float((y1 + y2) / 2.0)
                if class_name == "bull":
                    detected["bull"].append((cx, cy, conf))
                    detected["bull_boxes"].append((x1, y1, x2, y2, conf))
                elif class_name in bullseye_aliases:
                    detected["bullseye"].append((cx, cy, conf))
                    detected["bullseye_boxes"].append((x1, y1, x2, y2, conf))
                elif class_name in detected:
                    detected[class_name].append((cx, cy, conf))

        return detected
