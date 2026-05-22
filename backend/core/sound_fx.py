from __future__ import annotations

import json
import os
import sys
import base64
import re
import queue
import threading
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from backend.core.caller import _play_clip
from backend.core.detection_events import register_detection_event_listener


def _resolve_settings_path() -> Path:
    if getattr(sys, "frozen", False):
        if os.name == "nt":
            appdata = os.getenv("APPDATA", "").strip()
            base = Path(appdata).resolve() / "DartDetector" if appdata else Path.home() / "AppData" / "Roaming" / "DartDetector"
        else:
            xdg_data_home = os.getenv("XDG_DATA_HOME", "").strip()
            base = Path(xdg_data_home).resolve() if xdg_data_home else Path.home() / ".local" / "share"
            base = base / "DartDetector"
        return base / "settings" / "sound_fx.json"
    return Path(__file__).resolve().parents[1] / "data" / "settings" / "sound_fx.json"


SETTINGS_PATH = _resolve_settings_path()
SUPPORTED_AUDIO_EXTENSIONS = {".wav", ".mp3", ".ogg", ".m4a"}
SOUND_KEYS = {
    "triple",
    "double",
    "bull",
    "miss",
    "bust",
    "checkout",
    "cricket_valid",
    "cricket_invalid",
}
MAX_UPLOAD_BYTES = 5 * 1024 * 1024


def _resolve_upload_dir() -> Path:
    if getattr(sys, "frozen", False):
        return SETTINGS_PATH.parent.parent / "sound_fx"
    return Path(__file__).resolve().parents[1] / "data" / "sound_fx"


UPLOAD_DIR = _resolve_upload_dir()
_LOCK = threading.Lock()
_SERVICE: "SoundFxService | None" = None


@dataclass
class SoundFxSettings:
    enabled: bool = True
    volume: float = 0.75
    custom_sounds: dict[str, str] | None = None
    play_triple: bool = True
    play_double: bool = True
    play_bull: bool = True
    play_miss: bool = True
    play_bust: bool = True
    play_checkout: bool = True
    play_cricket_valid: bool = True
    play_cricket_invalid: bool = True

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "SoundFxSettings":
        out = cls()
        for key in cls.__dataclass_fields__.keys():  # type: ignore[attr-defined]
            if key in payload:
                setattr(out, key, payload[key])
        return out

    def normalized(self) -> "SoundFxSettings":
        self.enabled = bool(self.enabled)
        try:
            self.volume = float(self.volume)
        except Exception:
            self.volume = 0.75
        self.volume = max(0.0, min(1.0, self.volume))
        if not isinstance(self.custom_sounds, dict):
            self.custom_sounds = {}
        self.custom_sounds = {
            str(key): str(value)
            for key, value in self.custom_sounds.items()
            if str(key) in SOUND_KEYS and str(value).strip()
        }
        for key in (
            "play_triple",
            "play_double",
            "play_bull",
            "play_miss",
            "play_bust",
            "play_checkout",
            "play_cricket_valid",
            "play_cricket_invalid",
        ):
            setattr(self, key, bool(getattr(self, key)))
        return self


def _save_settings(settings: SoundFxSettings) -> None:
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(json.dumps(asdict(settings), indent=2), encoding="utf-8")


def _slugify_filename(value: str) -> str:
    stem = Path(value or "sound").stem.lower()
    stem = re.sub(r"[^a-z0-9_-]+", "-", stem).strip("-") or "sound"
    return stem[:48]


def get_sound_fx_settings() -> dict[str, Any]:
    if SETTINGS_PATH.exists():
        try:
            raw = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            settings = SoundFxSettings.from_dict(raw if isinstance(raw, dict) else {}).normalized()
            return asdict(settings)
        except Exception:
            pass
    settings = SoundFxSettings().normalized()
    _save_settings(settings)
    return asdict(settings)


def update_sound_fx_settings(incoming: dict[str, Any]) -> dict[str, Any]:
    current = get_sound_fx_settings()
    settings = SoundFxSettings.from_dict({**current, **(incoming or {})}).normalized()
    _save_settings(settings)
    return asdict(settings)


def reset_sound_fx_settings() -> dict[str, Any]:
    try:
        if UPLOAD_DIR.exists():
            for path in UPLOAD_DIR.iterdir():
                if path.is_file():
                    path.unlink()
    except Exception:
        pass
    settings = SoundFxSettings().normalized()
    _save_settings(settings)
    return asdict(settings)


