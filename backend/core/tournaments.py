from __future__ import annotations

import json
import os
import random
import sys
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend.core.player_bot_library import list_imported_player_bots
from backend.core.player_profiles import get_player_bot_status


_LOCK = threading.Lock()
_SCHEMA_VERSION = 1


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _resolve_tournaments_path() -> Path:
    if getattr(sys, "frozen", False):
        if os.name == "nt":
            appdata = os.getenv("APPDATA", "").strip()
            base = Path(appdata).resolve() / "DartDetector" if appdata else Path.home() / "AppData" / "Roaming" / "DartDetector"
        else:
            xdg_data_home = os.getenv("XDG_DATA_HOME", "").strip()
            base = Path(xdg_data_home).resolve() if xdg_data_home else Path.home() / ".local" / "share"
            base = base / "DartDetector"
        return base / "settings" / "tournaments.json"
    return Path(__file__).resolve().parents[1] / "data" / "settings" / "tournaments.json"


_TOURNAMENTS_PATH = _resolve_tournaments_path()


def _default_payload() -> dict[str, Any]:
    return {"version": _SCHEMA_VERSION, "tournaments": [], "updated_at": _utc_now_iso()}


def _load_payload() -> dict[str, Any]:
    payload = _default_payload()
    try:
        if _TOURNAMENTS_PATH.exists():
            incoming = json.loads(_TOURNAMENTS_PATH.read_text(encoding="utf-8"))
            if isinstance(incoming, dict):
                payload.update({key: incoming[key] for key in payload.keys() if key in incoming})
    except Exception:
        pass
    if not isinstance(payload.get("tournaments"), list):
        payload["tournaments"] = []
    return payload


def _save_payload(payload: dict[str, Any]) -> None:
    payload["updated_at"] = _utc_now_iso()
    _TOURNAMENTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    _TOURNAMENTS_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _next_power_of_two(value: int) -> int:
    size = 1
    while size < max(2, int(value)):
        size *= 2
    return size


def _normalize_participant(raw: dict[str, Any], index: int) -> dict[str, Any]:
    participant_id = str(raw.get("id") or uuid.uuid4().hex).strip()
    name = str(raw.get("name") or f"Player {index + 1}").strip() or f"Player {index + 1}"
    participant_type = str(raw.get("type") or "guest").strip().lower()
    if participant_type not in {"profile", "guest", "ai_bot", "player_bot"}:
        participant_type = "guest"
    return {
        "id": participant_id,
        "name": name,
        "type": participant_type,
        "profileId": str(raw.get("profileId") or "").strip() or None,
        "botLevel": _safe_int(raw.get("botLevel"), 4) if participant_type == "ai_bot" else None,
        "sourcePlayerId": str(raw.get("sourcePlayerId") or "").strip() or None,
    }


def _is_background_participant(participant: dict[str, Any] | None) -> bool:
    return str((participant or {}).get("type") or "").strip().lower() in {"ai_bot", "player_bot"}


def _participant_strength(participant: dict[str, Any] | None) -> float:
    if not isinstance(participant, dict):
        return 45.0
    participant_type = str(participant.get("type") or "").strip().lower()
    if participant_type == "ai_bot":
        level = max(1, min(9, _safe_int(participant.get("botLevel"), 4)))
        return 18.0 + (level * 8.0)
    if participant_type == "player_bot":
        source_player_id = str(participant.get("sourcePlayerId") or "").strip()
        status = get_player_bot_status(source_player_id) if source_player_id else None
        if not status:
            imported = list_imported_player_bots()
            status = next((row for row in imported if str(row.get("playerId") or "") == source_player_id), None)
        ppr = float((status or {}).get("ppr") or (status or {}).get("average") or 0.0)
        return ppr if ppr > 0 else 45.0
    return 45.0


def _match_player(participant_id: str | None) -> dict[str, Any] | None:
    if not participant_id:
        return None
    return {"participantId": participant_id}


