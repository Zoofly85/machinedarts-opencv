from __future__ import annotations

import json
import os
import sys
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _resolve_profiles_path() -> Path:
    appdata = os.getenv("APPDATA", "").strip()
    appdata_path = (
        (Path(appdata).resolve() / "DartDetector" / "settings" / "players.json")
        if appdata
        else None
    )
    if getattr(sys, "frozen", False):
        base = appdata_path.parent.parent if appdata_path else Path.home() / "AppData" / "Roaming" / "DartDetector"
        return base / "settings" / "players.json"
    if appdata_path and appdata_path.exists():
        return appdata_path
    return Path(__file__).resolve().parents[1] / "data" / "settings" / "players.json"


_PLAYERS_PATH = _resolve_profiles_path()
_LOCK = threading.Lock()


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_payload() -> dict[str, Any]:
    return {
        "version": 1,
        "players": [],
        "history": {},
        "updated_at": _utc_now_iso(),
    }


def _load_payload() -> dict[str, Any]:
    payload = _default_payload()
    try:
        if _PLAYERS_PATH.exists():
            incoming = json.loads(_PLAYERS_PATH.read_text(encoding="utf-8"))
            if isinstance(incoming, dict):
                payload.update({k: incoming[k] for k in payload.keys() if k in incoming})
    except Exception:
        pass
    players = payload.get("players")
    if not isinstance(players, list):
        payload["players"] = []
    history = payload.get("history")
    if not isinstance(history, dict):
        payload["history"] = {}
    return payload


def _save_payload(payload: dict[str, Any]) -> None:
    payload["updated_at"] = _utc_now_iso()
    _PLAYERS_PATH.parent.mkdir(parents=True, exist_ok=True)
    _PLAYERS_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def list_players() -> list[dict[str, str]]:
    with _LOCK:
        payload = _load_payload()
    players = [
        {
            "id": str(player.get("id", "")),
            "name": str(player.get("name", "")),
            "createdAt": str(player.get("createdAt", "")),
        }
        for player in payload.get("players", [])
        if isinstance(player, dict)
    ]
    return sorted(players, key=lambda player: player["name"].lower())


def create_player(name: str) -> dict[str, str]:
    normalized = str(name or "").strip()
    if not normalized:
        raise ValueError("Player name is required.")

    with _LOCK:
        payload = _load_payload()
        players = payload.setdefault("players", [])
        existing = next(
            (
                player
                for player in players
                if isinstance(player, dict) and str(player.get("name", "")).strip().lower() == normalized.lower()
            ),
            None,
        )
        if existing is not None:
            raise ValueError("A profile with that name already exists.")

        player = {
            "id": uuid.uuid4().hex,
            "name": normalized,
            "createdAt": _utc_now_iso(),
        }
        players.append(player)
        _save_payload(payload)
        return player


def update_player_name(player_id: str, name: str) -> dict[str, str] | None:
    target = str(player_id or "").strip()
    normalized = str(name or "").strip()
    if not target:
        return None
    if not normalized:
        raise ValueError("Player name is required.")

    with _LOCK:
        payload = _load_payload()
        players = payload.setdefault("players", [])
        if not isinstance(players, list):
            return None
        for player in players:
            if not isinstance(player, dict):
                continue
            if str(player.get("id", "")).strip() != target:
                continue
            duplicate = next(
                (
                    other
                    for other in players
                    if (
                        isinstance(other, dict)
                        and str(other.get("id", "")).strip() != target
                        and str(other.get("name", "")).strip().lower() == normalized.lower()
                    )
                ),
                None,
            )
            if duplicate is not None:
                raise ValueError("A profile with that name already exists.")
            player["name"] = normalized
            _save_payload(payload)
            return {
                "id": str(player.get("id", "")),
                "name": str(player.get("name", "")),
                "createdAt": str(player.get("createdAt", "")),
            }
    return None


def delete_player(player_id: str) -> bool:
    target = str(player_id or "").strip()
    if not target:
        return False

    with _LOCK:
        payload = _load_payload()
        players = payload.setdefault("players", [])
        initial_count = len(players)
        payload["players"] = [
            player
            for player in players
            if not (isinstance(player, dict) and str(player.get("id", "")).strip() == target)
        ]
        deleted = len(payload["players"]) != initial_count
        if deleted:
            history = payload.setdefault("history", {})
            if isinstance(history, dict):
                history.pop(target, None)
            _save_payload(payload)
        return deleted


