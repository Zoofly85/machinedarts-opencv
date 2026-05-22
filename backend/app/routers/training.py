from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from backend.core.training_store import get_training_store

router = APIRouter(tags=["training"])

TrainingBlockType = Literal["doubles", "power_scoring"]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class TrainingBlockDTO(BaseModel):
    id: Optional[str] = None
    order: int = 0
    type: TrainingBlockType
    config: dict[str, Any] = Field(default_factory=dict)


class TrainingProgramCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = ""
    created_by: str = ""
    is_archived: bool = False
    blocks: list[TrainingBlockDTO] = Field(default_factory=list)


class TrainingProgramUpdateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = ""
    created_by: str = ""
    is_archived: bool = False
    blocks: list[TrainingBlockDTO] = Field(default_factory=list)


class ArchiveProgramRequest(BaseModel):
    archived: bool = True


class TrainingSessionStartRequest(BaseModel):
    program_id: str = Field(min_length=1)
    player_id: str = ""
    player_name: str = ""


class TrainingSessionEventRequest(BaseModel):
    block_index: int = Field(ge=0)
    target_key: str = ""
    scored: int = 0
    multiplier: int = 1
    segment: str = ""
    zone: str = ""
    board_x: float | None = None
    board_y: float | None = None
    meta: dict[str, Any] = Field(default_factory=dict)


class TrainingSessionEventUpdateRequest(BaseModel):
    scored: int = 0
    multiplier: int = 1
    segment: str = ""
    zone: str = ""
    board_x: float | None = None
    board_y: float | None = None
    meta: dict[str, Any] = Field(default_factory=dict)


class TrainingSessionCompleteRequest(BaseModel):
    summary: dict[str, Any] = Field(default_factory=dict)
    metrics: dict[str, Any] = Field(default_factory=dict)


