from __future__ import annotations

import asyncio
import os
import sys
import threading
import time
from pathlib import Path

import cv2
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from backend.config.settings import (
    DEFAULT_SCORING_CAMERA_COUNT,
    camera_slot_role,
    enumerate_camera_device_identities,
    get_data_root,
    is_scoring_camera_slot,
    set_camera_indices,
    settings,
)
from backend.core.calibration_manager import get_shared_calibration_manager
from backend.core.camera_service import CameraService
from backend.core.calibration_point_detector import CalibrationPointDetector
from backend.core.detection_events import publish_detection_event
from backend.core.firebase_uploader import FirebaseUploader
from backend.core.player_replay_camera import get_player_replay_camera_service
from backend.models.schemas import RotationRequest, ScoreRequest

router = APIRouter(tags=["calibration"])

camera_service = CameraService(indices=settings.camera_indices)
calibration_manager = get_shared_calibration_manager(
    num_cameras=len(settings.camera_indices),
    calibration_dir=settings.calibration_data_dir,
)
calibration_detector: CalibrationPointDetector | None = None
camera_flip: dict[int, bool] = {}
_APP_STARTED_AT = time.time()
_WS_CAMERA_CLIENTS_LOCK = threading.Lock()
_WS_CAMERA_CLIENTS_PER_SLOT: dict[int, int] = {}
_WS_CAMERA_DETECTION_MAX_FPS = max(2.0, float(os.getenv("MACHINE_DARTS_WS_CAMERA_DETECTION_FPS", "8")))
_WS_CAMERA_STREAM_MIN_FPS = max(1.0, float(os.getenv("MACHINE_DARTS_WS_CAMERA_MIN_FPS", "2")))
_STARTUP_AUTO_CALIBRATION_STARTED = False
_STARTUP_AUTO_CALIBRATION_LOCK = threading.Lock()
_CALIBRATION_DETECTION_LOCK = threading.Lock()


def _resolve_training_data_dir() -> Path:
    if getattr(sys, "frozen", False):
        return get_data_root() / "training"
    return Path(__file__).resolve().parents[2] / "data" / "training"


def _calibration_file_debug() -> dict:
    base = Path(settings.calibration_data_dir)
    cameras: list[dict] = []
    for i in range(len(settings.camera_indices)):
        cam_dir = base / f"camera_{i}"
        npz_path = cam_dir / "dartboard_calibration.npz"
        json_path = cam_dir / "dartboard_calibration.json"
        cameras.append(
            {
                "camera_index": i,
                "dir": str(cam_dir),
                "npz": {
                    "path": str(npz_path),
                    "exists": npz_path.exists(),
                    "mtime": int(npz_path.stat().st_mtime) if npz_path.exists() else None,
                    "size": int(npz_path.stat().st_size) if npz_path.exists() else None,
                },
                "json": {
                    "path": str(json_path),
                    "exists": json_path.exists(),
                    "mtime": int(json_path.stat().st_mtime) if json_path.exists() else None,
                    "size": int(json_path.stat().st_size) if json_path.exists() else None,
                },
                "status": calibration_manager.status(i),
            }
        )
    return {"calibration_data_dir": str(base), "cameras": cameras}


def _count_training_images() -> dict:
    root = _resolve_training_data_dir()
    counts = {"dart_1": 0, "dart_2": 0, "dart_3": 0, "total": 0}
    if not root.exists():
        return counts
    for idx in range(1, 4):
        dart_dir = root / f"dart_{idx}"
        if not dart_dir.exists():
            continue
        n = len(list(dart_dir.glob("*.jpg")))
        counts[f"dart_{idx}"] = n
        counts["total"] += n
    return counts


def _validate_camera_index(camera_index: int) -> None:
    if camera_index < 0 or camera_index >= len(settings.camera_indices):
        raise HTTPException(status_code=404, detail=f"Camera slot {camera_index} not found")