def get_player(player_id: str) -> dict[str, str] | None:
    target = str(player_id or "").strip()
    if not target:
        return None
    for player in list_players():
        if player["id"] == target:
            return player
    return None


def _empty_history_record() -> list[dict[str, Any]]:
    return []


def empty_metric_triple() -> dict[str, float]:
    return {"current": 0.0, "previous": 0.0, "best": 0.0}


def empty_x01_window() -> dict[str, Any]:
    return {
        "legs": 0,
        "legsWon": 0,
        "averages": {
            "ppr": empty_metric_triple(),
            "pprTo170": empty_metric_triple(),
            "firstNine": empty_metric_triple(),
        },
        "checkout": {
            "attempts": 0,
            "successes": 0,
            "percentage": empty_metric_triple(),
        },
        "buckets": {"total": {}, "perLeg": {}},
    }


def empty_cricket_window() -> dict[str, Any]:
    return {
        "legs": 0,
        "legsWon": 0,
        "averages": {
            "mpr": empty_metric_triple(),
            "firstNineMpr": empty_metric_triple(),
            "score": empty_metric_triple(),
        },
        "marks": {"total": {}, "perLeg": {}},
    }


def empty_atc_window() -> dict[str, Any]:
    return {
        "legs": 0,
        "legsWon": 0,
        "averages": {
            "accuracy": empty_metric_triple(),
            "targetsPerLeg": empty_metric_triple(),
            "dartsPerTarget": empty_metric_triple(),
        },
        "numberAccuracy": {},
    }


def _window_set(factory) -> dict[str, Any]:
    keys = ("10", "100", "1000", "5000", "all")
    return {key: factory() for key in keys}


def get_player_stats(player_id: str) -> dict[str, Any] | None:
    player = get_player(player_id)
    if player is None:
        return None
    with _LOCK:
        payload = _load_payload()
    history_by_player = payload.get("history", {}) if isinstance(payload, dict) else {}
    history = history_by_player.get(player_id, []) if isinstance(history_by_player, dict) else []
    if not isinstance(history, list):
        history = []
    x01_history = [entry for entry in history if isinstance(entry, dict) and str(entry.get("gameMode", "")) == "x01"]
    cricket_history = [entry for entry in history if isinstance(entry, dict) and str(entry.get("gameMode", "")) == "cricket"]
    atc_history = [entry for entry in history if isinstance(entry, dict) and str(entry.get("gameMode", "")) == "around_the_clock"]
    return {
        "player": player,
        "history": history,
        "modes": {
            "x01": _build_x01_mode_summary(x01_history),
            "cricket": _build_cricket_mode_summary(cricket_history),
            "around_the_clock": _build_around_the_clock_mode_summary(atc_history),
        },
    }


def _has_player_bot_turn_script(record: dict[str, Any]) -> bool:
    def safe_int(value: Any) -> int:
        try:
            return int(value or 0)
        except Exception:
            return 0

    if not isinstance(record, dict):
        return False
    summary = record.get("summary")
    if not isinstance(summary, dict):
        return False
    raw_turns = summary.get("turnDarts")
    if isinstance(raw_turns, list):
        for raw_turn in raw_turns:
            if not isinstance(raw_turn, list):
                continue
            for dart in raw_turn:
                if isinstance(dart, dict):
                    return True
    raw_scores = summary.get("turnAppliedScores")
    if isinstance(raw_scores, list):
        for raw_turn in raw_scores:
            if isinstance(raw_turn, list) and any(safe_int(score) > 0 for score in raw_turn):
                return True
    raw_visits = summary.get("visits")
    if isinstance(raw_visits, list) and any(safe_int(score) > 0 for score in raw_visits):
        return True
    return False


