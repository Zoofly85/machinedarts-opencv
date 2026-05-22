from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, field_validator

from backend.core.games.bots import Field, NEXT_TARGET_DOUBLE_OUT, NEXT_TARGET_SINGLE_OUT
from backend.core.games.service import get_game_service

router = APIRouter(tags=["games"])


class X01PlayerSpec(BaseModel):
    name: str
    isBot: Optional[bool] = False
    isPlayerBot: Optional[bool] = False
    sourcePlayerId: Optional[str] = None
    botLevel: Optional[int] = None
    profileId: Optional[str] = None
    x01Settings: Optional[dict[str, Any]] = None


class X01TeamSpec(BaseModel):
    teamId: int
    teamName: str
    playerIndices: list[int]


class X01StartRequest(BaseModel):
    players: list[X01PlayerSpec]
    startScore: int = 501
    inMode: str = "straight"
    outMode: str = "double"
    startingPlayer: Optional[int] = 0
    legsPerSet: int = 3
    setsToWin: int = 1
    freePlay: Optional[bool] = False
    gameVariant: Optional[str] = "standard"
    lmsTotalLegs: Optional[int] = 3
    teams: Optional[list[X01TeamSpec]] = None
    analyticsSource: Optional[str] = "local"
    localInputPlayerIndex: Optional[int] = None

    @field_validator("players", mode="before")
    @classmethod
    def normalize_players(cls, value):
        normalized = []
        for item in value:
            if isinstance(item, str):
                normalized.append({"name": item})
            else:
                normalized.append(item)
        return normalized


class X01RemoteDartSpec(BaseModel):
    score: int
    multiplier: int = 1
    segment: str = "0"
    zone: str = "miss"
    confidence: float = 1.0


class X01ApplyRemoteTurnRequest(BaseModel):
    playerIndex: int
    darts: list[Optional[X01RemoteDartSpec]]


class X01RecordRemoteDartRequest(BaseModel):
    playerIndex: int
    dartIndex: int
    dart: Optional[X01RemoteDartSpec] = None


class X01CommitRemoteTurnRequest(BaseModel):
    playerIndex: int
    darts: Optional[list[Optional[X01RemoteDartSpec]]] = None


class CricketPlayerSpec(BaseModel):
    name: str
    isBot: Optional[bool] = False
    botLevel: Optional[int] = None
    profileId: Optional[str] = None


class CricketStartRequest(BaseModel):
    players: list[CricketPlayerSpec]
    mode: Optional[str] = "standard"
    startingPlayer: Optional[int] = 0
    legsPerSet: Optional[int] = 1
    setsToWin: Optional[int] = 1

    @field_validator("players", mode="before")
    @classmethod
    def normalize_players(cls, value):
        normalized = []
        for item in value:
            if isinstance(item, str):
                normalized.append({"name": item})
            else:
                normalized.append(item)
        return normalized


class AroundTheClockPlayerSpec(BaseModel):
    name: str
    isBot: Optional[bool] = False
    botLevel: Optional[int] = None
    profileId: Optional[str] = None


class AroundTheClockStartRequest(BaseModel):
    players: list[AroundTheClockPlayerSpec]
    mode: Optional[str] = "full"
    order: Optional[str] = "1-20-bull"
    hitsRequired: Optional[int] = 1
    startingPlayer: Optional[int] = 0
    legsPerSet: Optional[int] = 1
    setsToWin: Optional[int] = 1

    @field_validator("players", mode="before")
    @classmethod
    def normalize_players(cls, value):
        normalized = []
        for item in value:
            if isinstance(item, str):
                normalized.append({"name": item})
            else:
                normalized.append(item)
        return normalized


class ShanghaiPlayerSpec(BaseModel):
    name: str
    isBot: Optional[bool] = False
    botLevel: Optional[int] = None
    profileId: Optional[str] = None


class ShanghaiStartRequest(BaseModel):
    players: list[ShanghaiPlayerSpec]
    roundRange: Optional[str] = "1-20"
    mode: Optional[str] = "legs_sets"
    startingPlayer: Optional[int] = 0
    legsPerSet: Optional[int] = 1
    setsToWin: Optional[int] = 1

    @field_validator("players", mode="before")
    @classmethod
    def normalize_players(cls, value):
        normalized = []
        for item in value:
            if isinstance(item, str):
                normalized.append({"name": item})
            else:
                normalized.append(item)
        return normalized


class BeerRacePlayerSpec(BaseModel):
    name: str
    isBot: Optional[bool] = False
    botLevel: Optional[int] = None
    profileId: Optional[str] = None


