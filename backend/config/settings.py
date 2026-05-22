from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import contextlib
from pathlib import Path
from pydantic import BaseModel


def _is_packaged_runtime() -> bool:
    exe_name = Path(sys.executable).name.lower()
    return bool(
        getattr(sys, "frozen", False)
        or "__compiled__" in globals()
        or exe_name in {"darts-backend.exe", "darts-backend"}
    )


def _resolve_data_root() -> Path:
    """Return the data root path.

    - Frozen exe: use writable user data at %APPDATA%/DartDetector.
    - Script: use repo-local backend/data.
    """
    if _is_packaged_runtime():
        if os.name == "nt":
            appdata = os.getenv("APPDATA", "").strip()
            if appdata:
                return Path(appdata).resolve() / "DartDetector"
            return Path.home() / "AppData" / "Roaming" / "DartDetector"
        xdg_data_home = os.getenv("XDG_DATA_HOME", "").strip()
        base = Path(xdg_data_home).resolve() if xdg_data_home else Path.home() / ".local" / "share"
        return base / "DartDetector"
    return Path(__file__).resolve().parents[2]


_DATA_ROOT = _resolve_data_root()


def _env_int(name: str, default: int, *, minimum: int = 1, maximum: int = 8) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return int(default)
    try:
        value = int(raw)
    except Exception:
        return int(default)
    return max(int(minimum), min(int(maximum), value))


_SCORING_COUNT_ENV_SET = bool(os.getenv("MACHINE_DARTS_SCORING_CAMERA_COUNT", "").strip())
_CAMERA_SLOT_COUNT_ENV_SET = bool(os.getenv("MACHINE_DARTS_CAMERA_SLOT_COUNT", "").strip())
_REQUESTED_SCORING_CAMERA_COUNT = _env_int("MACHINE_DARTS_SCORING_CAMERA_COUNT", 3)
DEFAULT_CAMERA_SLOT_COUNT = _env_int(
    "MACHINE_DARTS_CAMERA_SLOT_COUNT",
    max(_REQUESTED_SCORING_CAMERA_COUNT + 1, 4),
)
DEFAULT_SCORING_CAMERA_COUNT = min(_REQUESTED_SCORING_CAMERA_COUNT, DEFAULT_CAMERA_SLOT_COUNT)


def _camera_indices_file() -> Path:
    if _is_packaged_runtime():
        return _DATA_ROOT / "settings" / "camera_indices.json"
    return _DATA_ROOT / "backend" / "data" / "settings" / "camera_indices.json"


def _camera_identity_file() -> Path:
    if _is_packaged_runtime():
        return _DATA_ROOT / "settings" / "camera_identity.json"
    return _DATA_ROOT / "backend" / "data" / "settings" / "camera_identity.json"


def enumerate_camera_device_identities(max_devices: int = 32) -> dict[int, dict[str, str | int | None]]:
    max_devices = max(1, min(int(max_devices), 64))
    identities: dict[int, dict[str, str | int | None]] = {}
    try:
        if sys.platform.startswith("win"):
            command = [
                "powershell",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                (
                    "$items = Get-CimInstance Win32_PnPEntity | "
                    "Where-Object { ($_.PNPClass -in @('Camera','Image') -or $_.Name -match 'webcam|usb video') "
                    "-and $_.Name -notmatch 'microphone|audio|speaker|sound' } | "
                    "Select-Object Name,PNPDeviceID,PNPClass; "
                    "$items | ConvertTo-Json -Compress"
                ),
            ]
            proc = subprocess.run(command, capture_output=True, text=True, timeout=3)
            raw = proc.stdout.strip()
            parsed = json.loads(raw) if raw else []
            if isinstance(parsed, dict):
                parsed = [parsed]
            if isinstance(parsed, list):
                for idx, item in enumerate(parsed[:max_devices]):
                    if not isinstance(item, dict):
                        continue
                    name = str(item.get("Name") or "").strip()
                    device_id = str(item.get("PNPDeviceID") or "").strip()
                    identities[idx] = {
                        "index": idx,
                        "label": name or f"Device {idx}",
                        "device_id": device_id or None,
                    }
        elif sys.platform.startswith("linux"):
            by_id = Path("/dev/v4l/by-id")
            by_path = Path("/dev/v4l/by-path")
            for base in (by_id, by_path):
                if not base.exists():
                    continue
                for link in sorted(base.iterdir()):
                    try:
                        target = link.resolve()
                        if not target.name.startswith("video"):
                            continue
                        idx = int(target.name.replace("video", ""))
                        if idx >= max_devices or idx in identities:
                            continue
                        identities[idx] = {
                            "index": idx,
                            "label": link.name.replace("-video-index0", "").replace("_", " "),
                            "device_id": str(link),
                        }
                    except Exception:
                        continue
    except Exception:
        pass
    return identities


