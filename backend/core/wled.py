from __future__ import annotations

import json
import re
import sys
import threading
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from backend.config.settings import get_data_root

_ASYNC_LOCK = threading.Lock()
_LAST_ASYNC_EVENT_MS: dict[str, float] = {}
_PROTECTED_UNTIL_MS = 0.0
_PROTECTED_EVENT = ""
_RETURN_TOKEN = 0
_LOW_PRIORITY_EVENTS = {"idle", "ready_to_detect"}
_IDLE_EVENT = "idle"


def _settings_path() -> Path:
    root = get_data_root()
    if getattr(sys, "frozen", False):
        return root / "settings" / "wled.json"
    return root / "backend" / "data" / "settings" / "wled.json"


def _default_settings() -> dict[str, Any]:
    return {
        "enabled": False,
        # User supplied 192.1.168.1.36, but WLED on a home LAN is almost always 192.168.x.x.
        "host": "192.168.1.36",
        "brightness": 160,
        "timeout_ms": 1200,
        "events": {
            "idle": {"mode": "color", "color": [40, 120, 255], "effect": 0, "duration_ms": 0},
            "game_start": {"mode": "effect", "color": [40, 180, 255], "effect": 11, "duration_ms": 2000},
            "ready_to_detect": {"mode": "color", "color": [40, 120, 255], "effect": 0, "duration_ms": 0},
            "dart_detected": {"mode": "color", "color": [255, 255, 255], "effect": 0, "duration_ms": 300},
            "takeout": {"mode": "effect", "color": [255, 120, 20], "effect": 63, "duration_ms": 1600},
            "score_60_plus": {"mode": "color", "color": [80, 220, 120], "effect": 0, "duration_ms": 900},
            "score_80_plus": {"mode": "color", "color": [60, 220, 180], "effect": 0, "duration_ms": 900},
            "score_100_plus": {"mode": "effect", "color": [80, 170, 255], "effect": 2, "duration_ms": 1200},
            "score_120_plus": {"mode": "effect", "color": [160, 120, 255], "effect": 24, "duration_ms": 1400},
            "score_140_plus": {"mode": "effect", "color": [255, 120, 220], "effect": 47, "duration_ms": 1600},
            "score_160_plus": {"mode": "effect", "color": [255, 90, 80], "effect": 68, "duration_ms": 1800},
            "score_180": {"mode": "effect", "color": [255, 220, 40], "effect": 9, "duration_ms": 2200},
            "checkout": {"mode": "color", "color": [0, 255, 90], "effect": 0, "duration_ms": 1200},
            "game_shot": {"mode": "effect", "color": [0, 255, 120], "effect": 9, "duration_ms": 2500},
            "bust": {"mode": "color", "color": [255, 0, 0], "effect": 0, "duration_ms": 800},
        },
    }


