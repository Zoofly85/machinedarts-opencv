from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from typing import Any


_VALID_EDITIONS = {"home", "club"}
_VALID_ROLES = {"home_user", "board_kiosk", "operator"}


def _normalize_edition(value: str) -> str:
    v = (value or "").strip().lower()
    return v if v in _VALID_EDITIONS else "home"


def _normalize_role(value: str, edition: str) -> str:
    v = (value or "").strip().lower()
    if v in _VALID_ROLES:
        return v
    if edition == "club":
        return "board_kiosk"
    return "home_user"


def _as_bool(value: str, default: bool) -> bool:
    if value is None:
        return default
    v = str(value).strip().lower()
    if v in {"1", "true", "yes", "on"}:
        return True
    if v in {"0", "false", "no", "off"}:
        return False
    return default


@dataclass
class SessionState:
    authenticated: bool
    user_id: str
    user_name: str
    edition: str
    role: str
    venue_id: str
    board_id: str


def _default_state() -> SessionState:
    edition = _normalize_edition(os.getenv("MACHINE_DARTS_EDITION", "home"))
    role = _normalize_role(os.getenv("MACHINE_DARTS_ROLE", ""), edition)
    default_auth = edition == "club"
    authenticated = _as_bool(os.getenv("MACHINE_DARTS_AUTHENTICATED"), default_auth)
    user_name = os.getenv("MACHINE_DARTS_USER_NAME", "Machine Darts User").strip() or "Machine Darts User"
    user_id = os.getenv("MACHINE_DARTS_USER_ID", "local-user").strip() or "local-user"
    venue_id = os.getenv("MACHINE_DARTS_VENUE_ID", "local-venue").strip() or "local-venue"
    board_id = os.getenv("MACHINE_DARTS_BOARD_ID", "board-1").strip() or "board-1"
    return SessionState(
        authenticated=authenticated,
        user_id=user_id,
        user_name=user_name,
        edition=edition,
        role=role,
        venue_id=venue_id,
        board_id=board_id,
    )


_LOCK = threading.RLock()
_STATE = _default_state()


def _capabilities_for(state: SessionState) -> dict[str, bool]:
    is_home = state.edition == "home"
    is_club = state.edition == "club"
    is_operator = state.role == "operator"
    is_board = state.role == "board_kiosk"
    return {
        "can_use_home": is_home or (is_club and is_board),
        "can_use_dashboard": is_club and is_operator,
        "can_manage_sessions": is_club and is_operator,
        "can_lock_settings": is_club and is_operator,
        "can_view_club_analytics": is_club and is_operator,
        "can_use_club_board": is_club and is_board,
        "cloud_sync_enabled": is_club,
    }


def get_session_snapshot() -> dict[str, Any]:
    with _LOCK:
        capabilities = _capabilities_for(_STATE)
        return {
            "authenticated": bool(_STATE.authenticated),
            "user": {
                "id": _STATE.user_id,
                "name": _STATE.user_name,
                "role": _STATE.role,
            },
            "entitlements": {
                "edition": _STATE.edition,
                "venue_id": _STATE.venue_id,
                "board_id": _STATE.board_id,
                "capabilities": capabilities,
            },
            "board_context": {
                "venue_id": _STATE.venue_id,
                "board_id": _STATE.board_id,
                "role": _STATE.role,
            },
        }


def login(*, user_name: str | None, role: str | None, edition: str | None) -> dict[str, Any]:
    with _LOCK:
        next_edition = _normalize_edition(edition or _STATE.edition)
        next_role = _normalize_role(role or _STATE.role, next_edition)
        if user_name:
            _STATE.user_name = user_name.strip() or _STATE.user_name
        _STATE.edition = next_edition
        _STATE.role = next_role
        _STATE.authenticated = True
        return get_session_snapshot()


def logout() -> dict[str, Any]:
    with _LOCK:
        _STATE.authenticated = False
        return get_session_snapshot()


def require_capability(name: str) -> bool:
    with _LOCK:
        return bool(_capabilities_for(_STATE).get(name, False))


def diagnostics_context() -> dict[str, str]:
    with _LOCK:
        return {
            "edition": _STATE.edition,
            "role": _STATE.role,
            "venue_id": _STATE.venue_id,
            "board_id": _STATE.board_id,
        }