class BeerRaceStartRequest(BaseModel):
    players: list[BeerRacePlayerSpec]
    targetScore: Optional[int] = 301
    startingPlayer: Optional[int] = 0
    legsPerSet: Optional[int] = 1
    setsToWin: Optional[int] = 1

    @field_validator("players", mode="before")
    @classmethod
    def normalize_players(cls, value):
        return [{"name": item} if isinstance(item, str) else item for item in value]


class BermudaPlayerSpec(BaseModel):
    name: str
    isBot: Optional[bool] = False
    botLevel: Optional[int] = None
    profileId: Optional[str] = None


class BermudaStartRequest(BaseModel):
    players: list[BermudaPlayerSpec]
    startingPlayer: Optional[int] = 0
    mode: Optional[str] = "legs_sets"
    legsPerSet: Optional[int] = 1
    setsToWin: Optional[int] = 1

    @field_validator("players", mode="before")
    @classmethod
    def normalize_players(cls, value):
        return [{"name": item} if isinstance(item, str) else item for item in value]


class Bob27PlayerSpec(BaseModel):
    name: str
    isBot: Optional[bool] = False
    botLevel: Optional[int] = None
    profileId: Optional[str] = None


class Bob27StartRequest(BaseModel):
    players: list[Bob27PlayerSpec]
    includeBull: Optional[bool] = True
    allowNegative: Optional[bool] = False
    startingPlayer: Optional[int] = 0
    legs: Optional[int] = 1

    @field_validator("players", mode="before")
    @classmethod
    def normalize_players(cls, value):
        return [{"name": item} if isinstance(item, str) else item for item in value]


class OneTwoOnePlayerSpec(BaseModel):
    name: str
    isBot: Optional[bool] = False
    botLevel: Optional[int] = None
    profileId: Optional[str] = None


class OneTwoOneStartRequest(BaseModel):
    players: list[OneTwoOnePlayerSpec]
    startingTarget: Optional[int] = 121
    targetLimit: Optional[int] = 130
    failurePolicy: Optional[str] = "stay"
    outRule: Optional[str] = "double"
    startingPlayer: Optional[int] = 0
    legsPerSet: Optional[int] = 1
    setsToWin: Optional[int] = 1

    @field_validator("players", mode="before")
    @classmethod
    def normalize_players(cls, value):
        return [{"name": item} if isinstance(item, str) else item for item in value]


class TargetTrainerPlayerSpec(BaseModel):
    name: str
    isBot: Optional[bool] = False
    botLevel: Optional[int] = None
    profileId: Optional[str] = None


class TargetTrainerStartRequest(BaseModel):
    players: list[TargetTrainerPlayerSpec]
    targetType: Optional[str] = "treble"
    targetNumber: Optional[int] = 20
    requiredHits: Optional[float] = 10.0
    allowClose: Optional[bool] = False
    sharedTarget: Optional[bool] = True
    startingPlayer: Optional[int] = 0
    legsPerSet: Optional[int] = 1
    setsToWin: Optional[int] = 1

    @field_validator("players", mode="before")
    @classmethod
    def normalize_players(cls, value):
        return [{"name": item} if isinstance(item, str) else item for item in value]


class PacmanPlayerSpec(BaseModel):
    name: str
    isBot: Optional[bool] = False
    botLevel: Optional[int] = None
    profileId: Optional[str] = None


class PacmanStartRequest(BaseModel):
    players: list[PacmanPlayerSpec]
    livesPerPlayer: Optional[int] = 5
    startingPlayer: Optional[int] = 0

    @field_validator("players", mode="before")
    @classmethod
    def normalize_players(cls, value):
        return [{"name": item} if isinstance(item, str) else item for item in value]


@router.post("/api/x01/start")
def start_x01_game(request: X01StartRequest) -> dict[str, Any]:
    service = get_game_service()
    try:
        state = service.start_x01(
            players=[player.model_dump(exclude_none=True) for player in request.players],
            start_score=request.startScore,
            in_mode=request.inMode or "straight",
            out_mode=request.outMode or "double",
            starting_player=request.startingPlayer or 0,
            legs_per_set=request.legsPerSet,
            sets_to_win=request.setsToWin,
            free_play=bool(request.freePlay),
            game_variant=request.gameVariant or "standard",
            lms_total_legs=request.lmsTotalLegs or 3,
            teams=[team.model_dump() for team in request.teams] if request.teams else None,
            analytics_source=str(request.analyticsSource or "local"),
            local_input_player_index=request.localInputPlayerIndex,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "started", "state": state}


@router.get("/api/x01/state")
def get_x01_state() -> dict[str, Any]:
    state = get_game_service().get_x01_state()
    if state is None:
        raise HTTPException(status_code=404, detail="X01 mode is not active")
    return state