def _merge_settings(base: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    result = dict(base)
    for key, value in incoming.items():
        if key == "events" and isinstance(value, dict):
            events = dict(result.get("events") or {})
            for event_name, event_config in value.items():
                if isinstance(event_config, dict):
                    events[str(event_name)] = {**dict(events.get(str(event_name)) or {}), **event_config}
            result["events"] = events
        else:
            result[key] = value
    return result


def _normalize_color(value: Any) -> list[int]:
    if not isinstance(value, list) or len(value) < 3:
        return [255, 255, 255]
    return [max(0, min(255, int(value[index] or 0))) for index in range(3)]


def _normalize_event(value: Any) -> dict[str, Any]:
    event = value if isinstance(value, dict) else {}
    mode = str(event.get("mode") or "color").lower()
    if mode not in {"color", "effect", "preset"}:
        mode = "color"
    return {
        "mode": mode,
        "color": _normalize_color(event.get("color")),
        "effect": max(0, int(event.get("effect") or 0)),
        "preset": max(0, int(event.get("preset") or 0)),
        "duration_ms": max(0, int(event.get("duration_ms") or 0)),
    }


def _canonical_event_name(event_name: str) -> str:
    normalized = str(event_name or "").strip().lower()
    if normalized == "ready_to_detect":
        return _IDLE_EVENT
    return normalized or _IDLE_EVENT


def _normalize_settings(payload: dict[str, Any]) -> dict[str, Any]:
    defaults = _default_settings()
    merged = _merge_settings(defaults, payload)
    host = str(merged.get("host") or defaults["host"]).strip()
    host = re.sub(r"^https?://", "", host).strip().strip("/")
    supported_events = set((defaults.get("events") or {}).keys())
    merged_events = dict(merged.get("events") or {})
    if _IDLE_EVENT not in merged_events and "ready_to_detect" in merged_events:
        merged_events[_IDLE_EVENT] = merged_events["ready_to_detect"]
    events = {
        event_name: _normalize_event(event_config)
        for event_name, event_config in merged_events.items()
        if event_name in supported_events
    }
    if "ready_to_detect" not in events and _IDLE_EVENT in events:
        events["ready_to_detect"] = dict(events[_IDLE_EVENT])
    return {
        "enabled": bool(merged.get("enabled", False)),
        "host": host,
        "brightness": max(1, min(255, int(merged.get("brightness") or defaults["brightness"]))),
        "timeout_ms": max(250, min(5000, int(merged.get("timeout_ms") or defaults["timeout_ms"]))),
        "events": events,
    }


def get_settings() -> dict[str, Any]:
    path = _settings_path()
    payload = _default_settings()
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                payload = _merge_settings(payload, loaded)
        except Exception:
            pass
    return _normalize_settings(payload)


def update_settings(incoming: dict[str, Any]) -> dict[str, Any]:
    settings = _normalize_settings(_merge_settings(get_settings(), incoming if isinstance(incoming, dict) else {}))
    path = _settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings, indent=2), encoding="utf-8")
    return settings


def _wled_url(host: str) -> str:
    return f"http://{host.strip().strip('/')}/json/state"


