#!/usr/bin/env python3
# Slim 3-dart detector: headless, no saving, minimal deps (OpenCV + NumPy)

import cv2
import numpy as np
import os
import sys
import time
import json
import shutil
import threading
from queue import Empty, Full, Queue
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple

from backend.config.settings import DEFAULT_SCORING_CAMERA_COUNT, get_data_root, scoring_camera_indices, settings
from backend.core.camera_service import CameraService
from backend.core.system_accuracy import record_detected_dart
from backend.core.detection.dartcount_helper import (
    handle_dart_detected_side_effects,
    perform_takeout_reset_side_effects,
    process_tip_score_job,
)
from backend.core.detection_events import publish_detection_event
from backend.core.opencv_dart_scoring import OpenCvDartScoringService
from backend.core import wled

# =========================
# Basic Configuration
# =========================
def _configured_camera_indices() -> list[int]:
    return scoring_camera_indices()


RES_W, RES_H = 1280, 720        # Lower to (480,360) for weaker devices
FPS = 30                        # 20-30 is fine
PROCESS_WIDTH = 1280            # Keep OpenCV line-fit masks in calibration coordinate space
MOTION_SCALE = 4                # 1280x720 -> 320x180 movement/takeout motion checks
WARMUP_MS = 800                 # allow camera auto-exposure to settle
SKIP_EVERY_OTHER_FRAME = False  # True -> halves processing load

# Thresholds (grayscale absdiff)
MOVEMENT_THRESHOLD = 0.001
DART_DETECTION_GATE_THRESHOLD = float(
    os.getenv("MACHINE_DARTS_DART_DETECTION_GATE_THRESHOLD", "0.001")
)
SINGLE_CAM_STRONG_MOVEMENT_THRESHOLD = float(
    os.getenv("MACHINE_DARTS_SINGLE_CAM_STRONG_MOVEMENT_THRESHOLD", "0.001")
)
DIFF_THRESHOLD = 0.095
REMOVE_DARTS_START = 0.03
REMOVE_DARTS_FINISH = 0.30
DIRECT_TAKEOUT_THRESHOLD = float(
    os.getenv("MACHINE_DARTS_DIRECT_TAKEOUT_THRESHOLD", "0.80")
)
REMOVE_DARTS_MIN_FOREGROUND = int(
    max(1, int(os.getenv("MACHINE_DARTS_REMOVE_DARTS_MIN_FOREGROUND", "200")))
)
DART_DETECTION_COOLDOWN_MS = 350
TAKEOUT_POST_RESET_GUARD_MS = float(
    os.getenv("MACHINE_DARTS_TAKEOUT_POST_RESET_GUARD_MS", "0")
)
PARTIAL_TAKEOUT_TIMEOUT_MS = float(
    os.getenv("MACHINE_DARTS_PARTIAL_TAKEOUT_TIMEOUT_MS", "3000")
)
PROCESS_PRIORITY_MODE = "normal"
IDLE_WAIT_LOG_INTERVAL_S = 2.0
MIN_MOVEMENT_FRAMES_FOR_DETECT = int(max(1, int(os.getenv("MACHINE_DARTS_MIN_MOVEMENT_FRAMES_FOR_DETECT", "2"))))
STABLE_END_FRAMES_FOR_DETECT = int(max(1, int(os.getenv("MACHINE_DARTS_STABLE_END_FRAMES_FOR_DETECT", "3"))))
BEST_DIFF_FRAMES = int(max(1, min(16, int(os.getenv("MACHINE_DARTS_BEST_DIFF_FRAMES", "3")))))
BEST_DIFF_WINDOW_MS = float(max(0.0, min(1000.0, float(os.getenv("MACHINE_DARTS_BEST_DIFF_WINDOW_MS", "80")))))
BURST_MASK_MIN_HITS = int(max(1, min(8, int(os.getenv("MACHINE_DARTS_BURST_MASK_MIN_HITS", "2")))))
FINAL_MASK_DIFF_MODE = str(os.getenv("MACHINE_DARTS_FINAL_MASK_DIFF_MODE", "lab")).strip().lower()
LAB_DIFF_L_THRESHOLD = int(max(0, min(255, int(os.getenv("MACHINE_DARTS_LAB_DIFF_L_THRESHOLD", "22")))))
LAB_DIFF_AB_THRESHOLD = int(max(0, min(255, int(os.getenv("MACHINE_DARTS_LAB_DIFF_AB_THRESHOLD", "10")))))
INSIGHTS_UPDATE_INTERVAL_S = float(os.getenv("MACHINE_DARTS_INSIGHTS_UPDATE_INTERVAL_S", "0.10"))
RUNTIME_DEBUG_UPDATE_INTERVAL_S = float(os.getenv("MACHINE_DARTS_RUNTIME_DEBUG_UPDATE_INTERVAL_S", "0.20"))
PRE_TRIGGER_LOG_COOLDOWN_S = float(os.getenv("MACHINE_DARTS_PRE_TRIGGER_LOG_COOLDOWN_S", "0.25"))
SETTINGS_VERSION = 5
THRESHOLD_DEBUG_LOGS = os.getenv("MACHINE_DARTS_THRESHOLD_DEBUG", "").strip().lower() in {"1", "true", "yes", "on"}
ENABLE_RUNTIME_DEBUG_SNAPSHOTS = os.getenv("MACHINE_DARTS_ENABLE_RUNTIME_DEBUG_SNAPSHOTS", "").strip().lower() in {"1", "true", "yes", "on"}
ENABLE_STATE_CHANGE_EVENTS = os.getenv("MACHINE_DARTS_ENABLE_STATE_CHANGE_EVENTS", "1").strip().lower() in {"1", "true", "yes", "on"}
PACE_LOOP_TO_CAMERA_FPS = os.getenv("MACHINE_DARTS_PACE_LOOP_TO_CAMERA_FPS", "1").strip().lower() in {"1", "true", "yes", "on"}
DART_PEAK_FALLBACK_THRESHOLD = float(
    os.getenv("MACHINE_DARTS_DART_PEAK_FALLBACK_THRESHOLD", "0.0012")
)
DART_PEAK_FALLBACK_MULTIPLIER = float(
    os.getenv("MACHINE_DARTS_DART_PEAK_FALLBACK_MULTIPLIER", "1.4")
)
REPLAY_ENABLED = os.getenv("MACHINE_DARTS_REPLAY_ENABLED", "1").strip().lower() in {"1", "true", "yes", "on"}
REPLAY_SHOW_IN_GAME = os.getenv("MACHINE_DARTS_REPLAY_SHOW_IN_GAME", "1").strip().lower() in {"1", "true", "yes", "on"}
REPLAY_TURN_MIN_SCORE = int(max(0, min(180, int(os.getenv("MACHINE_DARTS_REPLAY_TURN_MIN_SCORE", "60")))))
REPLAY_CHECKOUT_MIN_SCORE = int(max(0, min(170, int(os.getenv("MACHINE_DARTS_REPLAY_CHECKOUT_MIN_SCORE", "100")))))
REPLAY_AUTOSAVE_ENABLED = os.getenv("MACHINE_DARTS_REPLAY_AUTOSAVE_ENABLED", "").strip().lower() in {"1", "true", "yes", "on"}
REPLAY_AUTOSAVE_DIR = str(os.getenv("MACHINE_DARTS_REPLAY_AUTOSAVE_DIR", "") or "").strip()
PLAYER_REPLAY_ENABLED = os.getenv("MACHINE_DARTS_PLAYER_REPLAY_ENABLED", "").strip().lower() in {"1", "true", "yes", "on"}
PLAYER_REPLAY_CAMERA_INDEX = int(
    max(0, int(os.getenv("MACHINE_DARTS_PLAYER_REPLAY_CAMERA_INDEX", str(DEFAULT_SCORING_CAMERA_COUNT))))
)
PLAYER_REPLAY_ROTATION = int(os.getenv("MACHINE_DARTS_PLAYER_REPLAY_ROTATION", "0") or "0")
PLAYER_REPLAY_PORTRAIT_CROP = os.getenv("MACHINE_DARTS_PLAYER_REPLAY_PORTRAIT_CROP", "").strip().lower() in {"1", "true", "yes", "on"}


def _peak_fallback_threshold() -> float:
    return max(
        float(DART_PEAK_FALLBACK_THRESHOLD),
        float(MOVEMENT_THRESHOLD) * float(DART_PEAK_FALLBACK_MULTIPLIER),
    )

def _resolve_settings_path() -> Path:
    """Return the path to detection.json, working both frozen and as a script."""
    if getattr(sys, "frozen", False):
        if os.name == "nt":
            appdata = os.getenv("APPDATA", "").strip()
            base = Path(appdata).resolve() / "DartDetector" if appdata else Path.home() / "AppData" / "Roaming" / "DartDetector"
        else:
            xdg_data_home = os.getenv("XDG_DATA_HOME", "").strip()
            base = Path(xdg_data_home).resolve() if xdg_data_home else Path.home() / ".local" / "share"
            base = base / "DartDetector"
        return base / "settings" / "detection.json"
    # Script: backend/core/detection/dartcounter.py -> parents[2] = backend/ -> data/settings/
    return Path(__file__).resolve().parents[2] / "data" / "settings" / "detection.json"

_SETTINGS_PATH = _resolve_settings_path()
_SETTINGS_LOCK = threading.Lock()
_INSIGHTS_LOCK = threading.Lock()
_RUNTIME_DEBUG_LOCK = threading.Lock()
_DETECTION_PAGE_ACTIVE_LOCK = threading.Lock()
_DETECTION_PAGE_ACTIVE = False

DEFAULT_DETECTION_SETTINGS = {
    "movement_threshold": MOVEMENT_THRESHOLD,
    "dart_detection_gate_threshold": DART_DETECTION_GATE_THRESHOLD,
    "single_cam_strong_movement_threshold": SINGLE_CAM_STRONG_MOVEMENT_THRESHOLD,
    "diff_threshold": DIFF_THRESHOLD,
    "remove_darts_start": REMOVE_DARTS_START,
    "remove_darts_finish": REMOVE_DARTS_FINISH,
    "dart_detection_cooldown_ms": DART_DETECTION_COOLDOWN_MS,
    "takeout_post_reset_guard_ms": TAKEOUT_POST_RESET_GUARD_MS,
    "partial_takeout_timeout_ms": PARTIAL_TAKEOUT_TIMEOUT_MS,
    "skip_every_other_frame": SKIP_EVERY_OTHER_FRAME,
    "process_priority_mode": "normal",
    "replay_enabled": REPLAY_ENABLED,
    "replay_show_in_game": REPLAY_SHOW_IN_GAME,
    "replay_turn_min_score": 60,
    "replay_checkout_min_score": 100,
    "replay_autosave_enabled": REPLAY_AUTOSAVE_ENABLED,
    "replay_autosave_dir": REPLAY_AUTOSAVE_DIR,
    "player_replay_enabled": PLAYER_REPLAY_ENABLED,
    "player_replay_camera_index": PLAYER_REPLAY_CAMERA_INDEX,
    "player_replay_rotation": PLAYER_REPLAY_ROTATION,
    "player_replay_portrait_crop": PLAYER_REPLAY_PORTRAIT_CROP,
}

_DETECTION_INSIGHTS = {
    "result_of_last_detection": "-",
    "current_state": "init",
    "color_change_value": None,
    "live_motion_value": None,
    "start_detect_dart_value": None,
    "start_remove_darts_value": None,
    "finish_remove_darts_value": None,
    "process_images_duration_ms": None,
    "movement_duration_ms": None,
    "darts_on_board": 0,
    "detection_counter": 0,
    "fps": None,
    "last_voted_score": None,
    "last_votes": None,
    "last_miss_reason": None,
    "last_tip_scoring_ms": None,
    "last_tip_preprocess_ms": None,
    "last_tip_inference_ms": None,
    "last_tip_decode_ms": None,
    "last_tip_selection_ms": None,
    "last_tip_calibration_ms": None,
    "last_tip_vote_ms": None,
    "last_tip_total_ms": None,
}

_RUNTIME_DEBUG = {
    "state": "init",
    "darts_on_board": 0,
    "last_frame_imgs": [],
    "before_movement_imgs": [],
    "empty_imgs": [],
    # Full-resolution (raw) versions of the above for fronton view (homography needs original res)
    "raw_last_frame_imgs": [],
    "raw_before_movement_imgs": [],
    "raw_empty_imgs": [],
    "updated_at_ms": None,
}

# Frozen per-camera frames captured at the moment of dart detection.
# Only updated when a dart lands or darts are removed - never during idle live loop.
_DETECTION_FRAME_SNAPSHOT: list = []
_DETECTION_FRAME_LOCK = threading.Lock()
_ROUND_DART_HISTORY: list[dict] = []
_PREVIOUS_ROUND_DART_HISTORY: list[dict] = []
_ROUND_DART_HISTORY_LOCK = threading.Lock()
_ROUND_DART_SESSION_ID = 1
_RESET_REQUEST_LOCK = threading.Lock()
_RESET_REQUEST: dict[str, bool] = {"background": False}
_MANUAL_DART_SYNC_REQUEST_LOCK = threading.Lock()
_MANUAL_DART_SYNC_REQUEST: dict[str, int | None] = {"darts_on_board": None}


def _resolve_correction_temp_dir() -> Path:
    if getattr(sys, "frozen", False):
        return get_data_root() / "correction_temp"
    return Path(__file__).resolve().parents[2] / "data" / "correction_temp"


def _resolve_regression_debug_dir() -> Path:
    if getattr(sys, "frozen", False):
        return get_data_root() / "regression_debug"
    return Path(__file__).resolve().parents[2] / "data" / "regression_debug"


