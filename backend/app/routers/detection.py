from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from fastapi import APIRouter, HTTPException
from fastapi import WebSocket
from fastapi import WebSocketDisconnect
from fastapi.responses import FileResponse

from backend.config.settings import get_data_root, settings
from backend.core.detection import dartcounter
from backend.core.detection_events import get_detection_events_since, get_latest_detection_seq, publish_detection_event
from backend.core.model_accuracy_stats import get_model_accuracy_stats, record_model_correction, reset_model_accuracy_stats
from backend.core.player_replay_camera import get_player_replay_camera_service
from backend.core.process_priority import apply_process_priority, get_current_process_priority_mode
from backend.core.system_accuracy import get_stats as get_system_accuracy_stats
from backend.core.system_accuracy import record_corrected_dart, reset_stats as reset_system_accuracy_stats
from backend.core.games.service import get_game_service
from backend.app.routers.calibration import calibration_manager, camera_service

router = APIRouter(tags=["detection-settings"])
_LAST_HIGHLIGHT_REPLAY: dict[str, Any] | None = None
_LAST_HIGHLIGHT_AUTOSAVE_KEY: str | None = None
_DEFAULT_REPLAY_AUTOSAVE_MAX_FILES = int(max(10, min(5000, int(os.getenv("MACHINE_DARTS_REPLAY_AUTOSAVE_MAX_FILES", "50")))))
_REPLAY_PREROLL_MS = int(max(250, min(5000, int(os.getenv("MACHINE_DARTS_PLAYER_REPLAY_PREROLL_MS", "3000")))))
_REPLAY_BOARD_INTRO_MS = int(max(500, min(5000, int(os.getenv("MACHINE_DARTS_REPLAY_BOARD_INTRO_MS", "3000")))))
_REPLAY_BOARD_SYNC_OFFSET_MS = int(max(0, min(1500, int(os.getenv("MACHINE_DARTS_REPLAY_BOARD_SYNC_OFFSET_MS", "300")))))
_REPLAY_PLAYER_FRAME_MAX_DURATION_MS = int(
    max(80, min(1000, int(os.getenv("MACHINE_DARTS_REPLAY_PLAYER_FRAME_MAX_DURATION_MS", "250"))))
)
player_replay_camera_service = get_player_replay_camera_service()
player_replay_camera_service.configure_from_settings(dartcounter.get_detection_settings())


@router.get("/api/settings/system-accuracy")
def get_system_accuracy() -> dict[str, Any]:
    return {"stats": get_system_accuracy_stats()}


@router.post("/api/settings/system-accuracy/reset")
def reset_system_accuracy() -> dict[str, Any]:
    return {"status": "ok", "stats": reset_system_accuracy_stats()}


def _pick_folder_native(initial_path: str | None = None) -> str | None:
    initial_dir = str(initial_path or "").strip()
    if sys.platform.startswith("win"):
        script = (
            "Add-Type -AssemblyName System.Windows.Forms;"
            "[System.Windows.Forms.Application]::EnableVisualStyles();"
            "$owner=New-Object System.Windows.Forms.Form;"
            "$owner.TopMost=$true;"
            "$owner.ShowInTaskbar=$false;"
            "$owner.WindowState=[System.Windows.Forms.FormWindowState]::Minimized;"
            "$null=$owner.Show();"
            "$d=New-Object System.Windows.Forms.FolderBrowserDialog;"
            "$d.Description='Select replay auto-save folder';"
            "$d.ShowNewFolderButton=$true;"
            "$i=$env:PICKER_INITIAL_DIR;"
            "if($i -and (Test-Path $i)){ $d.SelectedPath=$i };"
            "$result=$d.ShowDialog($owner);"
            "$owner.Close();"
            "if($result -eq [System.Windows.Forms.DialogResult]::OK){"
            "[Console]::Out.Write($d.SelectedPath) }"
        )
        env = os.environ.copy()
        if initial_dir:
            env["PICKER_INITIAL_DIR"] = initial_dir
        try:
            print("[replay] opening Windows folder picker...")
            proc = subprocess.run(
                ["powershell", "-NoProfile", "-STA", "-Command", script],
                capture_output=True,
                text=True,
                env=env,
                timeout=45,
                check=False,
            )
            selected = str(proc.stdout or "").strip()
            if selected:
                print(f"[replay] folder picker selected: {selected}")
            else:
                print("[replay] folder picker canceled or empty")
            return selected or None
        except subprocess.TimeoutExpired:
            print("[replay] WARN folder picker timed out")
            return None
        except Exception as exc:
            print(f"[replay] WARN folder picker failed: {exc}")
            return None

    # Fallback for non-Windows local runs.
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        selected = filedialog.askdirectory(
            initialdir=initial_dir or str(Path.home()),
            title="Select replay auto-save folder",
        )
        root.destroy()
        selected_str = str(selected or "").strip()
        return selected_str or None
    except Exception:
        return None


def _legacy_detection_event(payload: dict[str, Any]) -> dict[str, Any]:
    event_type = str(payload.get("type", ""))
    data = dict(payload)
    data.setdefault("event", event_type)

    if event_type == "dart_detected":
        data["event"] = "dart_detected"
        data.setdefault("dart_count", int(payload.get("darts_on_board", 0) or 0))
        data.setdefault("detection_state", "movement")
    elif event_type == "takeout_complete":
        data["event"] = "darts_removed"
        data["dart_count"] = 0
        data["detection_state"] = "no_movement"
    elif event_type == "state_changed":
        data["event"] = "detection_status_update"
        data["dart_count"] = int(payload.get("darts_on_board", 0) or 0)
        data["detection_state"] = str(payload.get("to_state", "") or "")

    return data


def _resolve_benchmark_data_dir() -> Path:
    if getattr(sys, "frozen", False):
        return get_data_root() / "benchmark_capture"
    return Path(__file__).resolve().parents[2] / "data" / "benchmark_capture"


def _resolve_correction_debug_dir() -> Path:
    if getattr(sys, "frozen", False):
        return get_data_root() / "correction_debug"
    return Path(__file__).resolve().parents[2] / "data" / "correction_debug"


def _sanitize_dataset_name(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "-", str(value or "").strip()).strip("-_.")
    return cleaned[:64] or "default"


def _coerce_score_list_item(score: Any) -> dict[str, Any] | None:
    if score is None:
        return None
    if isinstance(score, dict):
        multiplier = int(score.get("multiplier", 1) or 1)
        segment_raw = score.get("segment", "0")
        try:
            segment = int(segment_raw)
        except Exception:
            segment = 25 if str(segment_raw) == "bull" else 0
        score_value = int(score.get("score", 0) or 0)
        zone = str(score.get("zone", "single") or "single")
        return {
            "score": score_value,
            "multiplier": multiplier,
            "segment": segment,
            "zone": zone,
            "confidence": float(score.get("confidence", 1.0) or 1.0),
        }
    return None


def _benchmark_dataset_status(dataset_name: str) -> dict[str, Any]:
    dataset_dir = _resolve_benchmark_data_dir() / dataset_name
    turns = 0
    darts = 0
    if dataset_dir.exists():
        for metadata_path in sorted(dataset_dir.glob("turn_*/metadata.json")):
            try:
                payload = json.loads(metadata_path.read_text(encoding="utf-8"))
                turns += 1
                darts += int(payload.get("dart_count", 0) or 0)
            except Exception:
                continue
    return {
        "dataset_name": dataset_name,
        "dataset_dir": str(dataset_dir),
        "turns": turns,
        "darts": darts,
    }


def _copy_calibration_snapshot(dataset_root: Path) -> dict[str, Any]:
    src_root = Path(settings.calibration_data_dir)
    dst_root = dataset_root / "calibration"
    copied_files = 0
    cameras: list[dict[str, Any]] = []

    if not src_root.exists():
        return {
            "source_dir": str(src_root),
            "target_dir": str(dst_root),
            "exists": False,
            "copied_files": 0,
            "cameras": [],
        }

    dst_root.mkdir(parents=True, exist_ok=True)
    for cam_dir in sorted([p for p in src_root.glob("camera_*") if p.is_dir()], key=lambda p: p.name):
        target_cam_dir = dst_root / cam_dir.name
        target_cam_dir.mkdir(parents=True, exist_ok=True)
        copied_names: list[str] = []
        for path in cam_dir.iterdir():
            if not path.is_file():
                continue
            if path.suffix.lower() not in {".json", ".npz", ".yaml", ".yml"}:
                continue
            shutil.copy2(path, target_cam_dir / path.name)
            copied_files += 1
            copied_names.append(path.name)
        cameras.append({"camera_dir": cam_dir.name, "files": copied_names})

    return {
        "source_dir": str(src_root),
        "target_dir": str(dst_root),
        "exists": True,
        "copied_files": copied_files,
        "cameras": cameras,
    }


