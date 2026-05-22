from __future__ import annotations

from typing import Any

from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from backend.core.gif_reactions import (
    UPLOAD_DIR,
    delete_gif_reaction_file,
    get_gif_reaction_settings,
    reset_gif_reaction_settings,
    update_gif_reaction_settings,
    upload_gif_reaction_file,
)

router = APIRouter(tags=["gif-reactions"])


class GifReactionRulePayload(BaseModel):
    id: str
    label: str
    match_type: str
    score: int | None = None
    gifs: list[str] = Field(default_factory=list)


class GifReactionSettingsPayload(BaseModel):
    enabled: bool = True
    duration_ms: int = Field(default=1800, ge=500, le=10000)
    score_rules: list[GifReactionRulePayload] = Field(default_factory=list)
    checkout_rules: list[GifReactionRulePayload] = Field(default_factory=list)
    set_won_gifs: list[str] = Field(default_factory=list)
    match_won_gifs: list[str] = Field(default_factory=list)


class GifReactionUploadPayload(BaseModel):
    target_type: str
    rule_id: str | None = None
    filename: str
    content_base64: str


class GifReactionDeletePayload(BaseModel):
    target_type: str
    rule_id: str | None = None
    file_path: str


@router.get("/api/gif-reactions/settings")
def get_settings() -> dict[str, Any]:
    return {"settings": get_gif_reaction_settings()}


@router.post("/api/gif-reactions/settings")
def update_settings(payload: GifReactionSettingsPayload) -> dict[str, Any]:
    return {"status": "ok", "settings": update_gif_reaction_settings(payload.model_dump())}


@router.post("/api/gif-reactions/reset")
def reset_settings() -> dict[str, Any]:
    return {"status": "ok", "settings": reset_gif_reaction_settings()}


@router.post("/api/gif-reactions/files")
def upload_file(payload: GifReactionUploadPayload) -> dict[str, Any]:
    try:
        settings = upload_gif_reaction_file(payload.target_type, payload.rule_id, payload.filename, payload.content_base64)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "ok", "settings": settings}


@router.post("/api/gif-reactions/files/delete")
def delete_file(payload: GifReactionDeletePayload) -> dict[str, Any]:
    try:
        settings = delete_gif_reaction_file(payload.target_type, payload.rule_id, payload.file_path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "ok", "settings": settings}


@router.get("/api/gif-reactions/files/content")
def get_file(path: str = Query(...)) -> FileResponse:
    try:
        requested = Path(path).resolve()
        root = UPLOAD_DIR.resolve()
        if not requested.is_file() or not requested.is_relative_to(root):
            raise ValueError("file not found")
    except Exception as exc:
        raise HTTPException(status_code=404, detail="file not found") from exc
    return FileResponse(str(requested))