def _validate_scoring_camera_index(camera_index: int) -> None:
    _validate_camera_index(camera_index)
    if not is_scoring_camera_slot(camera_index):
        raise HTTPException(status_code=400, detail="Player camera is preview-only and is not calibrated")


def _camera_slot_payload(slot: int) -> dict:
    role = camera_slot_role(slot)
    return {
        "index": slot,
        "name": "Player Cam" if role == "player" else f"Camera {slot + 1}",
        "role": role,
        "calibratable": role == "scoring",
    }


def _register_ws_camera_client(camera_index: int) -> None:
    with _WS_CAMERA_CLIENTS_LOCK:
        _WS_CAMERA_CLIENTS_PER_SLOT[camera_index] = int(_WS_CAMERA_CLIENTS_PER_SLOT.get(camera_index, 0)) + 1


def _unregister_ws_camera_client(camera_index: int) -> None:
    with _WS_CAMERA_CLIENTS_LOCK:
        current = int(_WS_CAMERA_CLIENTS_PER_SLOT.get(camera_index, 0))
        if current <= 1:
            _WS_CAMERA_CLIENTS_PER_SLOT.pop(camera_index, None)
        else:
            _WS_CAMERA_CLIENTS_PER_SLOT[camera_index] = current - 1


def _ws_camera_client_count(camera_index: int) -> int:
    with _WS_CAMERA_CLIENTS_LOCK:
        return max(1, int(_WS_CAMERA_CLIENTS_PER_SLOT.get(camera_index, 0)))


def _effective_ws_camera_fps(camera_index: int, view: str) -> float:
    base = float(settings.ws_camera_fps if settings.ws_camera_fps > 0 else 10.0)
    mode = str(camera_service.mode_status().get("mode", "idle"))
    if mode == "detection":
        # Keep detector responsive while still allowing live browser previews.
        if view in {"overlay", "fronton"}:
            base = min(base, _WS_CAMERA_DETECTION_MAX_FPS)
        else:
            base = min(base, max(_WS_CAMERA_DETECTION_MAX_FPS, 12.0))

    clients = _ws_camera_client_count(camera_index)
    per_client = base / float(max(1, clients))
    return max(_WS_CAMERA_STREAM_MIN_FPS, per_client)


def _get_calibration_detector() -> CalibrationPointDetector:
    global calibration_detector
    if calibration_detector is None:
        calibration_detector = CalibrationPointDetector()
    return calibration_detector


def _detect_and_capture_calibration(camera_index: int, include_inner_points: bool = True, timeout_s: float = 1.0) -> dict:
    frame = camera_service.wait_for_frame(camera_index, timeout_s=timeout_s)
    if frame is None:
        raise HTTPException(status_code=503, detail="No frame available from camera")

    with _CALIBRATION_DETECTION_LOCK:
        try:
            detector = _get_calibration_detector()
            detected = detector.detect(frame)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Calibration detection failed: {exc}") from exc

        cal_points = detected.get("cal", [])
        cal1_points = detected.get("cal1", [])
        cal2_points = detected.get("cal2", []) if include_inner_points else []
        cal3_points = detected.get("cal3", []) if include_inner_points else []
        twenty_points = detected.get("20", [])
        bull_boxes = detected.get("bull_boxes", [])
        bullseye_boxes = detected.get("bullseye_boxes", [])

        enough_points = len(cal_points) >= 8 and len(cal1_points) >= 8
        captured = False
        if enough_points:
            captured = bool(
                calibration_manager.capture_calibration(
                    camera_index,
                    frame,
                    cal_points,
                    cal1_points,
                    cal2_points,
                    cal3_points,
                    twenty_points,
                    bull_boxes,
                    bullseye_boxes,
                )
            )
            if captured:
                pass

    return {
        "camera_index": camera_index,
        "cal_points": [[float(x), float(y), float(c)] for x, y, c in cal_points],
        "cal1_points": [[float(x), float(y), float(c)] for x, y, c in cal1_points],
        "cal2_points": [[float(x), float(y), float(c)] for x, y, c in cal2_points],
        "cal3_points": [[float(x), float(y), float(c)] for x, y, c in cal3_points],
        "twenty_points": [[float(x), float(y), float(c)] for x, y, c in twenty_points],
        "bull_boxes": [[float(x1), float(y1), float(x2), float(y2), float(c)] for x1, y1, x2, y2, c in bull_boxes],
        "bullseye_boxes": [
            [float(x1), float(y1), float(x2), float(y2), float(c)] for x1, y1, x2, y2, c in bullseye_boxes
        ],
        "tips": [],
        "cal_count": len(cal_points),
        "cal1_count": len(cal1_points),
        "cal2_count": len(cal2_points),
        "cal3_count": len(cal3_points),
        "twenty_count": len(twenty_points),
        "bull_count": len(detected.get("bull", [])),
        "bullseye_count": len(detected.get("bullseye", [])),
        "enough_points": enough_points,
        "captured": captured,
    }