@contextlib.contextmanager
def _quiet_cv2_logs():
    try:
        import cv2
    except Exception:
        yield
        return
    previous_level = None
    try:
        get_level = getattr(cv2, "getLogLevel", None)
        set_level = getattr(cv2, "setLogLevel", None)
        if callable(get_level) and callable(set_level):
            previous_level = int(get_level())
            set_level(0)
    except Exception:
        previous_level = None
    devnull = None
    saved_stderr_fd = None
    try:
        try:
            devnull = open(os.devnull, "w", encoding="utf-8")
            saved_stderr_fd = os.dup(2)
            os.dup2(devnull.fileno(), 2)
        except Exception:
            saved_stderr_fd = None
        yield
    finally:
        if saved_stderr_fd is not None:
            try:
                os.dup2(saved_stderr_fd, 2)
                os.close(saved_stderr_fd)
            except Exception:
                pass
        if devnull is not None:
            try:
                devnull.close()
            except Exception:
                pass
        if previous_level is not None:
            try:
                cv2.setLogLevel(int(previous_level))
            except Exception:
                pass


def probe_opencv_camera_indices(max_devices: int = 16) -> list[int]:
    try:
        import cv2
    except Exception:
        return []
    max_devices = max(1, min(int(max_devices), 64))
    if sys.platform.startswith("win"):
        backends = [getattr(cv2, "CAP_DSHOW", None), getattr(cv2, "CAP_MSMF", None), int(cv2.CAP_ANY)]
    elif sys.platform.startswith("linux"):
        backends = [getattr(cv2, "CAP_V4L2", None), int(cv2.CAP_ANY)]
    elif sys.platform == "darwin":
        backends = [getattr(cv2, "CAP_AVFOUNDATION", None), int(cv2.CAP_ANY)]
    else:
        backends = [int(cv2.CAP_ANY)]
    backend_flags: list[int] = []
    for backend in backends:
        if backend is None:
            continue
        try:
            flag = int(backend)
        except Exception:
            continue
        if flag not in backend_flags:
            backend_flags.append(flag)

    def _open_probe_capture(index: int, backend: int):
        if sys.platform.startswith("win") and backend == int(getattr(cv2, "CAP_DSHOW", -1)):
            try:
                fourcc = int(cv2.VideoWriter_fourcc(*"MJPG"))
                return cv2.VideoCapture(
                    int(index),
                    int(backend),
                    [
                        int(cv2.CAP_PROP_FOURCC),
                        fourcc,
                        int(cv2.CAP_PROP_FRAME_WIDTH),
                        1280,
                        int(cv2.CAP_PROP_FRAME_HEIGHT),
                        720,
                        int(cv2.CAP_PROP_FPS),
                        30,
                    ],
                )
            except TypeError:
                pass
        return cv2.VideoCapture(int(index), int(backend))

    found: list[int] = []
    with _quiet_cv2_logs():
        for idx in range(max_devices):
            for backend in backend_flags:
                cap = None
                try:
                    cap = _open_probe_capture(int(idx), int(backend))
                    if not cap or not cap.isOpened():
                        continue
                    time.sleep(0.02)
                    ok, frame = cap.read()
                    if ok and frame is not None:
                        found.append(idx)
                        break
                except Exception:
                    continue
                finally:
                    if cap is not None:
                        try:
                            cap.release()
                        except Exception:
                            pass
    return found


def _compact_saved_indices(indices: list[int], target_count: int) -> list[int] | None:
    current_indices = sorted(
        int(idx)
        for idx in probe_opencv_camera_indices(max(16, max([int(idx) for idx in indices] + [0]) + 3))
    )
    if len(current_indices) < DEFAULT_SCORING_CAMERA_COUNT:
        return None
    adjusted = _extend_camera_indices(indices, target_count)

    scoring_indices = [int(idx) for idx in adjusted[:DEFAULT_SCORING_CAMERA_COUNT]]
    scoring_indices_are_usable = (
        len(set(scoring_indices)) == DEFAULT_SCORING_CAMERA_COUNT
        and all(idx in current_indices for idx in scoring_indices)
    )
    if scoring_indices_are_usable:
        return None

    repaired = list(current_indices[:target_count])
    used = {int(idx) for idx in repaired}
    fallback = 0
    while len(repaired) < target_count:
        while fallback in used:
            fallback += 1
        repaired.append(fallback)
        used.add(fallback)
    return repaired


