from __future__ import annotations

from datetime import datetime, timezone
import os
import random
from typing import Any, Optional
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.core.capabilities import get_session_snapshot, require_capability
from backend.core.club_store import get_club_store
from backend.core.player_profiles import get_player_stats

router = APIRouter(tags=["club"])
_SUPPORTED_SOCIAL_NIGHT_GAME_MODES = {"x01", "cricket"}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _require(name: str, message: str) -> None:
    if str(os.getenv("MACHINE_DARTS_CLUB_AUTH_ENFORCE", "0")).strip().lower() not in {"1", "true", "yes", "on"}:
        return
    if not require_capability(name):
        raise HTTPException(status_code=403, detail=message)


def _require_any(names: list[str], message: str) -> None:
    if str(os.getenv("MACHINE_DARTS_CLUB_AUTH_ENFORCE", "0")).strip().lower() not in {"1", "true", "yes", "on"}:
        return
    for name in names:
        if require_capability(name):
            return
    raise HTTPException(status_code=403, detail=message)


def _safe_ppr_from_profile(player_id: str) -> float:
    stats = get_player_stats(str(player_id or "").strip())
    if not isinstance(stats, dict):
        return 0.0
    modes = stats.get("modes", {})
    if not isinstance(modes, dict):
        return 0.0
    x01 = modes.get("x01", {})
    if not isinstance(x01, dict):
        return 0.0
    overall = x01.get("overall", {})
    if not isinstance(overall, dict):
        return 0.0
    averages = overall.get("averages", {})
    if not isinstance(averages, dict):
        return 0.0
    ppr = averages.get("ppr", {})
    if not isinstance(ppr, dict):
        return 0.0
    try:
        return float(ppr.get("current", 0.0) or 0.0)
    except Exception:
        return 0.0


