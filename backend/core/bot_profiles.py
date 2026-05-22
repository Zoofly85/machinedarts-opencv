from __future__ import annotations

import json
import os
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_LOCK = threading.Lock()


def _resolve_bot_profiles_path() -> Path:
    if getattr(sys, "frozen", False):
        appdata = os.getenv("APPDATA", "").strip()
        base = Path(appdata).resolve() / "DartDetector" if appdata else Path.home() / "AppData" / "Roaming" / "DartDetector"
        return base / "settings" / "bot_profiles.json"
    return Path(__file__).resolve().parents[1] / "data" / "settings" / "bot_profiles.json"


_BOT_PROFILES_PATH = _resolve_bot_profiles_path()


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_payload() -> dict[str, Any]:
    return {
        "version": 1,
        "updated_at": _utc_now_iso(),
        "x01": {},
        "seed": {
            "x01BaselineV1": False,
            "generatedAt": None,
        },
    }


def _load_payload() -> dict[str, Any]:
    payload = _default_payload()
    try:
        if _BOT_PROFILES_PATH.exists():
            incoming = json.loads(_BOT_PROFILES_PATH.read_text(encoding="utf-8"))
            if isinstance(incoming, dict):
                payload.update(incoming)
    except Exception:
        pass
    if not isinstance(payload.get("x01"), dict):
        payload["x01"] = {}
    seed = payload.get("seed")
    if not isinstance(seed, dict):
        payload["seed"] = {"x01BaselineV1": False, "generatedAt": None}
    else:
        if "x01BaselineV1" not in seed:
            seed["x01BaselineV1"] = False
        if "generatedAt" not in seed:
            seed["generatedAt"] = None
    return payload


def _save_payload(payload: dict[str, Any]) -> None:
    payload["updated_at"] = _utc_now_iso()
    _BOT_PROFILES_PATH.parent.mkdir(parents=True, exist_ok=True)
    _BOT_PROFILES_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def should_seed_x01_bot_baseline() -> bool:
    with _LOCK:
        payload = _load_payload()
    seed = payload.get("seed", {})
    if bool(seed.get("x01BaselineV1", False)):
        return False
    x01 = payload.get("x01", {})
    if not isinstance(x01, dict):
        return True
    # If any level already has data, do not auto-seed.
    for rows in x01.values():
        if isinstance(rows, list) and rows:
            return False
    return True


def mark_x01_bot_baseline_seeded() -> None:
    with _LOCK:
        payload = _load_payload()
        seed = payload.setdefault("seed", {})
        if not isinstance(seed, dict):
            seed = {}
            payload["seed"] = seed
        seed["x01BaselineV1"] = True
        seed["generatedAt"] = _utc_now_iso()
        _save_payload(payload)


def _as_float(value: Any) -> float:
    try:
        return float(value or 0.0)
    except Exception:
        return 0.0


def _as_int(value: Any) -> int:
    try:
        return int(value or 0)
    except Exception:
        return 0


def record_x01_bot_leg(*, bot_level: int, summary: dict[str, Any], max_legs: int = 50) -> None:
    level_key = str(int(bot_level))
    entry = {
        "finishedAt": _utc_now_iso(),
        "darts": _as_int(summary.get("darts")),
        "score": _as_int(summary.get("score")),
        "firstNineScore": _as_int(summary.get("firstNineScore")),
        "firstNineDarts": _as_int(summary.get("firstNineDarts")),
        "pre170Score": _as_int(summary.get("pre170Score")),
        "pre170Darts": _as_int(summary.get("pre170Darts")),
        "checkoutAttempts": _as_int(summary.get("checkoutAttempts")),
        "checkoutSuccesses": _as_int(summary.get("checkoutSuccesses")),
    }
    keep = max(1, int(max_legs))
    with _LOCK:
        payload = _load_payload()
        x01 = payload.setdefault("x01", {})
        rows = x01.setdefault(level_key, [])
        if not isinstance(rows, list):
            rows = []
            x01[level_key] = rows
        rows.append(entry)
        if len(rows) > keep:
            del rows[:-keep]
        _save_payload(payload)