def _load_camera_identity_slots() -> list[dict] | None:
    path = _camera_identity_file()
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    slots = payload.get("slots") if isinstance(payload, dict) else None
    return slots if isinstance(slots, list) else None


def _resolve_camera_indices_from_identities(indices: list[int], target_count: int) -> list[int] | None:
    slots = _load_camera_identity_slots()
    if not slots:
        return None
    current = enumerate_camera_device_identities()
    by_id = {
        str(info.get("device_id") or ""): int(idx)
        for idx, info in current.items()
        if str(info.get("device_id") or "").strip()
    }
    if not by_id:
        return None

    adjusted = _extend_camera_indices(indices, target_count)
    resolved_slots: set[int] = set()
    used: set[int] = set()
    for item in slots:
        if not isinstance(item, dict):
            continue
        try:
            slot = int(item.get("slot"))
        except Exception:
            continue
        if slot < 0 or slot >= target_count:
            continue
        device_id = str(item.get("device_id") or "").strip()
        if not device_id or device_id not in by_id:
            continue
        idx = int(by_id[device_id])
        if idx in used:
            continue
        adjusted[slot] = idx
        resolved_slots.add(slot)
        used.add(idx)

    if not resolved_slots:
        return None

    used = {int(adjusted[slot]) for slot in resolved_slots}
    for slot in range(target_count):
        idx = int(adjusted[slot])
        if slot in resolved_slots:
            continue
        if idx not in used:
            used.add(idx)
            continue
        fallback = 0
        while fallback in used:
            fallback += 1
        adjusted[slot] = fallback
        used.add(fallback)
    return adjusted


def _repair_camera_indices_from_current_devices(indices: list[int], target_count: int) -> list[int] | None:
    current_indices = probe_opencv_camera_indices(max(16, max([int(idx) for idx in indices] + [0]) + 3))
    if len(current_indices) < DEFAULT_SCORING_CAMERA_COUNT:
        return None

    adjusted = _extend_camera_indices(indices, target_count)
    available = set(current_indices)
    used: set[int] = set()
    missing_scoring_slots: list[int] = []

    for slot in range(min(DEFAULT_SCORING_CAMERA_COUNT, target_count)):
        idx = int(adjusted[slot])
        if idx in available and idx not in used:
            used.add(idx)
            continue
        missing_scoring_slots.append(slot)

    remaining_available = [idx for idx in current_indices if idx not in used]
    if len(remaining_available) < len(missing_scoring_slots):
        return None

    changed = False
    missing_or_duplicate_indices = {
        int(adjusted[slot])
        for slot in missing_scoring_slots
    }
    for slot in missing_scoring_slots:
        replacement = int(remaining_available.pop(0))
        if int(adjusted[slot]) != replacement:
            changed = True
        adjusted[slot] = replacement
        used.add(replacement)

    for slot in range(DEFAULT_SCORING_CAMERA_COUNT, target_count):
        idx = int(adjusted[slot])
        if idx not in used:
            used.add(idx)
            continue
        replacement = next((old for old in missing_or_duplicate_indices if old not in used), None)
        if replacement is None:
            replacement = 0
            while replacement in used:
                replacement += 1
        adjusted[slot] = int(replacement)
        used.add(int(replacement))
        changed = True

    if not changed:
        return None
    return adjusted


def _save_camera_identity_slots(indices: list[int]) -> None:
    identities = enumerate_camera_device_identities()
    slots: list[dict] = []
    for slot, index in enumerate(indices):
        info = identities.get(int(index), {})
        slots.append(
            {
                "slot": int(slot),
                "role": "scoring" if slot < DEFAULT_SCORING_CAMERA_COUNT else "player",
                "index": int(index),
                "label": info.get("label") or f"Device {int(index)}",
                "device_id": info.get("device_id"),
            }
        )
    path = _camera_identity_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"slots": slots}, indent=2), encoding="utf-8")


def _load_camera_indices_file() -> list[int] | None:
    path = _camera_indices_file()
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None

    raw = payload.get("indices") if isinstance(payload, dict) else payload
    if not isinstance(raw, list):
        return None
    try:
        parsed = [int(part) for part in raw]
    except Exception:
        return None
    if not parsed:
        return None
    return parsed


def _extend_camera_indices(indices: list[int], target_count: int) -> list[int]:
    adjusted = list(indices[:target_count])
    next_idx = 0
    while len(adjusted) < target_count:
        if next_idx not in adjusted:
            adjusted.append(next_idx)
        next_idx += 1
    return adjusted