def _auto_calibrate_scoring_cameras(include_inner_points: bool = True, only_missing: bool = False) -> dict:
    results: list[dict] = []
    scoring_count = min(DEFAULT_SCORING_CAMERA_COUNT, len(settings.camera_indices))

    for camera_index in range(scoring_count):
        status_before = calibration_manager.status(camera_index)
        if only_missing and status_before.get("is_calibrated"):
            results.append(
                {
                    "camera_index": camera_index,
                    "role": camera_slot_role(camera_index),
                    "status": "skipped",
                    "reason": "already_calibrated",
                    "captured": False,
                    "enough_points": False,
                }
            )
            continue

        try:
            result = _detect_and_capture_calibration(
                camera_index,
                include_inner_points=include_inner_points,
                timeout_s=2.0,
            )
            result["role"] = camera_slot_role(camera_index)
            result["status"] = "captured" if result.get("captured") else "not_enough_points"
            results.append(result)
        except HTTPException as exc:
            results.append(
                {
                    "camera_index": camera_index,
                    "role": camera_slot_role(camera_index),
                    "status": "error",
                    "reason": exc.detail,
                    "captured": False,
                    "enough_points": False,
                }
            )
        except Exception as exc:
            results.append(
                {
                    "camera_index": camera_index,
                    "role": camera_slot_role(camera_index),
                    "status": "error",
                    "reason": str(exc),
                    "captured": False,
                    "enough_points": False,
                }
            )

    for camera_index in range(scoring_count, len(settings.camera_indices)):
        results.append(
            {
                "camera_index": camera_index,
                "role": camera_slot_role(camera_index),
                "status": "skipped",
                "reason": "player_camera_preview_only",
                "captured": False,
                "enough_points": False,
            }
        )

    return {
        "scoring_camera_count": scoring_count,
        "camera_slot_count": len(settings.camera_indices),
        "captured_count": sum(1 for item in results if item.get("captured")),
        "results": results,
    }


def start_startup_auto_calibration(delay_s: float = 3.0) -> None:
    enabled = os.getenv("MACHINE_DARTS_AUTO_CALIBRATE_ON_STARTUP", "0").strip().lower()
    if enabled not in {"1", "true", "yes", "on"}:
        print("[calibration] startup auto-calibration disabled")
        return

    global _STARTUP_AUTO_CALIBRATION_STARTED
    with _STARTUP_AUTO_CALIBRATION_LOCK:
        if _STARTUP_AUTO_CALIBRATION_STARTED:
            return
        _STARTUP_AUTO_CALIBRATION_STARTED = True

    def _run() -> None:
        time.sleep(max(0.0, delay_s))
        try:
            result = _auto_calibrate_scoring_cameras(include_inner_points=True, only_missing=True)
            print(
                "[calibration] startup auto-calibration:",
                f"captured={result.get('captured_count')}",
                f"slots={result.get('camera_slot_count')}",
            )
        except Exception as exc:
            print(f"[calibration] startup auto-calibration failed: {exc}")

    threading.Thread(target=_run, name="startup-auto-calibration", daemon=True).start()


