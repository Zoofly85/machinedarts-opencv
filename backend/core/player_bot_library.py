from __future__ import annotations

import json
import os
import sys
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


_LOCK = threading.Lock()
_SCHEMA_VERSION = 1
_MAX_WON_LEGS = 50
_MIN_WON_LEGS = 5


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _resolve_player_bots_path() -> Path:
    appdata = os.getenv("APPDATA", "").strip()
    appdata_path = (
        (Path(appdata).resolve() / "DartDetector" / "settings" / "player_bots.json")
        if appdata
        else None
    )
    if getattr(sys, "frozen", False):
        base = appdata_path.parent.parent if appdata_path else Path.home() / "AppData" / "Roaming" / "DartDetector"
        return base / "settings" / "player_bots.json"
    if appdata_path and appdata_path.exists():
        return appdata_path
    return Path(__file__).resolve().parents[1] / "data" / "settings" / "player_bots.json"


_PLAYER_BOTS_PATH = _resolve_player_bots_path()


def _default_payload() -> dict[str, Any]:
    return {
        "version": _SCHEMA_VERSION,
        "bots": [],
        "updated_at": _utc_now_iso(),
    }


def _load_payload() -> dict[str, Any]:
    payload = _default_payload()
    try:
        if _PLAYER_BOTS_PATH.exists():
            incoming = json.loads(_PLAYER_BOTS_PATH.read_text(encoding="utf-8"))
            if isinstance(incoming, dict):
                payload.update({k: incoming[k] for k in payload.keys() if k in incoming})
    except Exception:
        pass
    bots = payload.get("bots")
    if not isinstance(bots, list):
        payload["bots"] = []
    return payload


def _save_payload(payload: dict[str, Any]) -> None:
    payload["updated_at"] = _utc_now_iso()
    _PLAYER_BOTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    _PLAYER_BOTS_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _has_turn_script(record: dict[str, Any]) -> bool:
    summary = record.get("summary")
    if not isinstance(summary, dict):
        return False
    raw_turns = summary.get("turnDarts")
    if isinstance(raw_turns, list) and raw_turns:
        for turn in raw_turns:
            if not isinstance(turn, list):
                return False
            for dart in turn:
                if dart is None:
                    continue
                if not isinstance(dart, dict):
                    return False
        return True
    raw_scores = summary.get("turnAppliedScores")
    if isinstance(raw_scores, list):
        for turn in raw_scores:
            if isinstance(turn, list) and any(_safe_int(score) > 0 for score in turn):
                return True
    raw_visits = summary.get("visits")
    return isinstance(raw_visits, list) and any(_safe_int(score) > 0 for score in raw_visits)


def _safe_int(value: Any) -> int:
    try:
        return int(value or 0)
    except Exception:
        return 0


def _compute_stats(won_legs: list[dict[str, Any]], *, window_size: int = _MAX_WON_LEGS) -> dict[str, Any]:
    rows = list(won_legs)[-max(1, int(window_size)) :]
    darts = 0
    score = 0
    first9_darts = 0
    first9_score = 0
    pre170_darts = 0
    pre170_score = 0
    attempts = 0
    successes = 0
    for row in rows:
        summary = dict((row or {}).get("summary") or {})
        darts += _safe_int(summary.get("darts"))
        score += _safe_int(summary.get("score"))
        first9_darts += _safe_int(summary.get("firstNineDarts"))
        first9_score += _safe_int(summary.get("firstNineScore"))
        pre170_darts += _safe_int(summary.get("pre170Darts"))
        pre170_score += _safe_int(summary.get("pre170Score"))
        attempts += _safe_int(summary.get("checkoutAttempts"))
        successes += _safe_int(summary.get("checkoutSuccesses"))
    ppr = (score / darts * 3.0) if darts else 0.0
    ppr_to_170 = (pre170_score / pre170_darts * 3.0) if pre170_darts else 0.0
    first9_ppr = (first9_score / first9_darts * 3.0) if first9_darts else 0.0
    checkout_pct = (successes / attempts * 100.0) if attempts else 0.0
    return {
        "windowLegs": int(window_size),
        "gamesPlayed": len(rows),
        "ppr": round(float(ppr), 2) if rows else None,
        "average": round(float(ppr), 2) if rows else None,
        "pprTo170": round(float(ppr_to_170), 2) if rows else None,
        "firstNinePpr": round(float(first9_ppr), 2) if rows else None,
        "checkoutPercentage": round(float(checkout_pct), 2) if rows else None,
        "checkoutAttempts": int(attempts),
        "checkoutSuccesses": int(successes),
    }