def _resolve_calibration_data_dir() -> Path:
    if getattr(sys, "frozen", False):
        return get_data_root() / "calibration"
    return Path(__file__).resolve().parents[2] / "data" / "calibration"


def _copy_regression_calibration_snapshot(pack_dir: Path) -> dict:
    source = _resolve_calibration_data_dir()
    target = pack_dir / "calibration"
    summary = {
        "source_dir": str(source),
        "target_dir": str(target),
        "exists": bool(source.exists()),
        "copied_files": 0,
        "cameras": [],
    }
    try:
        target.mkdir(parents=True, exist_ok=True)
        for camera_dir in sorted(source.glob("camera_*")) if source.exists() else []:
            if not camera_dir.is_dir():
                continue
            target_camera = target / camera_dir.name
            target_camera.mkdir(parents=True, exist_ok=True)
            files = []
            for filename in ("dartboard_calibration.json", "dartboard_calibration.npz"):
                src = camera_dir / filename
                if src.exists():
                    shutil.copy2(src, target_camera / filename)
                    files.append(filename)
                    summary["copied_files"] += 1
            summary["cameras"].append({"camera_dir": camera_dir.name, "files": files})
    except Exception as exc:
        summary["error"] = str(exc)
        print(f"[WARN] Failed copying regression calibration snapshot: {exc}")
    return summary


def _clear_correction_temp_round(round_session_id: int) -> None:
    root = _resolve_correction_temp_dir() / f"round_{int(round_session_id)}"
    try:
        if root.exists():
            shutil.rmtree(root)
    except Exception as exc:
        print(f"[WARN] Failed clearing correction temp data {root}: {exc}")