@router.get("/api/cameras")
def get_cameras() -> dict:
    cameras = camera_service.list_cameras()
    return {
        "cameras": [_camera_slot_payload(i) for i in range(len(cameras))],
        "devices": [
            {
                "slot": c.slot,
                "index": c.index,
                "opened": c.opened,
                "last_frame_ms": c.last_frame_ms,
                "backend": c.backend,
                "codec": c.codec,
                "width": c.width,
                "height": c.height,
                "fps": c.fps,
            }
            for c in cameras
        ],
        "mode": camera_service.mode_status(),
        "calibration_data_dir": str(settings.calibration_data_dir),
        "selected": settings.camera_indices,
        "scoring_camera_count": min(DEFAULT_SCORING_CAMERA_COUNT, len(settings.camera_indices)),
        "camera_slot_count": len(settings.camera_indices),
    }


@router.get("/api/calibration/debug/files")
def get_calibration_debug_files() -> dict:
    return _calibration_file_debug()


@router.get("/api/camera-service/status")
def get_camera_service_status() -> dict:
    return {"mode": camera_service.mode_status(), "devices": [c.__dict__ for c in camera_service.list_cameras()]}


@router.get("/api/camera/devices")
def get_camera_devices(max_devices: int = 20) -> dict:
    cameras = camera_service.list_cameras()
    max_devices = max(1, min(int(max_devices), 32))
    device_identities = enumerate_camera_device_identities(max_devices)
    devices_by_index: dict[int, dict] = {}
    selected_indices = [int(idx) for idx in settings.camera_indices]
    selected_index_set = set(selected_indices)
    player_replay_status = get_player_replay_camera_service().get_status()
    player_device_index = player_replay_status.get("camera_index")
    try:
        player_device_index = None if player_device_index is None else int(player_device_index)
    except Exception:
        player_device_index = None

    def _device_label(index: int) -> str:
        return f"OpenCV Device {int(index)}"

    def _os_identity(index: int) -> dict | None:
        return device_identities.get(int(index))

    def _open_device_probe(index: int):
        if int(index) in selected_index_set:
            return None
        if sys.platform.startswith("win"):
            try:
                return cv2.VideoCapture(
                    int(index),
                    int(cv2.CAP_DSHOW),
                    [
                        int(cv2.CAP_PROP_FOURCC),
                        int(cv2.VideoWriter_fourcc(*"MJPG")),
                        int(cv2.CAP_PROP_FRAME_WIDTH),
                        int(settings.camera_width),
                        int(cv2.CAP_PROP_FRAME_HEIGHT),
                        int(settings.camera_height),
                        int(cv2.CAP_PROP_FPS),
                        int(settings.camera_fps),
                    ],
                )
            except TypeError:
                pass
        return cv2.VideoCapture(int(index))

    for idx in range(max_devices):
        cap = _open_device_probe(idx)
        opened = bool(cap is not None and cap.isOpened())
        width = height = None
        fps = None
        if opened:
            try:
                width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or None
                height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or None
                fps_raw = float(cap.get(cv2.CAP_PROP_FPS))
                fps = round(fps_raw, 2) if fps_raw > 0 else None
            except Exception:
                pass
        if cap is not None:
            cap.release()
        devices_by_index[idx] = {
            "index": idx,
            "available": opened or int(idx) in selected_index_set,
            "status": "ready" if opened else ("in_use" if int(idx) in selected_index_set else "unavailable"),
            "width": width or settings.camera_width,
            "height": height or settings.camera_height,
            "fps": fps or settings.camera_fps,
            "backend": camera_service.backend_hint_label(),
            "label": _device_label(idx),
            "os_label": (_os_identity(idx) or {}).get("label"),
            "device_id": (_os_identity(idx) or {}).get("device_id"),
            "identity_verified": False,
        }

    for c in cameras:
        physical_index = int(c.index)
        is_player_device = player_device_index is not None and int(physical_index) == int(player_device_index)
        player_live = is_player_device and player_replay_status.get("last_frame_ms") is not None
        devices_by_index[int(c.index)] = {
            "index": physical_index,
            "available": bool(c.opened) or is_player_device,
            "status": "ready" if c.opened else ("preview" if player_live else ("in_use" if is_player_device else "unavailable")),
            "width": c.width or settings.camera_width,
            "height": c.height or settings.camera_height,
            "fps": c.fps or settings.camera_fps,
            "backend": c.backend or camera_service.backend_hint_label(),
            "label": _device_label(physical_index),
            "os_label": (_os_identity(physical_index) or {}).get("label"),
            "device_id": (_os_identity(physical_index) or {}).get("device_id"),
            "identity_verified": False,
        }
    devices = sorted(devices_by_index.values(), key=lambda d: int(d.get("index", 0)))
    return {"devices": devices, "selected": settings.camera_indices}


