from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.core.tournaments import (
    create_knockout_tournament,
    delete_tournament,
    get_tournament,
    list_tournaments,
    record_match_result,
    resolve_background_matches,
    set_match_participant_ready,
    update_match_status,
)


router = APIRouter(tags=["tournaments"])


class CreateTournamentRequest(BaseModel):
    name: str
    participants: list[dict[str, Any]]
    settings: dict[str, Any] | None = None


class MatchStatusRequest(BaseModel):
    status: str


class MatchResultRequest(BaseModel):
    winnerId: str
    legsA: int | None = None
    legsB: int | None = None


class MatchReadyRequest(BaseModel):
    participantId: str
    ready: bool = True


@router.get("/api/tournaments")
def api_list_tournaments() -> dict[str, Any]:
    return {"tournaments": list_tournaments()}


@router.post("/api/tournaments")
def api_create_tournament(request: CreateTournamentRequest) -> dict[str, Any]:
    try:
        tournament = create_knockout_tournament(
            name=request.name,
            participants=request.participants,
            settings=request.settings or {},
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"tournament": tournament}


@router.get("/api/tournaments/{tournament_id}")
def api_get_tournament(tournament_id: str) -> dict[str, Any]:
    tournament = get_tournament(tournament_id)
    if tournament is None:
        raise HTTPException(status_code=404, detail="Tournament not found.")
    return {"tournament": tournament}


@router.post("/api/tournaments/{tournament_id}/matches/{match_id}/status")
def api_update_match_status(tournament_id: str, match_id: str, request: MatchStatusRequest) -> dict[str, Any]:
    try:
        tournament = update_match_status(tournament_id, match_id, request.status)
    except ValueError as exc:
        message = str(exc)
        status_code = 404 if "not found" in message.lower() else 400
        raise HTTPException(status_code=status_code, detail=message) from exc
    return {"tournament": tournament}


@router.post("/api/tournaments/{tournament_id}/matches/{match_id}/ready")
def api_set_match_ready(tournament_id: str, match_id: str, request: MatchReadyRequest) -> dict[str, Any]:
    try:
        tournament = set_match_participant_ready(
            tournament_id=tournament_id,
            match_id=match_id,
            participant_id=request.participantId,
            ready=request.ready,
        )
    except ValueError as exc:
        message = str(exc)
        status_code = 404 if "not found" in message.lower() else 400
        raise HTTPException(status_code=status_code, detail=message) from exc
    return {"tournament": tournament}


@router.post("/api/tournaments/{tournament_id}/background/resolve")
def api_resolve_background_matches(tournament_id: str) -> dict[str, Any]:
    try:
        return resolve_background_matches(tournament_id)
    except ValueError as exc:
        message = str(exc)
        status_code = 404 if "not found" in message.lower() else 400
        raise HTTPException(status_code=status_code, detail=message) from exc


@router.post("/api/tournaments/{tournament_id}/matches/{match_id}/result")
def api_record_match_result(tournament_id: str, match_id: str, request: MatchResultRequest) -> dict[str, Any]:
    try:
        tournament = record_match_result(
            tournament_id=tournament_id,
            match_id=match_id,
            winner_id=request.winnerId,
            legs_a=request.legsA,
            legs_b=request.legsB,
        )
    except ValueError as exc:
        message = str(exc)
        status_code = 404 if "not found" in message.lower() else 400
        raise HTTPException(status_code=status_code, detail=message) from exc
    return {"tournament": tournament}


@router.delete("/api/tournaments/{tournament_id}")
def api_delete_tournament(tournament_id: str) -> dict[str, Any]:
    if not delete_tournament(tournament_id):
        raise HTTPException(status_code=404, detail="Tournament not found.")
    return {"deleted": True, "tournamentId": tournament_id}