def _build_knockout_matches(participants: list[dict[str, Any]]) -> list[dict[str, Any]]:
    bracket_size = _next_power_of_two(len(participants))
    participant_ids = [str(item["id"]) for item in participants]
    bye_count = bracket_size - len(participant_ids)
    first_round_count = bracket_size // 2
    bye_positions: list[int] = []
    left = 0
    right = first_round_count - 1
    while len(bye_positions) < bye_count and left <= right:
        bye_positions.append(left)
        if len(bye_positions) < bye_count and right != left:
            bye_positions.append(right)
        left += 1
        right -= 1
    bye_position_set = set(bye_positions)
    pairs: list[tuple[str | None, str | None]] = []
    cursor = 0
    for idx in range(first_round_count):
        if idx in bye_position_set:
            player = participant_ids[cursor] if cursor < len(participant_ids) else None
            cursor += 1
            pairs.append((player, None))
        else:
            player_a = participant_ids[cursor] if cursor < len(participant_ids) else None
            player_b = participant_ids[cursor + 1] if cursor + 1 < len(participant_ids) else None
            cursor += 2
            pairs.append((player_a, player_b))
    matches: list[dict[str, Any]] = []
    round_count = bracket_size.bit_length() - 1

    for idx, (player_a, player_b) in enumerate(pairs):
        winner = player_a if player_a and not player_b else player_b if player_b and not player_a else None
        matches.append(
            {
                "id": uuid.uuid4().hex,
                "round": 1,
                "position": idx,
                "playerAId": player_a,
                "playerBId": player_b,
                "status": "complete" if winner else "pending",
                "winnerId": winner,
                "emptyBye": not player_a and not player_b,
                "readyParticipantIds": [],
                "legsA": None,
                "legsB": None,
                "startedAt": None,
                "completedAt": _utc_now_iso() if winner else None,
            }
        )

    for round_number in range(2, round_count + 1):
        match_count = bracket_size // (2 ** round_number)
        for idx in range(match_count):
            matches.append(
                {
                    "id": uuid.uuid4().hex,
                    "round": round_number,
                    "position": idx,
                    "playerAId": None,
                    "playerBId": None,
                    "status": "waiting",
                    "winnerId": None,
                    "readyParticipantIds": [],
                    "legsA": None,
                    "legsB": None,
                    "startedAt": None,
                    "completedAt": None,
                }
            )
    _advance_completed_matches(matches)
    return matches


def _advance_completed_matches(matches: list[dict[str, Any]]) -> None:
    changed = True
    while changed:
        changed = False
        for match in matches:
            if not isinstance(match, dict):
                continue
            if _safe_int(match.get("round"), 1) != 1:
                continue
            if str(match.get("playerAId") or "").strip() or str(match.get("playerBId") or "").strip():
                continue
            if str(match.get("status")) != "complete":
                match["status"] = "complete"
                match["winnerId"] = None
                match["emptyBye"] = True
                match["completedAt"] = match.get("completedAt") or _utc_now_iso()
                changed = True
        for match in matches:
            winner_id = str(match.get("winnerId") or "").strip()
            if not winner_id:
                continue
            round_number = _safe_int(match.get("round"), 1)
            position = _safe_int(match.get("position"), 0)
            next_round = round_number + 1
            next_position = position // 2
            next_match = next(
                (
                    row
                    for row in matches
                    if _safe_int(row.get("round"), 0) == next_round and _safe_int(row.get("position"), -1) == next_position
                ),
                None,
            )
            if not next_match:
                continue
            slot_key = "playerAId" if position % 2 == 0 else "playerBId"
            if next_match.get(slot_key) != winner_id:
                next_match[slot_key] = winner_id
                changed = True
            if next_match.get("winnerId"):
                continue
            a = str(next_match.get("playerAId") or "").strip()
            b = str(next_match.get("playerBId") or "").strip()
            if a and b and next_match.get("status") == "waiting":
                next_match["status"] = "pending"
                changed = True
        for match in matches:
            if not isinstance(match, dict):
                continue
            if str(match.get("winnerId") or "").strip():
                continue
            round_number = _safe_int(match.get("round"), 1)
            if round_number <= 1:
                continue
            player_a = str(match.get("playerAId") or "").strip()
            player_b = str(match.get("playerBId") or "").strip()
            if bool(player_a) == bool(player_b):
                continue
            prev_round = round_number - 1
            prev_base = _safe_int(match.get("position"), 0) * 2
            feeders = [
                row
                for row in matches
                if _safe_int(row.get("round"), 0) == prev_round
                and _safe_int(row.get("position"), -1) in {prev_base, prev_base + 1}
            ]
            if len(feeders) != 2 or not all(str(row.get("status")) == "complete" for row in feeders):
                continue
            winner_id = player_a or player_b
            match["status"] = "complete"
            match["winnerId"] = winner_id
            match["readyParticipantIds"] = []
            match["completedAt"] = match.get("completedAt") or _utc_now_iso()
            changed = True


