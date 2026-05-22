from __future__ import annotations

import platform
from importlib import metadata

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from backend.core.model_accuracy_stats import get_model_accuracy_stats, reset_model_accuracy_stats
from backend.core.bot_profiles import get_x01_bot_stats
from backend.core.player_profiles import (
    create_player,
    delete_player,
    get_player_bot_status as get_profile_bot_status,
    get_player_bot_won_legs,
    get_player_stats,
    list_players,
    update_player_name,
)
from backend.core.player_bot_library import (
    build_player_bot_export_bundle,
    delete_imported_player_bot,
    import_cloud_player_bot_bundle,
    import_player_bot_bundle,
    list_imported_player_bots,
    replace_imported_player_bot,
)

router = APIRouter(tags=["health"])


class CreatePlayerRequest(BaseModel):
    name: str


class UpdatePlayerRequest(BaseModel):
    name: str


class ImportPlayerBotRequest(BaseModel):
    bundle: dict


class ImportCloudPlayerBotRequest(BaseModel):
    cloudBotId: str
    bundle: dict
    cloudVersion: int = 1
    autoUpdate: bool = True


@router.get("/api/health")
def health() -> dict:
    return {"ok": True}


@router.get("/api/health/versions")
def versions() -> dict:
    def pkg_version(name: str) -> str | None:
        try:
            return metadata.version(name)
        except Exception:
            return None

    try:
        import openvino  # type: ignore

        openvino_version = str(getattr(openvino, "__version__", None) or pkg_version("openvino"))
    except Exception:
        openvino_version = pkg_version("openvino")

    return {
        "python": platform.python_version(),
        "openvino": openvino_version,
        "fastapi": pkg_version("fastapi"),
        "uvicorn": pkg_version("uvicorn"),
    }


@router.get("/api/players")
def get_players() -> dict:
    return {"players": list_players()}


@router.post("/api/players")
def post_player(request: CreatePlayerRequest) -> dict:
    try:
        player = create_player(request.name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"player": player}


@router.put("/api/players/{player_id}")
def put_player(player_id: str, request: UpdatePlayerRequest) -> dict:
    try:
        player = update_player_name(player_id, request.name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if player is None:
        raise HTTPException(status_code=404, detail="Player not found.")
    return {"player": player}


@router.delete("/api/players/{player_id}")
def remove_player(player_id: str) -> dict:
    if not delete_player(player_id):
        raise HTTPException(status_code=404, detail="Player not found.")
    return {"success": True}


@router.get("/api/players/{player_id}/stats")
def player_stats(
    player_id: str,
    gameMode: str | None = Query(default=None),
    limit: int | None = Query(default=None),
) -> dict:
    stats = get_player_stats(player_id)
    if stats is None:
        raise HTTPException(status_code=404, detail="Player not found.")
    history = stats.get("history")
    if isinstance(history, list):
        filtered = history
        if gameMode:
            filtered = [entry for entry in filtered if str((entry or {}).get("gameMode", "")) == str(gameMode)]
        if limit and int(limit) > 0:
            filtered = filtered[-int(limit):]
        stats["history"] = filtered
    return stats


@router.get("/api/players/{player_id}/bot-status")
def get_player_bot_status(player_id: str) -> dict:
    status = get_profile_bot_status(player_id, unlock_wins=5, window_size=50)
    if status is None:
        raise HTTPException(status_code=404, detail="Player not found.")
    return status


@router.get("/api/bots/{bot_level}/stats")
def get_bot_stats(bot_level: int) -> dict:
    level = int(bot_level)
    if level < 1 or level > 9:
        raise HTTPException(status_code=400, detail="bot_level must be between 1 and 9.")
    return get_x01_bot_stats(bot_level=level, max_legs=50)


@router.get("/api/player-bots")
def get_imported_player_bots() -> dict:
    return {"bots": list_imported_player_bots()}


@router.get("/api/player-bots/export/{player_id}")
def export_player_bot(player_id: str) -> dict:
    status = get_profile_bot_status(player_id, unlock_wins=5, window_size=50)
    if status is None:
        raise HTTPException(status_code=404, detail="Player not found.")
    if not bool(status.get("isUnlocked")):
        raise HTTPException(status_code=400, detail="Player bot is locked; at least 5 won replayable X01 legs are required.")
    won_legs = get_player_bot_won_legs(player_id, limit=50)
    if len(won_legs) < 5:
        raise HTTPException(status_code=400, detail="Not enough replayable won legs to export.")
    bundle = build_player_bot_export_bundle(
        player_id=player_id,
        player_name=str(status.get("playerName", "Player Bot")),
        won_legs=won_legs,
        stats_snapshot=status,
    )
    safe_name = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in str(status.get("playerName", "player_bot")).strip()) or "player_bot"
    return {
        "filename": f"playerbot_{safe_name}.mdbot.json",
        "bundle": bundle,
    }


@router.post("/api/player-bots/import")
def import_player_bot(request: ImportPlayerBotRequest) -> dict:
    try:
        result = import_player_bot_bundle(dict(request.bundle or {}))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return result


@router.post("/api/player-bots/cloud/import")
def import_cloud_player_bot(request: ImportCloudPlayerBotRequest) -> dict:
    try:
        result = import_cloud_player_bot_bundle(
            cloud_bot_id=str(request.cloudBotId),
            bundle=dict(request.bundle or {}),
            cloud_version=int(request.cloudVersion or 1),
            auto_update=bool(request.autoUpdate),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return result


@router.post("/api/player-bots/{bot_id}/replace")
def replace_player_bot(bot_id: str, request: ImportPlayerBotRequest) -> dict:
    try:
        result = replace_imported_player_bot(str(bot_id), dict(request.bundle or {}))
    except ValueError as exc:
        message = str(exc)
        status = 404 if "not found" in message.lower() else 400
        raise HTTPException(status_code=status, detail=message) from exc
    return result


@router.delete("/api/player-bots/{bot_id}")
def delete_player_bot(bot_id: str) -> dict:
    deleted = delete_imported_player_bot(str(bot_id))
    if not deleted:
        raise HTTPException(status_code=404, detail="Imported player bot not found.")
    return {"deleted": True, "botId": str(bot_id)}


@router.get("/api/system/stats")
def get_system_stats() -> dict:
    raw = get_model_accuracy_stats(active_model_id=None)
    totals = raw.get("totals", {}) if isinstance(raw, dict) else {}
    darts = int(totals.get("total_darts", 0))
    corrections = int(totals.get("corrected_darts", 0))
    accuracy_percent = float(totals.get("accuracy_percent", 100.0) or 100.0)
    overall = {
        "legs": 0,
        "darts": darts,
        "corrections": corrections,
        "accuracy": round(accuracy_percent / 100.0, 4),
    }
    zero_row = {"legs": 0, "darts": 0, "corrections": 0, "accuracy": 1.0}
    return {
        "overall": overall,
        "modes": {
            "x01": dict(zero_row),
            "cricket": dict(zero_row),
            "around_the_clock": dict(zero_row),
        },
    }


@router.post("/api/system/reset-accuracy")
def post_reset_accuracy() -> dict:
    stats = reset_model_accuracy_stats()
    return {"success": True, "stats": stats}