def get_player_bot_status(player_id: str, *, unlock_wins: int = 5, window_size: int = 50) -> dict[str, Any] | None:
    target = str(player_id or "").strip()
    if not target:
        return None

    with _LOCK:
        payload = _load_payload()

    players = payload.get("players", [])
    player_name = ""
    if isinstance(players, list):
        for item in players:
            if not isinstance(item, dict):
                continue
            if str(item.get("id", "")).strip() == target:
                player_name = str(item.get("name", "")).strip()
                break
    if not player_name:
        return None

    history_by_player = payload.get("history", {})
    records = history_by_player.get(target, []) if isinstance(history_by_player, dict) else []
    if not isinstance(records, list):
        records = []

    x01_records = [
        entry
        for entry in records
        if isinstance(entry, dict) and str(entry.get("gameMode", "")) == "x01"
    ]
    won_x01_records = [entry for entry in x01_records if bool(entry.get("won"))]
    replayable_won_x01_records = [
        entry for entry in won_x01_records if _has_player_bot_turn_script(entry)
    ]
    replayable_won_legs_total = len(replayable_won_x01_records)
    available_pool = replayable_won_x01_records[-max(1, int(window_size)) :]
    previous_pool = replayable_won_x01_records[
        max(0, len(replayable_won_x01_records) - (2 * max(1, int(window_size)))): max(
            0, len(replayable_won_x01_records) - max(1, int(window_size))
        )
    ]
    x01_window = _aggregate_x01_window(available_pool, previous_pool) if available_pool else None
    progress_ratio = min(1.0, float(replayable_won_legs_total) / float(max(1, int(unlock_wins))))

    return {
        "playerId": target,
        "playerName": player_name,
        "completedLegs": replayable_won_legs_total,
        "completedLegsAllWins": len(won_x01_records),
        "playedLegs": len(x01_records),
        "isUnlocked": replayable_won_legs_total >= int(unlock_wins),
        "progressPercentage": round(progress_ratio * 100.0, 1),
        "unlockWinsRequired": int(unlock_wins),
        "availableWonLegs": len(available_pool),
        "wonLegPoolSize": int(window_size),
        "windowLegs": int(window_size),
        "gamesPlayed": len(available_pool),
        "profileId": target,
        "ppr": (
            float(x01_window["averages"]["ppr"]["current"]) if isinstance(x01_window, dict) else None
        ),
        "average": (
            float(x01_window["averages"]["ppr"]["current"]) if isinstance(x01_window, dict) else None
        ),
        "pprTo170": (
            float(x01_window["averages"]["pprTo170"]["current"]) if isinstance(x01_window, dict) else None
        ),
        "firstNinePpr": (
            float(x01_window["averages"]["firstNine"]["current"]) if isinstance(x01_window, dict) else None
        ),
        "checkoutPercentage": (
            float(x01_window["checkout"]["percentage"]["current"]) if isinstance(x01_window, dict) else None
        ),
        "checkoutAttempts": (
            int(x01_window["checkout"]["attempts"]) if isinstance(x01_window, dict) else 0
        ),
        "checkoutSuccesses": (
            int(x01_window["checkout"]["successes"]) if isinstance(x01_window, dict) else 0
        ),
        "previousPpr": (
            float(x01_window["averages"]["ppr"]["previous"]) if isinstance(x01_window, dict) else None
        ),
        "previousPprTo170": (
            float(x01_window["averages"]["pprTo170"]["previous"]) if isinstance(x01_window, dict) else None
        ),
        "previousFirstNinePpr": (
            float(x01_window["averages"]["firstNine"]["previous"]) if isinstance(x01_window, dict) else None
        ),
        "previousCheckoutPercentage": (
            float(x01_window["checkout"]["percentage"]["previous"]) if isinstance(x01_window, dict) else None
        ),
    }


def get_player_bot_won_legs(player_id: str, *, limit: int = 50) -> list[dict[str, Any]]:
    target = str(player_id or "").strip()
    if not target:
        return []
    max_items = max(1, int(limit))

    with _LOCK:
        payload = _load_payload()

    history_by_player = payload.get("history", {})
    records = history_by_player.get(target, []) if isinstance(history_by_player, dict) else []
    if not isinstance(records, list):
        return []

    won_x01 = [
        dict(entry)
        for entry in records
        if (
            isinstance(entry, dict)
            and str(entry.get("gameMode", "")) == "x01"
            and bool(entry.get("won"))
            and _has_player_bot_turn_script(entry)
        )
    ]
    if not won_x01:
        return []
    return won_x01[-max_items:]