def _repair_invalid_match_completions(matches: list[dict[str, Any]]) -> None:
    for match in matches:
        if not isinstance(match, dict):
            continue
        if str(match.get("status")) != "complete" or _safe_int(match.get("round"), 1) <= 1:
            continue
        player_a = str(match.get("playerAId") or "").strip()
        player_b = str(match.get("playerBId") or "").strip()
        winner_id = str(match.get("winnerId") or "").strip()
        if player_a and player_b and winner_id in {player_a, player_b}:
            continue
        match["status"] = "pending" if player_a and player_b else "waiting"
        match["winnerId"] = None
        match["readyParticipantIds"] = []
        match["legsA"] = None
        match["legsB"] = None
        match["completedAt"] = None
        match.pop("background", None)
        match.pop("backgroundLog", None)
        match.pop("backgroundLoserId", None)


def _refresh_status(tournament: dict[str, Any]) -> None:
    matches = tournament.get("matches")
    if not isinstance(matches, list):
        matches = []
        tournament["matches"] = matches
    _repair_invalid_match_completions(matches)
    _advance_completed_matches(matches)
    if matches and all(str(match.get("status")) == "complete" for match in matches):
        tournament["status"] = "complete"
        final_match = max(matches, key=lambda row: (_safe_int(row.get("round"), 0), _safe_int(row.get("position"), 0)))
        tournament["winnerId"] = str(final_match.get("winnerId") or "").strip() or None
    elif any(str(match.get("status")) in {"active", "complete"} for match in matches):
        tournament["status"] = "active"
    else:
        tournament["status"] = "draft"
    tournament["updatedAt"] = _utc_now_iso()


def list_tournaments() -> list[dict[str, Any]]:
    with _LOCK:
        payload = _load_payload()
    return sorted(
        [dict(item) for item in payload.get("tournaments", []) if isinstance(item, dict)],
        key=lambda item: str(item.get("updatedAt") or item.get("createdAt") or ""),
        reverse=True,
    )


def get_tournament(tournament_id: str) -> dict[str, Any] | None:
    target = str(tournament_id or "").strip()
    if not target:
        return None
    with _LOCK:
        payload = _load_payload()
    for item in payload.get("tournaments", []):
        if isinstance(item, dict) and str(item.get("id", "")).strip() == target:
            tournament = dict(item)
            _refresh_status(tournament)
            return tournament
    return None