def _prune_regression_debug_packs(max_packs: int = 500) -> None:
    try:
        root = _resolve_regression_debug_dir() / "correct"
        if not root.exists():
            return
        packs = sorted(
            [p for p in root.glob("dart_*") if p.is_dir()],
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        for old in packs[int(max_packs) :]:
            shutil.rmtree(old, ignore_errors=True)
    except Exception as exc:
        print(f"[WARN] Failed pruning regression debug packs: {exc}")


def _promote_correct_round_dart_packs(round_session_id: int, entries: list[dict]) -> None:
    """Persist non-corrected temp packs as the regression set before cleanup."""
    try:
        root = _resolve_regression_debug_dir() / "correct"
        root.mkdir(parents=True, exist_ok=True)
        for entry in entries:
            if bool(entry.get("corrected")):
                continue
            temp_debug_dir_raw = str(entry.get("temp_debug_dir", "") or "").strip()
            temp_debug_dir = Path(temp_debug_dir_raw) if temp_debug_dir_raw else None
            if temp_debug_dir is None or not temp_debug_dir.exists() or not temp_debug_dir.is_dir():
                continue
            dart_index = int(entry.get("dart_index", 0) or 0)
            ts_ms = int(entry.get("ts_ms", int(time.time() * 1000)) or int(time.time() * 1000))
            target = root / f"dart_{dart_index}_{ts_ms}"
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(temp_debug_dir, target)
            metadata_path = target / "metadata.json"
            try:
                metadata = json.loads(metadata_path.read_text(encoding="utf-8")) if metadata_path.exists() else {}
            except Exception:
                metadata = {}
            metadata_text = json.dumps(metadata, default=str).replace(str(temp_debug_dir), str(target))
            try:
                metadata = json.loads(metadata_text)
            except Exception:
                metadata = {}
            metadata.update(
                {
                    "kind": "score_regression_correct",
                    "saved_at_ms": int(time.time() * 1000),
                    "round_session_id": int(round_session_id),
                    "dart_index": int(dart_index),
                    "assumed_correct": True,
                    "original_score_value": int(entry.get("voted_score_value", 0) or 0),
                    "original_score": entry.get("voted_score") or metadata.get("original_score", {}),
                    "promoted_from_temp": str(temp_debug_dir),
                    "calibration_snapshot": _copy_regression_calibration_snapshot(target),
                }
            )
            metadata_path.write_text(json.dumps(metadata, indent=2, default=str), encoding="utf-8")
        _prune_regression_debug_packs()
    except Exception as exc:
        print(f"[WARN] Failed promoting correct regression packs: {exc}")


def _write_temp_round_dart_pack(entry: dict) -> str | None:
    try:
        round_session_id = int(entry.get("round_session_id", 0) or 0)
        dart_index = int(entry.get("dart_index", 0) or 0)
        ts_ms = int(entry.get("ts_ms", int(time.time() * 1000)) or int(time.time() * 1000))
        if round_session_id <= 0 or dart_index <= 0:
            return None
        root = _resolve_correction_temp_dir() / f"round_{round_session_id}"
        pack_dir = root / f"dart_{dart_index}"
        if pack_dir.exists():
            shutil.rmtree(pack_dir)
        frames_dir = pack_dir / "frames"
        masks_dir = pack_dir / "masks"
        frames_dir.mkdir(parents=True, exist_ok=True)
        masks_dir.mkdir(parents=True, exist_ok=True)

        saved_frames: list[dict] = []
        for cam_idx, frame in enumerate(entry.get("frames", []) or []):
            if frame is None or not isinstance(frame, np.ndarray):
                continue
            path = frames_dir / f"cam{cam_idx + 1}_detected.png"
            cv2.imwrite(str(path), frame)
            saved_frames.append({"camera_index": int(cam_idx), "kind": "detected", "path": str(path)})

        for cam_idx, frame in enumerate(entry.get("background_frames", []) or []):
            if frame is None or not isinstance(frame, np.ndarray):
                continue
            path = frames_dir / f"cam{cam_idx + 1}_background.png"
            cv2.imwrite(str(path), frame)
            saved_frames.append({"camera_index": int(cam_idx), "kind": "background", "path": str(path)})

        saved_burst_frames: list[dict] = []
        burst_dir = pack_dir / "burst_frames"
        for burst_i, burst_frames in enumerate(entry.get("burst_frames", []) or []):
            if not isinstance(burst_frames, (list, tuple)):
                continue
            burst_dir.mkdir(parents=True, exist_ok=True)
            for cam_idx, frame in enumerate(burst_frames):
                if frame is None or not isinstance(frame, np.ndarray):
                    continue
                path = burst_dir / f"burst_{burst_i + 1:02d}_cam{cam_idx + 1}.png"
                cv2.imwrite(str(path), frame)
                saved_burst_frames.append(
                    {
                        "burst_index": int(burst_i),
                        "camera_index": int(cam_idx),
                        "kind": "post_settle_burst",
                        "path": str(path),
                    }
                )

        saved_masks: list[dict] = []
        for cam_idx, mask in enumerate(entry.get("masks", []) or []):
            if mask is None or not isinstance(mask, np.ndarray):
                continue
            full_path = masks_dir / f"cam{cam_idx + 1}_mask_codes.png"
            new_path = masks_dir / f"cam{cam_idx + 1}_new_mask.png"
            cv2.imwrite(str(full_path), mask.astype(np.uint8))
            cv2.imwrite(str(new_path), (mask == CODE_NEW).astype(np.uint8) * 255)
            saved_masks.append(
                {
                    "camera_index": int(cam_idx),
                    "mask_codes": str(full_path),
                    "new_mask": str(new_path),
                    "pixels_any": int(np.count_nonzero(mask > 0)),
                    "pixels_new": int(np.count_nonzero(mask == CODE_NEW)),
                    "pixels_old": int(np.count_nonzero(mask == CODE_OLD)),
                }
            )

        metadata = {
            "kind": "score_correction_temp",
            "saved_at_ms": ts_ms,
            "round_session_id": round_session_id,
            "dart_index": dart_index,
            "active_model_id": str(entry.get("active_model_id", "") or "unknown"),
            "original_score_value": int(entry.get("voted_score_value", 0) or 0),
            "original_score": entry.get("voted_score") or {},
            "votes": int(entry.get("votes", 0) or 0),
            "candidates": entry.get("candidates", []) or [],
            "opencv_result": entry.get("opencv_result", {}) or {},
            "scoring_timings": entry.get("scoring_timings", {}) or {},
            "processing_ms": float(entry.get("processing_ms", 0.0) or 0.0),
            "total_ms": float(entry.get("total_ms", 0.0) or 0.0),
            "miss_reason": entry.get("miss_reason"),
            "detected_ts_ms": ts_ms,
            "frames": saved_frames,
            "burst_frames": saved_burst_frames,
            "masks": saved_masks,
        }
        (pack_dir / "metadata.json").write_text(json.dumps(metadata, indent=2, default=str), encoding="utf-8")
        return str(pack_dir)
    except Exception as exc:
        print(f"[WARN] Failed writing correction temp dart pack: {exc}")
        return None


def _save_settings_to_disk(current: dict) -> None:
    _SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {"version": SETTINGS_VERSION, "detection": current}
    _SETTINGS_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _as_bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return False


def _apply_settings(values: dict) -> None:
    global MOVEMENT_THRESHOLD, DART_DETECTION_GATE_THRESHOLD, SINGLE_CAM_STRONG_MOVEMENT_THRESHOLD, DIFF_THRESHOLD, REMOVE_DARTS_START, REMOVE_DARTS_FINISH
    global DART_DETECTION_COOLDOWN_MS, TAKEOUT_POST_RESET_GUARD_MS, PARTIAL_TAKEOUT_TIMEOUT_MS, SKIP_EVERY_OTHER_FRAME, PROCESS_PRIORITY_MODE
    global REPLAY_TURN_MIN_SCORE, REPLAY_CHECKOUT_MIN_SCORE, REPLAY_AUTOSAVE_ENABLED, REPLAY_AUTOSAVE_DIR
    global REPLAY_ENABLED, REPLAY_SHOW_IN_GAME
    global PLAYER_REPLAY_ENABLED, PLAYER_REPLAY_CAMERA_INDEX, PLAYER_REPLAY_ROTATION, PLAYER_REPLAY_PORTRAIT_CROP
    MOVEMENT_THRESHOLD = float(values["movement_threshold"])
    DART_DETECTION_GATE_THRESHOLD = float(values["dart_detection_gate_threshold"])
    SINGLE_CAM_STRONG_MOVEMENT_THRESHOLD = float(values["single_cam_strong_movement_threshold"])
    DIFF_THRESHOLD = float(values["diff_threshold"])
    REMOVE_DARTS_START = float(values["remove_darts_start"])
    REMOVE_DARTS_FINISH = float(values["remove_darts_finish"])
    DART_DETECTION_COOLDOWN_MS = int(values["dart_detection_cooldown_ms"])
    TAKEOUT_POST_RESET_GUARD_MS = float(values["takeout_post_reset_guard_ms"])
    PARTIAL_TAKEOUT_TIMEOUT_MS = float(values["partial_takeout_timeout_ms"])
    SKIP_EVERY_OTHER_FRAME = _as_bool(values["skip_every_other_frame"])
    PROCESS_PRIORITY_MODE = str(values.get("process_priority_mode", "normal"))
    REPLAY_ENABLED = _as_bool(values.get("replay_enabled", True))
    REPLAY_SHOW_IN_GAME = _as_bool(values.get("replay_show_in_game", True))
    REPLAY_TURN_MIN_SCORE = int(max(0, min(180, int(values.get("replay_turn_min_score", 60)))))
    REPLAY_CHECKOUT_MIN_SCORE = int(max(0, min(170, int(values.get("replay_checkout_min_score", 100)))))
    REPLAY_AUTOSAVE_ENABLED = _as_bool(values.get("replay_autosave_enabled", False))
    REPLAY_AUTOSAVE_DIR = str(values.get("replay_autosave_dir", "") or "").strip()
    PLAYER_REPLAY_ENABLED = _as_bool(values.get("player_replay_enabled", False))
    PLAYER_REPLAY_CAMERA_INDEX = max(0, int(values.get("player_replay_camera_index", DEFAULT_SCORING_CAMERA_COUNT)))
    PLAYER_REPLAY_ROTATION = _normalize_player_replay_rotation(values.get("player_replay_rotation", 0))
    PLAYER_REPLAY_PORTRAIT_CROP = _as_bool(values.get("player_replay_portrait_crop", False))


def _normalize_player_replay_rotation(value) -> int:
    try:
        rotation = int(value)
    except Exception:
        rotation = 0
    rotation = rotation % 360
    return rotation if rotation in {0, 90, 180, 270} else 0


def _migrate_detection_settings(values: dict, loaded_version: int) -> tuple[dict, bool]:
    migrated = dict(values)
    changed = False
    if int(loaded_version) < 2:
        # Keep migration conservative: only force expensive frame-skip off.
        if _as_bool(migrated.get("skip_every_other_frame", False)):
            migrated["skip_every_other_frame"] = False
            changed = True
    if int(loaded_version) < 3:
        # Move back toward detector defaults.
        try:
            diff_v = float(migrated.get("diff_threshold", DIFF_THRESHOLD))
            if abs(diff_v - 0.20) < 1e-9:
                migrated["diff_threshold"] = 0.15
                changed = True
        except Exception:
            pass
        try:
            remove_start_v = float(migrated.get("remove_darts_start", REMOVE_DARTS_START))
            if abs(remove_start_v - 0.02) < 1e-9:
                migrated["remove_darts_start"] = 0.03
                changed = True
        except Exception:
            pass
        try:
            remove_finish_v = float(migrated.get("remove_darts_finish", REMOVE_DARTS_FINISH))
            if abs(remove_finish_v - 0.20) < 1e-9:
                migrated["remove_darts_finish"] = 0.30
                changed = True
        except Exception:
            pass
        try:
            cooldown_v = int(migrated.get("dart_detection_cooldown_ms", DART_DETECTION_COOLDOWN_MS))
            if cooldown_v >= 500:
                migrated["dart_detection_cooldown_ms"] = 350
                changed = True
        except Exception:
            pass
        try:
            guard_v = float(migrated.get("takeout_post_reset_guard_ms", TAKEOUT_POST_RESET_GUARD_MS))
            if guard_v >= 900.0:
                migrated["takeout_post_reset_guard_ms"] = 0.0
                changed = True
        except Exception:
            pass
    if "process_priority_mode" not in migrated:
        migrated["process_priority_mode"] = "normal"
        changed = True
    if "dart_detection_gate_threshold" not in migrated:
        migrated["dart_detection_gate_threshold"] = float(migrated.get("movement_threshold", MOVEMENT_THRESHOLD))
        changed = True
    if "player_replay_enabled" not in migrated:
        migrated["player_replay_enabled"] = PLAYER_REPLAY_ENABLED
        changed = True
    if "player_replay_camera_index" not in migrated:
        migrated["player_replay_camera_index"] = PLAYER_REPLAY_CAMERA_INDEX
        changed = True
    if "player_replay_rotation" not in migrated:
        migrated["player_replay_rotation"] = PLAYER_REPLAY_ROTATION
        changed = True
    if "player_replay_portrait_crop" not in migrated:
        migrated["player_replay_portrait_crop"] = PLAYER_REPLAY_PORTRAIT_CROP
        changed = True
    return migrated, changed


def get_detection_settings() -> dict:
    with _SETTINGS_LOCK:
        return {
            "movement_threshold": MOVEMENT_THRESHOLD,
            "dart_detection_gate_threshold": DART_DETECTION_GATE_THRESHOLD,
            "single_cam_strong_movement_threshold": SINGLE_CAM_STRONG_MOVEMENT_THRESHOLD,
            "diff_threshold": DIFF_THRESHOLD,
            "remove_darts_start": REMOVE_DARTS_START,
            "remove_darts_finish": REMOVE_DARTS_FINISH,
            "dart_detection_cooldown_ms": DART_DETECTION_COOLDOWN_MS,
            "takeout_post_reset_guard_ms": TAKEOUT_POST_RESET_GUARD_MS,
            "partial_takeout_timeout_ms": PARTIAL_TAKEOUT_TIMEOUT_MS,
            "skip_every_other_frame": SKIP_EVERY_OTHER_FRAME,
            "process_priority_mode": PROCESS_PRIORITY_MODE,
            "replay_enabled": bool(globals().get("REPLAY_ENABLED", True)),
            "replay_show_in_game": bool(globals().get("REPLAY_SHOW_IN_GAME", True)),
            "replay_turn_min_score": int(globals().get("REPLAY_TURN_MIN_SCORE", 60)),
            "replay_checkout_min_score": int(globals().get("REPLAY_CHECKOUT_MIN_SCORE", 100)),
            "replay_autosave_enabled": bool(globals().get("REPLAY_AUTOSAVE_ENABLED", False)),
            "replay_autosave_dir": str(globals().get("REPLAY_AUTOSAVE_DIR", "") or ""),
            "player_replay_enabled": bool(globals().get("PLAYER_REPLAY_ENABLED", False)),
            "player_replay_camera_index": int(globals().get("PLAYER_REPLAY_CAMERA_INDEX", DEFAULT_SCORING_CAMERA_COUNT)),
            "player_replay_rotation": int(globals().get("PLAYER_REPLAY_ROTATION", 0)),
            "player_replay_portrait_crop": bool(globals().get("PLAYER_REPLAY_PORTRAIT_CROP", False)),
        }


def load_detection_settings() -> dict:
    with _SETTINGS_LOCK:
        values = dict(DEFAULT_DETECTION_SETTINGS)
        loaded_version = 0
        try:
            if _SETTINGS_PATH.exists():
                payload = json.loads(_SETTINGS_PATH.read_text(encoding="utf-8-sig"))
                try:
                    loaded_version = int(payload.get("version", 0))
                except Exception:
                    loaded_version = 0
                incoming = payload.get("detection", payload)
                if isinstance(incoming, dict):
                    values.update({k: incoming[k] for k in values.keys() if k in incoming})
        except Exception:
            pass
        values, migrated = _migrate_detection_settings(values, loaded_version)
        _apply_settings(values)
        if migrated:
            try:
                _save_settings_to_disk(values)
                print(f"[settings] Migrated detection settings to v{SETTINGS_VERSION}")
            except Exception:
                pass
        return dict(values)


def update_detection_settings(new_values: dict, persist: bool = True) -> dict:
    with _SETTINGS_LOCK:
        values = {
            "movement_threshold": MOVEMENT_THRESHOLD,
            "dart_detection_gate_threshold": DART_DETECTION_GATE_THRESHOLD,
            "single_cam_strong_movement_threshold": SINGLE_CAM_STRONG_MOVEMENT_THRESHOLD,
            "diff_threshold": DIFF_THRESHOLD,
            "remove_darts_start": REMOVE_DARTS_START,
            "remove_darts_finish": REMOVE_DARTS_FINISH,
            "dart_detection_cooldown_ms": DART_DETECTION_COOLDOWN_MS,
            "takeout_post_reset_guard_ms": TAKEOUT_POST_RESET_GUARD_MS,
            "partial_takeout_timeout_ms": PARTIAL_TAKEOUT_TIMEOUT_MS,
            "skip_every_other_frame": SKIP_EVERY_OTHER_FRAME,
            "process_priority_mode": PROCESS_PRIORITY_MODE,
            "replay_enabled": bool(globals().get("REPLAY_ENABLED", True)),
            "replay_show_in_game": bool(globals().get("REPLAY_SHOW_IN_GAME", True)),
            "replay_turn_min_score": int(globals().get("REPLAY_TURN_MIN_SCORE", 60)),
            "replay_checkout_min_score": int(globals().get("REPLAY_CHECKOUT_MIN_SCORE", 100)),
            "replay_autosave_enabled": bool(globals().get("REPLAY_AUTOSAVE_ENABLED", False)),
            "replay_autosave_dir": str(globals().get("REPLAY_AUTOSAVE_DIR", "") or ""),
            "player_replay_enabled": bool(globals().get("PLAYER_REPLAY_ENABLED", False)),
            "player_replay_camera_index": int(globals().get("PLAYER_REPLAY_CAMERA_INDEX", DEFAULT_SCORING_CAMERA_COUNT)),
            "player_replay_rotation": int(globals().get("PLAYER_REPLAY_ROTATION", 0)),
            "player_replay_portrait_crop": bool(globals().get("PLAYER_REPLAY_PORTRAIT_CROP", False)),
        }
        for key in values.keys():
            if key in new_values:
                values[key] = new_values[key]

        # Basic guards to keep values sane.
        values["movement_threshold"] = max(0.00001, float(values["movement_threshold"]))
        values["dart_detection_gate_threshold"] = max(0.00001, float(values["dart_detection_gate_threshold"]))
        values["single_cam_strong_movement_threshold"] = max(
            values["movement_threshold"],
            float(values["single_cam_strong_movement_threshold"]),
        )
        values["diff_threshold"] = min(1.0, max(0.01, float(values["diff_threshold"])))
        values["remove_darts_start"] = max(0.0001, float(values["remove_darts_start"]))
        values["remove_darts_finish"] = min(1.0, max(0.01, float(values["remove_darts_finish"])))
        values["dart_detection_cooldown_ms"] = max(0, int(values["dart_detection_cooldown_ms"]))
        values["takeout_post_reset_guard_ms"] = max(0.0, float(values["takeout_post_reset_guard_ms"]))
        values["partial_takeout_timeout_ms"] = max(500.0, float(values["partial_takeout_timeout_ms"]))
        values["skip_every_other_frame"] = _as_bool(values["skip_every_other_frame"])
        values["process_priority_mode"] = "high" if str(values.get("process_priority_mode", "normal")).strip().lower() == "high" else "normal"
        values["replay_enabled"] = _as_bool(values.get("replay_enabled", True))
        values["replay_show_in_game"] = _as_bool(values.get("replay_show_in_game", True))
        values["replay_turn_min_score"] = max(0, min(180, int(values.get("replay_turn_min_score", 60))))
        values["replay_checkout_min_score"] = max(0, min(170, int(values.get("replay_checkout_min_score", 100))))
        values["replay_autosave_enabled"] = _as_bool(values.get("replay_autosave_enabled", False))
        values["replay_autosave_dir"] = str(values.get("replay_autosave_dir", "") or "").strip()
        values["player_replay_enabled"] = _as_bool(values.get("player_replay_enabled", False))
        values["player_replay_camera_index"] = max(
            0,
            int(values.get("player_replay_camera_index", DEFAULT_SCORING_CAMERA_COUNT)),
        )
        values["player_replay_rotation"] = _normalize_player_replay_rotation(values.get("player_replay_rotation", 0))
        values["player_replay_portrait_crop"] = _as_bool(values.get("player_replay_portrait_crop", False))

        _apply_settings(values)
        if persist:
            _save_settings_to_disk(values)
        return dict(values)


def reset_detection_settings() -> dict:
    return update_detection_settings(dict(DEFAULT_DETECTION_SETTINGS), persist=True)


def get_detection_insights() -> dict:
    with _INSIGHTS_LOCK:
        return dict(_DETECTION_INSIGHTS)


def _update_detection_insights(**kwargs) -> None:
    with _INSIGHTS_LOCK:
        _DETECTION_INSIGHTS.update(kwargs)


def set_detection_page_active(active: bool) -> None:
    global _DETECTION_PAGE_ACTIVE
    with _DETECTION_PAGE_ACTIVE_LOCK:
        _DETECTION_PAGE_ACTIVE = bool(active)


def is_detection_page_active() -> bool:
    with _DETECTION_PAGE_ACTIVE_LOCK:
        return bool(_DETECTION_PAGE_ACTIVE)


def _update_runtime_debug(
    state: str,
    darts_on_board: int,
    last_frame_imgs: Optional[List[Optional[np.ndarray]]],
    before_movement_imgs: Optional[List[Optional[np.ndarray]]],
    empty_imgs: Optional[List[Optional[np.ndarray]]],
    raw_last_frame_imgs: Optional[List[Optional[np.ndarray]]] = None,
    raw_before_movement_imgs: Optional[List[Optional[np.ndarray]]] = None,
    raw_empty_imgs: Optional[List[Optional[np.ndarray]]] = None,
) -> None:
    with _RUNTIME_DEBUG_LOCK:
        _RUNTIME_DEBUG["state"] = state
        _RUNTIME_DEBUG["darts_on_board"] = int(darts_on_board)
        _RUNTIME_DEBUG["last_frame_imgs"] = last_frame_imgs or []
        _RUNTIME_DEBUG["before_movement_imgs"] = before_movement_imgs or []
        _RUNTIME_DEBUG["empty_imgs"] = empty_imgs or []
        _RUNTIME_DEBUG["raw_last_frame_imgs"] = raw_last_frame_imgs or []
        _RUNTIME_DEBUG["raw_before_movement_imgs"] = raw_before_movement_imgs or []
        _RUNTIME_DEBUG["raw_empty_imgs"] = raw_empty_imgs or []
        _RUNTIME_DEBUG["updated_at_ms"] = int(time.time() * 1000)


def get_runtime_debug_snapshot(camera_index: int = 0) -> dict:
    with _RUNTIME_DEBUG_LOCK:
        last_list = _RUNTIME_DEBUG.get("last_frame_imgs") or []
        before_list = _RUNTIME_DEBUG.get("before_movement_imgs") or []
        empty_list = _RUNTIME_DEBUG.get("empty_imgs") or []
        raw_last_list = _RUNTIME_DEBUG.get("raw_last_frame_imgs") or []
        raw_before_list = _RUNTIME_DEBUG.get("raw_before_movement_imgs") or []
        raw_empty_list = _RUNTIME_DEBUG.get("raw_empty_imgs") or []

        def _pick_and_copy(items):
            if 0 <= camera_index < len(items):
                img = items[camera_index]
                if isinstance(img, np.ndarray):
                    return img.copy()
            return None

        return {
            "state": _RUNTIME_DEBUG.get("state", "init"),
            "darts_on_board": int(_RUNTIME_DEBUG.get("darts_on_board", 0)),
            "updated_at_ms": _RUNTIME_DEBUG.get("updated_at_ms"),
            "last_frame": _pick_and_copy(last_list),
            "before_movement_frame": _pick_and_copy(before_list),
            "empty_frame": _pick_and_copy(empty_list),
            # Full-resolution versions for fronton view (homography needs original resolution)
            "raw_last_frame": _pick_and_copy(raw_last_list),
            "raw_before_movement_frame": _pick_and_copy(raw_before_list),
            "raw_empty_frame": _pick_and_copy(raw_empty_list),
        }


def freeze_detection_frames(frames: list, *, frames_are_copied: bool = False) -> None:
    """Freeze per-camera frames at the moment of dart detection.
    Called from the detection loop; frames must already be copies."""
    with _DETECTION_FRAME_LOCK:
        _DETECTION_FRAME_SNAPSHOT.clear()
        if frames_are_copied:
            _DETECTION_FRAME_SNAPSHOT.extend(frames)
            return
        for f in frames:
            _DETECTION_FRAME_SNAPSHOT.append(f.copy() if isinstance(f, np.ndarray) else None)


def clear_frozen_detection_frames() -> None:
    """Clear the frozen frame snapshot on takeout so the fronton view
    falls back to the background/empty board image."""
    with _DETECTION_FRAME_LOCK:
        _DETECTION_FRAME_SNAPSHOT.clear()


def get_frozen_detection_frame(camera_index: int = 0):
    """Return the frozen frame for *camera_index* captured at last dart event.
    Returns None if no frame has been frozen yet."""
    with _DETECTION_FRAME_LOCK:
        if 0 <= camera_index < len(_DETECTION_FRAME_SNAPSHOT):
            f = _DETECTION_FRAME_SNAPSHOT[camera_index]
            if isinstance(f, np.ndarray):
                return f.copy()
    return None


def clear_round_dart_history() -> None:
    global _ROUND_DART_SESSION_ID
    with _ROUND_DART_HISTORY_LOCK:
        current_session = int(_ROUND_DART_SESSION_ID)
        current_entries = [dict(e) for e in _ROUND_DART_HISTORY]
        _PREVIOUS_ROUND_DART_HISTORY[:] = [dict(e) for e in _ROUND_DART_HISTORY]
        _ROUND_DART_HISTORY.clear()
        _ROUND_DART_SESSION_ID = int(_ROUND_DART_SESSION_ID) + 1
    _promote_correct_round_dart_packs(current_session, current_entries)
    _clear_correction_temp_round(current_session)


def get_round_dart_session_id() -> int:
    with _ROUND_DART_HISTORY_LOCK:
        return int(_ROUND_DART_SESSION_ID)


def mark_round_dart_corrected(
    dart_index: int,
    *,
    corrected_score_value: int,
    corrected_score: Optional[dict] = None,
) -> None:
    """Mark a scored dart so takeout does not also save it as assumed-correct."""
    with _ROUND_DART_HISTORY_LOCK:
        for history in (_ROUND_DART_HISTORY, _PREVIOUS_ROUND_DART_HISTORY):
            for entry in history:
                if int(entry.get("dart_index", -1)) == int(dart_index):
                    entry["corrected"] = True
                    entry["corrected_score_value"] = int(corrected_score_value)
                    entry["corrected_score"] = dict(corrected_score or {})


def request_detection_reset(*, reset_background: bool = True) -> None:
    """Request a runtime detector reset from external API handlers.

    The actual reset is applied inside the detector loop (thread-safe point).
    """
    with _RESET_REQUEST_LOCK:
        if reset_background:
            _RESET_REQUEST["background"] = True


def request_detection_dart_count_sync(darts_on_board: int) -> None:
    """Request detector dart-count sync from external game handlers.

    This lets manual score corrections/add-dart keep detector count aligned
    with authoritative backend turn state.
    """
    clamped = int(max(0, min(3, int(darts_on_board))))
    with _MANUAL_DART_SYNC_REQUEST_LOCK:
        _MANUAL_DART_SYNC_REQUEST["darts_on_board"] = clamped


def _consume_detection_reset_request() -> bool:
    with _RESET_REQUEST_LOCK:
        reset_background = bool(_RESET_REQUEST.get("background", False))
        _RESET_REQUEST["background"] = False
        return reset_background


def _consume_manual_dart_sync_request() -> int | None:
    with _MANUAL_DART_SYNC_REQUEST_LOCK:
        value = _MANUAL_DART_SYNC_REQUEST.get("darts_on_board")
        _MANUAL_DART_SYNC_REQUEST["darts_on_board"] = None
        return int(value) if value is not None else None


def record_round_dart_result(
    dart_index: int,
    active_model_id: str,
    voted_score_value: int,
    voted_score: dict,
    votes: int,
    candidates: list,
    frames: list,
    background_frames: list,
    processing_ms: float,
    total_ms: float,
    burst_frames: Optional[list] = None,
    masks: Optional[list] = None,
    opencv_result: Optional[dict] = None,
    scoring_timings: Optional[dict] = None,
    miss_reason: Optional[str] = None,
    frames_are_owned: bool = False,
    background_frames_are_owned: bool = False,
    ts_ms: Optional[int] = None,
) -> None:
    stored_frames = (
        list(frames or [])
        if frames_are_owned
        else [f.copy() if isinstance(f, np.ndarray) else None for f in (frames or [])]
    )
    stored_background_frames = (
        list(background_frames or [])
        if background_frames_are_owned
        else [f.copy() if isinstance(f, np.ndarray) else None for f in (background_frames or [])]
    )
    stored_burst_frames: list[list] = []
    for burst in burst_frames or []:
        if not isinstance(burst, (list, tuple)):
            continue
        stored_burst_frames.append(
            [f.copy() if isinstance(f, np.ndarray) else None for f in burst]
        )
    stored_masks = [m.copy() if isinstance(m, np.ndarray) else None for m in (masks or [])]
    entry = {
        "dart_index": int(dart_index),
        "round_session_id": int(get_round_dart_session_id()),
        "active_model_id": str(active_model_id or "unknown"),
        "voted_score_value": int(voted_score_value),
        "voted_score": dict(voted_score or {}),
        "votes": int(votes),
        "candidates": [dict(c) for c in (candidates or [])],
        "frames": stored_frames,
        "background_frames": stored_background_frames,
        "burst_frames": stored_burst_frames,
        "masks": stored_masks,
        "opencv_result": dict(opencv_result or {}),
        "scoring_timings": dict(scoring_timings or {}),
        "processing_ms": float(processing_ms),
        "total_ms": float(total_ms),
        "miss_reason": str(miss_reason) if miss_reason else None,
        "ts_ms": int(ts_ms if ts_ms is not None else int(time.time() * 1000)),
    }
    try:
        record_detected_dart(
            round_session_id=int(entry["round_session_id"]),
            dart_index=int(dart_index),
            score_value=int(voted_score_value),
        )
    except Exception as exc:
        print(f"[WARN] system accuracy dart count failed: {exc}")
    temp_debug_dir = _write_temp_round_dart_pack(entry)
    if temp_debug_dir:
        entry["temp_debug_dir"] = temp_debug_dir
    with _ROUND_DART_HISTORY_LOCK:
        _ROUND_DART_HISTORY[:] = [e for e in _ROUND_DART_HISTORY if int(e.get("dart_index", -1)) != int(dart_index)]
        _ROUND_DART_HISTORY.append(entry)
        _ROUND_DART_HISTORY.sort(key=lambda e: int(e.get("dart_index", 0)))
        if len(_ROUND_DART_HISTORY) > 3:
            _ROUND_DART_HISTORY[:] = _ROUND_DART_HISTORY[-3:]


def _copy_round_entry(entry: dict) -> dict:
    out = dict(entry)
    out["candidates"] = [dict(c) for c in entry.get("candidates", [])]
    out["frames"] = [f.copy() if isinstance(f, np.ndarray) else None for f in entry.get("frames", [])]
    out["background_frames"] = [
        f.copy() if isinstance(f, np.ndarray) else None for f in entry.get("background_frames", [])
    ]
    out["burst_frames"] = [
        [f.copy() if isinstance(f, np.ndarray) else None for f in burst]
        for burst in entry.get("burst_frames", [])
        if isinstance(burst, (list, tuple))
    ]
    out["masks"] = [m.copy() if isinstance(m, np.ndarray) else None for m in entry.get("masks", [])]
    out["opencv_result"] = dict(entry.get("opencv_result", {}) or {})
    out["scoring_timings"] = dict(entry.get("scoring_timings", {}) or {})
    return out


def get_round_dart_result(dart_index: int, include_previous: bool = False) -> Optional[dict]:
    with _ROUND_DART_HISTORY_LOCK:
        for entry in _ROUND_DART_HISTORY:
            if int(entry.get("dart_index", -1)) == int(dart_index):
                return _copy_round_entry(entry)
        if include_previous:
            for entry in _PREVIOUS_ROUND_DART_HISTORY:
                if int(entry.get("dart_index", -1)) == int(dart_index):
                    out = _copy_round_entry(entry)
                    out["from_previous_round_cache"] = True
                    return out
    return None


load_detection_settings()

# Internal mask codes (kept in RAM only)
# 76 marks "fresh change" (new dart this cycle), then we promote to 152 so
# those pixels don't keep counting as new on subsequent frames.
CODE_NEW = 76
CODE_OLD = 152

# =========================
# Helpers
# =========================
def resize_to_width(img, width=PROCESS_WIDTH):
    h, w = img.shape[:2]
    if w == width:
        return img
    scale = width / float(w)
    return cv2.resize(img, (width, max(1, int(round(h * scale)))), interpolation=cv2.INTER_AREA)

def fast_absdiff_gray(gray_a: np.ndarray, gray_b: np.ndarray, threshold_u8: int) -> Tuple[float, np.ndarray]:
    """Grayscale absdiff; returns (percent, bool_mask)."""
    diff = cv2.absdiff(gray_a, gray_b)
    mask = (diff > threshold_u8)
    percent = float(np.count_nonzero(mask)) / mask.size
    return percent, mask

def downscale_gray_for_motion(gray: np.ndarray, scale=MOTION_SCALE) -> np.ndarray:
    """Create the low-resolution motion frame used by the lab detector."""
    if scale <= 1:
        return gray
    h, w = gray.shape[:2]
    return cv2.resize(
        gray,
        (max(1, w // scale), max(1, h // scale)),
        interpolation=cv2.INTER_AREA,
    )

def fast_absdiff_bgr(a: np.ndarray, b: np.ndarray, threshold=DIFF_THRESHOLD) -> Tuple[float, np.ndarray]:
    """Grayscale absdiff; returns (percent, bool_mask)."""
    gray_a = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY)
    gray_b = cv2.cvtColor(b, cv2.COLOR_BGR2GRAY)
    diff = cv2.absdiff(gray_a, gray_b)
    thr = int(threshold * 255)
    mask = (diff > thr)
    percent = float(np.count_nonzero(mask)) / mask.size
    return percent, mask

def lab_diff_mask(current: np.ndarray, reference: np.ndarray) -> Tuple[float, np.ndarray]:
    """Fast Lab-channel diff mask for final dart-mask extraction."""
    current_lab = cv2.cvtColor(current, cv2.COLOR_BGR2LAB)
    reference_lab = cv2.cvtColor(reference, cv2.COLOR_BGR2LAB)
    diff = cv2.absdiff(current_lab, reference_lab)
    mask = (
        (diff[:, :, 0] > LAB_DIFF_L_THRESHOLD)
        | (diff[:, :, 1] > LAB_DIFF_AB_THRESHOLD)
        | (diff[:, :, 2] > LAB_DIFF_AB_THRESHOLD)
    )
    percent = float(np.count_nonzero(mask)) / mask.size
    return percent, mask

def sum_of_2_smallest(diff_list):
    vals = sorted([d["percent"] for d in diff_list])
    if not vals: return 0.0
    if len(vals) == 1: return vals[0]
    return vals[0] + vals[1]

def sum_of_2_largest(diff_list):
    vals = sorted([d["percent"] for d in diff_list], reverse=True)
    if not vals: return 0.0
    if len(vals) == 1: return vals[0]
    return vals[0] + vals[1]

def second_largest(values: List[float]) -> float:
    if not values:
        return 0.0
    sorted_vals = sorted(values, reverse=True)
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    return sorted_vals[1]

def set_mask_to_background(mask_u8: Optional[np.ndarray]):
    """Promote fresh pixels (76) to old (152) so diffs 'settle' after a dart."""
    if mask_u8 is not None:
        mask_u8[mask_u8 == CODE_NEW] = CODE_OLD

def build_mask_from_diff(diff_mask_bool: np.ndarray, prev_mask_u8: Optional[np.ndarray] = None) -> np.ndarray:
    """
    Build/maintain a 0/76/152 mask from current diff:
    - keep previous foreground as 152 (old)
    - stamp current new diff pixels (not already old) as 76 (new)
    """
    h, w = diff_mask_bool.shape[:2]
    out = np.zeros((h, w), dtype=np.uint8)
    if prev_mask_u8 is not None:
        prev_fg = (prev_mask_u8 == CODE_NEW) | (prev_mask_u8 == CODE_OLD)
        out[prev_fg] = CODE_OLD
    out[diff_mask_bool & (out == 0)] = CODE_NEW
    return out

def calculate_mask_ratios_and_foregrounds(diff_list, masks):
    """Overlap ratio between current diff and existing masks, per camera."""
    ratios = [0.0] * len(masks)
    mask_foregrounds = [0] * len(masks)
    for i in range(len(masks)):
        diff = diff_list[i]["mask"]
        mask = masks[i]
        if mask is None:
            continue
        mask_fg = (mask == CODE_NEW) | (mask == CODE_OLD)
        mask_foregrounds[i] = int(mask_fg.sum())
        if mask_foregrounds[i] > 0:
            common = (diff & mask_fg).sum()
            ratios[i] = float(common) / float(mask_foregrounds[i])
    return ratios, mask_foregrounds


def _capture_best_diff_frames(
    *,
    camera_service: CameraService,
    num_cams: int,
    reference_grays: list,
    reference_frames: list,
    current_frames_raw: list,
    current_frames: list,
    current_grays: list,
    diff_threshold_u8: int,
    n_frames: int = BEST_DIFF_FRAMES,
    window_ms: float = BEST_DIFF_WINDOW_MS,
) -> tuple[list, list, list, list, list]:
    """Pick the clearest post-settle dart frame and build burst diff masks.

    The app's detector already waits for stillness. This adds the useful part
    from our lab detector: sample a short burst after the settle point, use the
    clearest frame for images, and use a multi-frame mask for scoring. Pixels
    that persist across several frames repair shaft gaps; the best single frame
    preserves dark/brief shaft pixels that may not cross the hit threshold.
    """
    candidates: list[tuple[list, list, list]] = [(
        list(current_frames_raw),
        list(current_frames),
        list(current_grays),
    )]
    if n_frames > 1:
        delay_s = (window_ms / max(1, n_frames - 1)) / 1000.0
        for i in range(n_frames - 1):
            if delay_s > 0:
                time.sleep(delay_s)
            raw_frames = []
            proc_frames = []
            proc_grays = []
            for cam_i in range(num_cams):
                raw, _ = camera_service.get_latest_frame_info(cam_i, copy=True)
                if raw is None:
                    raw = current_frames_raw[cam_i]
                raw_frames.append(raw)
                resized = resize_to_width(raw, PROCESS_WIDTH)
                gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
                proc_frames.append(resized)
                proc_grays.append(gray)
            candidates.append((raw_frames, proc_frames, proc_grays))

    best_raw = list(current_frames_raw)
    best_frames = list(current_frames)
    best_grays = list(current_grays)
    best_diffs = []
    for cam_i in range(num_cams):
        ref = reference_grays[cam_i] if cam_i < len(reference_grays) else None
        ref_frame = reference_frames[cam_i] if cam_i < len(reference_frames) else None
        best_score = -1
        best_mask = None
        mask_hits = None
        for raw_frames, proc_frames, proc_grays in candidates:
            gray = proc_grays[cam_i]
            if ref is None:
                score = float(cv2.Laplacian(gray, cv2.CV_64F).var())
                mask = np.zeros_like(gray, dtype=bool)
            else:
                if FINAL_MASK_DIFF_MODE == "lab" and ref_frame is not None:
                    _p, mask = lab_diff_mask(proc_frames[cam_i], ref_frame)
                else:
                    diff = cv2.absdiff(gray, ref)
                    mask = diff > diff_threshold_u8
                score = float(np.count_nonzero(mask))
                if mask_hits is None:
                    mask_hits = np.zeros(mask.shape, dtype=np.uint8)
                mask_hits += mask.astype(np.uint8)
            if score > best_score:
                best_score = score
                best_raw[cam_i] = raw_frames[cam_i]
                best_frames[cam_i] = proc_frames[cam_i]
                best_grays[cam_i] = gray
                best_mask = mask
        if best_mask is None:
            if ref is not None and FINAL_MASK_DIFF_MODE == "lab" and ref_frame is not None:
                p, best_mask = lab_diff_mask(best_frames[cam_i], ref_frame)
            else:
                p, best_mask = fast_absdiff_gray(best_grays[cam_i], ref, diff_threshold_u8) if ref is not None else (0.0, np.zeros_like(best_grays[cam_i], dtype=bool))
            best_diffs.append({"percent": p, "mask": best_mask})
        else:
            combined_mask = best_mask
            if mask_hits is not None:
                min_hits = min(int(BURST_MASK_MIN_HITS), max(1, len(candidates)))
                persistent_mask = mask_hits >= min_hits
                combined_mask = best_mask | persistent_mask
            percent = float(np.count_nonzero(combined_mask)) / combined_mask.size
            best_diffs.append({"percent": percent, "mask": combined_mask})

    burst_raw_frames = [raw_frames for raw_frames, _proc_frames, _proc_grays in candidates]
    return best_raw, best_frames, best_grays, best_diffs, burst_raw_frames


def _handle_dart_detected(
    *,
    st: "DetectState",
    diffs: list,
    frames_raw: list,
    background_frames_raw: list,
    burst_frames_raw: list | None,
    movement_started_at: Optional[float],
    detect_capture_ms: float,
    tip_jobs: Queue,
    current_tip_session,
) -> None:
    """Delegate detection side-effects to helper; keep this module state-machine focused."""
    handle_dart_detected_side_effects(
        st=st,
        diffs=diffs,
        frames_raw=frames_raw,
        background_frames_raw=background_frames_raw,
        burst_frames_raw=burst_frames_raw,
        movement_started_at=movement_started_at,
        detect_capture_ms=detect_capture_ms,
        tip_jobs=tip_jobs,
        current_tip_session=current_tip_session,
        sum_of_2_largest=sum_of_2_largest,
        update_detection_insights=_update_detection_insights,
        freeze_detection_frames=freeze_detection_frames,
    )


def _trigger_takeout_wled() -> None:
    wled.trigger_event_async("takeout", min_interval_ms=1200)


# =========================
# State Handlers
# =========================
_LAST_COLOR_CHANGE_UPDATE = 0.0


def _log_detection_decision(
    *,
    stage: str,
    accepted: bool,
    reason: str,
    percents: List[float],
    extra: Optional[dict] = None,
) -> None:
    if not THRESHOLD_DEBUG_LOGS:
        return
    top2 = float(sum(sorted([float(p) for p in percents], reverse=True)[:2])) if percents else 0.0
    max_percent = max((float(p) for p in percents), default=0.0)
    extras = ""
    if extra:
        extras = " " + " ".join([f"{k}={v}" for k, v in extra.items()])
    print(
        f"[detect] stage={stage} accepted={accepted} reason={reason} "
        f"max={max_percent:.4f} top2={top2:.4f} "
        f"move_half_thr={(MOVEMENT_THRESHOLD / 2.0):.6f} "
        f"single_cam_strong_thr={SINGLE_CAM_STRONG_MOVEMENT_THRESHOLD:.6f} "
        f"move_thr={MOVEMENT_THRESHOLD:.6f} "
        f"percents={[round(float(p), 4) for p in percents]}{extras}"
    )


def _handle_no_movement_state(
    *,
    st: "DetectState",
    frames: list,
    frames_gray: list,
    frames_motion_gray: list,
    frames_raw: list,
    diff_threshold_u8: int,
    now_loop: float,
    threshold_log_last: float,
    raw_before_movement_imgs: list,
    raw_last_frame_imgs: list,
) -> float:
    global _LAST_COLOR_CHANGE_UPDATE
    now_ms = time.perf_counter() * 1000.0
    diffs = []
    for j in range(st.num_cams):
        p, m = fast_absdiff_gray(frames_motion_gray[j], st.before_movement_motion_grays[j], diff_threshold_u8)
        diffs.append({"percent": p, "mask": m})
    live_motion_top2 = float(sum_of_2_largest(diffs))
    color_change_sum = float(sum(float(d["percent"]) for d in diffs))
    if (now_loop - _LAST_COLOR_CHANGE_UPDATE) >= INSIGHTS_UPDATE_INTERVAL_S:
        updates = {"color_change_value": round(color_change_sum, 6)}
        if is_detection_page_active():
            updates["live_motion_value"] = round(live_motion_top2, 6)
        _update_detection_insights(**updates)
        _LAST_COLOR_CHANGE_UPDATE = now_loop
    now = time.perf_counter()
    if THRESHOLD_DEBUG_LOGS and now - threshold_log_last >= 2.0:
        percents = [float(d["percent"]) for d in diffs]
        max_percent = max(percents) if percents else 0.0
        top2 = sum_of_2_largest(diffs)
        print(
            f"[thresholds] state=no_movement max={max_percent:.4f} "
            f"top2={top2:.4f} move_thr={MOVEMENT_THRESHOLD:.6f} "
            f"single_cam_strong_thr={SINGLE_CAM_STRONG_MOVEMENT_THRESHOLD:.4f} "
            f"remove_start_thr={REMOVE_DARTS_START:.4f} remove_finish_thr={REMOVE_DARTS_FINISH:.3f} "
            f"diff_thr={DIFF_THRESHOLD:.3f} percents={[round(p,4) for p in percents]}"
        )
        threshold_log_last = now
    cond = [d["percent"] > (MOVEMENT_THRESHOLD / 2.0) for d in diffs]
    at_least_two = sum(cond) >= 2
    single_cam_strong = any(float(d["percent"]) >= SINGLE_CAM_STRONG_MOVEMENT_THRESHOLD for d in diffs)
    movement_start = at_least_two or single_cam_strong
    if movement_start:
        _log_detection_decision(
            stage="movement_start_gate",
            accepted=True,
            reason="start_condition_met",
            percents=[float(d["percent"]) for d in diffs],
            extra={
                "at_least_two": at_least_two,
                "single_cam_strong": single_cam_strong,
            },
        )
    else:
        # Log rejected start gates when there is visible motion in at least one camera.
        max_percent = max((float(d["percent"]) for d in diffs), default=0.0)
        if max_percent > (MOVEMENT_THRESHOLD / 4.0):
            _log_detection_decision(
                stage="movement_start_gate",
                accepted=False,
                reason="below_start_threshold",
                percents=[float(d["percent"]) for d in diffs],
                extra={
                    "at_least_two": at_least_two,
                    "single_cam_strong": single_cam_strong,
                },
            )
    if movement_start:
        st.movement_frame_before = [d["percent"] for d in diffs]
        st.state = "movement"
        st.movement_started_at = time.perf_counter()
        st.movement_peak_top2 = float(sum_of_2_largest(diffs))
        st.movement_peak_max = max((float(d["percent"]) for d in diffs), default=0.0)
        st.movement_frames = 1
        st.stable_end_frames = 0
        if THRESHOLD_DEBUG_LOGS:
            try:
                percents = [float(d["percent"]) for d in diffs]
                max_percent = max(percents) if percents else 0.0
                top2 = sum_of_2_largest(diffs)
                print(
                    f"[thresholds] state=movement_start max={max_percent:.4f} "
                    f"top2={top2:.4f} move_thr={MOVEMENT_THRESHOLD:.6f} "
                    f"single_cam_strong_thr={SINGLE_CAM_STRONG_MOVEMENT_THRESHOLD:.4f} "
                    f"remove_start_thr={REMOVE_DARTS_START:.4f} remove_finish_thr={REMOVE_DARTS_FINISH:.3f} "
                    f"diff_thr={DIFF_THRESHOLD:.3f} percents={[round(p,4) for p in percents]}"
                )
            except Exception:
                pass
    else:
        st.movement_peak_top2 = 0.0
        st.movement_peak_max = 0.0
        st.movement_frames = 0
        st.stable_end_frames = 0
        st.before_movement_imgs = st.last_frame_imgs
        st.last_frame_imgs = frames
        st.before_movement_grays = st.last_frame_grays
        st.last_frame_grays = frames_gray
        st.before_movement_motion_grays = st.last_frame_motion_grays
        st.last_frame_motion_grays = frames_motion_gray
        raw_before_movement_imgs[:] = list(raw_last_frame_imgs)
        raw_last_frame_imgs[:] = list(frames_raw)
    return threshold_log_last


def _handle_movement_state(
    *,
    camera_service: CameraService,
    st: "DetectState",
    frames: list,
    frames_gray: list,
    frames_motion_gray: list,
    frames_raw: list,
    diff_threshold_u8: int,
    threshold_log_last: float,
    raw_before_movement_imgs: list,
    raw_last_frame_imgs: list,
    tip_jobs: Queue,
    current_tip_session,
) -> float:
    motion_diffs = []
    full_diffs = []
    for j in range(st.num_cams):
        p, m = fast_absdiff_gray(frames_motion_gray[j], st.before_movement_motion_grays[j], diff_threshold_u8)
        motion_diffs.append({"percent": p, "mask": m})
        p_full, m_full = fast_absdiff_gray(frames_gray[j], st.before_movement_grays[j], diff_threshold_u8)
        full_diffs.append({"percent": p_full, "mask": m_full})
    st.last_frame_imgs = frames
    st.last_frame_grays = frames_gray
    st.last_frame_motion_grays = frames_motion_gray
    raw_last_frame_imgs[:] = list(frames_raw)
    percents = [float(d["percent"]) for d in motion_diffs]
    max_percent = max(percents) if percents else 0.0
    current_top2 = float(sum_of_2_largest(motion_diffs))
    st.movement_peak_top2 = max(float(st.movement_peak_top2), current_top2)
    st.movement_peak_max = max(float(st.movement_peak_max), max_percent)
    st.movement_frames = int(st.movement_frames) + 1
    remove_start_value = sum_of_2_smallest(motion_diffs)
    if is_detection_page_active():
        _update_detection_insights(
            live_motion_value=round(current_top2, 6),
            start_remove_darts_value=round(float(remove_start_value), 6),
        )
    movement_active = st.is_movement(motion_diffs)
    if movement_active:
        st.stable_end_frames = 0
    else:
        st.stable_end_frames = int(st.stable_end_frames) + 1

    if st.dart_count >= 3:
        if st.is_remove_started(motion_diffs):
            st.remove_started_value = remove_start_value
            st.takeout_armed = True
            st.state = "removing_darts"
            st.stable_end_frames = 0
            _trigger_takeout_wled()
            _update_detection_insights(
                result_of_last_detection="remove_started",
                start_remove_darts_value=round(remove_start_value, 6),
            )
        else:
            movement_ended = not movement_active
            if movement_ended and st.stable_end_frames >= STABLE_END_FRAMES_FOR_DETECT:
                st.before_movement_imgs = frames
                st.before_movement_grays = frames_gray
                st.before_movement_motion_grays = frames_motion_gray
                raw_before_movement_imgs[:] = list(frames_raw)
                if st.is_direct_takeout(full_diffs):
                    print("[INFO] Direct takeout detected - entering remove flow")
                    st.remove_started_value = remove_start_value
                    st.takeout_armed = True
                    st.state = "removing_darts"
                    st.remove_delay_start = None
                    st.stable_end_frames = 0
                    _trigger_takeout_wled()
                    _update_detection_insights(
                        result_of_last_detection="remove_started",
                        start_remove_darts_value=round(remove_start_value, 6),
                    )
                    return threshold_log_last
                st.state = "no_movement"
                st.movement_started_at = None
                st.movement_peak_top2 = 0.0
                st.movement_peak_max = 0.0
                st.movement_frames = 0
                st.stable_end_frames = 0
            elif movement_ended:
                _log_detection_decision(
                    stage="movement_end_gate",
                    accepted=False,
                    reason="waiting_for_stable_end_frames",
                    percents=percents,
                    extra={
                        "stable_end_frames": int(st.stable_end_frames),
                        "required": int(STABLE_END_FRAMES_FOR_DETECT),
                    },
                )
        return threshold_log_last
    if st.is_remove_started(motion_diffs):
        st.remove_started_value = remove_start_value
        st.takeout_armed = True
        st.state = "removing_darts"
        st.stable_end_frames = 0
        _trigger_takeout_wled()
        _update_detection_insights(
            result_of_last_detection="remove_started",
            start_remove_darts_value=round(remove_start_value, 6),
        )
        return threshold_log_last
    largest2 = sum_of_2_largest(motion_diffs)
    if is_detection_page_active():
        _update_detection_insights(start_detect_dart_value=round(float(largest2), 6))
    movement_ended = not movement_active
    if not movement_ended:
        _log_detection_decision(
            stage="movement_end_gate",
            accepted=False,
            reason="movement_still_active",
            percents=percents,
            extra={
                "stable_end_frames": int(st.stable_end_frames),
                "required": int(STABLE_END_FRAMES_FOR_DETECT),
            },
        )
        return threshold_log_last
    if st.stable_end_frames < STABLE_END_FRAMES_FOR_DETECT:
        _log_detection_decision(
            stage="movement_end_gate",
            accepted=False,
            reason="waiting_for_stable_end_frames",
            percents=percents,
            extra={
                "stable_end_frames": int(st.stable_end_frames),
                "required": int(STABLE_END_FRAMES_FOR_DETECT),
            },
        )
        return threshold_log_last
    if st.movement_frames < MIN_MOVEMENT_FRAMES_FOR_DETECT:
        _log_detection_decision(
            stage="dart_detect_gate",
            accepted=False,
            reason="insufficient_movement_frames",
            percents=percents,
            extra={
                "movement_frames": int(st.movement_frames),
                "required": int(MIN_MOVEMENT_FRAMES_FOR_DETECT),
            },
        )
        return threshold_log_last
    reference_grays = list(st.before_movement_grays or [])
    reference_raw_frames = list(raw_before_movement_imgs)
    capture_t0 = time.perf_counter()
    best_raw, best_frames, best_grays, best_diffs, burst_frames_raw = _capture_best_diff_frames(
        camera_service=camera_service,
        num_cams=st.num_cams,
        reference_grays=reference_grays,
        reference_frames=list(st.before_movement_imgs or []),
        current_frames_raw=frames_raw,
        current_frames=frames,
        current_grays=frames_gray,
        diff_threshold_u8=diff_threshold_u8,
    )
    detect_capture_ms = (time.perf_counter() - capture_t0) * 1000.0
    diffs = best_diffs
    frames = best_frames
    frames_gray = best_grays
    frames_raw = best_raw
    percents = [float(d["percent"]) for d in diffs]
    largest2 = sum_of_2_largest(motion_diffs)
    st.before_movement_imgs = frames
    st.before_movement_grays = frames_gray
    frames_motion_gray = [downscale_gray_for_motion(g) for g in frames_gray]
    st.before_movement_motion_grays = frames_motion_gray
    st.last_frame_imgs = frames
    st.last_frame_grays = frames_gray
    st.last_frame_motion_grays = frames_motion_gray
    raw_before_movement_imgs[:] = list(frames_raw)
    raw_last_frame_imgs[:] = list(frames_raw)
    if largest2 < DART_DETECTION_GATE_THRESHOLD:
        _log_detection_decision(
            stage="dart_detect_gate",
            accepted=False,
            reason="largest2_below_dart_detection_gate",
            percents=percents,
            extra={
                "largest2": round(float(largest2), 6),
                "gate": round(float(DART_DETECTION_GATE_THRESHOLD), 6),
            },
        )
        st.state = "no_movement"
        st.movement_started_at = None
        st.movement_peak_top2 = 0.0
        st.movement_peak_max = 0.0
        st.movement_frames = 0
        st.stable_end_frames = 0
        return threshold_log_last
    now_ms = time.perf_counter() * 1000.0
    if st.last_dart_detection_time is not None and (now_ms - st.last_dart_detection_time < DART_DETECTION_COOLDOWN_MS):
        _log_detection_decision(
            stage="dart_detect_gate",
            accepted=False,
            reason="cooldown_active",
            percents=percents,
            extra={
                "elapsed_ms": int(now_ms - st.last_dart_detection_time),
                "cooldown_ms": int(DART_DETECTION_COOLDOWN_MS),
            },
        )
        st.state = "no_movement"
        st.movement_started_at = None
        st.movement_peak_top2 = 0.0
        st.movement_peak_max = 0.0
        st.movement_frames = 0
        st.stable_end_frames = 0
        return threshold_log_last
    if st.dart_count >= 3:
        _log_detection_decision(
            stage="dart_detect_gate",
            accepted=False,
            reason="already_have_3_darts",
            percents=percents,
            extra={"dart_count": int(st.dart_count)},
        )
        now = time.perf_counter()
        if st.last_waiting_log_at is None or (now - st.last_waiting_log_at) >= IDLE_WAIT_LOG_INTERVAL_S:
            print("[INFO] 3 darts already - waiting for removal")
            st.last_waiting_log_at = now
        st.state = "no_movement"
        st.movement_started_at = None
        st.movement_peak_top2 = 0.0
        st.movement_peak_max = 0.0
        st.movement_frames = 0
        st.stable_end_frames = 0
        return threshold_log_last
    for j in range(st.num_cams):
        if st.masks[j] is not None:
            set_mask_to_background(st.masks[j])
    for j in range(st.num_cams):
        st.masks[j] = build_mask_from_diff(diffs[j]["mask"], st.masks[j])
    top2 = sum_of_2_largest(diffs)
    _log_detection_decision(
        stage="dart_detect_gate",
        accepted=True,
        reason="dart_detected",
        percents=percents,
        extra={"largest2": round(float(top2), 6)},
    )
    if THRESHOLD_DEBUG_LOGS:
        try:
            percents = [float(d["percent"]) for d in diffs]
            max_percent = max(percents) if percents else 0.0
            print(
                f"[thresholds] state=dart_detect max={max_percent:.4f} "
                f"top2={top2:.4f} move_thr={MOVEMENT_THRESHOLD:.6f} "
                f"diff_thr={DIFF_THRESHOLD:.3f} percents={[round(p,4) for p in percents]}"
            )
        except Exception:
            pass
    _handle_dart_detected(
        st=st,
        diffs=diffs,
        frames_raw=frames_raw,
        background_frames_raw=reference_raw_frames,
        burst_frames_raw=burst_frames_raw,
        movement_started_at=st.movement_started_at,
        detect_capture_ms=detect_capture_ms,
        tip_jobs=tip_jobs,
        current_tip_session=current_tip_session,
    )
    st.state = "no_movement"
    st.movement_started_at = None
    st.movement_peak_top2 = 0.0
    st.movement_peak_max = 0.0
    st.movement_frames = 0
    st.stable_end_frames = 0
    return threshold_log_last


def _perform_takeout_reset(
    *,
    st: "DetectState",
    frames: list,
    frames_gray: list,
    frames_raw: list,
    raw_last_frame_imgs: list,
    raw_before_movement_imgs: list,
    raw_empty_imgs: list,
    tip_scorer,
    bump_tip_session,
    clear_tip_jobs,
    publish_event: bool,
) -> None:
    perform_takeout_reset_side_effects(
        st=st,
        frames=frames,
        frames_gray=frames_gray,
        frames_raw=frames_raw,
        raw_last_frame_imgs=raw_last_frame_imgs,
        raw_before_movement_imgs=raw_before_movement_imgs,
        raw_empty_imgs=raw_empty_imgs,
        tip_scorer=tip_scorer,
        bump_tip_session=bump_tip_session,
        clear_tip_jobs=clear_tip_jobs,
        publish_event=publish_event,
        clear_frozen_detection_frames=clear_frozen_detection_frames,
        clear_round_dart_history=clear_round_dart_history,
    )


def _handle_removing_darts_state(
    *,
    st: "DetectState",
    frames: list,
    frames_gray: list,
    frames_motion_gray: list,
    frames_raw: list,
    diff_threshold_u8: int,
    raw_last_frame_imgs: list,
    raw_before_movement_imgs: list,
    raw_empty_imgs: list,
    tip_scorer,
    bump_tip_session,
    clear_tip_jobs,
) -> None:
    diffs = []
    motion_diffs = []
    for j in range(st.num_cams):
        p, m = fast_absdiff_gray(frames_gray[j], st.before_movement_grays[j], diff_threshold_u8)
        diffs.append({"percent": p, "mask": m})
        p_motion, m_motion = fast_absdiff_gray(frames_motion_gray[j], st.before_movement_motion_grays[j], diff_threshold_u8)
        motion_diffs.append({"percent": p_motion, "mask": m_motion})
    if is_detection_page_active():
        try:
            _update_detection_insights(
                start_remove_darts_value=round(float(sum_of_2_smallest(motion_diffs)), 6),
            )
        except Exception:
            pass
    # Use frame-to-frame motion during takeout so we only continue after
    # hands/arms have actually settled, not just when baseline diff plateaus.
    live_motion = False
    live_percents: list[float] = []
    if st.last_frame_motion_grays is not None:
        for j in range(st.num_cams):
            prev_g = st.last_frame_motion_grays[j] if j < len(st.last_frame_motion_grays) else None
            curr_g = frames_motion_gray[j]
            if isinstance(prev_g, np.ndarray) and isinstance(curr_g, np.ndarray):
                p_live, _ = fast_absdiff_gray(curr_g, prev_g, diff_threshold_u8)
                live_percents.append(float(p_live))
    if live_percents:
        cond = [p > (MOVEMENT_THRESHOLD / 2.0) for p in live_percents]
        at_least_two = sum(cond) >= 2
        single_cam_strong = any(p >= SINGLE_CAM_STRONG_MOVEMENT_THRESHOLD for p in live_percents)
        live_motion = at_least_two or single_cam_strong

    if live_motion:
        st.last_frame_imgs = frames
        st.last_frame_grays = frames_gray
        st.last_frame_motion_grays = frames_motion_gray
        raw_last_frame_imgs[:] = list(frames_raw)
        # Require a fresh quiet window after any visible motion.
        st.remove_delay_start = None
        return

    now_ms = time.perf_counter() * 1000.0
    if st.remove_delay_start is None:
        st.remove_delay_start = now_ms
        return
    if now_ms - st.remove_delay_start < 450:
        return

    # If we have no armed takeout context (no detected darts/masks), do not
    # stay in removing_darts. This can happen from broad scene motion.
    if (st.dart_count <= 0) and all(m is None for m in st.masks):
        print("[INFO] Takeout ignored (no darts yet)")
        _perform_takeout_reset(
            st=st,
            frames=frames,
            frames_gray=frames_gray,
            frames_raw=frames_raw,
            raw_last_frame_imgs=raw_last_frame_imgs,
            raw_before_movement_imgs=raw_before_movement_imgs,
            raw_empty_imgs=raw_empty_imgs,
            tip_scorer=tip_scorer,
            bump_tip_session=bump_tip_session,
            clear_tip_jobs=clear_tip_jobs,
            publish_event=False,
        )
        st.state = "no_movement"
        st.remove_delay_start = None
        return

    is_partial, finish_metric = st.partial_takeout_status(diffs)
    finish_metric_out = round(finish_metric, 6) if finish_metric is not None else None
    # Guard against premature "takeout_complete": require board to be close to
    # empty baseline before allowing reset/turn-advance.
    empty_diffs = []
    for j in range(st.num_cams):
        p_empty, _ = fast_absdiff_gray(frames_gray[j], st.empty_grays[j], diff_threshold_u8)
        empty_diffs.append({"percent": p_empty, "mask": None})
    empty_match_value = sum_of_2_largest(empty_diffs)
    should_wait_for_takeout = bool(st.takeout_armed) and (
        is_partial or (empty_match_value >= REMOVE_DARTS_START)
    )

    if should_wait_for_takeout:
        print("[INFO] Partial takeout - waiting")
        st.state = "partial_takeout"
        _trigger_takeout_wled()
        _update_detection_insights(
            result_of_last_detection="partial_takeout",
            start_remove_darts_value=round(st.remove_started_value or 0.0, 6),
            finish_remove_darts_value=finish_metric_out,
        )
    else:
        print("[OK] Takeout complete -> reset")
        _update_detection_insights(
            result_of_last_detection="takeout_complete",
            darts_on_board=0,
            start_remove_darts_value=round(st.remove_started_value or 0.0, 6),
            finish_remove_darts_value=finish_metric_out,
        )
        _perform_takeout_reset(
            st=st,
            frames=frames,
            frames_gray=frames_gray,
            frames_raw=frames_raw,
            raw_last_frame_imgs=raw_last_frame_imgs,
            raw_before_movement_imgs=raw_before_movement_imgs,
            raw_empty_imgs=raw_empty_imgs,
            tip_scorer=tip_scorer,
            bump_tip_session=bump_tip_session,
            clear_tip_jobs=clear_tip_jobs,
            publish_event=True,
        )
        st.state = "no_movement"
        st.partial_takeout_started_at_ms = None
    st.remove_delay_start = None


def _handle_partial_takeout_state(
    *,
    st: "DetectState",
    frames: list,
    frames_gray: list,
    frames_motion_gray: list,
    frames_raw: list,
    diff_threshold_u8: int,
    raw_last_frame_imgs: list,
    raw_before_movement_imgs: list,
    raw_empty_imgs: list,
    tip_scorer,
    bump_tip_session,
    clear_tip_jobs,
) -> None:
    if not st.takeout_armed:
        st.state = "no_movement"
        st.partial_takeout_started_at_ms = None
        return

    # Same quiet-window rule as removing_darts: only evaluate completion after
    # frame-to-frame motion settles.
    live_motion = False
    live_percents: list[float] = []
    if st.last_frame_motion_grays is not None:
        for j in range(st.num_cams):
            prev_g = st.last_frame_motion_grays[j] if j < len(st.last_frame_motion_grays) else None
            curr_g = frames_motion_gray[j]
            if isinstance(prev_g, np.ndarray) and isinstance(curr_g, np.ndarray):
                p_live, _ = fast_absdiff_gray(curr_g, prev_g, diff_threshold_u8)
                live_percents.append(float(p_live))
    if live_percents:
        cond = [p > (MOVEMENT_THRESHOLD / 2.0) for p in live_percents]
        at_least_two = sum(cond) >= 2
        single_cam_strong = any(p >= SINGLE_CAM_STRONG_MOVEMENT_THRESHOLD for p in live_percents)
        live_motion = at_least_two or single_cam_strong
    if live_motion:
        st.last_frame_imgs = frames
        st.last_frame_grays = frames_gray
        st.last_frame_motion_grays = frames_motion_gray
        raw_last_frame_imgs[:] = list(frames_raw)
        return

    # Old-style partial logic can get stuck when overlap ratios stay near zero.
    # Confirm full takeout by matching against the stored empty-board baseline.
    empty_diffs = []
    for j in range(st.num_cams):
        p_empty, _ = fast_absdiff_gray(frames_gray[j], st.empty_grays[j], diff_threshold_u8)
        empty_diffs.append({"percent": p_empty, "mask": None})
    empty_match_value = sum_of_2_largest(empty_diffs)
    if empty_match_value < REMOVE_DARTS_START:
        print("[OK] Takeout complete (empty-board match) -> reset")
        _update_detection_insights(
            result_of_last_detection="takeout_complete",
            darts_on_board=0,
            start_remove_darts_value=round(st.remove_started_value or 0.0, 6),
            finish_remove_darts_value=round(empty_match_value, 6),
        )
        _perform_takeout_reset(
            st=st,
            frames=frames,
            frames_gray=frames_gray,
            frames_raw=frames_raw,
            raw_last_frame_imgs=raw_last_frame_imgs,
            raw_before_movement_imgs=raw_before_movement_imgs,
            raw_empty_imgs=raw_empty_imgs,
            tip_scorer=tip_scorer,
            bump_tip_session=bump_tip_session,
            clear_tip_jobs=clear_tip_jobs,
            publish_event=True,
        )
        st.state = "no_movement"
        st.partial_takeout_started_at_ms = None
        return

    now_ms = time.perf_counter() * 1000.0
    if st.partial_takeout_started_at_ms is None:
        st.partial_takeout_started_at_ms = now_ms

    diffs = []
    for j in range(st.num_cams):
        p, m = fast_absdiff_gray(frames_gray[j], st.before_movement_grays[j], diff_threshold_u8)
        diffs.append({"percent": p, "mask": m})
    is_partial, finish_metric = st.partial_takeout_status(diffs)
    finish_metric_out = round(finish_metric, 6) if finish_metric is not None else None
    _update_detection_insights(finish_remove_darts_value=finish_metric_out)

    if is_partial:
        if (now_ms - float(st.partial_takeout_started_at_ms)) >= float(PARTIAL_TAKEOUT_TIMEOUT_MS):
            print(
                f"[WARN] Partial takeout timeout ({int(PARTIAL_TAKEOUT_TIMEOUT_MS)} ms) -> still waiting"
            )
            _update_detection_insights(
                result_of_last_detection="partial_takeout_timeout_waiting",
                start_remove_darts_value=round(st.remove_started_value or 0.0, 6),
                finish_remove_darts_value=finish_metric_out,
            )
            # Keep waiting instead of forcing a reset/turn-advance while hands
            # are still on board during a slow takeout.
            st.partial_takeout_started_at_ms = now_ms
        return

    print("[OK] Partial takeout finished -> reset")
    _update_detection_insights(
        result_of_last_detection="takeout_complete",
        darts_on_board=0,
        start_remove_darts_value=round(st.remove_started_value or 0.0, 6),
        finish_remove_darts_value=finish_metric_out,
    )
    _perform_takeout_reset(
        st=st,
        frames=frames,
        frames_gray=frames_gray,
        frames_raw=frames_raw,
        raw_last_frame_imgs=raw_last_frame_imgs,
        raw_before_movement_imgs=raw_before_movement_imgs,
        raw_empty_imgs=raw_empty_imgs,
        tip_scorer=tip_scorer,
        bump_tip_session=bump_tip_session,
        clear_tip_jobs=clear_tip_jobs,
        publish_event=True,
    )
    st.state = "no_movement"
    st.partial_takeout_started_at_ms = None


def _handle_external_reset(
    *,
    st: "DetectState",
    frames: list,
    frames_gray: list,
    frames_raw: list,
    raw_last_frame_imgs: list,
    raw_before_movement_imgs: list,
    raw_empty_imgs: list,
    tip_scorer,
) -> None:
    st.reset_all(frames, frames_gray)
    st.state = "no_movement"
    st.movement_started_at = None
    st.remove_delay_start = None
    st.remove_started_value = None
    st.takeout_armed = False
    st.post_reset_guard_until_ms = (time.perf_counter() * 1000.0) + max(1200.0, float(WARMUP_MS))
    raw_last_frame_imgs[:] = list(frames_raw)
    raw_before_movement_imgs[:] = list(frames_raw)
    raw_empty_imgs[:] = list(frames_raw)
    clear_frozen_detection_frames()
    tip_scorer.reset_tracks()
    _update_detection_insights(
        result_of_last_detection="external_reset",
        current_state="no_movement",
        darts_on_board=0,
    )
    print("External reset: baseline/background refreshed")


def _handle_external_dart_count_sync(*, st: "DetectState", darts_on_board: int) -> None:
    value = int(max(0, min(3, int(darts_on_board))))
    if int(st.dart_count) == value:
        return
    st.dart_count = value
    _update_detection_insights(
        result_of_last_detection="manual_dart_sync",
        darts_on_board=int(st.dart_count),
        current_state=st.state,
    )
    print(f"External manual dart sync: darts_on_board={int(st.dart_count)}")


def _handle_init_state(
    *,
    st: "DetectState",
    frames: list,
    frames_gray: list,
    frames_motion_gray: list,
    frames_raw: list,
    raw_last_frame_imgs: list,
    raw_before_movement_imgs: list,
    raw_empty_imgs: list,
) -> None:
    st.last_frame_imgs = frames
    st.before_movement_imgs = frames
    st.empty_imgs = frames
    st.last_frame_grays = frames_gray
    st.before_movement_grays = frames_gray
    st.empty_grays = frames_gray
    st.last_frame_motion_grays = frames_motion_gray
    st.before_movement_motion_grays = frames_motion_gray
    st.empty_motion_grays = frames_motion_gray
    raw_last_frame_imgs[:] = list(frames_raw)
    raw_before_movement_imgs[:] = list(frames_raw)
    raw_empty_imgs[:] = list(frames_raw)
    if st.warmed_up():
        st.state = "no_movement"

# =========================
# State
# =========================
@dataclass
class DetectState:
    num_cams: int
    state: str = "init"
    warmup_done_at: Optional[float] = None

    masks: Optional[List[Optional[np.ndarray]]] = None
    detection_counter: int = 0
    dart_count: int = 0

    before_movement_imgs: Optional[List[Optional[np.ndarray]]] = None
    last_frame_imgs: Optional[List[Optional[np.ndarray]]] = None
    empty_imgs: Optional[List[Optional[np.ndarray]]] = None
    before_movement_grays: Optional[List[Optional[np.ndarray]]] = None
    last_frame_grays: Optional[List[Optional[np.ndarray]]] = None
    empty_grays: Optional[List[Optional[np.ndarray]]] = None
    before_movement_motion_grays: Optional[List[Optional[np.ndarray]]] = None
    last_frame_motion_grays: Optional[List[Optional[np.ndarray]]] = None
    empty_motion_grays: Optional[List[Optional[np.ndarray]]] = None
    movement_frame_before: Optional[List[float]] = None

    movement_started_at: Optional[float] = None
    remove_delay_start: Optional[float] = None
    remove_started_value: Optional[float] = None
    takeout_armed: bool = False
    last_dart_detection_time: Optional[float] = None
    last_waiting_log_at: Optional[float] = None
    movement_peak_top2: float = 0.0
    movement_peak_max: float = 0.0
    movement_frames: int = 0
    stable_end_frames: int = 0
    post_reset_guard_until_ms: Optional[float] = None
    partial_takeout_started_at_ms: Optional[float] = None

    def __post_init__(self):
        self.masks = [None] * self.num_cams
        self.before_movement_imgs = [None] * self.num_cams
        self.last_frame_imgs = [None] * self.num_cams
        self.empty_imgs = [None] * self.num_cams
        self.before_movement_grays = [None] * self.num_cams
        self.last_frame_grays = [None] * self.num_cams
        self.empty_grays = [None] * self.num_cams
        self.before_movement_motion_grays = [None] * self.num_cams
        self.last_frame_motion_grays = [None] * self.num_cams
        self.empty_motion_grays = [None] * self.num_cams
        self.movement_frame_before = [0.0] * self.num_cams

    def warmed_up(self):
        now = time.perf_counter() * 1000.0
        if self.warmup_done_at is None:
            self.warmup_done_at = now + WARMUP_MS
            return False
        return now >= self.warmup_done_at

    def is_movement(self, diff_images):
        moves = [float(r["percent"]) for r in diff_images]
        no_move = [
            abs(moves[i] - self.movement_frame_before[i]) < (MOVEMENT_THRESHOLD / 2.0)
            for i in range(self.num_cams)
        ]
        if all(no_move):
            return False
        self.movement_frame_before = moves
        return True

    def is_remove_started(self, diff_images):
        required_cams = 1 if self.num_cams <= 1 else 2
        cams_over_threshold = sum(
            1 for d in diff_images if float(d["percent"]) > REMOVE_DARTS_START
        )
        return cams_over_threshold >= required_cams

    def is_direct_takeout(self, diff_images):
        if all(m is None for m in self.masks):
            return False
        ratios, mask_fgs = calculate_mask_ratios_and_foregrounds(diff_images, self.masks)
        if sum(mask_fgs) < REMOVE_DARTS_MIN_FOREGROUND:
            return False
        return sum(1 for r in ratios if r >= DIRECT_TAKEOUT_THRESHOLD) >= 2

    def is_partial_takeout(self, diff_images):
        if all(m is None for m in self.masks):
            return False
        ratios, _ = calculate_mask_ratios_and_foregrounds(diff_images, self.masks)
        return sum(1 for r in ratios if r < REMOVE_DARTS_FINISH) >= 2

    def partial_takeout_status(self, diff_images) -> Tuple[bool, Optional[float]]:
        if all(m is None for m in self.masks):
            return False, None
        ratios, _ = calculate_mask_ratios_and_foregrounds(diff_images, self.masks)
        is_partial = sum(1 for r in ratios if r < REMOVE_DARTS_FINISH) >= 2
        # Same visualization style as Dartit: second-largest overlap ratio.
        finish_metric = second_largest([float(r) for r in ratios])
        return is_partial, finish_metric

    def reset_all(self, imgs, grays):
        now_ms = time.perf_counter() * 1000.0
        self.masks = [None] * self.num_cams
        self.dart_count = 0
        self.empty_imgs = imgs
        self.before_movement_imgs = imgs
        self.last_frame_imgs = imgs
        self.empty_grays = grays
        self.before_movement_grays = grays
        self.last_frame_grays = grays
        motion_grays = [downscale_gray_for_motion(g) for g in grays]
        self.empty_motion_grays = motion_grays
        self.before_movement_motion_grays = motion_grays
        self.last_frame_motion_grays = motion_grays
        self.movement_started_at = None
        self.remove_delay_start = None
        self.remove_started_value = None
        self.takeout_armed = False
        self.last_dart_detection_time = now_ms
        self.post_reset_guard_until_ms = None
        self.movement_peak_top2 = 0.0
        self.movement_peak_max = 0.0
        self.movement_frames = 0
        self.stable_end_frames = 0
        self.partial_takeout_started_at_ms = None
        print("[RESET] masks cleared; dart count=0")

# =========================
# Main
# =========================
def main(camera_service: Optional[CameraService] = None):
    camera_indices = _configured_camera_indices()
    print("[START] Slim Dart Detector (headless)")
    print(f"   Camera slots: {list(range(len(camera_indices)))} -> indices: {camera_indices}")
    print(f"   Res: {RES_W}x{RES_H}@{FPS} | Process width: {PROCESS_WIDTH}")
    print(f"   Motion scale: {MOTION_SCALE} -> {PROCESS_WIDTH // MOTION_SCALE}x{RES_H // MOTION_SCALE}")
    print(f"   Burst mask: {BEST_DIFF_FRAMES} frames over {BEST_DIFF_WINDOW_MS:.0f} ms, min_hits={BURST_MASK_MIN_HITS}")
    print(f"   Frame skip: {SKIP_EVERY_OTHER_FRAME}")
    print(
        "   Perf mode: "
        f"runtime_debug={ENABLE_RUNTIME_DEBUG_SNAPSHOTS} "
        f"state_events={ENABLE_STATE_CHANGE_EVENTS} "
        f"pace_to_fps={PACE_LOOP_TO_CAMERA_FPS}"
    )

    owned_service = False
    if camera_service is None:
        camera_service = CameraService(indices=camera_indices)
        owned_service = True

    mode_owner = f"dartcounter:{id(camera_service)}"
    if not camera_service.acquire_mode("detection", mode_owner):
        raise RuntimeError("Camera service busy in another mode; cannot start dartcounter detection loop.")

    startup_cameras = camera_service.list_cameras()
    startup_errors = [
        f"slot {int(camera.slot)} device {int(camera.index)}: {camera.error}"
        for camera in startup_cameras
        if int(camera.slot) < len(camera_indices) and camera.error
    ]
    if startup_errors:
        message = "; ".join(startup_errors)
        print(f"[camera] Detection not started: {message}")
        _update_detection_insights(
            current_state="camera_setup_required",
            result_of_last_detection="camera_setup_required",
            last_miss_reason=message,
        )
        camera_service.release_mode(mode_owner)
        return

    st = DetectState(num_cams=len(camera_indices))
    tip_scorer = OpenCvDartScoringService()
    print("[scoring] mode=opencv-line-fit-only")
    tip_jobs: Queue = Queue(maxsize=16)
    tip_stop_event = threading.Event()
    tip_session_lock = threading.Lock()
    tip_session_id = {"value": 0}

    def current_tip_session() -> int:
        with tip_session_lock:
            return int(tip_session_id["value"])

    def bump_tip_session() -> int:
        with tip_session_lock:
            tip_session_id["value"] = int(tip_session_id["value"]) + 1
            return int(tip_session_id["value"])

    def clear_tip_jobs() -> None:
        while True:
            try:
                tip_jobs.get_nowait()
                tip_jobs.task_done()
            except Empty:
                break

    def tip_worker() -> None:
        while not tip_stop_event.is_set():
            try:
                job = tip_jobs.get(timeout=0.2)
            except Empty:
                continue
            if job is None:
                tip_jobs.task_done()
                break

            job_session = int(job.get("session", -1))
            if job_session != current_tip_session():
                tip_jobs.task_done()
                continue

            try:
                process_tip_score_job(
                    job=job,
                    current_tip_session=current_tip_session,
                    tip_scorer=tip_scorer,
                    update_detection_insights=_update_detection_insights,
                    record_round_dart_result=record_round_dart_result,
                )
            except Exception as exc:
                print(f"[WARN] Tip scoring failed: {exc}")
            finally:
                tip_jobs.task_done()

    tip_thread = threading.Thread(target=tip_worker, name="tip-scoring-worker", daemon=True)
    tip_thread.start()

    frame_i = 0
    t_fps = time.perf_counter()
    frames_counted = 0
    threshold_log_last = 0.0
    frame_interval_s = 1.0 / float(max(1, FPS))
    last_processed_ts: List[Optional[int]] = [None] * len(camera_indices)
    last_state_insights_update = 0.0
    last_perf_insights_update = 0.0
    last_runtime_debug_update = 0.0
    last_camera_config_generation = camera_service.configuration_generation()

    # Full-resolution (raw) frame mirrors for fronton view.
    # These track the same logical frames as st.last_frame_imgs / st.before_movement_imgs /
    # st.empty_imgs but at the original camera resolution so the homography transform works.
    num_cams = len(camera_indices)
    raw_last_frame_imgs: List[Optional[np.ndarray]] = [None] * num_cams
    raw_before_movement_imgs: List[Optional[np.ndarray]] = [None] * num_cams
    raw_empty_imgs: List[Optional[np.ndarray]] = [None] * num_cams
    processed_frame_ts: List[Optional[int]] = [None] * num_cams
    processed_frames: List[Optional[np.ndarray]] = [None] * num_cams
    processed_grays: List[Optional[np.ndarray]] = [None] * num_cams
    processed_motion_grays: List[Optional[np.ndarray]] = [None] * num_cams

    try:
        while True:
            loop_start = time.perf_counter()
            state_before_loop = st.state
            frame_i += 1
            if SKIP_EVERY_OTHER_FRAME and (frame_i % 2 == 1):
                time.sleep(0.001)

            if str(camera_service.mode_status().get("mode", "")) == "switching":
                _update_detection_insights(
                    current_state="camera_switching",
                    result_of_last_detection="camera_switching",
                    darts_on_board=int(st.dart_count),
                )
                time.sleep(0.05)
                continue

            # Read frames
            frames_raw = []
            frame_timestamps: List[Optional[int]] = []
            failed = []
            for j in range(num_cams):
                f, ts_ms = camera_service.get_latest_frame_info(j, copy=False)
                frames_raw.append(f)
                frame_timestamps.append(ts_ms)
                if f is None:
                    failed.append(j)

            if len(failed) == num_cams:
                print("[ERROR] All cameras failed - retrying in 2s...")
                time.sleep(2)
                continue
            elif failed:
                # pad failed cams with black frames (keep array lengths)
                h, w = RES_H, RES_W
                for f in frames_raw:
                    if f is not None:
                        h, w = f.shape[:2]
                        break
                print(f"[WARN] Camera slots {failed} failed - padding")
                for j in range(num_cams):
                    if frames_raw[j] is None:
                        frames_raw[j] = np.zeros((h, w, 3), dtype=np.uint8)
                        frame_timestamps[j] = frame_timestamps[j] or int(time.time() * 1000)

            # Skip processing if no camera has produced a newer frame yet.
            has_new_frame = any(
                frame_timestamps[j] is not None and frame_timestamps[j] != last_processed_ts[j]
                for j in range(num_cams)
            )
            if not has_new_frame:
                time.sleep(min(0.01, frame_interval_s))
                continue

            # Normalize to processing width only for cameras with a newer frame.
            frames: List[np.ndarray] = [None] * num_cams  # type: ignore[assignment]
            frames_gray: List[np.ndarray] = [None] * num_cams  # type: ignore[assignment]
            frames_motion_gray: List[np.ndarray] = [None] * num_cams  # type: ignore[assignment]
            for j in range(num_cams):
                ts_ms = frame_timestamps[j]
                cached_frame = processed_frames[j]
                cached_gray = processed_grays[j]
                cached_motion_gray = processed_motion_grays[j]
                if (
                    ts_ms is not None
                    and ts_ms == processed_frame_ts[j]
                    and cached_frame is not None
                    and cached_gray is not None
                    and cached_motion_gray is not None
                ):
                    frames[j] = cached_frame
                    frames_gray[j] = cached_gray
                    frames_motion_gray[j] = cached_motion_gray
                    continue

                resized = resize_to_width(frames_raw[j], PROCESS_WIDTH)
                gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
                motion_gray = downscale_gray_for_motion(gray)
                processed_frame_ts[j] = ts_ms
                processed_frames[j] = resized
                processed_grays[j] = gray
                processed_motion_grays[j] = motion_gray
                frames[j] = resized
                frames_gray[j] = gray
                frames_motion_gray[j] = motion_gray
            diff_threshold_u8 = int(DIFF_THRESHOLD * 255)

            current_camera_config_generation = camera_service.configuration_generation()
            if current_camera_config_generation != last_camera_config_generation:
                bump_tip_session()
                clear_tip_jobs()
                _handle_external_reset(
                    st=st,
                    frames=frames,
                    frames_gray=frames_gray,
                    frames_raw=frames_raw,
                    raw_last_frame_imgs=raw_last_frame_imgs,
                    raw_before_movement_imgs=raw_before_movement_imgs,
                    raw_empty_imgs=raw_empty_imgs,
                    tip_scorer=tip_scorer,
                )
                last_camera_config_generation = current_camera_config_generation
                processed_frame_ts = list(frame_timestamps)
                last_processed_ts = list(frame_timestamps)
                processed_frames = list(frames)
                processed_grays = list(frames_gray)
                processed_motion_grays = list(frames_motion_gray)
                _update_detection_insights(
                    current_state="no_movement",
                    result_of_last_detection="camera_reconfigured",
                    darts_on_board=0,
                )
                publish_detection_event(
                    {
                        "type": "state_changed",
                        "from_state": state_before_loop,
                        "to_state": "no_movement",
                        "darts_on_board": 0,
                        "reason": "camera_reconfigured",
                    }
                )
                time.sleep(frame_interval_s)
                continue

            # External reset request (e.g. after leaving calibration page):
            # refresh background/baseline from current live frames.
            if _consume_detection_reset_request():
                _handle_external_reset(
                    st=st,
                    frames=frames,
                    frames_gray=frames_gray,
                    frames_raw=frames_raw,
                    raw_last_frame_imgs=raw_last_frame_imgs,
                    raw_before_movement_imgs=raw_before_movement_imgs,
                    raw_empty_imgs=raw_empty_imgs,
                    tip_scorer=tip_scorer,
                )
            manual_darts_sync = _consume_manual_dart_sync_request()
            if manual_darts_sync is not None:
                _handle_external_dart_count_sync(st=st, darts_on_board=int(manual_darts_sync))

            # ===== State machine =====
            now_loop = time.perf_counter()
            if (
                st.state != state_before_loop
                or (now_loop - last_state_insights_update) >= INSIGHTS_UPDATE_INTERVAL_S
            ):
                _update_detection_insights(
                    current_state=st.state,
                    darts_on_board=int(st.dart_count),
                )
                last_state_insights_update = now_loop
            if st.state == "init":
                _handle_init_state(
                    st=st,
                    frames=frames,
                    frames_gray=frames_gray,
                    frames_motion_gray=frames_motion_gray,
                    frames_raw=frames_raw,
                    raw_last_frame_imgs=raw_last_frame_imgs,
                    raw_before_movement_imgs=raw_before_movement_imgs,
                    raw_empty_imgs=raw_empty_imgs,
                )
            elif st.state == "no_movement":
                threshold_log_last = _handle_no_movement_state(
                    st=st,
                    frames=frames,
                    frames_gray=frames_gray,
                    frames_motion_gray=frames_motion_gray,
                    frames_raw=frames_raw,
                    diff_threshold_u8=diff_threshold_u8,
                    now_loop=now_loop,
                    threshold_log_last=threshold_log_last,
                    raw_before_movement_imgs=raw_before_movement_imgs,
                    raw_last_frame_imgs=raw_last_frame_imgs,
                )

            elif st.state == "movement":
                threshold_log_last = _handle_movement_state(
                    camera_service=camera_service,
                    st=st,
                    frames=frames,
                    frames_gray=frames_gray,
                    frames_motion_gray=frames_motion_gray,
                    frames_raw=frames_raw,
                    diff_threshold_u8=diff_threshold_u8,
                    threshold_log_last=threshold_log_last,
                    raw_before_movement_imgs=raw_before_movement_imgs,
                    raw_last_frame_imgs=raw_last_frame_imgs,
                    tip_jobs=tip_jobs,
                    current_tip_session=current_tip_session,
                )

            elif st.state == "removing_darts":
                _handle_removing_darts_state(
                    st=st,
                    frames=frames,
                    frames_gray=frames_gray,
                    frames_motion_gray=frames_motion_gray,
                    frames_raw=frames_raw,
                    diff_threshold_u8=diff_threshold_u8,
                    raw_last_frame_imgs=raw_last_frame_imgs,
                    raw_before_movement_imgs=raw_before_movement_imgs,
                    raw_empty_imgs=raw_empty_imgs,
                    tip_scorer=tip_scorer,
                    bump_tip_session=bump_tip_session,
                    clear_tip_jobs=clear_tip_jobs,
                )

            elif st.state == "partial_takeout":
                _handle_partial_takeout_state(
                    st=st,
                    frames=frames,
                    frames_gray=frames_gray,
                    frames_motion_gray=frames_motion_gray,
                    frames_raw=frames_raw,
                    diff_threshold_u8=diff_threshold_u8,
                    raw_last_frame_imgs=raw_last_frame_imgs,
                    raw_before_movement_imgs=raw_before_movement_imgs,
                    raw_empty_imgs=raw_empty_imgs,
                    tip_scorer=tip_scorer,
                    bump_tip_session=bump_tip_session,
                    clear_tip_jobs=clear_tip_jobs,
                )

            # Headless: periodic heartbeat
            frames_counted += 1
            if (time.perf_counter() - t_fps) > 2.0:
                fps_now = frames_counted / (time.perf_counter() - t_fps)
                _update_detection_insights(fps=round(fps_now, 2))
                print(f"[FPS] {fps_now:.1f} | state={st.state} | darts={st.dart_count}/3")
                t_fps = time.perf_counter()
                frames_counted = 0

            if ENABLE_STATE_CHANGE_EVENTS and st.state != state_before_loop:
                publish_detection_event(
                    {
                        "type": "state_changed",
                        "from_state": state_before_loop,
                        "to_state": st.state,
                        "darts_on_board": st.dart_count,
                    }
                )
            last_processed_ts = frame_timestamps

            # Pace loop to camera FPS so reported/processed FPS stays realistic.
            elapsed = time.perf_counter() - loop_start
            if (now_loop - last_perf_insights_update) >= INSIGHTS_UPDATE_INTERVAL_S:
                _update_detection_insights(process_images_duration_ms=round(elapsed * 1000.0, 2))
                last_perf_insights_update = now_loop
            if ENABLE_RUNTIME_DEBUG_SNAPSHOTS and (
                st.state != state_before_loop
                or (now_loop - last_runtime_debug_update) >= RUNTIME_DEBUG_UPDATE_INTERVAL_S
            ):
                _update_runtime_debug(
                    state=st.state,
                    darts_on_board=st.dart_count,
                    last_frame_imgs=st.last_frame_imgs,
                    before_movement_imgs=st.before_movement_imgs,
                    empty_imgs=st.empty_imgs,
                    raw_last_frame_imgs=raw_last_frame_imgs,
                    raw_before_movement_imgs=raw_before_movement_imgs,
                    raw_empty_imgs=raw_empty_imgs,
                )
                last_runtime_debug_update = now_loop
            if PACE_LOOP_TO_CAMERA_FPS and elapsed < frame_interval_s:
                time.sleep(frame_interval_s - elapsed)

    finally:
        tip_stop_event.set()
        try:
            tip_jobs.put_nowait(None)
        except Full:
            pass
        tip_thread.join(timeout=1.0)
        camera_service.release_mode(mode_owner)
        if owned_service:
            camera_service.close()

if __name__ == "__main__":
    main()