def _format_score_payload(segment: int, multiplier: int, score: int, zone_hint: str | None = None) -> dict[str, Any]:
    zone = "single"
    zone_hint_norm = str(zone_hint or "").strip().lower()
    if zone_hint_norm in {"single_inner", "single_outer", "single", "double", "triple", "outer_bull", "inner_bull", "miss"}:
        zone = zone_hint_norm
    elif zone_hint_norm:
        zone = "single"
    if multiplier == 2:
        zone = "double"
    elif multiplier == 3:
        zone = "triple"
    elif segment == 25:
        zone = "outer_bull" if multiplier == 1 else "inner_bull"
    elif multiplier == 0:
        zone = "miss"
    elif multiplier == 1 and zone_hint_norm in {"single_inner", "single_outer"}:
        zone = zone_hint_norm
    return {
        "score": int(score),
        "multiplier": int(multiplier),
        "segment": str(int(segment)),
        "zone": zone,
        "confidence": 1.0,
        "manual": True,
    }


def _coerce_score_payload(score: dict[str, Any] | None, score_value: int) -> dict[str, Any]:
    payload = dict(score or {})
    segment = str(payload.get("segment", "0"))
    zone = str(payload.get("zone", "single") or "single")
    multiplier = payload.get("multiplier")
    if multiplier is None:
        if zone == "triple":
            multiplier = 3
        elif zone == "double":
            multiplier = 2
        elif zone == "inner_bull":
            multiplier = 2
        elif zone == "outer_bull":
            multiplier = 1
        else:
            multiplier = 1
    return {
        "score": int(score_value),
        "multiplier": int(multiplier),
        "segment": segment,
        "zone": zone,
        "confidence": float(payload.get("confidence", 1.0) or 1.0),
    }


def _project_candidate_board_point(candidate: dict[str, Any]) -> dict[str, Any] | None:
    try:
        cam_idx = int(candidate.get("camera_index", -1))
        tip = candidate.get("tip", {}) or {}
        tx = float(tip.get("x"))
        ty = float(tip.get("y"))
        projected = calibration_manager.project_to_model(cam_idx, tx, ty)
        return {
            "x": projected.get("model_x"),
            "y": projected.get("model_y"),
            "norm_x": projected.get("norm_x"),
            "norm_y": projected.get("norm_y"),
        }
    except Exception:
        return None


def _pick_primary_candidate(round_entry: dict[str, Any]) -> dict[str, Any] | None:
    candidates = round_entry.get("candidates", []) or []
    if not isinstance(candidates, list) or not candidates:
        return None

    voted_value = int(round_entry.get("voted_score_value", 0) or 0)
    same_score = [
        c for c in candidates
        if isinstance(c, dict) and int(c.get("score_value", -9999) or -9999) == voted_value
    ]
    source = same_score if same_score else [c for c in candidates if isinstance(c, dict)]
    if not source:
        return None
    return max(source, key=lambda c: float(c.get("confidence", 0.0) or 0.0))


def _pick_replay_camera_index(round_entry: dict[str, Any]) -> int | None:
    primary = _pick_primary_candidate(round_entry)
    if isinstance(primary, dict):
        try:
            idx = int(primary.get("camera_index", -1))
            if idx >= 0:
                return idx
        except Exception:
            pass

    frames = round_entry.get("frames", []) if isinstance(round_entry, dict) else []
    if isinstance(frames, list):
        for idx, frame in enumerate(frames):
            if isinstance(frame, np.ndarray):
                return idx
    return None


def _pick_locked_replay_camera_index(entries: list[dict[str, Any]]) -> int | None:
    if not entries:
        return None

    # Prefer the camera selected for the first dart, but lock replay to one
    # camera that is available across as many dart snapshots as possible.
    preferred = _pick_replay_camera_index(entries[0])
    counts: dict[int, int] = {}
    for entry in entries:
        frames = entry.get("frames", [])
        if not isinstance(frames, list):
            continue
        for idx, frame in enumerate(frames):
            if isinstance(frame, np.ndarray):
                counts[idx] = int(counts.get(idx, 0)) + 1

    if not counts:
        return preferred

    selected = max(
        counts.items(),
        key=lambda item: (
            int(item[1]),
            1 if preferred is not None and int(item[0]) == int(preferred) else 0,
            -int(item[0]),
        ),
    )[0]
    return int(selected)


def _normalize_replay_type(value: Any) -> str:
    replay_type = str(value or "score").strip().lower()
    return "checkout" if replay_type == "checkout" else "score"


def _highlight_replay_filename(replay: dict[str, Any], *, timestamp_ms: int | None = None, include_camera: bool = True) -> str:
    replay_type = _normalize_replay_type(replay.get("replay_type"))
    score_value = int(replay.get("turn_total", replay.get("trigger_score", 0)) or 0)
    score_value = max(0, min(180, score_value))
    captured_at_ms = int(timestamp_ms if timestamp_ms is not None else replay.get("captured_at_ms", int(time.time() * 1000)) or int(time.time() * 1000))
    cam_idx = int(replay.get("camera_index", -1) or -1)
    camera_suffix = f"_cam{cam_idx}" if include_camera else ""
    return f"highlight_replay_{replay_type}_{score_value}_{captured_at_ms}{camera_suffix}.mp4"


def _build_fronton_replay_frames(
    min_score: int = 60,
    camera_index: int | None = None,
    replay_type: str = "score",
) -> dict[str, Any]:
    normalized_replay_type = _normalize_replay_type(replay_type)
    det_settings = dartcounter.get_detection_settings()
    if not bool(det_settings.get("replay_enabled", True)):
        return {"ready": False, "reason": "replay_disabled"}

    entries: list[dict[str, Any]] = []
    for dart_index in (1, 2, 3):
        entry = dartcounter.get_round_dart_result(dart_index)
        if isinstance(entry, dict):
            entries.append(entry)
    if not entries:
        return {
            "ready": False,
            "reason": "no_round_data",
            "round_session_id": int(dartcounter.get_round_dart_session_id()),
        }

    latest_round_session_id = max(int(entry.get("round_session_id", 0) or 0) for entry in entries)
    entries = [
        entry
        for entry in entries
        if int(entry.get("round_session_id", 0) or 0) == int(latest_round_session_id)
    ]
    if not entries:
        return {
            "ready": False,
            "reason": "no_round_data",
            "round_session_id": int(latest_round_session_id),
        }

    entries.sort(key=lambda e: int(e.get("dart_index", 0) or 0))
    scores = [int(e.get("voted_score_value", 0) or 0) for e in entries]
    turn_total = int(sum(scores)) if scores else 0
    if turn_total < int(min_score):
        return {
            "ready": False,
            "reason": "threshold_not_met",
            "turn_total": turn_total,
            "min_score": int(min_score),
            "round_session_id": int(latest_round_session_id),
        }

    replay_frames: list[dict[str, Any]] = []
    captured_at_ms = max((int(e.get("ts_ms", 0) or 0) for e in entries), default=0)
    first_dart_ms = min((int(e.get("ts_ms", 0) or 0) for e in entries), default=int(captured_at_ms))
    replay_start_ms = max(0, int(first_dart_ms) - int(_REPLAY_PREROLL_MS))
    if camera_index is not None and int(camera_index) >= 0:
        locked_camera_index = int(camera_index)
    else:
        locked_camera_index = _pick_locked_replay_camera_index(entries)

    if locked_camera_index is None:
        return {
            "ready": False,
            "reason": "no_replay_camera",
            "round_session_id": int(latest_round_session_id),
        }

    # Add a "board clear/background" frame first for replay context.
    # Use the exact same source selection chain as practice fronton,
    # but force background context by disallowing frozen dart frame.
    bg_source = "none"
    bg_included = False
    try:
        bg_frame = calibration_manager.get_saved_reference_frame(int(locked_camera_index))
        bg_source = "calibration_saved_reference" if isinstance(bg_frame, np.ndarray) else "none"
        if not isinstance(bg_frame, np.ndarray):
            bg_frame, bg_source = _select_fronton_source_frame(int(locked_camera_index), allow_frozen=False)

        if not isinstance(bg_frame, np.ndarray):
            print(
                f"[replay] WARN background missing: camera={int(locked_camera_index)} "
                "sources_checked=[calibration_saved_reference,runtime_snapshot,camera_live_fallback]"
            )
        else:
            try:
                bg_fronton = calibration_manager.fronton(int(locked_camera_index), bg_frame)
            except Exception as exc:
                print(f"[replay] WARN background fronton transform failed: camera={int(locked_camera_index)} err={exc}")
                bg_fronton = bg_frame
            bg_encoded = _encode_image_b64(bg_fronton, quality=82)
            if bg_encoded:
                replay_frames.append(
                    {
                        "dart_index": 0,
                        "score_value": 0,
                        "camera_index": int(locked_camera_index),
                        "image": bg_encoded,
                        "label": "Board Clear",
                        "ts_ms": int(replay_start_ms),
                    }
                )
                bg_included = True
            else:
                print(f"[replay] WARN background encode failed: camera={int(locked_camera_index)} source={bg_source}")
    except Exception as exc:
        print(f"[replay] WARN background build failed: camera={int(locked_camera_index)} err={exc}")
    for entry in entries:
        frames = entry.get("frames", [])
        if not isinstance(frames, list) or locked_camera_index >= len(frames):
            continue
        frame = frames[locked_camera_index]
        if frame is None or not isinstance(frame, np.ndarray):
            continue
        try:
            fronton = calibration_manager.fronton(locked_camera_index, frame)
        except Exception:
            fronton = frame
        encoded = _encode_image_b64(fronton, quality=82)
        if not encoded:
            continue
        replay_frames.append(
            {
                "dart_index": int(entry.get("dart_index", 0) or 0),
                "score_value": int(entry.get("voted_score_value", 0) or 0),
                "camera_index": int(locked_camera_index),
                "image": encoded,
                "label": f"Dart {int(entry.get('dart_index', 0) or 0)}",
                "ts_ms": max(
                    int(replay_start_ms),
                    int(entry.get("ts_ms", captured_at_ms) or captured_at_ms) - int(_REPLAY_BOARD_SYNC_OFFSET_MS),
                ),
                "detection_ts_ms": int(entry.get("ts_ms", captured_at_ms) or captured_at_ms),
            }
        )

    if not replay_frames:
        return {
            "ready": False,
            "reason": "no_replay_frames",
            "round_session_id": int(latest_round_session_id),
        }
    if not bg_included:
        return {
            "ready": False,
            "reason": "background_missing",
            "camera_index": int(locked_camera_index),
            "background_source": str(bg_source),
            "round_session_id": int(latest_round_session_id),
        }

    player_replay = player_replay_camera_service.build_replay_payload(
        entries=entries,
        fallback_capture_ms=int(captured_at_ms),
    )

    return {
        "ready": True,
        "replay_type": normalized_replay_type,
        "trigger_score": turn_total,
        "turn_total": turn_total,
        "min_score": int(min_score),
        "replay_start_ms": int(replay_start_ms),
        "captured_at_ms": int(captured_at_ms),
        "round_session_id": int(latest_round_session_id),
        "camera_index": int(locked_camera_index),
        "background_included": bool(bg_included),
        "background_source": str(bg_source),
        "frames": replay_frames,
        "player_replay": player_replay,
    }


