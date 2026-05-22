from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any


def _is_packaged_runtime() -> bool:
    exe_name = Path(sys.executable).name.lower()
    return bool(
        getattr(sys, "frozen", False)
        or "__compiled__" in globals()
        or exe_name in {"darts-backend.exe", "darts-backend"}
    )


def _data_root() -> Path:
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

_LOCK = threading.Lock()
_STATS_PATH = _data_root() / "backend" / "data" / "settings" / "system_accuracy.json"
if _is_packaged_runtime():
    _STATS_PATH = _data_root() / "settings" / "system_accuracy.json"


def _empty_stats() -> dict[str, Any]:
    now = int(time.time() * 1000)
    return {
        "started_at_ms": now,
        "updated_at_ms": now,
        "dart_count": 0,
        "correction_count": 0,
        "corrected_dart_keys": [],
    }


def _read_unlocked() -> dict[str, Any]:
    if not _STATS_PATH.exists():
        return _empty_stats()
    try:
        payload = json.loads(_STATS_PATH.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            return _empty_stats()
    except Exception:
        return _empty_stats()

    base = _empty_stats()
    base.update(payload)
    base["dart_count"] = max(0, int(base.get("dart_count", 0) or 0))
    base["correction_count"] = max(0, int(base.get("correction_count", 0) or 0))
    keys = base.get("corrected_dart_keys")
    base["corrected_dart_keys"] = [str(k) for k in keys] if isinstance(keys, list) else []
    return base


def _write_unlocked(payload: dict[str, Any]) -> None:
    _STATS_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload["updated_at_ms"] = int(time.time() * 1000)
    _STATS_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _public(payload: dict[str, Any]) -> dict[str, Any]:
    darts = max(0, int(payload.get("dart_count", 0) or 0))
    corrections = max(0, int(payload.get("correction_count", 0) or 0))
    correct = max(0, darts - corrections)
    accuracy = (correct / darts * 100.0) if darts > 0 else None
    correction_rate = (corrections / darts * 100.0) if darts > 0 else None
    return {
        "started_at_ms": int(payload.get("started_at_ms", 0) or 0),
        "updated_at_ms": int(payload.get("updated_at_ms", 0) or 0),
        "dart_count": darts,
        "correction_count": corrections,
        "correct_count": correct,
        "accuracy_percent": round(float(accuracy), 2) if accuracy is not None else None,
        "correction_rate_percent": round(float(correction_rate), 2) if correction_rate is not None else None,
    }


def get_stats() -> dict[str, Any]:
    with _LOCK:
        return _public(_read_unlocked())


def reset_stats() -> dict[str, Any]:
    with _LOCK:
        payload = _empty_stats()
        _write_unlocked(payload)
        return _public(payload)


def record_detected_dart(*, round_session_id: int, dart_index: int, score_value: int | None = None) -> None:
    # Keep the signature descriptive; score_value is reserved for later breakdowns.
    _ = score_value
    with _LOCK:
        payload = _read_unlocked()
        payload["dart_count"] = int(payload.get("dart_count", 0) or 0) + 1
        _write_unlocked(payload)


def record_corrected_dart(
    *,
    round_session_id: int | None,
    dart_index: int,
    original_score_value: int | None,
    corrected_score_value: int,
    event_kind: str = "score_correction",
) -> None:
    original = int(original_score_value) if original_score_value is not None else None
    corrected = int(corrected_score_value)
    if event_kind == "score_correction" and original is not None and original == corrected:
        return

    with _LOCK:
        payload = _read_unlocked()
        keys = [str(k) for k in payload.get("corrected_dart_keys", [])]
        session_part = str(round_session_id) if round_session_id is not None else "unknown"
        key = f"{event_kind}:{session_part}:{int(dart_index)}"
        if key in keys:
            return
        keys.append(key)
        payload["corrected_dart_keys"] = keys[-5000:]
        payload["correction_count"] = int(payload.get("correction_count", 0) or 0) + 1
        if event_kind == "added_dart":
            payload["dart_count"] = int(payload.get("dart_count", 0) or 0) + 1
        _write_unlocked(payload)