def _sanitize_blocks(blocks: list[TrainingBlockDTO]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for idx, block in enumerate(blocks):
        out.append(
            {
                "id": (block.id or "").strip() or None,
                "order": idx,
                "type": str(block.type),
                "config": dict(block.config or {}),
            }
        )
    return out


@router.get("/api/training/programs")
def list_training_programs(include_archived: bool = Query(default=False)) -> dict[str, Any]:
    store = get_training_store()
    items = store.list_programs(include_archived=include_archived)
    return {"programs": items, "count": len(items), "generatedAt": _utc_now()}


@router.post("/api/training/programs")
def create_training_program(request: TrainingProgramCreateRequest) -> dict[str, Any]:
    store = get_training_store()
    program = store.upsert_program(
        program_id=None,
        name=request.name.strip(),
        description=request.description.strip(),
        created_by=request.created_by.strip(),
        is_archived=bool(request.is_archived),
        blocks=_sanitize_blocks(request.blocks),
    )
    return {"program": program, "createdAt": _utc_now()}


@router.get("/api/training/programs/{program_id}")
def get_training_program(program_id: str) -> dict[str, Any]:
    store = get_training_store()
    program = store.get_program(program_id.strip())
    if program is None:
        raise HTTPException(status_code=404, detail="Training program not found")
    return {"program": program}


@router.put("/api/training/programs/{program_id}")
def update_training_program(program_id: str, request: TrainingProgramUpdateRequest) -> dict[str, Any]:
    store = get_training_store()
    existing = store.get_program(program_id.strip())
    if existing is None:
        raise HTTPException(status_code=404, detail="Training program not found")
    program = store.upsert_program(
        program_id=program_id.strip(),
        name=request.name.strip(),
        description=request.description.strip(),
        created_by=request.created_by.strip(),
        is_archived=bool(request.is_archived),
        blocks=_sanitize_blocks(request.blocks),
    )
    return {"program": program, "updatedAt": _utc_now()}


@router.delete("/api/training/programs/{program_id}")
def delete_training_program(program_id: str) -> dict[str, Any]:
    store = get_training_store()
    ok = store.delete_program(program_id.strip())
    if not ok:
        raise HTTPException(status_code=404, detail="Training program not found")
    return {"status": "deleted", "programId": program_id.strip()}


@router.post("/api/training/programs/{program_id}/archive")
def archive_training_program(program_id: str, request: ArchiveProgramRequest) -> dict[str, Any]:
    store = get_training_store()
    program = store.set_program_archived(program_id.strip(), bool(request.archived))
    if program is None:
        raise HTTPException(status_code=404, detail="Training program not found")
    return {"program": program, "updatedAt": _utc_now()}


@router.post("/api/training/sessions/start")
def start_training_session(request: TrainingSessionStartRequest) -> dict[str, Any]:
    store = get_training_store()
    program = store.get_program(request.program_id.strip())
    if program is None:
        raise HTTPException(status_code=404, detail="Training program not found")
    if bool(program.get("isArchived")):
        raise HTTPException(status_code=400, detail="Archived programs cannot be started")
    session = store.create_session(
        program_id=request.program_id.strip(),
        player_id=request.player_id.strip(),
        player_name=request.player_name.strip(),
    )
    return {"session": session, "startedAt": _utc_now()}


@router.get("/api/training/sessions/{session_id}")
def get_training_session(session_id: str) -> dict[str, Any]:
    store = get_training_store()
    session = store.get_session(session_id.strip())
    if session is None:
        raise HTTPException(status_code=404, detail="Training session not found")
    return {"session": session}


@router.post("/api/training/sessions/{session_id}/events")
def append_training_session_event(session_id: str, request: TrainingSessionEventRequest) -> dict[str, Any]:
    store = get_training_store()
    session = store.append_session_event(
        session_id=session_id.strip(),
        block_index=int(request.block_index),
        target_key=request.target_key.strip(),
        scored=int(request.scored),
        multiplier=int(request.multiplier),
        segment=request.segment.strip(),
        zone=request.zone.strip(),
        board_x=request.board_x,
        board_y=request.board_y,
        meta=dict(request.meta or {}),
    )
    if session is None:
        raise HTTPException(status_code=400, detail="Session is not active or was not found")
    return {"session": session, "recordedAt": _utc_now()}


@router.put("/api/training/sessions/{session_id}/events/{event_id}")
def update_training_session_event(
    session_id: str,
    event_id: int,
    request: TrainingSessionEventUpdateRequest,
) -> dict[str, Any]:
    store = get_training_store()
    session = store.update_session_event(
        session_id=session_id.strip(),
        event_id=int(event_id),
        scored=int(request.scored),
        multiplier=int(request.multiplier),
        segment=request.segment.strip(),
        zone=request.zone.strip(),
        board_x=request.board_x,
        board_y=request.board_y,
        meta=dict(request.meta or {}),
    )
    if session is None:
        raise HTTPException(status_code=400, detail="Session/event not found or session is not active")
    return {"session": session, "updatedAt": _utc_now()}


@router.post("/api/training/sessions/{session_id}/complete")
def complete_training_session(session_id: str, request: TrainingSessionCompleteRequest) -> dict[str, Any]:
    store = get_training_store()
    session = store.complete_session(
        session_id=session_id.strip(),
        summary=dict(request.summary or {}),
        metrics=dict(request.metrics or {}),
    )
    if session is None:
        raise HTTPException(status_code=400, detail="Session is not active or was not found")
    return {"session": session, "completedAt": _utc_now()}


@router.get("/api/training/reports/overview")
def training_reports_overview(player_id: str = Query(default="")) -> dict[str, Any]:
    store = get_training_store()
    report = store.report_overview(player_id=player_id.strip())
    return {"report": report, "generatedAt": _utc_now()}


@router.get("/api/training/reports/session/{session_id}")
def training_report_session(session_id: str) -> dict[str, Any]:
    store = get_training_store()
    report = store.report_session(session_id=session_id.strip())
    if report is None:
        raise HTTPException(status_code=404, detail="Training session not found")
    return {"report": report, "generatedAt": _utc_now()}


@router.get("/api/training/reports/program/{program_id}")
def training_report_program(program_id: str, player_id: str = Query(default="")) -> dict[str, Any]:
    store = get_training_store()
    report = store.report_program(program_id=program_id.strip(), player_id=player_id.strip())
    return {"report": report, "generatedAt": _utc_now()}