def append_player_history(player_id: str, record: dict[str, Any]) -> None:
    target = str(player_id or "").strip()
    if not target:
        return
    with _LOCK:
        payload = _load_payload()
        history_by_player = payload.setdefault("history", {})
        if not isinstance(history_by_player, dict):
            history_by_player = {}
            payload["history"] = history_by_player
        entries = history_by_player.setdefault(target, [])
        if not isinstance(entries, list):
            entries = []
            history_by_player[target] = entries
        entries.append(record)
        _save_payload(payload)


def record_x01_leg_for_profiles(
    *,
    profile_ids_by_index: dict[int, str] | None,
    summaries: list[dict[str, Any]] | None,
    started_at: str,
    finished_at: str,
) -> None:
    if not profile_ids_by_index or not summaries:
        return
    for idx, summary in enumerate(summaries):
        profile_id = str((profile_ids_by_index or {}).get(idx, "")).strip()
        if not profile_id or not isinstance(summary, dict):
            continue
        darts = int(summary.get("darts", 0) or 0)
        corrections = int(summary.get("corrections", 0) or 0)
        accuracy = 1.0
        if darts > 0:
            accuracy = max(0.0, min(1.0, float(darts - corrections) / float(darts)))
        record = {
            "gameMode": "x01",
            "startedAt": started_at,
            "finishedAt": finished_at,
            "darts": darts,
            "accuracy": round(accuracy, 4),
            "won": bool(summary.get("winner", False)),
            "corrections": corrections,
            "summary": dict(summary),
        }
        append_player_history(profile_id, record)


def record_cricket_leg_for_profiles(
    *,
    profile_ids_by_index: dict[int, str] | None,
    summaries: list[dict[str, Any]] | None,
    started_at: str,
    finished_at: str,
) -> None:
    if not profile_ids_by_index or not summaries:
        return
    for idx, summary in enumerate(summaries):
        profile_id = str((profile_ids_by_index or {}).get(idx, "")).strip()
        if not profile_id or not isinstance(summary, dict):
            continue
        darts = int(summary.get("darts", 0) or 0)
        corrections = int(summary.get("corrections", 0) or 0)
        accuracy = 1.0
        if darts > 0:
            accuracy = max(0.0, min(1.0, float(darts - corrections) / float(darts)))
        record = {
            "gameMode": "cricket",
            "startedAt": started_at,
            "finishedAt": finished_at,
            "darts": darts,
            "accuracy": round(accuracy, 4),
            "won": bool(summary.get("winner", False)),
            "corrections": corrections,
            "summary": dict(summary),
        }
        append_player_history(profile_id, record)


def record_around_the_clock_leg_for_profiles(
    *,
    profile_ids_by_index: dict[int, str] | None,
    summaries: list[dict[str, Any]] | None,
    started_at: str,
    finished_at: str,
) -> None:
    if not profile_ids_by_index or not summaries:
        return
    for idx, summary in enumerate(summaries):
        profile_id = str((profile_ids_by_index or {}).get(idx, "")).strip()
        if not profile_id or not isinstance(summary, dict):
            continue
        darts = int(summary.get("darts", 0) or 0)
        corrections = int(summary.get("corrections", 0) or 0)
        accuracy = 1.0
        if darts > 0:
            accuracy = max(0.0, min(1.0, float(darts - corrections) / float(darts)))
        record = {
            "gameMode": "around_the_clock",
            "startedAt": started_at,
            "finishedAt": finished_at,
            "darts": darts,
            "accuracy": round(accuracy, 4),
            "won": bool(summary.get("winner", False)),
            "corrections": corrections,
            "summary": dict(summary),
        }
        append_player_history(profile_id, record)


def _history_slice(records: list[dict[str, Any]], window_key: str) -> list[dict[str, Any]]:
    if window_key == "all":
        return list(records)
    try:
        limit = int(window_key)
    except Exception:
        return list(records)
    if limit <= 0:
        return list(records)
    return records[-limit:]


def _metric_triple(current: float, previous: float, best: float) -> dict[str, float]:
    return {
        "current": round(current, 2),
        "previous": round(previous, 2),
        "best": round(best, 2),
    }