@router.post("/api/x01/stop")
def stop_x01_game() -> dict[str, str]:
    get_game_service().stop_x01()
    return {"status": "practice"}


@router.post("/api/x01/force-next-turn")
def force_next_turn() -> dict[str, Any]:
    try:
        state = get_game_service().force_next_turn()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"success": True, "message": "Turn completed and moved to next player", "state": state}


@router.post("/api/x01/undo-turn")
def undo_x01_turn() -> dict[str, Any]:
    try:
        state = get_game_service().undo_x01_turn()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"success": True, "message": "Last turn undone", "state": state}


@router.post("/api/x01/apply-remote-turn")
def apply_remote_x01_turn(request: X01ApplyRemoteTurnRequest) -> dict[str, Any]:
    try:
        state = get_game_service().apply_remote_x01_turn(
            player_index=request.playerIndex,
            darts=[dart.model_dump() if dart is not None else None for dart in request.darts],
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"success": True, "message": "Remote turn applied", "state": state}


@router.post("/api/x01/record-remote-dart")
def record_remote_x01_dart(request: X01RecordRemoteDartRequest) -> dict[str, Any]:
    try:
        state = get_game_service().record_remote_x01_dart(
            player_index=request.playerIndex,
            dart_index=request.dartIndex,
            dart=request.dart.model_dump() if request.dart is not None else None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"success": True, "message": "Remote dart recorded", "state": state}


@router.post("/api/x01/commit-remote-turn")
def commit_remote_x01_turn(request: X01CommitRemoteTurnRequest) -> dict[str, Any]:
    try:
        state = get_game_service().commit_remote_x01_turn(
            player_index=request.playerIndex,
            darts=[dart.model_dump() if dart is not None else None for dart in request.darts] if request.darts else None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"success": True, "message": "Remote turn committed", "state": state}


@router.post("/api/cricket/start")
def start_cricket_game(request: CricketStartRequest) -> dict[str, Any]:
    service = get_game_service()
    try:
        state = service.start_cricket(
            players=[player.model_dump(exclude_none=True) for player in request.players],
            mode=request.mode or "standard",
            starting_player=request.startingPlayer or 0,
            legs_per_set=request.legsPerSet or 1,
            sets_to_win=request.setsToWin or 1,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "started", "state": state}


@router.get("/api/cricket/state")
def get_cricket_state() -> dict[str, Any]:
    state = get_game_service().get_cricket_state()
    if state is None:
        raise HTTPException(status_code=404, detail="Cricket mode is not active")
    return state


@router.post("/api/cricket/stop")
def stop_cricket_game() -> dict[str, str]:
    get_game_service().stop_cricket()
    return {"status": "practice"}


@router.post("/api/cricket/force-next-turn")
def force_next_turn_cricket() -> dict[str, Any]:
    try:
        state = get_game_service().force_next_turn_cricket()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"success": True, "message": "Turn completed and moved to next player", "state": state}


@router.post("/api/around_the_clock/start")
def start_around_the_clock_game(request: AroundTheClockStartRequest) -> dict[str, Any]:
    service = get_game_service()
    try:
        state = service.start_around_the_clock(
            players=[player.model_dump(exclude_none=True) for player in request.players],
            mode=request.mode or "full",
            order=request.order or "1-20-bull",
            hits_required=request.hitsRequired or 1,
            starting_player=request.startingPlayer or 0,
            legs_per_set=request.legsPerSet or 1,
            sets_to_win=request.setsToWin or 1,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "started", "state": state}


@router.get("/api/around_the_clock/state")
def get_around_the_clock_state() -> dict[str, Any]:
    state = get_game_service().get_around_the_clock_state()
    if state is None:
        raise HTTPException(status_code=404, detail="Around the Clock mode is not active")
    return state


@router.post("/api/around_the_clock/stop")
def stop_around_the_clock_game() -> dict[str, str]:
    get_game_service().stop_around_the_clock()
    return {"status": "practice"}


@router.post("/api/around_the_clock/force-next-turn")
def force_next_turn_around_the_clock() -> dict[str, Any]:
    try:
        state = get_game_service().force_next_turn_around_the_clock()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"success": True, "message": "Turn completed and moved to next player", "state": state}


@router.post("/api/shanghai/start")
def start_shanghai_game(request: ShanghaiStartRequest) -> dict[str, Any]:
    service = get_game_service()
    try:
        state = service.start_shanghai(
            players=[player.model_dump(exclude_none=True) for player in request.players],
            round_range=request.roundRange or "1-20",
            mode=request.mode or "legs_sets",
            starting_player=request.startingPlayer or 0,
            legs_per_set=request.legsPerSet or 1,
            sets_to_win=request.setsToWin or 1,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "started", "state": state}


