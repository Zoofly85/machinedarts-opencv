from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.core.sound_fx import clear_sound_fx_file, get_sound_fx_settings, reset_sound_fx_settings, update_sound_fx_settings, upload_sound_fx_file

router = APIRouter(tags=["sound-fx"])


class SoundFxSettingsPayload(BaseModel):
    enabled: bool = True
    volume: float = Field(default=0.75, ge=0.0, le=1.0)
    custom_sounds: dict[str, str] = Field(default_factory=dict)
    play_triple: bool = True
    play_double: bool = True
    play_bull: bool = True
    play_miss: bool = True
    play_bust: bool = True
    play_checkout: bool = True
    play_cricket_valid: bool = True
    play_cricket_invalid: bool = True


class SoundFxUploadPayload(BaseModel):
    filename: str
    content_base64: str


@router.get("/api/sound-fx/settings")
def get_settings() -> dict[str, Any]:
    return {"settings": get_sound_fx_settings()}


@router.post("/api/sound-fx/settings")
def update_settings(payload: SoundFxSettingsPayload) -> dict[str, Any]:
    return {"status": "ok", "settings": update_sound_fx_settings(payload.model_dump())}


@router.post("/api/sound-fx/reset")
def reset_settings() -> dict[str, Any]:
    return {"status": "ok", "settings": reset_sound_fx_settings()}


@router.post("/api/sound-fx/sounds/{sound_key}")
def upload_sound(sound_key: str, payload: SoundFxUploadPayload) -> dict[str, Any]:
    try:
        settings = upload_sound_fx_file(sound_key, payload.filename, payload.content_base64)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "ok", "settings": settings}


@router.delete("/api/sound-fx/sounds/{sound_key}")
def clear_sound(sound_key: str) -> dict[str, Any]:
    try:
        settings = clear_sound_fx_file(sound_key)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "ok", "settings": settings}