def _aggregate_x01_window(records: list[dict[str, Any]], previous_records: list[dict[str, Any]]) -> dict[str, Any]:
    def _collect(source: list[dict[str, Any]]) -> dict[str, Any]:
        legs = len(source)
        legs_won = sum(1 for record in source if bool(record.get("won")))
        darts = 0
        score = 0
        first_nine_score = 0
        first_nine_darts = 0
        pre170_score = 0
        pre170_darts = 0
        attempts = 0
        successes = 0
        bucket_totals: dict[str, int] = {}
        per_leg_buckets: dict[str, float] = {}
        ppr_values: list[float] = []
        ppr170_values: list[float] = []
        first9_values: list[float] = []
        checkout_values: list[float] = []
        for record in source:
            summary = dict(record.get("summary") or {})
            darts_i = int(summary.get("darts", 0) or 0)
            score_i = int(summary.get("score", 0) or 0)
            first9_score_i = int(summary.get("firstNineScore", 0) or 0)
            first9_darts_i = int(summary.get("firstNineDarts", 0) or 0)
            pre170_score_i = int(summary.get("pre170Score", 0) or 0)
            pre170_darts_i = int(summary.get("pre170Darts", 0) or 0)
            attempts_i = int(summary.get("checkoutAttempts", 0) or 0)
            successes_i = int(summary.get("checkoutSuccesses", 0) or 0)
            raw_buckets = summary.get("visitBuckets", {}) or {}
            darts += darts_i
            score += score_i
            first_nine_score += first9_score_i
            first_nine_darts += first9_darts_i
            pre170_score += pre170_score_i
            pre170_darts += pre170_darts_i
            attempts += attempts_i
            successes += successes_i
            if darts_i:
                ppr_values.append((score_i / darts_i) * 3.0)
            if pre170_darts_i:
                ppr170_values.append((pre170_score_i / pre170_darts_i) * 3.0)
            if first9_darts_i:
                first9_values.append((first9_score_i / first9_darts_i) * 3.0)
            checkout_values.append((successes_i / attempts_i * 100.0) if attempts_i else 0.0)
            for key, value in raw_buckets.items():
                bucket_totals[str(key)] = int(bucket_totals.get(str(key), 0)) + int(value or 0)
        for key, value in bucket_totals.items():
            per_leg_buckets[key] = (float(value) / float(legs)) if legs > 0 else 0.0
        return {
            "legs": legs,
            "legsWon": legs_won,
            "ppr": (score / darts * 3.0) if darts else 0.0,
            "pprTo170": (pre170_score / pre170_darts * 3.0) if pre170_darts else 0.0,
            "firstNine": (first_nine_score / first_nine_darts * 3.0) if first_nine_darts else 0.0,
            "checkoutPct": (successes / attempts * 100.0) if attempts else 0.0,
            "checkoutAttempts": attempts,
            "checkoutSuccesses": successes,
            "bucketTotals": bucket_totals,
            "bucketPerLeg": per_leg_buckets,
            "bestPpr": max(ppr_values) if ppr_values else 0.0,
            "bestPpr170": max(ppr170_values) if ppr170_values else 0.0,
            "bestFirst9": max(first9_values) if first9_values else 0.0,
            "bestCheckoutPct": max(checkout_values) if checkout_values else 0.0,
        }

    current = _collect(records)
    previous = _collect(previous_records)
    return {
        "legs": current["legs"],
        "legsWon": current["legsWon"],
        "averages": {
            "ppr": _metric_triple(current["ppr"], previous["ppr"], current["bestPpr"]),
            "pprTo170": _metric_triple(current["pprTo170"], previous["pprTo170"], current["bestPpr170"]),
            "firstNine": _metric_triple(current["firstNine"], previous["firstNine"], current["bestFirst9"]),
        },
        "checkout": {
            "attempts": current["checkoutAttempts"],
            "successes": current["checkoutSuccesses"],
            "percentage": _metric_triple(current["checkoutPct"], previous["checkoutPct"], current["bestCheckoutPct"]),
        },
        "buckets": {
            "total": {key: int(value) for key, value in current["bucketTotals"].items()},
            "perLeg": {key: round(float(value), 2) for key, value in current["bucketPerLeg"].items()},
        },
    }