def _iter_replay_video_frames(
    frames_bgr: list[np.ndarray],
    size: tuple[int, int],
    hold_frames_per_input: int,
):
    w, h = size
    for frame in frames_bgr:
        if frame is None or not isinstance(frame, np.ndarray):
            continue
        if frame.shape[:2] != (h, w):
            frame = cv2.resize(frame, (w, h), interpolation=cv2.INTER_LINEAR)
        frame = _ensure_even_video_frame(frame)
        for _ in range(max(1, int(hold_frames_per_input))):
            yield frame


def _ensure_even_video_frame(frame: np.ndarray) -> np.ndarray:
    try:
        height, width = frame.shape[:2]
    except Exception:
        return frame
    even_height = int(height) if int(height) % 2 == 0 else int(height) - 1
    even_width = int(width) if int(width) % 2 == 0 else int(width) - 1
    if even_height < 2 or even_width < 2:
        return frame
    if even_height != height or even_width != width:
        frame = frame[:even_height, :even_width]
    return np.ascontiguousarray(frame)


def _find_ffmpeg_executable() -> str | None:
    exe_name = "ffmpeg.exe" if sys.platform.startswith("win") else "ffmpeg"
    candidates: list[Path] = []
    env_path = os.getenv("MACHINE_DARTS_FFMPEG_PATH", "").strip()
    if env_path:
        candidates.append(Path(env_path))

    runtime_roots = [
        Path(sys.executable).resolve().parent,
        Path.cwd(),
        Path(__file__).resolve().parent,
    ]
    for root in runtime_roots:
        candidates.extend(
            [
                root / "tools" / exe_name,
                root / exe_name,
                root / "_internal" / "tools" / exe_name,
            ]
        )

    for candidate in candidates:
        try:
            if candidate.is_file():
                return str(candidate)
        except OSError:
            continue
    return shutil.which("ffmpeg")


def _write_replay_mp4_h264_ffmpeg(
    frames_bgr: list[np.ndarray],
    output_path: Path,
    fps: int,
    hold_frames_per_input: int,
) -> bool:
    ffmpeg_path = _find_ffmpeg_executable()
    if not ffmpeg_path:
        return False
    first_frame = _ensure_even_video_frame(frames_bgr[0])
    h, w = first_frame.shape[:2]
    cmd = [
        ffmpeg_path,
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgr24",
        "-s",
        f"{w}x{h}",
        "-r",
        str(float(max(1, fps))),
        "-i",
        "pipe:0",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        str(output_path),
    ]
    proc: subprocess.Popen[bytes] | None = None
    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        if proc.stdin is None:
            return False
        for frame in _iter_replay_video_frames(frames_bgr, (w, h), hold_frames_per_input):
            proc.stdin.write(frame.tobytes())
        proc.stdin.close()
        proc.stdin = None
        _, stderr = proc.communicate(timeout=60)
        if proc.returncode == 0 and output_path.exists() and output_path.stat().st_size > 0:
            return True
        err_text = stderr.decode("utf-8", errors="ignore").strip() if stderr else ""
        print(f"[replay] WARN H.264 ffmpeg encode failed: {err_text[-500:]}")
        return False
    except Exception as exc:
        if proc and proc.poll() is None:
            proc.kill()
        print(f"[replay] WARN H.264 ffmpeg encode exception: {exc}")
        return False


def _write_replay_mp4_opencv(
    frames_bgr: list[np.ndarray],
    output_path: Path,
    fps: int,
    hold_frames_per_input: int,
) -> bool:
    first_frame = _ensure_even_video_frame(frames_bgr[0])
    h, w = first_frame.shape[:2]
    codec_candidates = ("mp4v",)
    writer: cv2.VideoWriter | None = None
    codec_used = ""
    for codec in codec_candidates:
        fourcc = cv2.VideoWriter_fourcc(*codec)
        candidate = cv2.VideoWriter(str(output_path), fourcc, float(max(1, fps)), (w, h))
        if candidate.isOpened():
            writer = candidate
            codec_used = codec
            break
        candidate.release()
    if writer is None:
        return False
    print("[replay] WARN falling back to mp4v; H.264 encoder unavailable")
    try:
        for frame in _iter_replay_video_frames(frames_bgr, (w, h), hold_frames_per_input):
            writer.write(frame)
    finally:
        writer.release()
    return True


def _write_replay_mp4(frames_bgr: list[np.ndarray], output_path: Path, fps: int = 2, hold_frames_per_input: int = 8) -> bool:
    if not frames_bgr:
        return False
    if _write_replay_mp4_h264_ffmpeg(frames_bgr, output_path, fps, hold_frames_per_input):
        return True
    return _write_replay_mp4_opencv(frames_bgr, output_path, fps, hold_frames_per_input)


def _decode_encoded_replay_frames(items: Any) -> list[dict[str, Any]]:
    frames_bgr: list[dict[str, Any]] = []
    if not isinstance(items, list):
        return frames_bgr
    for item in items:
        if not isinstance(item, dict):
            continue
        img_b64 = item.get("image")
        if not isinstance(img_b64, str) or not img_b64:
            continue
        try:
            raw = base64.b64decode(img_b64)
            arr = np.frombuffer(raw, dtype=np.uint8)
            frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if frame is not None:
                frames_bgr.append(
                    {
                        "frame": frame,
                        "dart_index": int(item.get("dart_index", 0) or 0),
                        "score_value": int(item.get("score_value", 0) or 0),
                        "ts_ms": int(item.get("ts_ms", 0) or 0),
                        "label": str(item.get("label", "") or ""),
                    }
                )
        except Exception:
            continue
    return frames_bgr


def _decode_replay_frames_bgr(replay: dict[str, Any]) -> list[np.ndarray]:
    return [item["frame"] for item in _decode_encoded_replay_frames(replay.get("frames", []))]