def create_knockout_tournament(
    *,
    name: str,
    participants: list[dict[str, Any]],
    settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    normalized = [_normalize_participant(item, idx) for idx, item in enumerate(participants) if isinstance(item, dict)]
    if len(normalized) < 2:
        raise ValueError("At least two participants are required.")
    now = _utc_now_iso()
    tournament = {
        "id": uuid.uuid4().hex,
        "schemaVersion": _SCHEMA_VERSION,
        "name": str(name or "Knockout Tournament").strip() or "Knockout Tournament",
        "format": "knockout",
        "status": "draft",
        "participants": normalized,
        "settings": dict(settings or {}),
        "matches": _build_knockout_matches(normalized),
        "winnerId": None,
        "createdAt": now,
        "updatedAt": now,
    }
    _refresh_status(tournament)
    with _LOCK:
        payload = _load_payload()
        payload.setdefault("tournaments", []).append(tournament)
        _save_payload(payload)
    return tournament


def update_match_status(tournament_id: str, match_id: str, status: str) -> dict[str, Any]:
    normalized_status = str(status or "").strip().lower()
    if normalized_status not in {"pending", "active"}:
        raise ValueError("Unsupported match status.")
    with _LOCK:
        payload = _load_payload()
        for tournament in payload.get("tournaments", []):
            if not isinstance(tournament, dict) or str(tournament.get("id", "")) != str(tournament_id):
                continue
            for match in tournament.get("matches", []):
                if isinstance(match, dict) and str(match.get("id", "")) == str(match_id):
                    if str(match.get("status")) == "complete":
                        raise ValueError("Completed matches cannot be changed.")
                    match["status"] = normalized_status
                    if normalized_status == "active":
                        match["startedAt"] = match.get("startedAt") or _utc_now_iso()
                    _refresh_status(tournament)
                    _save_payload(payload)
                    return dict(tournament)
            raise ValueError("Match not found.")
    raise ValueError("Tournament not found.")


def set_match_participant_ready(
    *,
    tournament_id: str,
    match_id: str,
    participant_id: str,
    ready: bool = True,
) -> dict[str, Any]:
    target_participant_id = str(participant_id or "").strip()
    if not target_participant_id:
        raise ValueError("Participant is required.")
    with _LOCK:
        payload = _load_payload()
        for tournament in payload.get("tournaments", []):
            if not isinstance(tournament, dict) or str(tournament.get("id", "")) != str(tournament_id):
                continue
            participants = {str(item.get("id")) for item in tournament.get("participants", []) if isinstance(item, dict)}
            if target_participant_id not in participants:
                raise ValueError("Participant is not in this tournament.")
            for match in tournament.get("matches", []):
                if not isinstance(match, dict) or str(match.get("id", "")) != str(match_id):
                    continue
                if str(match.get("status")) == "complete":
                    raise ValueError("Completed matches cannot be changed.")
                if target_participant_id not in {str(match.get("playerAId") or ""), str(match.get("playerBId") or "")}:
                    raise ValueError("Participant is not in this match.")
                ready_ids = match.get("readyParticipantIds")
                if not isinstance(ready_ids, list):
                    ready_ids = []
                ready_set = {str(item) for item in ready_ids if str(item).strip()}
                if ready:
                    ready_set.add(target_participant_id)
                else:
                    ready_set.discard(target_participant_id)
                match["readyParticipantIds"] = sorted(ready_set)
                _refresh_status(tournament)
                _save_payload(payload)
                return dict(tournament)
            raise ValueError("Match not found.")
    raise ValueError("Tournament not found.")


def record_match_result(
    *,
    tournament_id: str,
    match_id: str,
    winner_id: str,
    legs_a: int | None = None,
    legs_b: int | None = None,
) -> dict[str, Any]:
    with _LOCK:
        payload = _load_payload()
        for tournament in payload.get("tournaments", []):
            if not isinstance(tournament, dict) or str(tournament.get("id", "")) != str(tournament_id):
                continue
            participants = {str(item.get("id")) for item in tournament.get("participants", []) if isinstance(item, dict)}
            if str(winner_id) not in participants:
                raise ValueError("Winner is not a tournament participant.")
            for match in tournament.get("matches", []):
                if not isinstance(match, dict) or str(match.get("id", "")) != str(match_id):
                    continue
                if str(winner_id) not in {str(match.get("playerAId") or ""), str(match.get("playerBId") or "")}:
                    raise ValueError("Winner is not in this match.")
                match["winnerId"] = str(winner_id)
                match["status"] = "complete"
                match["readyParticipantIds"] = []
                match["legsA"] = legs_a
                match["legsB"] = legs_b
                match["completedAt"] = _utc_now_iso()
                _refresh_status(tournament)
                _save_payload(payload)
                return dict(tournament)
            raise ValueError("Match not found.")
    raise ValueError("Tournament not found.")


def resolve_background_matches(tournament_id: str) -> dict[str, Any]:
    target = str(tournament_id or "").strip()
    if not target:
        raise ValueError("Tournament not found.")
    resolved_count = 0
    with _LOCK:
        payload = _load_payload()
        for tournament in payload.get("tournaments", []):
            if not isinstance(tournament, dict) or str(tournament.get("id", "")) != target:
                continue
            changed = True
            while changed:
                changed = False
                _refresh_status(tournament)
                participants = {
                    str(item.get("id")): item
                    for item in tournament.get("participants", [])
                    if isinstance(item, dict) and str(item.get("id") or "").strip()
                }
                for match in tournament.get("matches", []):
                    if not isinstance(match, dict) or str(match.get("status")) != "pending":
                        continue
                    player_a = participants.get(str(match.get("playerAId") or ""))
                    player_b = participants.get(str(match.get("playerBId") or ""))
                    if not (_is_background_participant(player_a) and _is_background_participant(player_b)):
                        continue
                    strength_a = _participant_strength(player_a)
                    strength_b = _participant_strength(player_b)
                    total_strength = max(1.0, strength_a + strength_b)
                    chance_a = max(0.08, min(0.92, strength_a / total_strength))
                    winner_slot = "A" if random.random() <= chance_a else "B"
                    winner_id = str(match.get("playerAId") if winner_slot == "A" else match.get("playerBId"))
                    loser_id = str(match.get("playerBId") if winner_slot == "A" else match.get("playerAId"))
                    target_legs = max(1, _safe_int((tournament.get("settings") or {}).get("legsPerSet"), 3))
                    loser_legs = random.randint(0, max(0, target_legs - 1))
                    legs_a = target_legs if winner_slot == "A" else loser_legs
                    legs_b = target_legs if winner_slot == "B" else loser_legs
                    now = _utc_now_iso()
                    match["status"] = "complete"
                    match["winnerId"] = winner_id
                    match["readyParticipantIds"] = []
                    match["legsA"] = legs_a
                    match["legsB"] = legs_b
                    match["startedAt"] = match.get("startedAt") or now
                    match["completedAt"] = now
                    match["background"] = True
                    match["backgroundLog"] = [
                        f"Background bot match: {str((player_a or {}).get('name') or 'Bot A')} vs {str((player_b or {}).get('name') or 'Bot B')}.",
                        f"Estimated strength: {strength_a:.1f} vs {strength_b:.1f}.",
                        f"Winner: {str((participants.get(winner_id) or {}).get('name') or 'Winner')} ({legs_a}-{legs_b}).",
                    ]
                    match["backgroundLoserId"] = loser_id
                    resolved_count += 1
                    changed = True
                    break
            _refresh_status(tournament)
            if resolved_count:
                _save_payload(payload)
            return {"tournament": dict(tournament), "resolved": resolved_count}
    raise ValueError("Tournament not found.")


def delete_tournament(tournament_id: str) -> bool:
    target = str(tournament_id or "").strip()
    if not target:
        return False
    with _LOCK:
        payload = _load_payload()
        tournaments = payload.setdefault("tournaments", [])
        before = len(tournaments)
        payload["tournaments"] = [
            item for item in tournaments if not (isinstance(item, dict) and str(item.get("id", "")) == target)
        ]
        deleted = len(payload["tournaments"]) != before
        if deleted:
            _save_payload(payload)
        return deleted