def _build_x01_mode_summary(records: list[dict[str, Any]]) -> dict[str, Any]:
    ordered = sorted(
        [record for record in records if isinstance(record, dict)],
        key=lambda record: str(record.get("finishedAt", "")),
    )
    windows: dict[str, Any] = {}
    for window_key in ("10", "100", "1000", "5000", "all"):
        current = _history_slice(ordered, window_key)
        if window_key == "all":
            previous = []
        else:
            limit = int(window_key)
            previous = ordered[max(0, len(ordered) - (2 * limit)): max(0, len(ordered) - limit)]
        windows[window_key] = _aggregate_x01_window(current, previous)
    return {
        "overall": windows["all"],
        "windows": windows,
    }


def _build_cricket_window(records: list[dict[str, Any]], window_key: str) -> dict[str, Any]:
    current_records = _history_slice(records, window_key)
    if not current_records and records:
        current_records = list(records)

    legs = len(current_records)
    legs_won = sum(1 for record in current_records if bool(record.get("won")))
    mark_keys = tuple(str(k) for k in range(3, 10))
    mark_totals = {key: 0 for key in mark_keys}

    for record in current_records:
        payload = dict(record.get("summary") or {})
        counts = payload.get("markCounts", {})
        if isinstance(counts, dict):
            for key in mark_keys:
                mark_totals[key] += int(counts.get(key, 0) or 0)

    marks_per_leg = {key: (mark_totals[key] / legs if legs else 0.0) for key in mark_keys}

    def aggregate_mpr(subset: list[dict[str, Any]]) -> float:
        marks_total = 0
        darts_total = 0
        for entry in subset:
            payload = dict(entry.get("summary") or {})
            marks_total += int(payload.get("marks", 0) or 0)
            darts_total += int(payload.get("darts", 0) or entry.get("darts", 0) or 0)
        return (marks_total / darts_total * 3.0) if darts_total else 0.0

    def aggregate_first_nine_mpr(subset: list[dict[str, Any]]) -> float:
        marks_total = 0
        darts_total = 0
        for entry in subset:
            payload = dict(entry.get("summary") or {})
            marks_total += int(payload.get("firstNineMarks", 0) or 0)
            darts_total += min(int(payload.get("darts", 0) or entry.get("darts", 0) or 0), 9)
        return (marks_total / darts_total * 3.0) if darts_total else 0.0

    def aggregate_score(subset: list[dict[str, Any]]) -> float:
        legs_count = len(subset)
        if legs_count == 0:
            return 0.0
        points_total = 0
        for entry in subset:
            payload = dict(entry.get("summary") or {})
            points_total += int(payload.get("points", 0) or 0)
        return points_total / float(legs_count)

    def build_metric(current_fn, previous_subset: list[dict[str, Any]], current_subset: list[dict[str, Any]]) -> dict[str, float]:
        current_value = current_fn(current_subset)
        previous_value = current_fn(previous_subset)
        best_value = max((current_fn([entry]) for entry in records), default=0.0)
        return _metric_triple(current_value, previous_value, best_value)

    if window_key == "all":
        previous_records = []
    else:
        limit = int(window_key)
        previous_records = records[max(0, len(records) - (2 * limit)): max(0, len(records) - limit)]

    return {
        "legs": legs,
        "legsWon": legs_won,
        "averages": {
            "mpr": build_metric(aggregate_mpr, previous_records, current_records),
            "firstNineMpr": build_metric(aggregate_first_nine_mpr, previous_records, current_records),
            "score": build_metric(aggregate_score, previous_records, current_records),
        },
        "marks": {
            "total": {key: int(value) for key, value in mark_totals.items()},
            "perLeg": {key: round(float(value), 2) for key, value in marks_per_leg.items()},
        },
    }


def _build_cricket_mode_summary(records: list[dict[str, Any]]) -> dict[str, Any]:
    ordered = sorted(
        [record for record in records if isinstance(record, dict)],
        key=lambda record: str(record.get("finishedAt", "")),
    )
    windows: dict[str, Any] = {}
    for window_key in ("10", "100", "1000", "5000", "all"):
        windows[window_key] = _build_cricket_window(ordered, window_key)
    return {
        "overall": windows["all"],
        "windows": windows,
    }


