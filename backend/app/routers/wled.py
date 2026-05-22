from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.core import wled

router = APIRouter(tags=["wled"])


class WledSettingsPayload(BaseModel):
    enabled: bool = False
    host: str = "192.168.1.36"
    brightness: int = Field(default=160, ge=1, le=255)
    timeout_ms: int = Field(default=1200, ge=250, le=5000)
    events: dict[str, Any] = Field(default_factory=dict)


class WledEventPayload(BaseModel):
    event: str = "ready_to_detect"


@router.get("/api/wled/settings")
def get_wled_settings() -> dict[str, Any]:
    return {"settings": wled.get_settings()}


@router.post("/api/wled/settings")
def update_wled_settings(payload: WledSettingsPayload) -> dict[str, Any]:
    return {"status": "ok", "settings": wled.update_settings(payload.model_dump())}


@router.post("/api/wled/test")
def test_wled(payload: WledEventPayload | None = None) -> dict[str, Any]:
    event_name = (payload.event if payload else "ready_to_detect").strip() or "ready_to_detect"
    try:
        return wled.trigger_event(event_name)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"WLED test failed: {exc}") from exc


@router.post("/api/wled/state")
def send_wled_state(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        result = wled.send_state(payload)
        return {"status": "ok" if result.get("ok") else "error", "result": result}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"WLED command failed: {exc}") from exc