def get_x01_bot_stats(*, bot_level: int, max_legs: int = 50) -> dict[str, Any]:
    level_key = str(int(bot_level))
    keep = max(1, int(max_legs))
    with _LOCK:
        payload = _load_payload()
    x01 = payload.get("x01", {})
    rows = x01.get(level_key, []) if isinstance(x01, dict) else []
    if not isinstance(rows, list):
        rows = []
    rows = rows[-keep:]

    darts = sum(_as_int(r.get("darts")) for r in rows)
    score = sum(_as_int(r.get("score")) for r in rows)
    first9_darts = sum(_as_int(r.get("firstNineDarts")) for r in rows)
    first9_score = sum(_as_int(r.get("firstNineScore")) for r in rows)
    pre170_darts = sum(_as_int(r.get("pre170Darts")) for r in rows)
    pre170_score = sum(_as_int(r.get("pre170Score")) for r in rows)
    checkout_attempts = sum(_as_int(r.get("checkoutAttempts")) for r in rows)
    checkout_successes = sum(_as_int(r.get("checkoutSuccesses")) for r in rows)

    ppr = (score / darts * 3.0) if darts > 0 else 0.0
    ppr_to_170 = (pre170_score / pre170_darts * 3.0) if pre170_darts > 0 else 0.0
    first9_ppr = (first9_score / first9_darts * 3.0) if first9_darts > 0 else 0.0
    checkout_pct = (checkout_successes / checkout_attempts * 100.0) if checkout_attempts > 0 else 0.0

    # "previous" = previous half-window of same size
    with _LOCK:
        payload_full = _load_payload()
    all_rows = payload_full.get("x01", {}).get(level_key, []) if isinstance(payload_full.get("x01", {}), dict) else []
    if not isinstance(all_rows, list):
        all_rows = []
    prev_rows = all_rows[max(0, len(all_rows) - (2 * keep)): max(0, len(all_rows) - keep)]
    prev_darts = sum(_as_int(r.get("darts")) for r in prev_rows)
    prev_score = sum(_as_int(r.get("score")) for r in prev_rows)
    prev_first9_darts = sum(_as_int(r.get("firstNineDarts")) for r in prev_rows)
    prev_first9_score = sum(_as_int(r.get("firstNineScore")) for r in prev_rows)
    prev_pre170_darts = sum(_as_int(r.get("pre170Darts")) for r in prev_rows)
    prev_pre170_score = sum(_as_int(r.get("pre170Score")) for r in prev_rows)
    prev_checkout_attempts = sum(_as_int(r.get("checkoutAttempts")) for r in prev_rows)
    prev_checkout_successes = sum(_as_int(r.get("checkoutSuccesses")) for r in prev_rows)

    prev_ppr = (prev_score / prev_darts * 3.0) if prev_darts > 0 else 0.0
    prev_ppr_to_170 = (prev_pre170_score / prev_pre170_darts * 3.0) if prev_pre170_darts > 0 else 0.0
    prev_first9_ppr = (prev_first9_score / prev_first9_darts * 3.0) if prev_first9_darts > 0 else 0.0
    prev_checkout_pct = (prev_checkout_successes / prev_checkout_attempts * 100.0) if prev_checkout_attempts > 0 else 0.0

    return {
        "botLevel": int(bot_level),
        "windowLegs": keep,
        "gamesPlayed": len(rows),
        "profileId": None,
        "ppr": round(_as_float(ppr), 2) if rows else None,
        "average": round(_as_float(ppr), 2) if rows else None,
        "pprTo170": round(_as_float(ppr_to_170), 2) if rows else None,
        "firstNinePpr": round(_as_float(first9_ppr), 2) if rows else None,
        "checkoutPercentage": round(_as_float(checkout_pct), 2) if rows else None,
        "checkoutAttempts": checkout_attempts,
        "checkoutSuccesses": checkout_successes,
        "previousPpr": round(_as_float(prev_ppr), 2) if prev_rows else None,
        "previousPprTo170": round(_as_float(prev_ppr_to_170), 2) if prev_rows else None,
        "previousFirstNinePpr": round(_as_float(prev_first9_ppr), 2) if prev_rows else None,
        "previousCheckoutPercentage": round(_as_float(prev_checkout_pct), 2) if prev_rows else None,
    }