def _validate_import_bundle(bundle: dict[str, Any]) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    if not isinstance(bundle, dict):
        raise ValueError("Import payload must be a JSON object.")
    schema_version = _safe_int(bundle.get("schemaVersion"))
    if schema_version != _SCHEMA_VERSION:
        raise ValueError(f"Unsupported schemaVersion={schema_version}. Expected {_SCHEMA_VERSION}.")
    bot_meta = bundle.get("botMeta") or {}
    if not isinstance(bot_meta, dict):
        bot_meta = {}
    display_name = str(bot_meta.get("playerName") or bot_meta.get("displayName") or "").strip()
    if not display_name:
        raise ValueError("botMeta.playerName is required.")

    raw_legs = bundle.get("wonLegs")
    if not isinstance(raw_legs, list):
        raise ValueError("wonLegs must be an array.")
    valid_legs: list[dict[str, Any]] = []
    for item in raw_legs:
        if not isinstance(item, dict):
            continue
        normalized = dict(item)
        normalized["gameMode"] = "x01"
        normalized["won"] = True
        if not _has_turn_script(normalized):
            continue
        valid_legs.append(normalized)
    valid_legs = valid_legs[-_MAX_WON_LEGS:]
    if len(valid_legs) < _MIN_WON_LEGS:
        raise ValueError(f"Need at least {_MIN_WON_LEGS} replayable won legs (found {len(valid_legs)}).")
    return display_name, valid_legs, bot_meta


def list_imported_player_bots() -> list[dict[str, Any]]:
    with _LOCK:
        payload = _load_payload()
    out: list[dict[str, Any]] = []
    for row in payload.get("bots", []):
        if not isinstance(row, dict):
            continue
        source_id = str(row.get("id", "")).strip()
        if not source_id:
            continue
        won_legs = row.get("wonLegs", [])
        if not isinstance(won_legs, list):
            won_legs = []
        stats = _compute_stats(won_legs, window_size=_MAX_WON_LEGS)
        out.append(
            {
                "botId": source_id,
                "playerId": f"shared:{source_id}",
                "playerName": str(row.get("name", "Imported Bot")).strip() or "Imported Bot",
                "completedLegs": len(won_legs),
                "completedLegsAllWins": len(won_legs),
                "playedLegs": len(won_legs),
                "isUnlocked": len(won_legs) >= _MIN_WON_LEGS,
                "progressPercentage": 100.0,
                "unlockWinsRequired": _MIN_WON_LEGS,
                "availableWonLegs": len(won_legs[-_MAX_WON_LEGS:]),
                "wonLegPoolSize": _MAX_WON_LEGS,
                "profileId": f"shared:{source_id}",
                "cloudBotId": str(row.get("cloudBotId", "")).strip() or None,
                "cloudVersion": _safe_int(row.get("cloudVersion")),
                "autoUpdate": bool(row.get("autoUpdate", False)),
                **stats,
            }
        )
    return sorted(out, key=lambda item: str(item.get("playerName", "")).lower())


def get_imported_player_bot_won_legs(source_player_id: str, *, limit: int = _MAX_WON_LEGS) -> list[dict[str, Any]]:
    source = str(source_player_id or "").strip()
    if not source.startswith("shared:"):
        return []
    bot_id = source.split(":", 1)[1].strip()
    if not bot_id:
        return []
    max_items = max(1, int(limit))
    with _LOCK:
        payload = _load_payload()
    for row in payload.get("bots", []):
        if not isinstance(row, dict):
            continue
        if str(row.get("id", "")).strip() != bot_id:
            continue
        won_legs = row.get("wonLegs", [])
        if not isinstance(won_legs, list):
            return []
        return [dict(item) for item in won_legs[-max_items:] if isinstance(item, dict)]
    return []


def import_player_bot_bundle(bundle: dict[str, Any]) -> dict[str, Any]:
    display_name, won_legs, bot_meta = _validate_import_bundle(bundle)
    record = {
        "id": uuid.uuid4().hex,
        "name": display_name,
        "importedAt": _utc_now_iso(),
        "schemaVersion": _SCHEMA_VERSION,
        "botMeta": dict(bot_meta),
        "wonLegs": [dict(item) for item in won_legs],
    }
    with _LOCK:
        payload = _load_payload()
        bots = payload.setdefault("bots", [])
        if not isinstance(bots, list):
            bots = []
            payload["bots"] = bots
        bots.append(record)
        _save_payload(payload)
    return {
        "imported": True,
        "botId": record["id"],
        "playerId": f"shared:{record['id']}",
        "playerName": display_name,
        "wonLegs": len(won_legs),
        "schemaVersion": _SCHEMA_VERSION,
    }


