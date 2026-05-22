from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from backend.core.custom_games_store import (
    custom_game_archive,
    delete_custom_game,
    import_custom_game,
    list_custom_games,
)

router = APIRouter(tags=["custom-games"])


class CustomGameImportRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    content_base64: str = Field(min_length=1)


@router.get("/api/custom-games")
def get_custom_games() -> dict[str, Any]:
    games = list_custom_games()
    return {"games": games, "count": len(games)}


@router.post("/api/custom-games/import")
def import_custom_game_package(request: CustomGameImportRequest) -> dict[str, Any]:
    try:
        game = import_custom_game(request.filename, request.content_base64)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to import package: {exc}") from exc
    return {"status": "success", "game": game}


@router.post("/api/custom-games/import/", include_in_schema=False)
def import_custom_game_package_slash(request: CustomGameImportRequest) -> dict[str, Any]:
    return import_custom_game_package(request)


@router.delete("/api/custom-games/{game_id}")
def remove_custom_game(game_id: str) -> dict[str, Any]:
    if not delete_custom_game(game_id):
        raise HTTPException(status_code=404, detail="Custom game not found")
    return {"status": "deleted", "gameId": game_id}


@router.get("/api/custom-games/{game_id}/download")
def download_custom_game(game_id: str) -> FileResponse:
    archive = custom_game_archive(game_id)
    if archive is None:
        raise HTTPException(status_code=404, detail="Custom game package not found")
    return FileResponse(
        path=str(archive),
        media_type="application/zip",
        filename=archive.name,
    )