@router.get("/api/shanghai/state")
def get_shanghai_state() -> dict[str, Any]:
    state = get_game_service().get_shanghai_state()
    if state is None:
        raise HTTPException(status_code=404, detail="Shanghai mode is not active")
    return state


@router.post("/api/shanghai/stop")
def stop_shanghai_game() -> dict[str, str]:
    get_game_service().stop_shanghai()
    return {"status": "practice"}


@router.post("/api/shanghai/force-next-turn")
def force_next_turn_shanghai() -> dict[str, Any]:
    try:
        state = get_game_service().force_next_turn_shanghai()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"success": True, "message": "Turn completed and moved to next player", "state": state}


@router.post("/api/beer_race/start")
def start_beer_race_game(request: BeerRaceStartRequest) -> dict[str, Any]:
    try:
        state = get_game_service().start_beer_race(
            players=[player.model_dump(exclude_none=True) for player in request.players],
            target_score=request.targetScore or 301,
            starting_player=request.startingPlayer or 0,
            legs_per_set=request.legsPerSet or 1,
            sets_to_win=request.setsToWin or 1,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "started", "state": state}


@router.get("/api/beer_race/state")
def get_beer_race_state() -> dict[str, Any]:
    state = get_game_service().get_beer_race_state()
    if state is None:
        raise HTTPException(status_code=404, detail="Beer Race mode is not active")
    return state


@router.post("/api/beer_race/stop")
def stop_beer_race_game() -> dict[str, str]:
    get_game_service().stop_beer_race()
    return {"status": "practice"}


@router.post("/api/beer_race/force-next-turn")
def force_next_turn_beer_race() -> dict[str, Any]:
    try:
        state = get_game_service().force_next_turn_beer_race()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"success": True, "message": "Turn completed and moved to next player", "state": state}


@router.post("/api/bermuda/start")
def start_bermuda_game(request: BermudaStartRequest) -> dict[str, Any]:
    try:
        state = get_game_service().start_bermuda(
            players=[player.model_dump(exclude_none=True) for player in request.players],
            starting_player=request.startingPlayer or 0,
            mode=request.mode or "legs_sets",
            legs_per_set=request.legsPerSet or 1,
            sets_to_win=request.setsToWin or 1,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "started", "state": state}


@router.get("/api/bermuda/state")
def get_bermuda_state() -> dict[str, Any]:
    state = get_game_service().get_bermuda_state()
    if state is None:
        raise HTTPException(status_code=404, detail="Bermuda mode is not active")
    return state


@router.post("/api/bermuda/stop")
def stop_bermuda_game() -> dict[str, str]:
    get_game_service().stop_bermuda()
    return {"status": "practice"}


@router.post("/api/bermuda/force-next-turn")
def force_next_turn_bermuda() -> dict[str, Any]:
    try:
        state = get_game_service().force_next_turn_bermuda()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"success": True, "message": "Turn completed and moved to next player", "state": state}


@router.post("/api/bob27/start")
def start_bob27_game(request: Bob27StartRequest) -> dict[str, Any]:
    try:
        state = get_game_service().start_bob27(
            players=[player.model_dump(exclude_none=True) for player in request.players],
            include_bull=bool(request.includeBull),
            allow_negative=bool(request.allowNegative),
            starting_player=request.startingPlayer or 0,
            total_legs=request.legs or 1,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "started", "state": state}


@router.get("/api/bob27/state")
def get_bob27_state() -> dict[str, Any]:
    state = get_game_service().get_bob27_state()
    if state is None:
        raise HTTPException(status_code=404, detail="Bob27 mode is not active")
    return state


@router.post("/api/bob27/stop")
def stop_bob27_game() -> dict[str, str]:
    get_game_service().stop_bob27()
    return {"status": "practice"}


@router.post("/api/bob27/force-next-turn")
def force_next_turn_bob27() -> dict[str, Any]:
    try:
        state = get_game_service().force_next_turn_bob27()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"success": True, "message": "Turn completed and moved to next player", "state": state}


@router.post("/api/one_two_one/start")
def start_one_two_one_game(request: OneTwoOneStartRequest) -> dict[str, Any]:
    try:
        state = get_game_service().start_one_two_one(
            players=[player.model_dump(exclude_none=True) for player in request.players],
            starting_target=request.startingTarget or 121,
            target_limit=request.targetLimit,
            failure_policy=request.failurePolicy or "stay",
            out_rule=request.outRule or "double",
            starting_player=request.startingPlayer or 0,
            legs_per_set=request.legsPerSet or 1,
            sets_to_win=request.setsToWin or 1,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "started", "state": state}