def delete_imported_player_bot(bot_id: str) -> bool:
    target = str(bot_id or "").strip()
    if not target:
        return False
    with _LOCK:
        payload = _load_payload()
        bots = payload.setdefault("bots", [])
        if not isinstance(bots, list):
            return False
        before = len(bots)
        payload["bots"] = [
            row
            for row in bots
            if not (isinstance(row, dict) and str(row.get("id", "")).strip() == target)
        ]
        deleted = len(payload["bots"]) != before
        if deleted:
            _save_payload(payload)
        return deleted


def replace_imported_player_bot(bot_id: str, bundle: dict[str, Any]) -> dict[str, Any]:
    target = str(bot_id or "").strip()
    if not target:
        raise ValueError("bot_id is required.")
    display_name, won_legs, bot_meta = _validate_import_bundle(bundle)
    with _LOCK:
        payload = _load_payload()
        bots = payload.setdefault("bots", [])
        if not isinstance(bots, list):
            raise ValueError("Player bot library is corrupted.")
        row_idx = None
        for idx, row in enumerate(bots):
            if isinstance(row, dict) and str(row.get("id", "")).strip() == target:
                row_idx = idx
                break
        if row_idx is None:
            raise ValueError("Imported player bot not found.")
        existing = dict(bots[row_idx]) if isinstance(bots[row_idx], dict) else {}
        bots[row_idx] = {
            "id": target,
            "name": display_name,
            "importedAt": str(existing.get("importedAt") or _utc_now_iso()),
            "updatedAt": _utc_now_iso(),
            "schemaVersion": _SCHEMA_VERSION,
            "botMeta": dict(bot_meta),
            "wonLegs": [dict(item) for item in won_legs],
        }
        _save_payload(payload)
    return {
        "replaced": True,
        "botId": target,
        "playerId": f"shared:{target}",
        "playerName": display_name,
        "wonLegs": len(won_legs),
        "schemaVersion": _SCHEMA_VERSION,
    }


def import_cloud_player_bot_bundle(
    *,
    cloud_bot_id: str,
    bundle: dict[str, Any],
    cloud_version: int = 1,
    auto_update: bool = True,
) -> dict[str, Any]:
    cloud_id = str(cloud_bot_id or "").strip()
    if not cloud_id:
        raise ValueError("cloud_bot_id is required.")
    display_name, won_legs, bot_meta = _validate_import_bundle(bundle)
    with _LOCK:
        payload = _load_payload()
        bots = payload.setdefault("bots", [])
        if not isinstance(bots, list):
            raise ValueError("Player bot library is corrupted.")
        row_idx = None
        for idx, row in enumerate(bots):
            if isinstance(row, dict) and str(row.get("cloudBotId", "")).strip() == cloud_id:
                row_idx = idx
                break
        existing = dict(bots[row_idx]) if row_idx is not None and isinstance(bots[row_idx], dict) else {}
        local_id = str(existing.get("id") or uuid.uuid4().hex)
        record = {
            "id": local_id,
            "name": display_name,
            "importedAt": str(existing.get("importedAt") or _utc_now_iso()),
            "updatedAt": _utc_now_iso(),
            "schemaVersion": _SCHEMA_VERSION,
            "source": "supabase",
            "cloudBotId": cloud_id,
            "cloudVersion": max(1, _safe_int(cloud_version)),
            "autoUpdate": bool(auto_update),
            "botMeta": dict(bot_meta),
            "wonLegs": [dict(item) for item in won_legs],
        }
        if row_idx is None:
            bots.append(record)
        else:
            bots[row_idx] = record
        _save_payload(payload)
    return {
        "imported": row_idx is None,
        "updated": row_idx is not None,
        "botId": local_id,
        "cloudBotId": cloud_id,
        "playerId": f"shared:{local_id}",
        "playerName": display_name,
        "wonLegs": len(won_legs),
        "schemaVersion": _SCHEMA_VERSION,
    }


def build_player_bot_export_bundle(
    *,
    player_id: str,
    player_name: str,
    won_legs: list[dict[str, Any]],
    stats_snapshot: dict[str, Any],
) -> dict[str, Any]:
    cleaned_legs = [dict(item) for item in won_legs[-_MAX_WON_LEGS:] if isinstance(item, dict)]
    return {
        "schemaVersion": _SCHEMA_VERSION,
        "botMeta": {
            "playerId": str(player_id),
            "playerName": str(player_name),
            "exportedAt": _utc_now_iso(),
        },
        "statsSnapshot": dict(stats_snapshot or {}),
        "wonLegs": cleaned_legs,
    }
