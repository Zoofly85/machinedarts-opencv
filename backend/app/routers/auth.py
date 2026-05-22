from __future__ import annotations

from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from backend.core.capabilities import get_session_snapshot, login, logout

router = APIRouter(tags=["auth"])


class LoginPayload(BaseModel):
    username: Optional[str] = None
    role: Optional[str] = None
    edition: Optional[str] = None
    password: Optional[str] = None


@router.post("/api/auth/login")
def auth_login(payload: LoginPayload) -> dict:
    # Password verification is intentionally omitted in Sprint 1 scaffolding.
    return login(user_name=payload.username, role=payload.role, edition=payload.edition)


@router.post("/api/auth/logout")
def auth_logout() -> dict:
    return logout()


@router.get("/api/auth/session")
def auth_session() -> dict:
    return get_session_snapshot()