def _default_camera_indices() -> list[int]:
    raw = os.getenv("MACHINE_DARTS_CAMERA_INDICES", "").strip()
    if raw:
        try:
            parsed = [int(part.strip()) for part in raw.split(",") if part.strip() != ""]
            if parsed:
                return parsed
        except Exception:
            pass
    file_indices = _load_camera_indices_file()
    if file_indices:
        compacted = _compact_saved_indices(file_indices, DEFAULT_CAMERA_SLOT_COUNT)
        if compacted:
            try:
                path = _camera_indices_file()
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps({"indices": compacted}, indent=2), encoding="utf-8")
                _save_camera_identity_slots(compacted)
            except Exception:
                pass
            return compacted
        use_identity_remap = os.getenv("MACHINE_DARTS_USE_CAMERA_IDENTITIES", "").strip().lower()
        if use_identity_remap in {"1", "true", "yes", "on"}:
            resolved = _resolve_camera_indices_from_identities(file_indices, DEFAULT_CAMERA_SLOT_COUNT)
            if resolved:
                return resolved
        repaired = _repair_camera_indices_from_current_devices(file_indices, DEFAULT_CAMERA_SLOT_COUNT)
        if repaired:
            try:
                path = _camera_indices_file()
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps({"indices": repaired}, indent=2), encoding="utf-8")
                _save_camera_identity_slots(repaired)
            except Exception:
                pass
            return repaired
        if _SCORING_COUNT_ENV_SET or _CAMERA_SLOT_COUNT_ENV_SET:
            return _extend_camera_indices(file_indices, DEFAULT_CAMERA_SLOT_COUNT)
        if len(file_indices) < DEFAULT_CAMERA_SLOT_COUNT:
            return _extend_camera_indices(file_indices, DEFAULT_CAMERA_SLOT_COUNT)
        return file_indices
    detected_indices = []
    if not sys.platform.startswith("linux"):
        detected_indices = sorted(int(idx) for idx in probe_opencv_camera_indices(max(16, DEFAULT_CAMERA_SLOT_COUNT + 4)))
    if len(detected_indices) >= DEFAULT_SCORING_CAMERA_COUNT:
        selected = list(detected_indices[:DEFAULT_CAMERA_SLOT_COUNT])
        used = {int(idx) for idx in selected}
        fallback = 0
        while len(selected) < DEFAULT_CAMERA_SLOT_COUNT:
            while fallback in used:
                fallback += 1
            selected.append(fallback)
            used.add(fallback)
        try:
            path = _camera_indices_file()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"indices": selected}, indent=2), encoding="utf-8")
            _save_camera_identity_slots(selected)
        except Exception:
            pass
        return selected
    if sys.platform.startswith("linux"):
        # Linux UVC cameras often expose paired nodes, such as /dev/video0 plus
        # /dev/video1 for one physical camera. Even indices are safer defaults.
        return [idx * 2 for idx in range(DEFAULT_CAMERA_SLOT_COUNT)]
    return list(range(DEFAULT_CAMERA_SLOT_COUNT))


class Settings(BaseModel):
    camera_indices: list[int] = _default_camera_indices()
    calibration_data_dir: str = str(
        (_DATA_ROOT / "calibration") if _is_packaged_runtime() else (_DATA_ROOT / "backend" / "data" / "calibration")
    )
    camera_width: int = 1280
    camera_height: int = 720
    camera_fps: int = 30
    jpeg_quality: int = 70
    ws_camera_fps: float = 30.0


settings = Settings()


def get_data_root() -> Path:
    return _DATA_ROOT


def set_camera_indices(indices: list[int], persist: bool = True) -> list[int]:
    normalized = [int(idx) for idx in indices]
    if not normalized:
        raise ValueError("camera indices cannot be empty")
    if len(set(normalized)) != len(normalized):
        raise ValueError("camera indices must be unique")
    settings.camera_indices = normalized
    if persist:
        path = _camera_indices_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"indices": normalized}, indent=2), encoding="utf-8")
        _save_camera_identity_slots(normalized)
    return normalized


def scoring_camera_indices() -> list[int]:
    return [int(idx) for idx in settings.camera_indices[:DEFAULT_SCORING_CAMERA_COUNT]]


def is_scoring_camera_slot(camera_index: int) -> bool:
    return 0 <= int(camera_index) < min(DEFAULT_SCORING_CAMERA_COUNT, len(settings.camera_indices))


def camera_slot_role(camera_index: int) -> str:
    return "scoring" if is_scoring_camera_slot(camera_index) else "player"