def _compose_replay_vertical_stack(
    board_frame: np.ndarray,
    player_frame: np.ndarray,
    *,
    board_label: str,
    player_label: str,
    shorts_layout: bool = False,
) -> np.ndarray:
    def _resize_cover(frame: np.ndarray, width: int, height: int) -> np.ndarray:
        h, w = frame.shape[:2]
        if w <= 0 or h <= 0:
            return np.zeros((height, width, 3), dtype=np.uint8)
        scale = max(float(width) / float(w), float(height) / float(h))
        resized_w = max(width, int(round(float(w) * scale)))
        resized_h = max(height, int(round(float(h) * scale)))
        resized = cv2.resize(frame, (resized_w, resized_h), interpolation=cv2.INTER_LINEAR)
        x0 = max(0, (resized_w - width) // 2)
        y0 = max(0, (resized_h - height) // 2)
        return resized[y0 : y0 + height, x0 : x0 + width]

    def _resize_contain(frame: np.ndarray, width: int, height: int) -> np.ndarray:
        h, w = frame.shape[:2]
        if w <= 0 or h <= 0:
            return np.zeros((height, width, 3), dtype=np.uint8)
        scale = min(float(width) / float(w), float(height) / float(h))
        resized_w = max(2, int(round(float(w) * scale)))
        resized_h = max(2, int(round(float(h) * scale)))
        resized = cv2.resize(frame, (resized_w, resized_h), interpolation=cv2.INTER_LINEAR)
        canvas = np.zeros((height, width, 3), dtype=np.uint8)
        x0 = max(0, (width - resized_w) // 2)
        y0 = max(0, (height - resized_h) // 2)
        canvas[y0 : y0 + resized_h, x0 : x0 + resized_w] = resized
        return canvas

    if shorts_layout:
        target_w = 720
        target_h = 1280
        divider_h = 16
        board_h = 540
        player_h = target_h - board_h - divider_h
        canvas = np.zeros((target_h, target_w, 3), dtype=np.uint8)
        board_resized = _resize_contain(board_frame, target_w, board_h)
        player_resized = _resize_cover(player_frame, target_w, player_h)
        canvas[0:board_h, :] = board_resized
        canvas[board_h : board_h + divider_h, :] = (22, 22, 22)
        player_y = board_h + divider_h
        canvas[player_y : player_y + player_h, :] = player_resized
        return _ensure_even_video_frame(canvas)

    board_h, board_w = board_frame.shape[:2]
    player_h, player_w = player_frame.shape[:2]
    target_w = int(min(max(board_w, player_w), 720))
    if target_w % 2 != 0:
        target_w -= 1
    target_w = max(2, target_w)

    def _resize_to_width(frame: np.ndarray, width: int) -> np.ndarray:
        h, w = frame.shape[:2]
        if w == width:
            return _ensure_even_video_frame(frame)
        target_h = max(2, int(round((float(h) / float(w)) * float(width))))
        if target_h % 2 != 0:
            target_h -= 1
        return cv2.resize(frame, (width, target_h), interpolation=cv2.INTER_LINEAR)

    board_resized = _resize_to_width(board_frame, target_w)
    player_resized = _resize_to_width(player_frame, target_w)
    divider_h = 6
    canvas = np.zeros((board_resized.shape[0] + divider_h + player_resized.shape[0], target_w, 3), dtype=np.uint8)
    canvas[: board_resized.shape[0], :] = board_resized
    canvas[board_resized.shape[0] : board_resized.shape[0] + divider_h, :] = (22, 22, 22)
    player_y = board_resized.shape[0] + divider_h
    canvas[player_y : player_y + player_resized.shape[0], :] = player_resized
    return _ensure_even_video_frame(canvas)


def _select_board_frame_for_ts(board_frames: list[dict[str, Any]], ts_ms: int) -> dict[str, Any] | None:
    selected: dict[str, Any] | None = None
    for item in board_frames:
        item_ts = int(item.get("ts_ms", 0) or 0)
        if selected is None:
            selected = item
        if item_ts <= ts_ms:
            selected = item
        else:
            break
    return selected


def _repeat_count_for_duration(duration_ms: int, fps: int) -> int:
    safe_fps = max(1, int(fps))
    safe_duration_ms = max(1, int(duration_ms))
    return max(1, int(round((float(safe_duration_ms) / 1000.0) * float(safe_fps))))


def _render_replay_video_frames(replay: dict[str, Any]) -> tuple[list[np.ndarray], int]:
    board_frames = _decode_encoded_replay_frames(replay.get("frames", []))
    if not board_frames:
        return [], 2

    player_replay = replay.get("player_replay", {}) if isinstance(replay.get("player_replay"), dict) else {}
    player_frames = _decode_encoded_replay_frames(player_replay.get("frames", []))
    if not player_frames:
        rendered = [item["frame"] for item in board_frames if isinstance(item.get("frame"), np.ndarray)]
        return rendered, 2

    output_fps = int(max(8, min(30, int(player_replay.get("fps", 30) or 30))))
    shorts_layout = bool(player_replay.get("portrait_crop", False))
    rendered_frames: list[np.ndarray] = []
    player_camera_index = int(player_replay.get("camera_index", -1) or -1)
    for idx, player_item in enumerate(player_frames):
        player_frame = player_item.get("frame")
        if not isinstance(player_frame, np.ndarray):
            continue
        ts_ms = int(player_item.get("ts_ms", 0) or 0)
        board_item = _select_board_frame_for_ts(board_frames, ts_ms)
        if not isinstance(board_item, dict):
            continue
        board_frame = board_item.get("frame")
        if not isinstance(board_frame, np.ndarray):
            continue
        board_dart_index = int(board_item.get("dart_index", 0) or 0)
        board_score_value = int(board_item.get("score_value", 0) or 0)
        board_label = "Board Clear" if board_dart_index <= 0 else f"Board Dart {board_dart_index}  Score {board_score_value}"
        player_label = (
            "Player Ready"
            if ts_ms < int(board_frames[0].get("ts_ms", 0) or 0)
            else f"Player Cam {player_camera_index if player_camera_index >= 0 else ''}".strip()
        )
        composed_frame = _compose_replay_vertical_stack(
            board_frame,
            player_frame,
            board_label=board_label,
            player_label=player_label,
            shorts_layout=shorts_layout,
        )
        next_ts_ms = (
            int(player_frames[idx + 1].get("ts_ms", ts_ms) or ts_ms)
            if idx + 1 < len(player_frames)
            else ts_ms
        )
        if idx == len(player_frames) - 1:
            frame_duration_ms = 2000
        else:
            frame_duration_ms = max(16, min(_REPLAY_PLAYER_FRAME_MAX_DURATION_MS, next_ts_ms - ts_ms or 33))
        repeat_count = _repeat_count_for_duration(frame_duration_ms, output_fps)
        rendered_frames.extend([composed_frame] + [composed_frame.copy() for _ in range(repeat_count - 1)])
    return rendered_frames, output_fps


def _autosave_highlight_replay_if_enabled(replay: dict[str, Any]) -> None:
    global _LAST_HIGHLIGHT_AUTOSAVE_KEY
    if not bool(replay.get("ready")):
        return
    settings_payload = dartcounter.get_detection_settings()
    if not bool(settings_payload.get("replay_autosave_enabled", False)):
        return

    capture_key = (
        f"{int(replay.get('captured_at_ms', 0) or 0)}:"
        f"{int(replay.get('camera_index', -1) or -1)}:"
        f"{int(replay.get('trigger_score', 0) or 0)}"
    )
    if _LAST_HIGHLIGHT_AUTOSAVE_KEY == capture_key:
        return

    save_dir_raw = str(settings_payload.get("replay_autosave_dir", "") or "").strip()
    using_default_dir = not bool(save_dir_raw)
    if save_dir_raw:
        save_dir = Path(save_dir_raw).expanduser()
    else:
        save_dir = get_data_root() / "replays"
    save_dir.mkdir(parents=True, exist_ok=True)

    # Keep the default replay directory bounded so disk usage does not grow forever.
    # If a custom directory is chosen, we do not prune automatically.
    if using_default_dir:
        try:
            files = sorted(
                [p for p in save_dir.glob("highlight_replay_*.mp4") if p.is_file()],
                key=lambda p: p.stat().st_mtime,
            )
            max_files = int(_DEFAULT_REPLAY_AUTOSAVE_MAX_FILES)
            if len(files) >= max_files:
                to_remove = (len(files) - max_files) + 1
                for old in files[:to_remove]:
                    try:
                        old.unlink(missing_ok=True)
                    except Exception:
                        pass
                if to_remove > 0:
                    print(f"[replay] pruned {to_remove} old replay file(s) from default folder")
        except Exception:
            pass

    frames_bgr, replay_fps = _render_replay_video_frames(replay)
    if not frames_bgr:
        return

    mp4_path = save_dir / _highlight_replay_filename(replay, include_camera=True)
    ok = _write_replay_mp4(frames_bgr, mp4_path, fps=replay_fps, hold_frames_per_input=1)
    if ok:
        _LAST_HIGHLIGHT_AUTOSAVE_KEY = capture_key
        print(f"[replay] autosaved -> {mp4_path}")
    else:
        print(f"[replay] WARN autosave failed -> {mp4_path}")


def _serialize_candidate(candidate: dict[str, Any]) -> dict[str, Any]:
    board = _project_candidate_board_point(candidate)
    tip = candidate.get("tip", {}) or {}
    return {
        "camera_index": int(candidate.get("camera_index", -1) or -1),
        "tip": {
            "x": float(tip.get("x", 0.0) or 0.0),
            "y": float(tip.get("y", 0.0) or 0.0),
        },
        "confidence": float(candidate.get("confidence", 0.0) or 0.0),
        "score_value": int(candidate.get("score_value", 0) or 0),
        "score": dict(candidate.get("score", {}) or {}),
        "is_miss": bool(candidate.get("is_miss", False)),
        "board": board,
    }


def _round_entry_position_payload(round_entry: dict[str, Any]) -> dict[str, Any] | None:
    primary = _pick_primary_candidate(round_entry)
    if not isinstance(primary, dict):
        return None
    try:
        cam_idx = int(primary.get("camera_index", -1) or -1)
        if cam_idx < 0:
            return None
        tip = primary.get("tip", {}) or {}
        tx = float(tip.get("x"))
        ty = float(tip.get("y"))
        return calibration_manager.describe_board_point(cam_idx, tx, ty)
    except Exception:
        return None


def _save_correction_training_data(
    dart_index_zero_based: int,
    round_entry: dict[str, Any],
    corrected_score_value: int,
    corrected_score_payload: dict[str, Any],
) -> dict[str, Any]:
    frames = round_entry.get("frames", [])
    background_frames = round_entry.get("background_frames", [])
    burst_frames = round_entry.get("burst_frames", [])
    masks = round_entry.get("masks", [])
    candidates = round_entry.get("candidates", [])
    original_score_value = int(round_entry.get("voted_score_value", 0))
    ts_ms = int(time.time() * 1000)

    debug_root = _resolve_correction_debug_dir()
    debug_root.mkdir(parents=True, exist_ok=True)
    debug_dir = debug_root / f"dart_{dart_index_zero_based + 1}_{ts_ms}"

    temp_debug_dir_raw = str(round_entry.get("temp_debug_dir", "") or "").strip()
    temp_debug_dir = Path(temp_debug_dir_raw) if temp_debug_dir_raw else None
    if temp_debug_dir is not None and temp_debug_dir.exists() and temp_debug_dir.is_dir():
        shutil.copytree(temp_debug_dir, debug_dir)
        metadata_path = debug_dir / "metadata.json"
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8")) if metadata_path.exists() else {}
        except Exception:
            metadata = {}
        metadata_text = json.dumps(metadata, default=str)
        metadata_text = metadata_text.replace(str(temp_debug_dir), str(debug_dir))
        try:
            metadata = json.loads(metadata_text)
        except Exception:
            metadata = {}
        calibration_snapshot = _copy_calibration_snapshot(debug_dir)
        metadata.update(
            {
                "kind": "score_correction_debug",
                "saved_at_ms": int(ts_ms),
                "dart_index_zero_based": int(dart_index_zero_based),
                "dart_index": int(dart_index_zero_based + 1),
                "original_score_value": int(original_score_value),
                "original_score": round_entry.get("voted_score") or metadata.get("original_score", {}),
                "corrected_score_value": int(corrected_score_value),
                "corrected_score": corrected_score_payload,
                "calibration_snapshot": calibration_snapshot,
                "promoted_from_temp": str(temp_debug_dir),
            }
        )
        metadata_path.write_text(json.dumps(metadata, indent=2, default=str), encoding="utf-8")
        return {
            "training_dir": None,
            "dart_dir": None,
            "saved_images": 0,
            "saved_mappings": 0,
            "saved_masks": 0,
            "metadata_path": None,
            "debug_dir": str(debug_dir),
            "debug_metadata_path": str(metadata_path),
            "debug_frames": len(metadata.get("frames", []) or []),
            "debug_burst_frames": len(metadata.get("burst_frames", []) or []),
            "debug_masks": len(metadata.get("masks", []) or []),
            "capped": False,
            "cap_limit": None,
            "message": "OpenCV correction temp pack promoted to debug pack.",
        }

    frames_dir = debug_dir / "frames"
    masks_dir = debug_dir / "masks"
    debug_dir.mkdir(parents=True, exist_ok=True)
    frames_dir.mkdir(parents=True, exist_ok=True)
    masks_dir.mkdir(parents=True, exist_ok=True)

    debug_frames: list[dict[str, Any]] = []
    for cam_idx, frame in enumerate(frames or []):
        if frame is None or not isinstance(frame, np.ndarray):
            continue
        path = frames_dir / f"cam{cam_idx + 1}_detected.png"
        cv2.imwrite(str(path), frame)
        debug_frames.append({"camera_index": int(cam_idx), "kind": "detected", "path": str(path)})

    for cam_idx, frame in enumerate(background_frames or []):
        if frame is None or not isinstance(frame, np.ndarray):
            continue
        path = frames_dir / f"cam{cam_idx + 1}_background.png"
        cv2.imwrite(str(path), frame)
        debug_frames.append({"camera_index": int(cam_idx), "kind": "background", "path": str(path)})

    burst_dir = debug_dir / "burst_frames"
    debug_burst_frames: list[dict[str, Any]] = []
    for burst_i, burst in enumerate(burst_frames or []):
        if not isinstance(burst, (list, tuple)):
            continue
        burst_dir.mkdir(parents=True, exist_ok=True)
        for cam_idx, frame in enumerate(burst):
            if frame is None or not isinstance(frame, np.ndarray):
                continue
            path = burst_dir / f"burst_{burst_i + 1:02d}_cam{cam_idx + 1}.png"
            cv2.imwrite(str(path), frame)
            debug_burst_frames.append(
                {
                    "burst_index": int(burst_i),
                    "camera_index": int(cam_idx),
                    "kind": "post_settle_burst",
                    "path": str(path),
                }
            )

    debug_masks: list[dict[str, Any]] = []
    for cam_idx, mask in enumerate(masks or []):
        if mask is None or not isinstance(mask, np.ndarray):
            continue
        full_path = masks_dir / f"cam{cam_idx + 1}_mask_codes.png"
        new_path = masks_dir / f"cam{cam_idx + 1}_new_mask.png"
        cv2.imwrite(str(full_path), mask.astype(np.uint8))
        cv2.imwrite(str(new_path), (mask == 76).astype(np.uint8) * 255)
        debug_masks.append(
            {
                "camera_index": int(cam_idx),
                "mask_codes": str(full_path),
                "new_mask": str(new_path),
                "pixels_any": int(np.count_nonzero(mask > 0)),
                "pixels_new": int(np.count_nonzero(mask == 76)),
                "pixels_old": int(np.count_nonzero(mask == 152)),
            }
        )

    calibration_snapshot = _copy_calibration_snapshot(debug_dir)
    debug_metadata = {
        "kind": "score_correction_debug",
        "saved_at_ms": int(ts_ms),
        "dart_index_zero_based": int(dart_index_zero_based),
        "dart_index": int(dart_index_zero_based + 1),
        "round_session_id": int(round_entry.get("round_session_id", 0) or 0),
        "active_model_id": str(round_entry.get("active_model_id", "") or "unknown"),
        "original_score_value": int(original_score_value),
        "original_score": round_entry.get("voted_score") or {},
        "corrected_score_value": int(corrected_score_value),
        "corrected_score": corrected_score_payload,
        "votes": int(round_entry.get("votes", 0) or 0),
        "candidates": candidates if isinstance(candidates, list) else [],
        "opencv_result": round_entry.get("opencv_result", {}),
        "processing_ms": float(round_entry.get("processing_ms", 0.0) or 0.0),
        "total_ms": float(round_entry.get("total_ms", 0.0) or 0.0),
        "detected_ts_ms": int(round_entry.get("ts_ms", 0) or 0),
        "frames": debug_frames,
        "burst_frames": debug_burst_frames,
        "masks": debug_masks,
        "calibration_snapshot": calibration_snapshot,
    }
    debug_metadata_path = debug_dir / "metadata.json"
    debug_metadata_path.write_text(json.dumps(debug_metadata, indent=2, default=str), encoding="utf-8")

    return {
        "training_dir": None,
        "dart_dir": None,
        "saved_images": 0,
        "saved_mappings": 0,
        "saved_masks": 0,
        "metadata_path": None,
        "debug_dir": str(debug_dir),
        "debug_metadata_path": str(debug_metadata_path),
        "debug_frames": len(debug_frames),
        "debug_burst_frames": len(debug_burst_frames),
        "debug_masks": len(debug_masks),
        "capped": False,
        "cap_limit": None,
        "message": "OpenCV correction debug pack saved; training image export disabled.",
    }


@router.get("/api/settings/detection")
def get_detection_settings() -> dict:
    return {
        "settings": dartcounter.get_detection_settings(),
        "runtime": {"process_priority_mode": get_current_process_priority_mode()},
        "player_replay": player_replay_camera_service.get_status(),
    }


@router.put("/api/settings/detection")
def update_detection_settings(payload: dict) -> dict:
    incoming = payload.get("settings", payload) if isinstance(payload, dict) else {}
    updated = dartcounter.update_detection_settings(incoming, persist=True)
    player_replay_status = player_replay_camera_service.configure_from_settings(updated)
    priority_result = apply_process_priority(updated.get("process_priority_mode", "normal"))
    return {
        "settings": updated,
        "runtime": {"process_priority_mode": get_current_process_priority_mode()},
        "player_replay": player_replay_status,
        "priority_apply": priority_result,
    }


@router.post("/api/settings/detection/reset")
def reset_detection_settings() -> dict:
    reset = dartcounter.reset_detection_settings()
    player_replay_status = player_replay_camera_service.configure_from_settings(reset)
    priority_result = apply_process_priority(reset.get("process_priority_mode", "normal"))
    return {
        "settings": reset,
        "runtime": {"process_priority_mode": get_current_process_priority_mode()},
        "player_replay": player_replay_status,
        "priority_apply": priority_result,
    }


@router.get("/api/settings/detection/insights")
def get_detection_insights() -> dict:
    return {"insights": dartcounter.get_detection_insights()}


@router.post("/api/settings/detection/page-active")
def set_detection_page_active(payload: dict | None = None) -> dict:
    enabled = False
    if isinstance(payload, dict):
        enabled = bool(payload.get("enabled", False))
    dartcounter.set_detection_page_active(enabled)
    return {"ok": True, "enabled": bool(enabled)}


@router.post("/api/settings/replay/pick-folder")
def pick_replay_folder(payload: dict | None = None) -> dict:
    initial_path = ""
    if isinstance(payload, dict):
        initial_path = str(payload.get("initial_path", "") or "").strip()
    selected = _pick_folder_native(initial_path or None)
    return {"path": selected}


@router.get("/api/settings/models/stats")
def get_models_stats() -> dict:
    active_model_id = "opencv-line-fit"
    return {"stats": get_model_accuracy_stats(active_model_id=active_model_id)}


@router.post("/api/settings/models/stats/reset")
def reset_models_stats() -> dict:
    return {"stats": reset_model_accuracy_stats()}


def _resize_image_max_dimension(frame, max_size: int | None = None):
    if frame is None or not max_size or max_size <= 0:
        return frame
    try:
        height, width = frame.shape[:2]
    except Exception:
        return frame
    largest = max(int(width), int(height))
    if largest <= max_size:
        return frame
    scale = float(max_size) / float(largest)
    next_width = max(1, int(round(width * scale)))
    next_height = max(1, int(round(height * scale)))
    return cv2.resize(frame, (next_width, next_height), interpolation=cv2.INTER_AREA)


def _encode_image_b64(frame, quality: int = 75) -> str | None:
    if frame is None:
        return None
    safe_quality = max(35, min(95, int(quality)))
    ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, safe_quality])
    if not ok:
        return None
    return base64.b64encode(jpeg.tobytes()).decode("ascii")


def _first_valid(*frames):
    """Return the first numpy array that is not None."""
    for f in frames:
        if f is not None:
            return f
    return None


def _select_fronton_source_frame(camera_index: int, *, allow_frozen: bool) -> tuple[np.ndarray | None, str]:
    """Pick fronton source frame using the same chain as practice fronton view."""
    snap = dartcounter.get_runtime_debug_snapshot(camera_index=int(camera_index))
    if allow_frozen:
        frozen = dartcounter.get_frozen_detection_frame(int(camera_index))
        if isinstance(frozen, np.ndarray):
            return frozen, "frozen_detection_frame"

    frame = _first_valid(
        snap.get("raw_empty_frame"),
        snap.get("raw_before_movement_frame"),
        snap.get("raw_last_frame"),
        snap.get("empty_frame"),
        snap.get("before_movement_frame"),
        snap.get("last_frame"),
    )
    if isinstance(frame, np.ndarray):
        return frame, "runtime_snapshot"

    frame = camera_service.wait_for_frame(int(camera_index), timeout_s=0.4)
    if isinstance(frame, np.ndarray):
        return frame, "camera_live_fallback"
    return None, "missing"


@router.post("/api/detection/image/enable")
def enable_detection_image() -> dict[str, Any]:
    """Legacy Practice page compatibility endpoint."""
    dartcounter.set_detection_page_active(True)
    return {"ok": True, "enabled": True}


@router.post("/api/detection/image/disable")
def disable_detection_image() -> dict[str, Any]:
    """Legacy Practice page compatibility endpoint."""
    dartcounter.set_detection_page_active(False)
    return {"ok": True, "enabled": False}


@router.post("/api/detection/preview_camera")
def set_detection_preview_camera(payload: dict | None = None) -> dict[str, Any]:
    """Legacy Practice page compatibility endpoint.

    Front-on image requests already pass camera_index directly, so this only
    acknowledges the selected preview camera for older frontend calls.
    """
    camera_index = 0
    if isinstance(payload, dict):
        try:
            camera_index = int(payload.get("camera_index", 0) or 0)
        except Exception:
            camera_index = 0
    return {"ok": True, "camera_index": camera_index}


@router.get("/api/detection/image")
def get_detection_image(view: str = "fronton", camera_index: int = 0, max_size: int = 0, quality: int = 75) -> dict:
    view_name = str(view).strip().lower()
    if camera_index < 0:
        raise HTTPException(status_code=400, detail="camera_index must be >= 0")

    frame = None
    snap = dartcounter.get_runtime_debug_snapshot(camera_index=camera_index)

    if view_name in ("raw", "normal", "fronton"):
        # 1. Frozen frame captured at dart detection moment.
        # 2. Raw (full-res) background/empty frame — needed for fronton homography.
        # 3. Raw before-movement frame.
        # 4. Raw last frame.
        # 5. Downscaled fallbacks (for raw/normal view only).
        # 6. Direct camera grab as last resort.
        if view_name == "fronton":
            frame, _ = _select_fronton_source_frame(int(camera_index), allow_frozen=True)
        else:
            frame = dartcounter.get_frozen_detection_frame(camera_index)
            if frame is None:
                frame = _first_valid(
                    snap.get("empty_frame"),
                    snap.get("before_movement_frame"),
                    snap.get("last_frame"),
                )
            if frame is None:
                frame = camera_service.wait_for_frame(camera_index, timeout_s=0.4)
        if frame is None:
            raise HTTPException(status_code=503, detail="No frame available")
        if view_name == "fronton":
            frame = calibration_manager.fronton(camera_index, frame)
    elif view_name == "overlay":
        frame = _first_valid(snap.get("last_frame"), snap.get("before_movement_frame"), snap.get("empty_frame"))
        if frame is None:
            frame = camera_service.wait_for_frame(camera_index, timeout_s=0.4)
        if frame is None:
            raise HTTPException(status_code=503, detail="No frame available")
        frame = calibration_manager.overlay(camera_index, frame)
    elif view_name == "background":
        frame = _first_valid(snap.get("before_movement_frame"), snap.get("empty_frame"), snap.get("last_frame"))
        if frame is None:
            raise HTTPException(status_code=503, detail="No background frame available")
    elif view_name == "diff":
        current = snap.get("last_frame")
        background = _first_valid(snap.get("before_movement_frame"), snap.get("empty_frame"))
        if current is None or background is None:
            frame = current
        else:
            _, mask = dartcounter.fast_absdiff_bgr(current, background, dartcounter.DIFF_THRESHOLD)
            mask_u8 = (mask.astype("uint8")) * 255
            frame = cv2.cvtColor(mask_u8, cv2.COLOR_GRAY2BGR)
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported view '{view_name}'")

    encoded_frame = _resize_image_max_dimension(frame, max_size=max_size)
    encoded = _encode_image_b64(encoded_frame, quality=quality)
    if not encoded:
        raise HTTPException(status_code=503, detail="Unable to encode detection image")
    height, width = encoded_frame.shape[:2] if encoded_frame is not None else (0, 0)
    return {
        "image": encoded,
        "view": view_name,
        "camera_index": int(camera_index),
        "width": int(width),
        "height": int(height),
        "quality": max(35, min(95, int(quality))),
    }


@router.websocket("/ws/detection/events")
async def ws_detection_events(websocket: WebSocket) -> None:
    await websocket.accept()
    last_seq = get_latest_detection_seq()
    try:
        while True:
            events = get_detection_events_since(last_seq)
            for ev in events:
                await websocket.send_json(ev)
                last_seq = int(ev.get("seq", last_seq))
            await asyncio.sleep(0.02)
    except WebSocketDisconnect:
        return


@router.websocket("/ws/detection")
async def ws_detection_legacy(websocket: WebSocket) -> None:
    await websocket.accept()
    last_seq = get_latest_detection_seq()
    try:
        while True:
            events = get_detection_events_since(last_seq)
            for ev in events:
                await websocket.send_json(_legacy_detection_event(ev))
                last_seq = int(ev.get("seq", last_seq))
            await asyncio.sleep(0.02)
    except WebSocketDisconnect:
        return


@router.post("/api/detection/reset")
def reset_detection_round() -> dict[str, Any]:
    dartcounter.clear_round_dart_history()
    dartcounter.request_detection_reset(reset_background=True)
    publish_detection_event(
        {
            "type": "state_changed",
            "from_state": str(dartcounter.get_detection_insights().get("current_state", "unknown")),
            "to_state": "no_movement",
            "darts_on_board": 0,
        }
    )
    return {"status": "success", "background_reset_requested": True}


@router.get("/api/detection/scores")
def get_detection_scores(raw: bool = False) -> dict[str, Any]:
    if raw:
        scores: list[Any] = [None, None, None]
        positions: list[Any] = [None, None, None]
        for idx in range(3):
            round_entry = dartcounter.get_round_dart_result(idx + 1)
            if round_entry is None:
                continue
            score_value = int(round_entry.get("voted_score_value", 0) or 0)
            score = round_entry.get("voted_score") or {}
            scores[idx] = _coerce_score_payload(score, score_value)
            positions[idx] = _round_entry_position_payload(round_entry)
        return {"scores": scores, "positions": positions}

    service = get_game_service()

    state = service.get_x01_state()
    if state is not None:
        current_turn = state.get("currentTurn", {}) or {}
        darts = current_turn.get("darts")
        if isinstance(darts, list):
            return {"scores": darts[:3] + [None] * max(0, 3 - len(darts))}

    state = service.get_cricket_state()
    if state is not None:
        current_turn = state.get("currentTurn", {}) or {}
        darts = current_turn.get("darts")
        if isinstance(darts, list):
            return {"scores": darts[:3] + [None] * max(0, 3 - len(darts))}

    state = service.get_around_the_clock_state()
    if state is not None:
        current_turn = state.get("currentTurn", {}) or {}
        darts = current_turn.get("darts")
        if isinstance(darts, list):
            return {"scores": darts[:3] + [None] * max(0, 3 - len(darts))}

    state = service.get_shanghai_state()
    if state is not None:
        current_turn = state.get("currentTurn", {}) or {}
        darts = current_turn.get("darts")
        if isinstance(darts, list):
            return {"scores": darts[:3] + [None] * max(0, 3 - len(darts))}

    state = service.get_beer_race_state()
    if state is not None:
        current_turn = state.get("currentTurn", {}) or {}
        darts = current_turn.get("darts")
        if isinstance(darts, list):
            return {"scores": darts[:3] + [None] * max(0, 3 - len(darts))}

    state = service.get_bermuda_state()
    if state is not None:
        current_turn = state.get("currentTurn", {}) or {}
        darts = current_turn.get("darts")
        if isinstance(darts, list):
            return {"scores": darts[:3] + [None] * max(0, 3 - len(darts))}

    state = service.get_bob27_state()
    if state is not None:
        current_turn = state.get("currentTurn", {}) or {}
        darts = current_turn.get("darts")
        if isinstance(darts, list):
            return {"scores": darts[:3] + [None] * max(0, 3 - len(darts))}

    state = service.get_one_two_one_state()
    if state is not None:
        current_turn = state.get("currentTurn", {}) or {}
        darts = current_turn.get("darts")
        if isinstance(darts, list):
            return {"scores": darts[:3] + [None] * max(0, 3 - len(darts))}

    state = service.get_target_trainer_state()
    if state is not None:
        current_turn = state.get("currentTurn", {}) or {}
        darts = current_turn.get("darts")
        if isinstance(darts, list):
            return {"scores": darts[:3] + [None] * max(0, 3 - len(darts))}

    scores: list[Any] = [None, None, None]
    for idx in range(3):
        round_entry = dartcounter.get_round_dart_result(idx + 1)
        if round_entry is None:
            continue
        score_value = int(round_entry.get("voted_score_value", 0) or 0)
        score = round_entry.get("voted_score") or {}
        scores[idx] = _coerce_score_payload(score, score_value)
    return {"scores": scores}


@router.get("/api/detection/round-dart/{dart_index}")
def get_detection_round_dart(dart_index: int, include_candidates: bool = False) -> dict[str, Any]:
    if dart_index < 1 or dart_index > 3:
        raise HTTPException(status_code=400, detail="dart_index must be between 1 and 3")

    round_entry = dartcounter.get_round_dart_result(dart_index)
    if round_entry is None:
        raise HTTPException(status_code=404, detail="Round dart result not found")

    primary = _pick_primary_candidate(round_entry)
    payload: dict[str, Any] = {
        "dart_index": int(round_entry.get("dart_index", dart_index) or dart_index),
        "active_model_id": str(round_entry.get("active_model_id", "") or "unknown"),
        "voted_score_value": int(round_entry.get("voted_score_value", 0) or 0),
        "voted_score": dict(round_entry.get("voted_score", {}) or {}),
        "votes": int(round_entry.get("votes", 0) or 0),
        "ts_ms": int(round_entry.get("ts_ms", 0) or 0),
        "primary_candidate": _serialize_candidate(primary) if isinstance(primary, dict) else None,
    }

    if include_candidates:
        raw_candidates = round_entry.get("candidates", []) or []
        candidates = [
            _serialize_candidate(c)
            for c in raw_candidates
            if isinstance(c, dict)
        ]
        payload["candidates"] = candidates

    return {"round_dart": payload}


@router.get("/api/replay/highlight/latest")
def get_latest_highlight_replay(
    min_score: int = 60,
    camera_index: int | None = None,
    replay_type: str = "score",
    autosave: bool = True,
) -> dict[str, Any]:
    global _LAST_HIGHLIGHT_REPLAY
    replay = _build_fronton_replay_frames(
        min_score=int(min_score),
        camera_index=camera_index,
        replay_type=replay_type,
    )
    print(
        "[replay] latest "
        f"min_score={int(min_score)} "
        f"type={_normalize_replay_type(replay_type)} "
        f"camera_index={camera_index if camera_index is not None else 'auto'} "
        f"ready={bool(replay.get('ready'))} "
        f"reason={replay.get('reason', '-') } "
        f"turn_total={replay.get('turn_total', '-')} "
        f"trigger_score={replay.get('trigger_score', '-')} "
        f"autosave={bool(autosave)} "
        f"player_available={bool((replay.get('player_replay') or {}).get('available')) if isinstance(replay.get('player_replay'), dict) else False} "
        f"player_frames={len((replay.get('player_replay') or {}).get('frames', [])) if isinstance(replay.get('player_replay'), dict) else 0} "
        f"player_reason={(replay.get('player_replay') or {}).get('reason', '-') if isinstance(replay.get('player_replay'), dict) else '-'} "
        f"player_source={(replay.get('player_replay') or {}).get('frame_source', '-') if isinstance(replay.get('player_replay'), dict) else '-'}"
    )
    if bool(replay.get("ready")):
        _LAST_HIGHLIGHT_REPLAY = replay
        if bool(autosave):
            _autosave_highlight_replay_if_enabled(replay)
        return {"replay": replay}
    if _LAST_HIGHLIGHT_REPLAY and bool(_LAST_HIGHLIGHT_REPLAY.get("ready")):
        cached = dict(_LAST_HIGHLIGHT_REPLAY)
        cached["from_cache"] = True
        cached["replay_type"] = _normalize_replay_type(cached.get("replay_type", replay_type))
        if bool(autosave):
            _autosave_highlight_replay_if_enabled(cached)
        return {"replay": cached}
    return {"replay": replay}


@router.get("/api/replay/highlight/latest.mp4")
def download_latest_highlight_replay(
    min_score: int = 60,
    camera_index: int | None = None,
    replay_type: str = "score",
) -> FileResponse:
    global _LAST_HIGHLIGHT_REPLAY
    replay = _build_fronton_replay_frames(
        min_score=int(min_score),
        camera_index=camera_index,
        replay_type=replay_type,
    )
    if bool(replay.get("ready")):
        _LAST_HIGHLIGHT_REPLAY = replay
        _autosave_highlight_replay_if_enabled(replay)
    elif _LAST_HIGHLIGHT_REPLAY and bool(_LAST_HIGHLIGHT_REPLAY.get("ready")):
        replay = dict(_LAST_HIGHLIGHT_REPLAY)
        replay["replay_type"] = _normalize_replay_type(replay.get("replay_type", replay_type))
    if not bool(replay.get("ready")):
        raise HTTPException(status_code=404, detail=f"No replay ready: {replay.get('reason', 'unknown')}")

    frames_bgr, replay_fps = _render_replay_video_frames(replay)
    if not frames_bgr:
        raise HTTPException(status_code=404, detail="Replay frames unavailable")

    replays_dir = get_data_root() / "replays"
    replays_dir.mkdir(parents=True, exist_ok=True)
    mp4_path = replays_dir / _highlight_replay_filename(replay, timestamp_ms=int(time.time() * 1000), include_camera=False)
    ok = _write_replay_mp4(frames_bgr, mp4_path, fps=replay_fps, hold_frames_per_input=1)
    if not ok:
        raise HTTPException(status_code=500, detail="Failed to render replay video")

    return FileResponse(
        path=str(mp4_path),
        media_type="video/mp4",
        filename=mp4_path.name,
    )


@router.post("/api/correction/score")
def correct_score(payload: dict) -> dict:
    dart_index = int(payload.get("dartIndex", -1))
    if dart_index < 0 or dart_index >= 3:
        raise HTTPException(status_code=400, detail="dartIndex must be between 0 and 2")

    is_bouncer = bool(payload.get("bouncer", False))
    multiplier = int(payload.get("multiplier", 1))
    segment = int(payload.get("segment", 20))
    score_value = int(payload.get("score", segment * max(0, multiplier)))
    if is_bouncer:
        multiplier = 0
        segment = 0
        score_value = 0

    if multiplier < 0 or multiplier > 3:
        raise HTTPException(status_code=400, detail="multiplier must be between 0 and 3")
    if segment < 0 or segment > 25:
        raise HTTPException(status_code=400, detail="segment must be between 0 and 25")
    if score_value < 0 or score_value > 60:
        raise HTTPException(status_code=400, detail="score must be between 0 and 60")

    round_entry = dartcounter.get_round_dart_result(dart_index + 1, include_previous=True)
    round_session_id = int(round_entry.get("round_session_id", 0)) if round_entry is not None else None
    original_score_value = int(round_entry.get("voted_score_value", 0)) if round_entry is not None else None
    if round_entry is not None:
        active_model_id = str(round_entry.get("active_model_id", "") or "unknown")
    else:
        active_model_id = "opencv-line-fit"
    corrected_score_payload = _format_score_payload(
        segment=segment,
        multiplier=multiplier,
        score=score_value,
        zone_hint=str(payload.get("zone", "") or ""),
    )
    if round_entry is not None and not is_bouncer:
        try:
            training = _save_correction_training_data(
                dart_index_zero_based=dart_index,
                round_entry=round_entry,
                corrected_score_value=score_value,
                corrected_score_payload=corrected_score_payload,
            )
        except Exception as exc:
            print(f"[WARN] correction training save failed: {exc}")
            training = {
                "saved_images": 0,
                "camera_frames": [],
                "score_files": [],
                "message": f"Applied correction without saving training data: {exc}",
            }
    else:
        training = {
            "saved_images": 0,
            "camera_frames": [],
            "score_files": [],
            "message": "Bouncer applied; skipped training capture."
            if is_bouncer
            else "No captured dart frames available; applied correction without saving debug data.",
        }
        if not is_bouncer:
            print(
                f"[CORRECTION] no debug pack saved for dart {dart_index + 1}: "
                "no current or previous captured round entry"
            )
    if not is_bouncer:
        record_model_correction(active_model_id)
        try:
            record_corrected_dart(
                round_session_id=round_session_id,
                dart_index=dart_index,
                original_score_value=original_score_value,
                corrected_score_value=score_value,
                event_kind="score_correction",
            )
        except Exception as exc:
            print(f"[WARN] system accuracy correction count failed: {exc}")

    publish_detection_event(
        {
            "type": "dart_score_corrected",
            "dart_index": dart_index,
            "active_model_id": active_model_id,
            "original_score_value": original_score_value,
            "corrected_score_value": score_value,
            "corrected_score": corrected_score_payload,
            "bouncer": is_bouncer,
            "saved_images": int(training.get("saved_images", 0)),
        }
    )

    return {
        "status": "success",
        "dart_index": dart_index,
        "original_score_value": original_score_value,
        "corrected_score_value": score_value,
        "corrected_score": corrected_score_payload,
        "bouncer": is_bouncer,
        "training_data": training,
    }


@router.post("/api/correction/add-dart")
def add_dart_correction(payload: dict) -> dict[str, Any]:
    dart_index = int(payload.get("dartIndex", -1))
    if dart_index < 0 or dart_index >= 3:
        raise HTTPException(status_code=400, detail="dartIndex must be between 0 and 2")

    is_bouncer = bool(payload.get("bouncer", False))
    multiplier = int(payload.get("multiplier", 1))
    segment = int(payload.get("segment", 20))
    score_value = int(payload.get("score", segment * max(0, multiplier)))
    if is_bouncer:
        multiplier = 0
        segment = 0
        score_value = 0

    if multiplier < 0 or multiplier > 3:
        raise HTTPException(status_code=400, detail="multiplier must be between 0 and 3")
    if segment < 0 or segment > 25:
        raise HTTPException(status_code=400, detail="segment must be between 0 and 25")
    if score_value < 0 or score_value > 60:
        raise HTTPException(status_code=400, detail="score must be between 0 and 60")

    active_model_id = "opencv-line-fit"
    corrected_score_payload = _format_score_payload(
        segment=segment,
        multiplier=multiplier,
        score=score_value,
        zone_hint=str(payload.get("zone", "") or ""),
    )
    round_entry = dartcounter.get_round_dart_result(dart_index + 1, include_previous=True)
    round_session_id = int(round_entry.get("round_session_id", 0)) if round_entry is not None else None
    debug_training: dict[str, Any] = {
        "saved_images": 0,
        "debug_frames": 0,
        "debug_masks": 0,
        "message": "No captured dart frames available; added dart without saving debug data.",
    }
    if round_entry is not None and not is_bouncer:
        try:
            debug_training = _save_correction_training_data(
                dart_index_zero_based=dart_index,
                round_entry=round_entry,
                corrected_score_value=score_value,
                corrected_score_payload=corrected_score_payload,
            )
        except Exception as exc:
            print(f"[WARN] add-dart debug save failed: {exc}")
            debug_training = {
                "saved_images": 0,
                "debug_frames": 0,
                "debug_masks": 0,
                "message": f"Added dart without saving debug data: {exc}",
            }
    elif not is_bouncer:
        print(
            f"[CORRECTION] no debug pack saved for added dart {dart_index + 1}: "
            "no current or previous captured round entry"
        )
    if not is_bouncer:
        record_model_correction(active_model_id)
        try:
            record_corrected_dart(
                round_session_id=round_session_id,
                dart_index=dart_index,
                original_score_value=None,
                corrected_score_value=score_value,
                event_kind="added_dart",
            )
        except Exception as exc:
            print(f"[WARN] system accuracy add-dart count failed: {exc}")
    publish_detection_event(
        {
            "type": "dart_score_corrected",
            "dart_index": dart_index,
            "active_model_id": active_model_id,
            "original_score_value": None,
            "corrected_score_value": score_value,
            "corrected_score": corrected_score_payload,
            "bouncer": is_bouncer,
            "saved_images": 0,
            "debug_dir": debug_training.get("debug_dir"),
            "manual_add": True,
        }
    )
    return {
        "status": "success",
        "dart_index": dart_index,
        "corrected_score_value": score_value,
        "corrected_score": corrected_score_payload,
        "bouncer": is_bouncer,
        "training_data": debug_training,
    }


@router.post("/api/correction/delete-images")
def delete_correction_images(_: dict | None = None) -> dict[str, str]:
    return {"status": "success"}


@router.get("/api/benchmark-dataset/status")
def get_benchmark_dataset_status(dataset_name: str = "default") -> dict[str, Any]:
    dataset_id = _sanitize_dataset_name(dataset_name)
    return {"status": "success", **_benchmark_dataset_status(dataset_id)}


@router.post("/api/benchmark-dataset/save-turn")
def save_benchmark_dataset_turn(payload: dict | None = None) -> dict[str, Any]:
    body = payload or {}
    dataset_id = _sanitize_dataset_name(str(body.get("dataset_name", "default")))
    raw_scores = body.get("scores", [])
    if not isinstance(raw_scores, list):
        raise HTTPException(status_code=400, detail="scores must be an array")

    final_scores = [_coerce_score_list_item(score) for score in raw_scores[:3]]
    if not any(score is not None for score in final_scores):
        raise HTTPException(status_code=400, detail="No dart scores available to save.")

    dataset_root = _resolve_benchmark_data_dir() / dataset_id
    dataset_root.mkdir(parents=True, exist_ok=True)
    calibration_snapshot = _copy_calibration_snapshot(dataset_root)
    next_turn_index = 1
    existing_turns = sorted([p for p in dataset_root.glob("turn_*") if p.is_dir()])
    if existing_turns:
        try:
            next_turn_index = max(int(p.name.split("_")[1]) for p in existing_turns) + 1
        except Exception:
            next_turn_index = len(existing_turns) + 1

    turn_dir = dataset_root / f"turn_{next_turn_index:04d}"
    turn_dir.mkdir(parents=True, exist_ok=True)

    saved_images = 0
    darts_payload: list[dict[str, Any]] = []
    for idx, final_score in enumerate(final_scores, start=1):
        round_entry = dartcounter.get_round_dart_result(idx)
        dart_dir = turn_dir / f"dart_{idx}"
        dart_dir.mkdir(parents=True, exist_ok=True)

        entry: dict[str, Any] = {
            "dart_index": idx,
            "final_score": final_score,
            "captured": round_entry is not None,
        }
        if round_entry is not None:
            entry.update(
                {
                    "active_model_id": str(round_entry.get("active_model_id", "") or ""),
                    "original_score_value": int(round_entry.get("voted_score_value", 0) or 0),
                    "original_score": round_entry.get("voted_score") or {},
                    "votes": int(round_entry.get("votes", 0) or 0),
                    "candidates": round_entry.get("candidates", []) or [],
                    "processing_ms": float(round_entry.get("processing_ms", 0.0) or 0.0),
                    "total_ms": float(round_entry.get("total_ms", 0.0) or 0.0),
                    "ts_ms": int(round_entry.get("ts_ms", 0) or 0),
                }
            )
            for cam_idx, frame in enumerate(round_entry.get("frames", []), start=1):
                if frame is None or not isinstance(frame, np.ndarray):
                    continue
                image_path = dart_dir / f"cam{cam_idx}.png"
                cv2.imwrite(str(image_path), frame)
                saved_images += 1
        darts_payload.append(entry)

    metadata = {
        "dataset_name": dataset_id,
        "turn_index": next_turn_index,
        "saved_at_ms": int(time.time() * 1000),
        "dart_count": sum(1 for score in final_scores if score is not None),
        "saved_images": saved_images,
        "calibration_snapshot": calibration_snapshot,
        "darts": darts_payload,
    }
    metadata_path = turn_dir / "metadata.json"
    metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    return {
        "status": "success",
        "dataset_name": dataset_id,
        "turn_index": next_turn_index,
        "saved_images": saved_images,
        "metadata_path": str(metadata_path),
        "calibration_snapshot": calibration_snapshot,
        "summary": _benchmark_dataset_status(dataset_id),
    }