def send_state(state: dict[str, Any], settings: dict[str, Any] | None = None) -> dict[str, Any]:
    active = settings or get_settings()
    host = str(active.get("host") or "").strip()
    if not host:
        raise ValueError("WLED host is not configured")

    body = json.dumps(state).encode("utf-8")
    timeout = max(0.25, float(active.get("timeout_ms") or 1200) / 1000.0)
    request = Request(
        _wled_url(host),
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    try:
        with urlopen(request, timeout=timeout) as response:
            response_body = response.read().decode("utf-8", errors="replace")
            return {
                "ok": 200 <= int(response.status) < 300,
                "status": int(response.status),
                "elapsed_ms": round((time.perf_counter() - started) * 1000),
                "response": response_body[:500],
            }
    except HTTPError as exc:
        return {
            "ok": False,
            "status": int(exc.code),
            "elapsed_ms": round((time.perf_counter() - started) * 1000),
            "response": exc.read().decode("utf-8", errors="replace")[:500],
        }
    except URLError as exc:
        raise ConnectionError(str(exc.reason)) from exc


def build_event_state(event_name: str, settings: dict[str, Any] | None = None) -> dict[str, Any]:
    active = settings or get_settings()
    canonical = _canonical_event_name(event_name)
    event = _normalize_event((active.get("events") or {}).get(canonical))
    state: dict[str, Any] = {
        "on": True,
        "bri": int(active.get("brightness") or 160),
    }
    if event["mode"] == "preset" and event["preset"] > 0:
        state["ps"] = event["preset"]
        return state
    segment: dict[str, Any] = {"col": [event["color"]]}
    if event["mode"] == "effect":
        segment["fx"] = event["effect"]
    else:
        # WLED keeps the previous segment effect unless we explicitly return to
        # solid, so color-only tests can otherwise look like the same animation.
        segment["fx"] = 0
    state["seg"] = [segment]
    return state


def _event_duration_ms(event_name: str, settings: dict[str, Any]) -> int:
    event = _normalize_event((settings.get("events") or {}).get(_canonical_event_name(event_name)))
    return max(0, min(30000, int(event.get("duration_ms") or 0)))


def _send_idle_state_later(token: int, respect_enabled: bool) -> None:
    with _ASYNC_LOCK:
        if token != _RETURN_TOKEN:
            return
    try:
        result = trigger_event(_IDLE_EVENT, respect_enabled=respect_enabled, schedule_return=False)
        if result.get("status") == "ok":
            print("[WLED] returned to idle")
        elif result.get("status") == "skipped":
            print(f"[WLED] idle skipped ({result.get('reason')})")
        else:
            print(f"[WLED] idle returned {result.get('status')}")
    except Exception as exc:
        print(f"[WLED] idle failed: {exc}")


def _schedule_idle_return(event_name: str, duration_ms: int, respect_enabled: bool) -> None:
    global _PROTECTED_EVENT, _PROTECTED_UNTIL_MS, _RETURN_TOKEN
    canonical = _canonical_event_name(event_name)
    if canonical == _IDLE_EVENT or duration_ms <= 0:
        return
    now_ms = time.perf_counter() * 1000.0
    with _ASYNC_LOCK:
        _RETURN_TOKEN += 1
        token = _RETURN_TOKEN
        _PROTECTED_EVENT = canonical
        _PROTECTED_UNTIL_MS = now_ms + duration_ms
    timer = threading.Timer(duration_ms / 1000.0, _send_idle_state_later, args=(token, respect_enabled))
    timer.daemon = True
    timer.start()


def trigger_event(event_name: str, *, respect_enabled: bool = False, schedule_return: bool = True) -> dict[str, Any]:
    settings = get_settings()
    if respect_enabled and not bool(settings.get("enabled")):
        return {"status": "skipped", "event": event_name, "reason": "disabled"}
    canonical = _canonical_event_name(event_name)
    state = build_event_state(canonical, settings)
    result = send_state(state, settings)
    status = "ok" if result.get("ok") else "error"
    if status == "ok" and schedule_return:
        _schedule_idle_return(canonical, _event_duration_ms(canonical, settings), respect_enabled)
    return {"status": status, "event": canonical, "state": state, "result": result}


def trigger_event_async(event_name: str, *, min_interval_ms: int = 700) -> None:
    """Fire a configured WLED event without blocking the detector/game loop."""
    now_ms = time.perf_counter() * 1000.0
    canonical = _canonical_event_name(event_name)
    with _ASYNC_LOCK:
        if canonical in _LOW_PRIORITY_EVENTS and now_ms < _PROTECTED_UNTIL_MS:
            remaining_ms = round(_PROTECTED_UNTIL_MS - now_ms)
            print(f"[WLED] event '{event_name}' deferred by '{_PROTECTED_EVENT}' ({remaining_ms}ms)")
            return
        previous_ms = float(_LAST_ASYNC_EVENT_MS.get(canonical, 0.0))
        if now_ms - previous_ms < max(0, int(min_interval_ms)):
            return
        _LAST_ASYNC_EVENT_MS[canonical] = now_ms

    def _worker() -> None:
        try:
            result = trigger_event(canonical, respect_enabled=True)
            if result.get("status") == "ok":
                print(f"[WLED] event '{canonical}' sent")
            elif result.get("status") == "skipped":
                print(f"[WLED] event '{canonical}' skipped ({result.get('reason')})")
            else:
                print(f"[WLED] event '{canonical}' returned {result.get('status')}")
        except Exception as exc:
            print(f"[WLED] event '{canonical}' failed: {exc}")

    threading.Thread(target=_worker, name=f"wled-{canonical}", daemon=True).start()


def apply_idle_async(*, min_interval_ms: int = 0) -> None:
    trigger_event_async(_IDLE_EVENT, min_interval_ms=min_interval_ms)