@router.post("/api/camera/devices/select")
def select_camera_devices(payload: dict) -> dict:
    indices = payload.get("indices") if isinstance(payload, dict) else None
    if not isinstance(indices, list):
        raise HTTPException(status_code=400, detail="indices must be an array")
    try:
        normalized = [int(idx) for idx in indices]
    except Exception:
        raise HTTPException(status_code=400, detail="indices must contain integers") from None
    if len(normalized) != len(settings.camera_indices):
        raise HTTPException(
            status_code=400,
            detail=f"Expected {len(settings.camera_indices)} camera indices for configured slots",
        )
    if any(idx < 0 for idx in normalized):
        raise HTTPException(status_code=400, detail="camera indices must be >= 0")
    if len(set(normalized)) != len(normalized):
        raise HTTPException(status_code=400, detail="camera indices must be unique")
    readiness: dict[int, bool] = {}
    player_replay_status: dict = {}
    try:
        previous_indices = [int(idx) for idx in settings.camera_indices]
        dartcounter = None
        publish_detection_event(
            {
                "type": "camera_selection_changing",
                "previous_indices": previous_indices,
                "next_indices": normalized,
            }
        )
        try:
            camera_service.begin_maintenance()
            try:
                from backend.core.detection import dartcounter

                dartcounter.request_detection_reset(reset_background=True)
            except Exception as exc:
                print(f"[WARN] Detection pre-reset before camera selection failed: {exc}")
            time.sleep(0.25)
            try:
                get_player_replay_camera_service().close()
            except Exception as exc:
                print(f"[WARN] Player Cam close before camera selection failed: {exc}")
            camera_service.reconfigure_indices(normalized)
            set_camera_indices(normalized, persist=True)
            readiness = camera_service.wait_for_configured_frames(timeout_s=3.5, scoring_only=True)
            try:
                if dartcounter is None:
                    from backend.core.detection import dartcounter

                dartcounter.request_detection_reset(reset_background=True)
                player_replay_status = get_player_replay_camera_service().configure_from_settings(
                    dartcounter.get_detection_settings()
                )
            except Exception as exc:
                print(f"[WARN] Detection reset after camera selection failed: {exc}")
                player_replay_status = get_player_replay_camera_service().get_status()
        finally:
            camera_service.end_maintenance()
        publish_detection_event(
            {
                "type": "camera_selection_applied",
                "previous_indices": previous_indices,
                "selected_indices": [int(idx) for idx in settings.camera_indices],
                "scoring_ready": {str(slot): bool(ready) for slot, ready in readiness.items()},
                "detection_reset_requested": True,
                "player_replay": player_replay_status,
            }
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to apply camera selection: {exc}") from exc
    return {
        "ok": True,
        "selected": settings.camera_indices,
        "devices": [c.__dict__ for c in camera_service.list_cameras()],
        "mode": camera_service.mode_status(),
        "scoring_ready": {str(slot): bool(ready) for slot, ready in readiness.items()},
        "player_replay": player_replay_status,
        "message": "Camera selection applied. Detection background reset requested.",
    }


@router.get("/api/camera/flip")
def get_camera_flip() -> dict:
    return {"flips": camera_flip}


@router.post("/api/camera/flip")
def set_camera_flip(payload: dict) -> dict:
    camera_index = int(payload.get("camera_index", -1))
    flipped = bool(payload.get("flipped", False))
    _validate_camera_index(camera_index)
    camera_flip[camera_index] = flipped
    return {"camera_index": camera_index, "flipped": flipped, "flips": camera_flip}


@router.get("/api/calibration/status/{camera_index}")
def get_calibration_status(camera_index: int) -> dict:
    _validate_camera_index(camera_index)
    return calibration_manager.status(camera_index)


@router.post("/api/calibration/rotate")
def rotate_calibration(request: RotationRequest) -> dict:
    _validate_scoring_camera_index(request.camera_index)
    segment = calibration_manager.rotate_next(request.camera_index)
    return {"camera_index": request.camera_index, "segment": segment}


@router.post("/api/calibration/save/{camera_index}")
def save_calibration(camera_index: int) -> dict:
    _validate_scoring_camera_index(camera_index)
    if not calibration_manager.save(camera_index):
        raise HTTPException(status_code=500, detail="Failed to save calibration")
    return {"camera_index": camera_index, "saved": True}


@router.post("/api/calibration/score")
def score_point(request: ScoreRequest) -> dict:
    _validate_scoring_camera_index(request.camera_index)
    score = calibration_manager.score(request.camera_index, request.x, request.y)
    return {"camera_index": request.camera_index, "x": request.x, "y": request.y, "score": score}


@router.post("/api/calibration/detect/{camera_index}")
def detect_calibration_points(camera_index: int, include_inner_points: bool = True) -> dict:
    _validate_scoring_camera_index(camera_index)
    return _detect_and_capture_calibration(camera_index, include_inner_points=include_inner_points)


@router.post("/api/calibration/auto")
def auto_calibrate_scoring_cameras(include_inner_points: bool = True, only_missing: bool = False) -> dict:
    return _auto_calibrate_scoring_cameras(include_inner_points=include_inner_points, only_missing=only_missing)


@router.websocket("/ws/camera/{camera_index}")
async def ws_camera(websocket: WebSocket, camera_index: int) -> None:
    if camera_index < 0 or camera_index >= len(settings.camera_indices):
        await websocket.close(code=1008, reason="Unknown camera slot")
        return
    await websocket.accept()
    view = str(websocket.query_params.get("view", "overlay")).strip().lower()
    _register_ws_camera_client(camera_index)
    try:
        while True:
            frame_interval = 1.0 / _effective_ws_camera_fps(camera_index, view)
            start = time.perf_counter()
            if not is_scoring_camera_slot(camera_index):
                payload = get_player_replay_camera_service().get_latest_jpeg_bytes()
                if payload:
                    await websocket.send_bytes(payload)
                elapsed = time.perf_counter() - start
                await asyncio.sleep(max(0.0, frame_interval - elapsed))
                continue

            frame = camera_service.wait_for_frame(camera_index, timeout_s=0.5)
            if frame is not None:
                if view == "fronton":
                    frame = calibration_manager.fronton(camera_index, frame)
                elif view == "raw":
                    pass
                else:
                    frame = calibration_manager.overlay(camera_index, frame)
                payload = calibration_manager.encode_jpeg(frame, quality=settings.jpeg_quality)
                if payload:
                    await websocket.send_bytes(payload)
            elapsed = time.perf_counter() - start
            await asyncio.sleep(max(0.0, frame_interval - elapsed))
    except WebSocketDisconnect:
        return
    finally:
        _unregister_ws_camera_client(camera_index)


@router.websocket("/ws/events")
async def ws_events(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        while True:
            statuses = [calibration_manager.status(i) for i in range(len(settings.camera_indices))]
            await websocket.send_json(
                {
                    "type": "calibration_status",
                    "at_ms": int(time.time() * 1000),
                    "cameras": statuses,
                }
            )
            await asyncio.sleep(1.0)
    except WebSocketDisconnect:
        return


@router.websocket("/ws/calibration/status")
async def ws_calibration_status(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        while True:
            statuses = [calibration_manager.status(i) for i in range(len(settings.camera_indices))]
            await websocket.send_json({"calibration_statuses": statuses})
            await asyncio.sleep(1.0)
    except WebSocketDisconnect:
        return


@router.get("/api/version/current")
def get_version_current() -> dict:
    return {"version": "0.1.0-dev"}


@router.get("/api/detection/status")
def get_detection_status() -> dict:
    devices = camera_service.list_cameras()
    now_ms = int(time.time() * 1000)
    camera_details = []
    for d in devices:
        last_frame_ms = int(d.last_frame_ms) if d.last_frame_ms is not None else None
        frame_age_ms = (now_ms - last_frame_ms) if last_frame_ms is not None else None
        is_scoring = is_scoring_camera_slot(int(d.slot))
        has_recent_frame = frame_age_ms is not None and frame_age_ms <= 5000
        looks_black = d.frame_mean is not None and d.frame_mean < 3.0
        camera_details.append(
            {
                "slot": int(d.slot),
                "index": int(d.index),
                "role": camera_slot_role(int(d.slot)),
                "name": "Player Cam" if not is_scoring else f"Camera {int(d.slot) + 1}",
                "opened": bool(d.opened),
                "has_recent_frame": bool(has_recent_frame),
                "frame_age_ms": frame_age_ms,
                "frame_mean": d.frame_mean,
                "error": d.error,
                "looks_black": bool(looks_black),
                "backend": d.backend,
                "codec": d.codec,
                "width": d.width,
                "height": d.height,
                "fps": d.fps,
            }
        )
    scoring_details = [item for item in camera_details if item["role"] == "scoring"]
    opened_count = sum(1 for d in scoring_details if d.get("opened"))
    live_count = sum(1 for d in scoring_details if d.get("opened") and d.get("has_recent_frame") and not d.get("looks_black"))
    camera_errors = [str(d.get("error")) for d in scoring_details if d.get("error")]
    total_cams = sum(1 for i in range(len(settings.camera_indices)) if is_scoring_camera_slot(i))
    cameras_ready = live_count >= total_cams and total_cams > 0

    scorer_id = "opencv-line-fit"
    scorer_ready = True

    current_step = "cameras"
    if cameras_ready:
        current_step = "detection"

    is_ready = cameras_ready and scorer_ready

    return {
        "initialization": {
            "is_ready": is_ready,
            "current_step": current_step,
            "uptime_s": int(max(0, time.time() - _APP_STARTED_AT)),
            "steps": {
                "cameras": {
                    "status": "completed" if cameras_ready else ("error" if camera_errors else "in_progress"),
                    "message": (
                        camera_errors[0]
                        if camera_errors
                        else f"{live_count}/{total_cams} scoring cameras live ({opened_count} opened)"
                    ),
                },
                "scorer": {
                    "status": "completed" if scorer_ready else "pending",
                    "message": f"OpenCV scorer active ({scorer_id})",
                },
                "models": {
                    "status": "completed",
                    "message": f"AI models disabled; OpenCV scorer active ({scorer_id})",
                },
                "detection": {
                    "status": "completed" if is_ready else "pending",
                    "message": "Detection ready" if is_ready else "Waiting for cameras",
                },
            },
            "error": None,
            "diagnostics": {
                "camera_indices": [int(idx) for idx in settings.camera_indices],
                "scoring_camera_count": int(total_cams),
                "camera_backend_hint": camera_service.backend_hint_label(),
                "cameras": camera_details,
            },
        }
    }


@router.get("/api/initialization/status")
def get_initialization_status() -> dict:
    detection_status = get_detection_status()
    initialization = dict(detection_status.get("initialization", {}))
    steps = dict(initialization.get("steps", {}))

    cameras_step = steps.get("cameras", {"status": "pending", "message": "Waiting for cameras"})
    scorer_step = steps.get("scorer", {"status": "completed", "message": "OpenCV scorer active"})
    models_step = steps.get("models", {"status": "completed", "message": "AI models disabled; OpenCV scorer active"})
    detection_step = steps.get("detection", {"status": "pending", "message": "Waiting for detection"})

    calibration_ready = False
    for i in range(len(settings.camera_indices)):
        if not is_scoring_camera_slot(i):
            continue
        status = calibration_manager.status(i)
        if bool(status.get("is_calibrated", status.get("calibrated", False))):
            calibration_ready = True
            break
    steps["calibration"] = {
        "status": "completed" if calibration_ready else ("in_progress" if cameras_step.get("status") == "completed" else "pending"),
        "message": "Calibration available" if calibration_ready else "Waiting for calibration",
    }
    steps["warmup"] = {
        "status": "completed" if cameras_step.get("status") == "completed" else "pending",
        "message": "OpenCV scorer ready" if cameras_step.get("status") == "completed" else "Waiting for cameras",
    }
    steps["services"] = {
        "status": "completed" if cameras_step.get("status") == "completed" else "pending",
        "message": "Core services ready" if cameras_step.get("status") == "completed" else "Waiting for services",
    }

    initialization["steps"] = {
        "cameras": cameras_step,
        "calibration": steps["calibration"],
        "models": models_step,
        "scorer": scorer_step,
        "warmup": steps["warmup"],
        "services": steps["services"],
        "detection": detection_step,
    }
    return initialization


def _system_status_snapshot() -> dict:
    from backend.core.detection import dartcounter

    return {
        "initialization": get_initialization_status(),
        "detection_status": get_detection_status(),
        "insights": dartcounter.get_detection_insights(),
        "at_ms": int(time.time() * 1000),
    }


@router.websocket("/ws/system/status")
async def ws_system_status(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        while True:
            await websocket.send_json(_system_status_snapshot())
            await asyncio.sleep(2.0)
    except WebSocketDisconnect:
        return


@router.get("/api/training-data/count")
def get_training_data_count() -> dict:
    uploader = FirebaseUploader()
    return {
        "success": True,
        "counts": _count_training_images(),
        "correction_debug": uploader.count_correction_debug_packs(),
    }


@router.post("/api/training-data/upload")
def upload_training_data() -> dict:
    uploader = FirebaseUploader()
    training_result = uploader.upload_and_clean()
    correction_debug_result = uploader.upload_correction_debug_and_clean()
    success = bool(training_result.get("success", False)) and bool(correction_debug_result.get("success", False))
    return {
        "success": success,
        "message": (
            f"{training_result.get('message', '')}; "
            f"{correction_debug_result.get('message', '')}"
        ).strip("; "),
        "training": training_result,
        "correction_debug": correction_debug_result,
        "images_count": int(training_result.get("images_count", 0)),
        "debug_packs_count": int(correction_debug_result.get("packs_count", 0)),
        "file_size_mb": float(training_result.get("file_size_mb", 0.0))
        + float(correction_debug_result.get("file_size_mb", 0.0)),
    }


@router.get("/api/updates/check")
def updates_check() -> dict:
    return {"status": "disabled", "message": "Updater disabled in slim dev backend."}


@router.post("/api/updates/download")
def updates_download() -> dict:
    raise HTTPException(status_code=400, detail="Updater disabled")


@router.post("/api/updates/install")
def updates_install() -> dict:
    raise HTTPException(status_code=400, detail="Updater disabled")


@router.post("/api/shutdown")
def shutdown() -> dict:
    def _shutdown_process() -> None:
        try:
            camera_service.close()
        except Exception:
            pass
        time.sleep(0.25)
        os._exit(0)

    threading.Thread(target=_shutdown_process, name="backend-shutdown", daemon=True).start()
    return {"ok": True, "message": "Backend shutting down."}