def upload_sound_fx_file(sound_key: str, filename: str, content_base64: str) -> dict[str, Any]:
    sound_key = str(sound_key or "").strip().lower()
    if sound_key not in SOUND_KEYS:
        raise ValueError("unknown sound key")
    suffix = Path(filename or "").suffix.lower()
    if suffix not in SUPPORTED_AUDIO_EXTENSIONS:
        raise ValueError("unsupported audio file type")

    try:
        raw = base64.b64decode(str(content_base64 or ""), validate=True)
    except Exception as exc:
        raise ValueError("invalid audio file data") from exc
    if not raw:
        raise ValueError("audio file is empty")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise ValueError("audio file is too large")

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    target = UPLOAD_DIR / f"{sound_key}-{_slugify_filename(filename)}{suffix}"
    target.write_bytes(raw)

    current = get_sound_fx_settings()
    custom_sounds = dict(current.get("custom_sounds") or {})
    old_path = custom_sounds.get(sound_key)
    custom_sounds[sound_key] = str(target)
    settings = SoundFxSettings.from_dict({**current, "custom_sounds": custom_sounds}).normalized()
    _save_settings(settings)

    if old_path and old_path != str(target):
        try:
            old = Path(old_path)
            if old.is_file() and old.resolve().is_relative_to(UPLOAD_DIR.resolve()):
                old.unlink()
        except Exception:
            pass
    return asdict(settings)


def clear_sound_fx_file(sound_key: str) -> dict[str, Any]:
    sound_key = str(sound_key or "").strip().lower()
    if sound_key not in SOUND_KEYS:
        raise ValueError("unknown sound key")
    current = get_sound_fx_settings()
    custom_sounds = dict(current.get("custom_sounds") or {})
    old_path = custom_sounds.pop(sound_key, None)
    settings = SoundFxSettings.from_dict({**current, "custom_sounds": custom_sounds}).normalized()
    _save_settings(settings)
    if old_path:
        try:
            old = Path(old_path)
            if old.is_file() and old.resolve().is_relative_to(UPLOAD_DIR.resolve()):
                old.unlink()
        except Exception:
            pass
    return asdict(settings)


def _score_sound_key(event: dict[str, Any]) -> str | None:
    score = event.get("score") if isinstance(event.get("score"), dict) else {}
    value = NumberLike(event.get("score_value", score.get("score", 0))).to_int()
    zone = str(score.get("zone") or "").strip().lower()
    segment = str(score.get("segment") or "").strip()
    multiplier = NumberLike(score.get("multiplier", 0)).to_int()

    if value <= 0 or zone == "miss":
        return "miss"
    if zone == "inner_bull" or (segment == "25" and value == 50):
        return "bull"
    if zone == "outer_bull" or (segment == "25" and value == 25):
        return "bull"
    if zone == "triple" or multiplier == 3:
        return "triple"
    if zone == "double" or multiplier == 2:
        return "double"
    return None


class NumberLike:
    def __init__(self, value: Any):
        self.value = value

    def to_int(self) -> int:
        try:
            return int(round(float(self.value)))
        except Exception:
            return 0


class SoundFxService:
    def __init__(self) -> None:
        self._queue: "queue.Queue[str]" = queue.Queue()
        self._last_bust_key = ""
        self._last_checkout_key = ""
        self._worker = threading.Thread(target=self._worker_loop, name="sound-fx-playback", daemon=True)
        self._worker.start()
        register_detection_event_listener(self.on_event)

    def on_event(self, event: dict[str, Any]) -> None:
        try:
            event_type = str(event.get("type") or "")
            if event_type == "dart_score":
                self._queue_sound(_score_sound_key(event))
                return

            if event_type == "x01_state_updated":
                state = event.get("state") if isinstance(event.get("state"), dict) else {}
                current_turn = state.get("currentTurn") if isinstance(state.get("currentTurn"), dict) else {}
                last_turn = state.get("lastTurn") if isinstance(state.get("lastTurn"), dict) else {}
                if bool(current_turn.get("bust")) or bool(last_turn.get("bust")):
                    bust_turn = last_turn if bool(last_turn.get("bust")) else current_turn
                    bust_key = f"{bust_turn.get('playerIndex')}:{bust_turn.get('turnIndex')}:{bust_turn.get('scored')}"
                    if bust_key == self._last_bust_key:
                        return
                    self._last_bust_key = bust_key
                    self._queue_sound("bust")
                    return
                if bool(last_turn.get("finished")) and not bool(last_turn.get("bust")):
                    checkout_key = f"{last_turn.get('playerIndex')}:{last_turn.get('turnIndex')}:{last_turn.get('scored')}"
                    if checkout_key == self._last_checkout_key:
                        return
                    self._last_checkout_key = checkout_key
                    self._queue_sound("checkout")
        except Exception:
            return

    def _queue_sound(self, sound_key: str | None) -> None:
        if not sound_key:
            return
        settings = SoundFxSettings.from_dict(get_sound_fx_settings()).normalized()
        if not settings.enabled:
            return
        if not bool(getattr(settings, f"play_{sound_key}", False)):
            return
        clip = (settings.custom_sounds or {}).get(sound_key)
        if not clip:
            return
        path = Path(clip)
        if path.is_file():
            self._queue.put(str(path))

    def _worker_loop(self) -> None:
        while True:
            clip = self._queue.get()
            try:
                _play_clip(Path(clip))
            except Exception as exc:
                print(f"[sound-fx] playback error: {exc}")
            finally:
                self._queue.task_done()


def get_sound_fx_service() -> SoundFxService:
    global _SERVICE
    with _LOCK:
        if _SERVICE is None:
            _SERVICE = SoundFxService()
        return _SERVICE