@router.get("/api/one_two_one/state")
def get_one_two_one_state() -> dict[str, Any]:
    state = get_game_service().get_one_two_one_state()
    if state is None:
        raise HTTPException(status_code=404, detail="One Two One mode is not active")
    return state


@router.post("/api/one_two_one/stop")
def stop_one_two_one_game() -> dict[str, str]:
    get_game_service().stop_one_two_one()
    return {"status": "practice"}


@router.post("/api/one_two_one/force-next-turn")
def force_next_turn_one_two_one() -> dict[str, Any]:
    try:
        state = get_game_service().force_next_turn_one_two_one()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"success": True, "message": "Turn completed and moved to next player", "state": state}


@router.post("/api/target-trainer/start")
def start_target_trainer_game(request: TargetTrainerStartRequest) -> dict[str, Any]:
    try:
        state = get_game_service().start_target_trainer(
            players=[player.model_dump(exclude_none=True) for player in request.players],
            target_type=request.targetType or "treble",
            target_number=request.targetNumber or 20,
            required_hits=request.requiredHits or 10.0,
            allow_close=bool(request.allowClose),
            shared_target=bool(request.sharedTarget),
            starting_player=request.startingPlayer or 0,
            legs_per_set=request.legsPerSet or 1,
            sets_to_win=request.setsToWin or 1,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "started", "state": state}


@router.get("/api/target-trainer/state")
def get_target_trainer_state() -> dict[str, Any]:
    state = get_game_service().get_target_trainer_state()
    if state is None:
        raise HTTPException(status_code=404, detail="Target Trainer mode is not active")
    return state


@router.post("/api/target-trainer/stop")
def stop_target_trainer_game() -> dict[str, str]:
    get_game_service().stop_target_trainer()
    return {"status": "practice"}


@router.post("/api/target-trainer/force-next-turn")
def force_next_turn_target_trainer() -> dict[str, Any]:
    try:
        state = get_game_service().force_next_turn_target_trainer()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"success": True, "message": "Turn completed and moved to next player", "state": state}


@router.post("/api/pacman/start")
def start_pacman_game(request: PacmanStartRequest) -> dict[str, Any]:
    try:
        state = get_game_service().start_pacman(
            players=[player.model_dump(exclude_none=True) for player in request.players],
            lives_per_player=request.livesPerPlayer or 5,
            starting_player=request.startingPlayer or 0,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "started", "state": state}


@router.get("/api/pacman/state")
def get_pacman_state() -> dict[str, Any]:
    state = get_game_service().get_pacman_state()
    if state is None:
        raise HTTPException(status_code=404, detail="Pacman mode is not active")
    return state


@router.post("/api/pacman/stop")
def stop_pacman_game() -> dict[str, str]:
    get_game_service().stop_pacman()
    return {"status": "practice"}


@router.post("/api/pacman/force-next-turn")
def force_next_turn_pacman() -> dict[str, Any]:
    try:
        state = get_game_service().force_next_turn_pacman()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"success": True, "message": "Turn completed and moved to next player", "state": state}


@router.get("/api/x01/checkout-suggestion")
def get_checkout_suggestion(
    player_index: int = Query(default=0),
    remaining: int = Query(default=0),
    out_mode: str = "double",
) -> dict[str, Any]:
    if out_mode == "double":
        target = NEXT_TARGET_DOUBLE_OUT.get(remaining)
    else:
        target = NEXT_TARGET_SINGLE_OUT.get(remaining)

    if target is None:
        if remaining > 170:
            target = (Field.TRIPLE, 20)
        else:
            target = (Field.TRIPLE, 19)

    field_type, number = target
    if field_type == Field.TRIPLE:
        field_name = "T"
    elif field_type == Field.DOUBLE:
        field_name = "D"
    else:
        field_name = "S"

    return {
        "playerIndex": int(player_index),
        "target": f"{field_name}{number}",
        "field": field_name,
        "number": int(number),
        "remaining": int(remaining),
    }


@router.get("/api/bots/speed")
def get_bot_speed() -> dict[str, str]:
    return {"speed": get_game_service().get_bot_speed()}


@router.post("/api/bots/speed")
def set_bot_speed(payload: dict[str, Any]) -> dict[str, str]:
    speed = payload.get("speed", "normal") if isinstance(payload, dict) else "normal"
    try:
        normalized = get_game_service().set_bot_speed(str(speed))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "success", "speed": normalized}