def _build_around_the_clock_window(records: list[dict[str, Any]], window_key: str, game_mode: str | None = None) -> dict[str, Any]:
    filtered_records = list(records)
    if game_mode and game_mode != "all":
        filtered_records = [
            record
            for record in filtered_records
            if str(dict(record.get("summary") or {}).get("gameMode", "")) == game_mode
        ]

    current_records = _history_slice(filtered_records, window_key)
    if not current_records and filtered_records:
        current_records = list(filtered_records)

    legs = len(current_records)
    legs_won = sum(1 for record in current_records if bool(record.get("won")))

    def aggregate_accuracy(subset: list[dict[str, Any]]) -> float:
        if not subset:
            return 0.0
        total_accuracy = 0.0
        count = 0
        for entry in subset:
            payload = dict(entry.get("summary") or {})
            accuracy = float(payload.get("overallAccuracy", 0) or 0)
            if accuracy > 0:
                total_accuracy += accuracy
                count += 1
        return (total_accuracy / count) if count else 0.0

    def aggregate_targets_hit(subset: list[dict[str, Any]]) -> float:
        if not subset:
            return 0.0
        total_targets = 0
        for entry in subset:
            payload = dict(entry.get("summary") or {})
            total_targets += int(payload.get("targetsHit", 0) or 0)
        return total_targets / float(len(subset))

    def aggregate_darts_per_target(subset: list[dict[str, Any]]) -> float:
        if not subset:
            return 0.0
        total_darts = 0
        total_targets = 0
        for entry in subset:
            payload = dict(entry.get("summary") or {})
            total_darts += int(payload.get("darts", 0) or 0)
            total_targets += int(payload.get("targetsHit", 0) or 0)
        return (total_darts / total_targets) if total_targets else 0.0

    def build_metric(current_fn, previous_subset: list[dict[str, Any]], current_subset: list[dict[str, Any]]) -> dict[str, float]:
        current_value = current_fn(current_subset)
        previous_value = current_fn(previous_subset)
        best_value = max((current_fn([entry]) for entry in filtered_records), default=0.0)
        return _metric_triple(current_value, previous_value, best_value)

    if window_key == "all":
        previous_records = []
    else:
        limit = int(window_key)
        previous_records = filtered_records[max(0, len(filtered_records) - (2 * limit)): max(0, len(filtered_records) - limit)]

    number_accuracy: dict[str, float] = {}
    for target_num in list(range(1, 21)) + [25]:
        target_hits = 0
        target_attempts = 0
        for entry in current_records:
            payload = dict(entry.get("summary") or {})
            hits_per_target = payload.get("hitsPerTarget", [])
            if not isinstance(hits_per_target, list):
                continue
            for idx, darts_taken in enumerate(hits_per_target):
                actual_target = idx + 1 if idx < 20 else 25
                if actual_target == target_num and int(darts_taken or 0) > 0:
                    target_hits += 1
                    target_attempts += int(darts_taken or 0)
        number_accuracy[str(target_num)] = round((target_hits / target_attempts) * 100.0, 2) if target_attempts > 0 else 0.0

    return {
        "legs": legs,
        "legsWon": legs_won,
        "averages": {
            "accuracy": build_metric(aggregate_accuracy, previous_records, current_records),
            "targetsPerLeg": build_metric(aggregate_targets_hit, previous_records, current_records),
            "dartsPerTarget": build_metric(aggregate_darts_per_target, previous_records, current_records),
        },
        "numberAccuracy": number_accuracy,
    }


def _build_around_the_clock_mode_summary(records: list[dict[str, Any]]) -> dict[str, Any]:
    ordered = sorted(
        [record for record in records if isinstance(record, dict)],
        key=lambda record: str(record.get("finishedAt", "")),
    )
    windows: dict[str, Any] = {}
    for window_key in ("10", "100", "1000", "5000", "all"):
        windows[window_key] = _build_around_the_clock_window(ordered, window_key, game_mode="all")
    modes: dict[str, Any] = {}
    for mode in ("single", "double", "triple", "full"):
        mode_windows: dict[str, Any] = {}
        for window_key in ("10", "100", "1000", "5000", "all"):
            mode_windows[window_key] = _build_around_the_clock_window(ordered, window_key, game_mode=mode)
        modes[mode] = {"windows": mode_windows}
    return {
        "overall": windows["all"],
        "windows": windows,
        "modes": modes,
    }
