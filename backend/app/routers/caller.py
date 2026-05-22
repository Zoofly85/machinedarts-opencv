from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from backend.core.caller import get_caller_events_since, get_caller_service, get_default_voice_pack_path, get_latest_caller_event_seq

router = APIRouter(tags=["caller"])


class CallerSettingsPayload(BaseModel):
    enabled: bool = False
    voice_pack_path: str = ""
    queue_delay_ms: int = Field(default=150, ge=0, le=5000)
    call_dart_score: bool = True
    call_turn_change: bool = True
    call_game_events: bool = True
    call_corrections: bool = True
    call_required_score: bool = True
    call_leg_win: bool = True
    call_set_win: bool = True
    call_match_win: bool = True
    score_call_mode: str = "per_dart"
    browser_playback_enabled: bool = True
    local_playback_enabled: bool = True


class CallerTestPayload(BaseModel):
    tokens: list[str] = Field(default_factory=list)


@router.get("/api/caller/settings")
def get_caller_settings() -> dict[str, Any]:
    return {
        "settings": get_caller_service().get_settings(),
        "defaultVoicePackPath": get_default_voice_pack_path(),
    }


@router.post("/api/caller/settings")
def update_caller_settings(payload: CallerSettingsPayload) -> dict[str, Any]:
    settings = get_caller_service().update_settings(payload.model_dump())
    return {
        "status": "ok",
        "settings": settings,
        "defaultVoicePackPath": get_default_voice_pack_path(),
    }


@router.post("/api/caller/test")
def test_caller(payload: CallerTestPayload | None = None) -> dict[str, Any]:
    svc = get_caller_service()
    if payload is None or not payload.tokens:
        svc.play_test()
    else:
        svc.play_tokens(payload.tokens)
    return {"status": "queued"}


@router.get("/api/caller/clip/{token}")
def get_caller_clip(token: str) -> FileResponse:
    clip = get_caller_service().resolve_clip_path(token)
    if clip is None or not clip.exists() or not clip.is_file():
        raise HTTPException(status_code=404, detail=f"Caller clip not found: {token}")
    return FileResponse(path=str(clip), media_type=_media_type_for_clip(clip.name))


@router.post("/api/caller/reset-voice-pack")
def reset_voice_pack() -> dict[str, Any]:
    svc = get_caller_service()
    settings = svc.reset_to_default_voice_pack()
    return {
        "status": "ok",
        "settings": settings,
        "defaultVoicePackPath": get_default_voice_pack_path(),
    }


@router.websocket("/ws/caller/events")
async def ws_caller_events(websocket: WebSocket) -> None:
    await websocket.accept()
    last_seq = get_latest_caller_event_seq()
    try:
        while True:
            events = get_caller_events_since(last_seq)
            for ev in events:
                await websocket.send_json(ev)
                last_seq = int(ev.get("seq", last_seq))
            await asyncio.sleep(0.02)
    except WebSocketDisconnect:
        return


def _media_type_for_clip(name: str) -> str:
    lower = name.lower()
    if lower.endswith(".mp3"):
        return "audio/mpeg"
    if lower.endswith(".ogg"):
        return "audio/ogg"
    if lower.endswith(".wav"):
        return "audio/wav"
    return "application/octet-stream"