def _assign_start_scores_by_rank(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # Best players get higher start scores per club handicap convention.
    score_ladder = [701, 651, 601, 551, 501, 451]
    if not items:
        return []
    ordered = sorted(items, key=lambda row: float(row.get("rating", 0.0)), reverse=True)
    count = len(ordered)
    for rank, row in enumerate(ordered):
        bucket = min(len(score_ladder) - 1, int((rank * len(score_ladder)) / max(1, count)))
        row["start_score"] = int(score_ladder[bucket])
    return ordered


def _round_robin_pairs(indices: list[int]) -> list[list[tuple[int, int]]]:
    if len(indices) < 2:
        return []
    participants = list(indices)
    bye = -1
    if len(participants) % 2 == 1:
        participants.append(bye)
    rounds: list[list[tuple[int, int]]] = []
    n = len(participants)
    for _ in range(n - 1):
        half = n // 2
        left = participants[:half]
        right = list(reversed(participants[half:]))
        matches: list[tuple[int, int]] = []
        for a, b in zip(left, right):
            if a == bye or b == bye:
                continue
            matches.append((a, b))
        rounds.append(matches)
        participants = [participants[0]] + [participants[-1]] + participants[1:-1]
    return rounds


def _balanced_group_sizes(total: int, group_count: int) -> list[int]:
    if group_count <= 0:
        return [total]
    base = total // group_count
    rem = total % group_count
    return [base + (1 if idx < rem else 0) for idx in range(group_count)]


def _build_social_night_plan(payload: SocialNightPlanPayload) -> dict[str, Any]:
    if not payload.players:
        raise HTTPException(status_code=400, detail="Social night plan requires at least 2 players.")

    game_mode = str(payload.game_mode or "x01").strip().lower()
    if game_mode not in _SUPPORTED_SOCIAL_NIGHT_GAME_MODES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported social-night game mode '{game_mode}'. Supported: x01, cricket.",
        )

    board_ids = [str(b).strip() for b in payload.board_ids if str(b).strip()]
    if not board_ids:
        board_ids = ["board-1"]

    rng = random.Random(payload.random_seed if payload.random_seed is not None else None)
    players: list[dict[str, Any]] = []
    for p in payload.players:
        pid = str(p.id or "").strip()
        rating = _safe_ppr_from_profile(pid) if pid else 0.0
        players.append(
            {
                "id": pid,
                "name": str(p.name).strip(),
                "rating": round(float(rating), 2),
            }
        )

    participants: list[dict[str, Any]]
    fmt = str(payload.format or "singles").strip().lower()
    if fmt == "doubles":
        pool = list(players)
        rng.shuffle(pool)
        pairs: list[dict[str, Any]] = []
        pair_idx = 1
        while len(pool) >= 2:
            a = pool.pop()
            b = pool.pop()
            pairs.append(
                {
                    "id": f"team_{pair_idx}",
                    "name": f"{a['name']} / {b['name']}",
                    "members": [a, b],
                    "rating": round((float(a.get("rating", 0.0)) + float(b.get("rating", 0.0))) / 2.0, 2),
                }
            )
            pair_idx += 1
        if pool:
            leftover = pool.pop()
            pairs.append(
                {
                    "id": f"team_{pair_idx}",
                    "name": f"{leftover['name']} / Bye",
                    "members": [leftover],
                    "rating": float(leftover.get("rating", 0.0)),
                    "incomplete": True,
                }
            )
        participants = pairs
    else:
        participants = [
            {
                "id": row.get("id") or f"player_{idx+1}",
                "name": row.get("name", f"Player {idx+1}"),
                "members": [row],
                "rating": float(row.get("rating", 0.0)),
            }
            for idx, row in enumerate(players)
        ]

    if len(participants) < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 participants for social night.")

    ranked = _assign_start_scores_by_rank(participants)
    if not payload.preserve_rating_order:
        rng.shuffle(ranked)

    board_count = min(len(board_ids), max(1, (len(ranked) + max(1, payload.players_per_board) - 1) // max(1, payload.players_per_board)))
    sizes = _balanced_group_sizes(len(ranked), board_count)

    groups: list[dict[str, Any]] = []
    cursor = 0
    for g_idx, g_size in enumerate(sizes):
        if g_size <= 0:
            continue
        chunk = ranked[cursor: cursor + g_size]
        cursor += g_size
        board_id = board_ids[g_idx % len(board_ids)]
        rounds = _round_robin_pairs(list(range(len(chunk))))
        fixtures: list[dict[str, Any]] = []
        for r_idx, round_matches in enumerate(rounds, start=1):
            match_list: list[dict[str, Any]] = []
            for m_idx, (a_idx, b_idx) in enumerate(round_matches, start=1):
                pa = chunk[a_idx]
                pb = chunk[b_idx]
                match_list.append(
                    {
                        "match_id": f"{board_id}_r{r_idx}_m{m_idx}",
                        "round": r_idx,
                        "a": {
                            "id": pa.get("id"),
                            "name": pa.get("name"),
                            "start_score": pa.get("start_score"),
                        },
                        "b": {
                            "id": pb.get("id"),
                            "name": pb.get("name"),
                            "start_score": pb.get("start_score"),
                        },
                    }
                )
            fixtures.append({"round": r_idx, "matches": match_list})
        groups.append(
            {
                "board_id": board_id,
                "group_name": f"Group {g_idx + 1}",
                "participants": chunk,
                "fixtures": fixtures,
                "games_per_participant": max(0, len(chunk) - 1),
                "qualify_wins": int(payload.qualify_wins),
            }
        )

    return {
        "name": payload.name,
        "format": "doubles" if fmt == "doubles" else "singles",
        "game_mode": game_mode,
        "board_ids": board_ids,
        "players_per_board": int(payload.players_per_board),
        "qualify_wins": int(payload.qualify_wins),
        "groups": groups,
        "generated_at": _utc_now(),
    }


def _compute_social_night_standings(record: dict[str, Any]) -> dict[str, Any]:
    plan = record.get("plan", {}) if isinstance(record, dict) else {}
    results = record.get("results", {}) if isinstance(record, dict) else {}
    if not isinstance(plan, dict):
        plan = {}
    if not isinstance(results, dict):
        results = {}
    groups = plan.get("groups", [])
    standings_groups: list[dict[str, Any]] = []
    for group in groups if isinstance(groups, list) else []:
        participants = group.get("participants", []) if isinstance(group, dict) else []
        fixtures = group.get("fixtures", []) if isinstance(group, dict) else []
        qualify_wins = int(group.get("qualify_wins", plan.get("qualify_wins", 3)) or 3) if isinstance(group, dict) else 3
        table: dict[str, dict[str, Any]] = {}
        for p in participants if isinstance(participants, list) else []:
            pid = str((p or {}).get("id") or (p or {}).get("name") or "")
            if not pid:
                continue
            table[pid] = {
                "id": (p or {}).get("id"),
                "name": str((p or {}).get("name", "Player")),
                "start_score": (p or {}).get("start_score"),
                "wins": 0,
                "losses": 0,
                "played": 0,
                "qualified": False,
            }
        for round_block in fixtures if isinstance(fixtures, list) else []:
            matches = round_block.get("matches", []) if isinstance(round_block, dict) else []
            for match in matches if isinstance(matches, list) else []:
                match_id = str((match or {}).get("match_id", ""))
                if not match_id:
                    continue
                res = results.get(match_id, {})
                if not isinstance(res, dict):
                    continue
                winner = str(res.get("winner", "")).strip().lower()
                a = (match or {}).get("a", {})
                b = (match or {}).get("b", {})
                a_key = str((a or {}).get("id") or (a or {}).get("name") or "")
                b_key = str((b or {}).get("id") or (b or {}).get("name") or "")
                if not a_key or not b_key:
                    continue
                if a_key not in table or b_key not in table:
                    continue
                if winner in {"a", "left", "1", a_key.lower(), str(table[a_key]["name"]).lower()}:
                    table[a_key]["wins"] += 1
                    table[b_key]["losses"] += 1
                elif winner in {"b", "right", "2", b_key.lower(), str(table[b_key]["name"]).lower()}:
                    table[b_key]["wins"] += 1
                    table[a_key]["losses"] += 1
                else:
                    continue
                table[a_key]["played"] += 1
                table[b_key]["played"] += 1
        rows = sorted(
            table.values(),
            key=lambda r: (int(r.get("wins", 0)), -int(r.get("losses", 0)), str(r.get("name", "")).lower()),
            reverse=True,
        )
        for row in rows:
            row["qualified"] = int(row.get("wins", 0)) >= qualify_wins
        standings_groups.append(
            {
                "group_name": str((group or {}).get("group_name", "Group")),
                "board_id": str((group or {}).get("board_id", "")),
                "qualify_wins": qualify_wins,
                "rows": rows,
            }
        )
    return {"groups": standings_groups}


def _resolve_next_match_for_board(
    *,
    board_id: str,
    social_night: dict[str, Any],
) -> dict[str, Any] | None:
    plan = social_night.get("plan", {}) if isinstance(social_night, dict) else {}
    results = social_night.get("results", {}) if isinstance(social_night, dict) else {}
    if not isinstance(plan, dict):
        return None
    if not isinstance(results, dict):
        results = {}
    groups = plan.get("groups", [])
    if not isinstance(groups, list):
        return None

    for group in groups:
        if not isinstance(group, dict):
            continue
        if str(group.get("board_id", "")).strip() != board_id:
            continue
        fixtures = group.get("fixtures", [])
        if not isinstance(fixtures, list):
            continue
        for fixture in fixtures:
            if not isinstance(fixture, dict):
                continue
            round_no = int(fixture.get("round", 0) or 0)
            matches = fixture.get("matches", [])
            if not isinstance(matches, list):
                continue
            for idx, match in enumerate(matches):
                if not isinstance(match, dict):
                    continue
                match_id = str(match.get("match_id", "")).strip()
                if not match_id or match_id in results:
                    continue
                a = match.get("a", {}) if isinstance(match.get("a", {}), dict) else {}
                b = match.get("b", {}) if isinstance(match.get("b", {}), dict) else {}
                return {
                    "social_night_id": str(social_night.get("id", "")),
                    "social_night_name": str(social_night.get("name", "")),
                    "board_id": board_id,
                    "game_mode": str(plan.get("game_mode", "x01") or "x01"),
                    "format": str(plan.get("format", "singles") or "singles"),
                    "group_name": str(group.get("group_name", "Group")),
                    "round": round_no,
                    "slot": idx + 1,
                    "match_id": match_id,
                    "a": {
                        "id": a.get("id"),
                        "name": str(a.get("name", "Player A")),
                        "start_score": int(a.get("start_score", 501) or 501),
                    },
                    "b": {
                        "id": b.get("id"),
                        "name": str(b.get("name", "Player B")),
                        "start_score": int(b.get("start_score", 501) or 501),
                    },
                }
    return None


def _find_board_match(
    *,
    social_night: dict[str, Any],
    board_id: str,
    match_id: str,
) -> dict[str, Any] | None:
    plan = social_night.get("plan", {}) if isinstance(social_night, dict) else {}
    if not isinstance(plan, dict):
        return None
    groups = plan.get("groups", [])
    if not isinstance(groups, list):
        return None
    for group in groups:
        if not isinstance(group, dict):
            continue
        if str(group.get("board_id", "")).strip() != board_id:
            continue
        fixtures = group.get("fixtures", [])
        if not isinstance(fixtures, list):
            continue
        for fixture in fixtures:
            if not isinstance(fixture, dict):
                continue
            matches = fixture.get("matches", [])
            if not isinstance(matches, list):
                continue
            for match in matches:
                if not isinstance(match, dict):
                    continue
                if str(match.get("match_id", "")).strip() == match_id:
                    return match
    return None


def _generate_playoff_bracket(standings: dict[str, Any], payload: SocialNightPlayoffGeneratePayload) -> dict[str, Any]:
    groups = standings.get("groups", []) if isinstance(standings, dict) else []
    qualifiers: list[dict[str, Any]] = []
    for group in groups if isinstance(groups, list) else []:
        rows = group.get("rows", []) if isinstance(group, dict) else []
        group_name = str(group.get("group_name", "")) if isinstance(group, dict) else ""
        for row in rows if isinstance(rows, list) else []:
            if bool(row.get("qualified")):
                qualifiers.append(
                    {
                        "id": row.get("id"),
                        "name": row.get("name"),
                        "wins": int(row.get("wins", 0) or 0),
                        "losses": int(row.get("losses", 0) or 0),
                        "played": int(row.get("played", 0) or 0),
                        "group": group_name,
                    }
                )
    qualifiers = sorted(
        qualifiers,
        key=lambda r: (int(r.get("wins", 0)), -int(r.get("losses", 0)), str(r.get("name", "")).lower()),
        reverse=True,
    )
    if len(qualifiers) < int(payload.min_qualifiers):
        raise HTTPException(status_code=400, detail=f"Need at least {payload.min_qualifiers} qualifiers before playoffs.")

    max_q = max(2, int(payload.max_qualifiers))
    qualifiers = qualifiers[:max_q]

    size = 2
    while size < len(qualifiers):
        size *= 2
    byes = max(0, size - len(qualifiers))

    seeded = list(qualifiers)
    for i in range(byes):
        seeded.append(
            {
                "id": f"bye_{i+1}",
                "name": "BYE",
                "wins": 0,
                "losses": 0,
                "played": 0,
                "group": "",
                "bye": True,
            }
        )

    round_one: list[dict[str, Any]] = []
    for i in range(len(seeded) // 2):
        a = seeded[i]
        b = seeded[len(seeded) - 1 - i]
        auto_winner = None
        if bool(a.get("bye")) and not bool(b.get("bye")):
            auto_winner = {"id": b.get("id"), "name": b.get("name")}
        elif bool(b.get("bye")) and not bool(a.get("bye")):
            auto_winner = {"id": a.get("id"), "name": a.get("name")}
        round_one.append(
            {
                "match_id": f"po_r1_m{i+1}",
                "round": 1,
                "a": {"id": a.get("id"), "name": a.get("name")},
                "b": {"id": b.get("id"), "name": b.get("name")},
                "winner": auto_winner,
            }
        )

    rounds: list[dict[str, Any]] = [{"round": 1, "matches": round_one}]
    current_count = len(round_one)
    ridx = 2
    while current_count > 1:
        next_matches = [
            {
                "match_id": f"po_r{ridx}_m{midx+1}",
                "round": ridx,
                "a": {"id": None, "name": "TBD"},
                "b": {"id": None, "name": "TBD"},
                "winner": None,
            }
            for midx in range(current_count // 2)
        ]
        rounds.append({"round": ridx, "matches": next_matches})
        current_count = len(next_matches)
        ridx += 1

    return {
        "generated_at": _utc_now(),
        "qualifiers": qualifiers,
        "size": size,
        "rounds": rounds,
    }


class ClubSessionStartPayload(BaseModel):
    title: Optional[str] = None
    operator: Optional[str] = None
    notes: Optional[str] = None


class BoardPolicyApplyPayload(BaseModel):
    policy_id: str = Field(min_length=1)
    policy_name: Optional[str] = None
    lock_detection_settings: bool = True
    lock_runtime_settings: bool = True
    lock_calibration: bool = True
    lock_game_presets: bool = False


class SocialNightCreatePayload(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    starts_at: Optional[str] = None
    board_ids: list[str] = Field(default_factory=list)
    plan: Optional[dict[str, Any]] = None


class TournamentCreatePayload(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    starts_at: Optional[str] = None
    board_ids: list[str] = Field(default_factory=list)
    notes: Optional[str] = None


class SocialNightPlannerPlayer(BaseModel):
    id: Optional[str] = None
    name: str = Field(min_length=1, max_length=120)


class SocialNightPlanPayload(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    format: str = Field(default="singles")
    game_mode: str = Field(default="x01")
    board_ids: list[str] = Field(default_factory=list)
    players_per_board: int = Field(default=6, ge=2, le=16)
    qualify_wins: int = Field(default=3, ge=1, le=16)
    players: list[SocialNightPlannerPlayer] = Field(default_factory=list)
    random_seed: Optional[int] = None
    preserve_rating_order: bool = False


class SyncEventsPayload(BaseModel):
    events: list[dict[str, Any]] = Field(default_factory=list)


class BoardHeartbeatPayload(BaseModel):
    venue_id: Optional[str] = None
    machine_id: str = ""
    status: str = "idle"
    shell: str = "club-board"
    active_game: str = ""
    fps: Optional[float] = None
    diagnostics: dict[str, Any] = Field(default_factory=dict)


class BoardRegisterPayload(BaseModel):
    board_id: str = Field(min_length=1, max_length=80)
    venue_id: str = Field(min_length=1, max_length=120)
    machine_id: str = Field(min_length=1, max_length=120)
    shell: str = "club-board"


class SocialNightResultPayload(BaseModel):
    match_id: str = Field(min_length=1)
    winner: str = Field(min_length=1)
    score_a: Optional[int] = None
    score_b: Optional[int] = None


class BoardMatchResultPayload(BaseModel):
    social_night_id: str = Field(min_length=1)
    match_id: str = Field(min_length=1)
    winner: str = Field(min_length=1)
    score_a: Optional[int] = None
    score_b: Optional[int] = None


class SocialNightPlayoffGeneratePayload(BaseModel):
    min_qualifiers: int = Field(default=4, ge=2, le=64)
    max_qualifiers: int = Field(default=16, ge=2, le=128)


@router.get("/api/club/boards")
def list_boards() -> dict[str, Any]:
    _require("can_use_dashboard", "Dashboard access is restricted to operator role.")
    session = get_session_snapshot()
    venue_id = str(session.get("entitlements", {}).get("venue_id", "local-venue"))
    board_id = str(session.get("entitlements", {}).get("board_id", "board-1"))
    boards = get_club_store().list_boards(venue_id=venue_id, seed_board_ids=[board_id, "board-2", "board-3"])
    return {"boards": boards}


@router.post("/api/club/boards/register")
def register_board(payload: BoardRegisterPayload) -> dict[str, Any]:
    _require_any(
        ["can_use_club_board", "can_use_dashboard"],
        "Board registration is restricted to club board/operator roles.",
    )
    ok, record = get_club_store().register_board(
        board_id=str(payload.board_id).strip(),
        venue_id=str(payload.venue_id).strip(),
        machine_id=str(payload.machine_id).strip(),
        shell=str(payload.shell or "club-board"),
    )
    if not ok:
        raise HTTPException(
            status_code=409,
            detail={
                "message": f"Board id '{payload.board_id}' is already claimed by another machine.",
                "existing": record,
            },
        )
    return {"ok": True, "board": record}


@router.post("/api/club/boards/{board_id}/heartbeat")
def board_heartbeat(board_id: str, payload: BoardHeartbeatPayload) -> dict[str, Any]:
    _require_any(
        ["can_use_club_board", "can_use_dashboard"],
        "Board heartbeat is restricted to club board/operator roles.",
    )
    session = get_session_snapshot()
    venue_id = str(payload.venue_id or session.get("entitlements", {}).get("venue_id", "local-venue"))
    machine_id = str(payload.machine_id or "").strip()
    if not machine_id:
        machine_id = "unknown-machine"
    row = get_club_store().upsert_board_heartbeat(
        board_id=board_id,
        venue_id=venue_id,
        machine_id=machine_id,
        status=str(payload.status or "idle"),
        shell=str(payload.shell or ""),
        active_game=str(payload.active_game or ""),
        fps=payload.fps,
        payload={"diagnostics": dict(payload.diagnostics or {})},
    )
    if row is None:
        raise HTTPException(status_code=409, detail=f"Board id '{board_id}' is already claimed by another machine.")
    return {"ok": True, "board": row}


@router.post("/api/club/boards/{board_id}/session/start")
def start_board_session(board_id: str, payload: ClubSessionStartPayload) -> dict[str, Any]:
    _require("can_manage_sessions", "Session control is restricted to operator role.")
    session_id = f"sess_{uuid4().hex[:10]}"
    session = get_session_snapshot()
    venue_id = str(session.get("entitlements", {}).get("venue_id", "local-venue"))
    record = get_club_store().start_session(
        session_id=session_id,
        board_id=board_id,
        venue_id=venue_id,
        title=payload.title or "Open Session",
        operator=payload.operator or session.get("user", {}).get("name", "Operator"),
        notes=payload.notes or "",
    )
    return {"ok": True, "session": record}


@router.post("/api/club/boards/{board_id}/session/stop")
def stop_board_session(board_id: str) -> dict[str, Any]:
    _require("can_manage_sessions", "Session control is restricted to operator role.")
    current = get_club_store().stop_session(board_id=board_id)
    if not current:
        raise HTTPException(status_code=404, detail=f"No active session for board '{board_id}'.")
    return {"ok": True, "session": current}


@router.post("/api/club/boards/{board_id}/policy/apply")
def apply_board_policy(board_id: str, payload: BoardPolicyApplyPayload) -> dict[str, Any]:
    _require("can_lock_settings", "Board policy actions are restricted to operator role.")
    record = get_club_store().apply_policy(
        board_id=board_id,
        policy_id=payload.policy_id,
        policy_name=payload.policy_name or payload.policy_id,
        lock_detection_settings=bool(payload.lock_detection_settings),
        lock_runtime_settings=bool(payload.lock_runtime_settings),
        lock_calibration=bool(payload.lock_calibration),
        lock_game_presets=bool(payload.lock_game_presets),
    )
    return {"ok": True, "policy": record}


@router.get("/api/club/boards/{board_id}/next-match")
def get_board_next_match(board_id: str) -> dict[str, Any]:
    _require_any(
        ["can_use_club_board", "can_use_dashboard"],
        "Board queue access is restricted to club board/operator roles.",
    )
    store = get_club_store()
    active_nights = store.list_active_social_nights()
    for night in active_nights:
        if board_id not in [str(v).strip() for v in list(night.get("board_ids", []))]:
            continue
        match = _resolve_next_match_for_board(board_id=board_id, social_night=night)
        if match is not None:
            return {"ok": True, "has_match": True, "next_match": match}
    return {"ok": True, "has_match": False, "next_match": None}


@router.post("/api/club/boards/{board_id}/results")
def post_board_match_result(board_id: str, payload: BoardMatchResultPayload) -> dict[str, Any]:
    _require_any(
        ["can_use_club_board", "can_use_dashboard"],
        "Board result submission is restricted to club board/operator roles.",
    )
    store = get_club_store()
    record = store.get_social_night(str(payload.social_night_id).strip())
    if not record:
        raise HTTPException(status_code=404, detail=f"Social night '{payload.social_night_id}' not found.")
    match = _find_board_match(
        social_night=record,
        board_id=str(board_id).strip(),
        match_id=str(payload.match_id).strip(),
    )
    if match is None:
        raise HTTPException(status_code=403, detail="This board cannot submit results for that match.")
    updated = store.upsert_social_night_result(
        social_id=str(payload.social_night_id).strip(),
        match_id=str(payload.match_id).strip(),
        winner=str(payload.winner).strip(),
        score_a=payload.score_a,
        score_b=payload.score_b,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail=f"Social night '{payload.social_night_id}' not found.")
    standings = _compute_social_night_standings(store.get_social_night(str(payload.social_night_id).strip()) or {})
    return {"ok": True, "result": updated, "standings": standings}


@router.post("/api/club/social-nights")
def create_social_night(payload: SocialNightCreatePayload) -> dict[str, Any]:
    _require("can_use_dashboard", "Social night management is restricted to operator role.")
    plan = dict(payload.plan or {})
    if plan:
        mode = str(plan.get("game_mode", "x01")).strip().lower()
        if mode not in _SUPPORTED_SOCIAL_NIGHT_GAME_MODES:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported social-night game mode '{mode}'. Supported: x01, cricket.",
            )
    social_id = f"night_{uuid4().hex[:10]}"
    record = get_club_store().create_social_night(
        social_id=social_id,
        name=payload.name,
        starts_at=payload.starts_at or _utc_now(),
        board_ids=list(payload.board_ids),
        plan=plan,
    )
    return {"ok": True, "social_night": record}


@router.post("/api/club/social-nights/plan")
def generate_social_night_plan(payload: SocialNightPlanPayload) -> dict[str, Any]:
    _require("can_use_dashboard", "Social night planning is restricted to operator role.")
    return {"ok": True, "plan": _build_social_night_plan(payload)}


@router.post("/api/club/tournaments")
def create_tournament(payload: TournamentCreatePayload) -> dict[str, Any]:
    _require("can_use_dashboard", "Tournament management is restricted to operator role.")
    tournament_id = f"tournament_{uuid4().hex[:10]}"
    record = get_club_store().create_tournament(
        tournament_id=tournament_id,
        name=payload.name,
        starts_at=payload.starts_at or _utc_now(),
        board_ids=list(payload.board_ids),
        notes=payload.notes or "",
    )
    return {"ok": True, "tournament": record}


@router.get("/api/club/social-nights/{social_night_id}/leaderboard")
def get_social_night_leaderboard(social_night_id: str) -> dict[str, Any]:
    _require("can_use_dashboard", "Social night management is restricted to operator role.")
    record = get_club_store().get_social_night(social_night_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"Social night '{social_night_id}' not found.")
    standings = _compute_social_night_standings(record)
    return {"social_night_id": social_night_id, "leaderboard": list(record.get("leaderboard", [])), "standings": standings}


@router.get("/api/club/social-nights/{social_night_id}")
def get_social_night(social_night_id: str) -> dict[str, Any]:
    _require("can_use_dashboard", "Social night management is restricted to operator role.")
    record = get_club_store().get_social_night(social_night_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"Social night '{social_night_id}' not found.")
    standings = _compute_social_night_standings(record)
    return {"ok": True, "social_night": record, "standings": standings}


@router.post("/api/club/social-nights/{social_night_id}/results")
def post_social_night_result(social_night_id: str, payload: SocialNightResultPayload) -> dict[str, Any]:
    _require("can_use_dashboard", "Social night management is restricted to operator role.")
    updated = get_club_store().upsert_social_night_result(
        social_id=social_night_id,
        match_id=payload.match_id,
        winner=payload.winner,
        score_a=payload.score_a,
        score_b=payload.score_b,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail=f"Social night '{social_night_id}' not found.")
    record = get_club_store().get_social_night(social_night_id)
    standings = _compute_social_night_standings(record or {})
    return {"ok": True, "result": updated, "standings": standings}


@router.post("/api/club/social-nights/{social_night_id}/playoffs/generate")
def generate_social_night_playoffs(
    social_night_id: str,
    payload: SocialNightPlayoffGeneratePayload,
) -> dict[str, Any]:
    _require("can_use_dashboard", "Social night management is restricted to operator role.")
    record = get_club_store().get_social_night(social_night_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"Social night '{social_night_id}' not found.")
    standings = _compute_social_night_standings(record)
    bracket = _generate_playoff_bracket(standings, payload)
    saved = get_club_store().set_social_night_playoffs(social_id=social_night_id, playoffs=bracket)
    if saved is None:
        raise HTTPException(status_code=404, detail=f"Social night '{social_night_id}' not found.")
    return {"ok": True, "playoffs": bracket, "standings": standings}


@router.get("/api/club/analytics/playtime")
def get_playtime_analytics(from_: Optional[str] = None, to: Optional[str] = None, board_id: Optional[str] = None) -> dict[str, Any]:
    _require("can_view_club_analytics", "Playtime analytics are restricted to operator role.")
    stats = get_club_store().playtime_metrics(from_value=from_, to_value=to, board_id=board_id)
    return {
        "filters": {"from": from_, "to": to, "board_id": board_id},
        "metrics": dict(stats.get("metrics", {})),
        "boards": list(stats.get("boards", [])),
    }


@router.post("/api/club/sync/events")
def sync_events(payload: SyncEventsPayload) -> dict[str, Any]:
    _require("cloud_sync_enabled", "Cloud sync is unavailable for this edition.")
    accepted = []
    now = _utc_now()
    store = get_club_store()
    for item in payload.events:
        event_id = str(item.get("event_id") or f"evt_{uuid4().hex[:12]}")
        store.upsert_sync_event(
            event_id=event_id,
            event_type=str(item.get("type", "unknown")),
            payload=dict(item.get("payload", {})),
            received_at=now,
        )
        accepted.append({"event_id": event_id, "status": "accepted"})
    return {"accepted": accepted, "count": len(accepted)}
