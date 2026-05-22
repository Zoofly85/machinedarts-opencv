from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.core.owner_analytics import get_owner_analytics_service

router = APIRouter(tags=["analytics"])


class OwnerAnalyticsSessionStartRequest(BaseModel):
    installId: str
    sessionId: str
    appVersion: str | None = None
    productFlavor: str | None = None
    uiShell: str | None = None
    platform: str | None = None
    isTauri: bool = False
    userAgent: str | None = None
    language: str | None = None
    timezone: str | None = None


@router.post("/api/owner-analytics/session-start")
def owner_analytics_session_start(request: OwnerAnalyticsSessionStartRequest) -> dict[str, Any]:
    get_owner_analytics_service().record_app_open(
        {
            "install_id": request.installId,
            "session_id": request.sessionId,
            "app_version": request.appVersion,
            "product_flavor": request.productFlavor,
            "ui_shell": request.uiShell,
            "platform": request.platform,
            "is_tauri": request.isTauri,
            "user_agent": request.userAgent,
            "language": request.language,
            "timezone": request.timezone,
        }
    )
    return {"status": "queued"}


@router.get("/api/owner-analytics/status")
def owner_analytics_status() -> dict[str, Any]:
    return get_owner_analytics_service().status()


@router.get("/api/owner-analytics/dashboard")
def owner_analytics_dashboard() -> dict[str, Any]:
    try:
        return get_owner_analytics_service().fetch_dashboard()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
