from __future__ import annotations

import json
import copy
import os
import threading
import time
import random
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
import sys
from typing import Any

from backend.core.detection_events import publish_detection_event, register_detection_event_listener
from backend.core import wled
from backend.core.bot_profiles import (
    mark_x01_bot_baseline_seeded,
    record_x01_bot_leg,
    should_seed_x01_bot_baseline,
)
from backend.core.games import (
    AroundTheClockGame,
    BeerRaceGame,
    BermudaTriangleGame,
    Bob27Game,
    CricketGame,
    OneTwoOneGame,
    PacmanGame,
    ShanghaiGame,
    TargetTrainerGame,
    X01Game,
)
from backend.core.player_profiles import (
    get_player_bot_won_legs,
    record_around_the_clock_leg_for_profiles,
    record_cricket_leg_for_profiles,
    record_x01_leg_for_profiles,
)
from backend.core.owner_analytics import get_owner_analytics_service
from backend.core.player_bot_library import get_imported_player_bot_won_legs
from backend.core.games.bots import (
    AroundTheClockBot,
    BeerRaceBot,
    BermudaBot,
    Bob27Bot,
    CricketBot,
    OneTwoOneBot,
    PacmanBot,
    ShanghaiBot,
    TargetTrainerBot,
    X01Bot,
)

_SETTINGS_LOCK = threading.Lock()
_DEFAULT_GAME_SETTINGS = {
    "bot_speed": "normal",
}


def _resolve_settings_path() -> Path:
    """Return the path to games.json, working both frozen and as a script."""
    if getattr(sys, "frozen", False):
        if os.name == "nt":
            appdata = os.getenv("APPDATA", "").strip()
            base = (
                Path(appdata).resolve() / "DartDetector"
                if appdata
                else Path.home() / "AppData" / "Roaming" / "DartDetector"
            )
        else:
            xdg_data_home = os.getenv("XDG_DATA_HOME", "").strip()
            base = Path(xdg_data_home).resolve() if xdg_data_home else Path.home() / ".local" / "share"
            base = base / "DartDetector"
        return base / "settings" / "games.json"
    # Script: backend/core/games/service.py -> parents[2] = backend/ -> data/settings/
    return Path(__file__).resolve().parents[2] / "data" / "settings" / "games.json"


_SETTINGS_PATH = _resolve_settings_path()


def _load_game_settings() -> dict[str, Any]:
    values = dict(_DEFAULT_GAME_SETTINGS)
    with _SETTINGS_LOCK:
        try:
            if _SETTINGS_PATH.exists():
                payload = json.loads(_SETTINGS_PATH.read_text(encoding="utf-8-sig"))
                if isinstance(payload, dict):
                    values.update(payload)
        except Exception:
            pass
    return values


def _save_game_settings(settings: dict[str, Any]) -> None:
    with _SETTINGS_LOCK:
        _SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        _SETTINGS_PATH.write_text(json.dumps(settings, indent=2), encoding="utf-8")


def _normalize_score_payload(score: dict[str, Any] | None, score_value: int) -> dict[str, Any]:
    payload = dict(score or {})
    segment = str(payload.get("segment", "0"))
    zone = str(payload.get("zone", "single") or "single")
    multiplier = payload.get("multiplier")
    if multiplier is None:
        if zone == "triple":
            multiplier = 3
        elif zone == "double":
            multiplier = 2
        elif zone == "inner_bull":
            multiplier = 2
        elif zone == "outer_bull":
            multiplier = 1
        else:
            multiplier = 1
    normalized = {
        "score": int(score_value),
        "multiplier": int(multiplier),
        "segment": segment,
        "zone": zone,
        "confidence": float(payload.get("confidence", 1.0) or 1.0),
    }
    board = payload.get("board") if isinstance(payload.get("board"), dict) else None
    board_x = payload.get("boardX", payload.get("board_x"))
    board_y = payload.get("boardY", payload.get("board_y"))
    board_display_x = payload.get("boardDisplayX", payload.get("board_display_x"))
    board_display_y = payload.get("boardDisplayY", payload.get("board_display_y"))
    board_rotation_deg = payload.get("boardRotationDeg", payload.get("board_rotation_deg"))
    if isinstance(board, dict):
        board_x = board.get("x", board_x)
        board_y = board.get("y", board_y)
        board_display_x = board.get("display_x", board_display_x)
        board_display_y = board.get("display_y", board_display_y)
        board_rotation_deg = board.get("rotation_deg", board_rotation_deg)
        normalized["board"] = dict(board)
    try:
        nx = float(board_x)
        ny = float(board_y)
        if nx == nx and ny == ny:
            normalized["boardX"] = nx
            normalized["boardY"] = ny
    except (TypeError, ValueError):
        pass
    try:
        dx = float(board_display_x)
        dy = float(board_display_y)
        if dx == dx and dy == dy:
            normalized["boardDisplayX"] = dx
            normalized["boardDisplayY"] = dy
    except (TypeError, ValueError):
        pass
    try:
        rotation = float(board_rotation_deg)
        if rotation == rotation:
            normalized["boardRotationDeg"] = rotation
    except (TypeError, ValueError):
        pass
    return normalized


@dataclass
class X01GameSession:
    game: X01Game
    darts_recorded_in_turn: int = 0
    bot_levels: dict[int, int] | None = None
    player_bot_sources: dict[int, str] | None = None
    player_bot_won_legs: dict[int, list[dict[str, Any]]] | None = None
    player_bot_replay_state: dict[int, dict[str, Any]] | None = None
    bot_turn_active: bool = False
    bot_turn_token: int = 0
    profile_ids: dict[int, str] | None = None
    leg_started_at: str | None = None
    match_started_at: str | None = None
    corrections_applied: int = 0
    analytics_source: str = "local"
    analytics_match_reported: bool = False
    local_input_player_index: int | None = None
    wled_live_turn_key: str | None = None
    wled_live_event: str | None = None


@dataclass
class CricketGameSession:
    game: CricketGame
    darts_recorded_in_turn: int = 0
    bot_levels: dict[int, int] | None = None
    bot_turn_active: bool = False
    bot_turn_token: int = 0
    profile_ids: dict[int, str] | None = None
    leg_started_at: str | None = None


@dataclass
class AroundTheClockGameSession:
    game: AroundTheClockGame
    darts_recorded_in_turn: int = 0
    bot_levels: dict[int, int] | None = None
    bot_turn_active: bool = False
    bot_turn_token: int = 0
    profile_ids: dict[int, str] | None = None
    leg_started_at: str | None = None


@dataclass
class ShanghaiGameSession:
    game: ShanghaiGame
    darts_recorded_in_turn: int = 0
    bot_levels: dict[int, int] | None = None
    bot_turn_active: bool = False
    bot_turn_token: int = 0


@dataclass
class BeerRaceGameSession:
    game: BeerRaceGame
    darts_recorded_in_turn: int = 0
    bot_levels: dict[int, int] | None = None
    bot_turn_active: bool = False
    bot_turn_token: int = 0


@dataclass
class BermudaGameSession:
    game: BermudaTriangleGame
    darts_recorded_in_turn: int = 0
    bot_levels: dict[int, int] | None = None
    bot_turn_active: bool = False
    bot_turn_token: int = 0


@dataclass
class Bob27GameSession:
    game: Bob27Game
    darts_recorded_in_turn: int = 0
    bot_levels: dict[int, int] | None = None
    bot_turn_active: bool = False
    bot_turn_token: int = 0


@dataclass
class OneTwoOneGameSession:
    game: OneTwoOneGame
    darts_recorded_in_turn: int = 0
    bot_levels: dict[int, int] | None = None
    bot_turn_active: bool = False
    bot_turn_token: int = 0


@dataclass
class TargetTrainerGameSession:
    game: TargetTrainerGame
    darts_recorded_in_turn: int = 0
    bot_levels: dict[int, int] | None = None
    bot_turn_active: bool = False
    bot_turn_token: int = 0


@dataclass
class PacmanGameSession:
    game: PacmanGame
    darts_recorded_in_turn: int = 0
    bot_levels: dict[int, int] | None = None
    bot_turn_active: bool = False
    bot_turn_token: int = 0


class GameService:
    _BOT_SPEED_DELAYS = {
        # Legacy-like cadence (old app used ~1.8-2.4s pre-dart with speed scale).
        "slow": 2.8,
        "normal": 2.1,
        "fast": 1.5,
    }

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._active_mode: str | None = None
        self._x01: X01GameSession | None = None
        self._cricket: CricketGameSession | None = None
        self._around_the_clock: AroundTheClockGameSession | None = None
        self._shanghai: ShanghaiGameSession | None = None
        self._beer_race: BeerRaceGameSession | None = None
        self._bermuda: BermudaGameSession | None = None
        self._bob27: Bob27GameSession | None = None
        self._one_two_one: OneTwoOneGameSession | None = None
        self._target_trainer: TargetTrainerGameSession | None = None
        self._pacman: PacmanGameSession | None = None
        loaded = _load_game_settings()
        loaded_speed = str(loaded.get("bot_speed", "normal")).strip().lower()
        self._bot_speed = loaded_speed if loaded_speed in self._BOT_SPEED_DELAYS else "normal"
        register_detection_event_listener(self._handle_detection_event)
        self._seed_thread_started = False
        self._start_bot_stats_seed_thread()

    @staticmethod
    def _debug_x01_sync(label: str, state: dict[str, Any] | None = None, *, extra: str = "") -> None:
        try:
            if not isinstance(state, dict):
                print(f"[ONLINE X01] {label}{f' | {extra}' if extra else ''}")
                return
            match = dict(state.get("match", {}) or {})
            players = list(state.get("players", []) or [])
            players_summary = ", ".join(
                f"{idx}:{player.get('name', f'P{idx + 1}')}={player.get('score', '?')} "
                f"L{player.get('legsWon', 0)} S{player.get('setsWon', 0)}"
                for idx, player in enumerate(players)
            )
            current_turn = dict(state.get("currentTurn", {}) or {})
            turn_scores = list(current_turn.get("appliedScores", []) or [])
            print(
                "[ONLINE X01] "
                f"{label} | current={state.get('currentPlayer')} "
                f"turn={current_turn.get('turnIndex')} "
                f"leg={match.get('currentLeg')} "
                f"set={match.get('currentSet')} "
                f"legWinner={match.get('legWinner')} "
                f"setWinner={match.get('setWinner')} "
                f"matchWinner={match.get('matchWinner')} "
                f"scores=[{players_summary}] "
                f"turnScores={turn_scores}"
                f"{f' | {extra}' if extra else ''}"
            )
        except Exception as exc:
            print(f"[ONLINE X01] {label} | debug_log_failed={exc}{f' | {extra}' if extra else ''}")

    def _start_bot_stats_seed_thread(self) -> None:
        if self._seed_thread_started:
            return
        self._seed_thread_started = True
        worker = threading.Thread(
            target=self._seed_x01_bot_baseline_if_needed,
            name="x01-bot-seed",
            daemon=True,
        )
        worker.start()

    @staticmethod
    def _to_score_payload_from_throw(bot_throw: Any) -> dict[str, Any]:
        return {
            "score": int(bot_throw.score),
            "multiplier": int(bot_throw.multiplier),
            "segment": str(int(bot_throw.number)),
            "zone": str(bot_throw.zone),
            "confidence": float(bot_throw.confidence),
        }

    @staticmethod
    def _wled_score_event_for_visit(score: int) -> str | None:
        value = int(score or 0)
        if value >= 180:
            return "score_180"
        if value >= 160:
            return "score_160_plus"
        if value >= 140:
            return "score_140_plus"
        if value >= 120:
            return "score_120_plus"
        if value >= 100:
            return "score_100_plus"
        if value >= 80:
            return "score_80_plus"
        if value >= 60:
            return "score_60_plus"
        return None

    def _trigger_x01_turn_wled(self, state: dict[str, Any]) -> None:
        last_turn = state.get("lastCommittedTurn") or state.get("lastTurn")
        if not isinstance(last_turn, dict):
            return
        if bool(last_turn.get("finished")):
            wled.trigger_event_async("game_shot", min_interval_ms=800)
            return
        if bool(last_turn.get("bust")):
            wled.trigger_event_async("bust", min_interval_ms=800)
            return
        event_name = self._wled_score_event_for_visit(int(last_turn.get("scored", 0) or 0))
        if event_name:
            wled.trigger_event_async(event_name, min_interval_ms=800)

    def _trigger_x01_live_wled(self, session: X01GameSession, state: dict[str, Any]) -> None:
        current_turn = state.get("currentTurn")
        if not isinstance(current_turn, dict):
            return
        turn_key = (
            f"{state.get('currentPlayer')}:{current_turn.get('turnIndex')}:"
            f"{current_turn.get('scoreBefore')}"
        )
        if session.wled_live_turn_key != turn_key:
            session.wled_live_turn_key = turn_key
            session.wled_live_event = None
        if bool(current_turn.get("finished")):
            event_name = "game_shot"
        elif bool(current_turn.get("bust")):
            event_name = "bust"
        else:
            event_name = self._wled_score_event_for_visit(int(current_turn.get("scored", 0) or 0))
        if event_name and event_name != session.wled_live_event:
            session.wled_live_event = event_name
            wled.trigger_event_async(event_name, min_interval_ms=500)

    def _simulate_x01_seed_leg(self, *, level: int, starting_player: int) -> dict[str, Any] | None:
        game = X01Game()
        game.start_game(
            ["SeedA", "SeedB"],
            start_score=501,
            in_mode="straight",
            out_mode="double",
            starting_player=int(starting_player),
            legs_per_set=1,
            sets_to_win=1,
            free_play=False,
            player_settings=[{}, {}],
            game_variant="standard",
            lms_total_legs=3,
            teams=None,
        )
        bot_a = X01Bot(level=int(level))
        bot_b = X01Bot(level=int(level))
        guard = 0
        while guard < 300:
            guard += 1
            state = game.get_state()
            if state.get("winner") is not None or state.get("matchWinner") is not None:
                break
            current_player = state.get("currentPlayer")
            if current_player is None:
                break
            player_index = int(current_player)
            bot = bot_a if player_index == 0 else bot_b
            for dart_index in range(3):
                state = game.get_state()
                if state.get("currentPlayer") != player_index:
                    break
                if state.get("winner") is not None or state.get("matchWinner") is not None:
                    break
                throw = bot.throw(state, player_index)
                game.record_dart(dart_index, self._to_score_payload_from_throw(throw))
                state = game.get_state()
                turn = state.get("currentTurn", {}) or {}
                if bool(turn.get("bust")) or bool(turn.get("finished")):
                    break
            state = game.get_state()
            if state.get("winner") is not None or state.get("matchWinner") is not None:
                break
            if state.get("currentPlayer") == player_index:
                game.complete_turn()

        summaries = game.consume_leg_summary() or []
        if not summaries or not isinstance(summaries[0], dict):
            return None
        # Record one synthetic leg sample per simulated leg.
        return dict(summaries[0])

    def _seed_x01_bot_baseline_if_needed(self) -> None:
        try:
            if not should_seed_x01_bot_baseline():
                return
            # 10 sets x 5 legs = 50 legs per level
            total_legs = 50
            for level in range(1, 10):
                for leg_idx in range(total_legs):
                    summary = self._simulate_x01_seed_leg(level=level, starting_player=(leg_idx % 2))
                    if isinstance(summary, dict):
                        record_x01_bot_leg(bot_level=level, summary=summary, max_legs=50)
            mark_x01_bot_baseline_seeded()
        except Exception:
            # Seeding failure should never block app startup.
            return

    @staticmethod
    def _utc_now_iso() -> str:
        return datetime.now(timezone.utc).isoformat()

    def start_x01(
        self,
        *,
        players: list[dict[str, Any]],
        start_score: int,
        in_mode: str,
        out_mode: str,
        starting_player: int,
        legs_per_set: int,
        sets_to_win: int,
        free_play: bool,
        game_variant: str,
        lms_total_legs: int,
        teams: list[dict[str, Any]] | None,
        analytics_source: str,
        local_input_player_index: int | None = None,
    ) -> dict[str, Any]:
        names = [str((p or {}).get("name", "")).strip() for p in players]
        names = [name for name in names if name]
        if not names:
            raise ValueError("At least one player name is required")

        player_settings = []
        for player in players:
            x01_settings = dict((player or {}).get("x01Settings") or {})
            if player.get("teamId") is not None:
                x01_settings["teamId"] = player.get("teamId")
            player_settings.append(x01_settings)

        game = X01Game()
        game.start_game(
            names,
            start_score=int(start_score),
            in_mode=str(in_mode or "straight"),
            out_mode=str(out_mode or "double"),
            starting_player=int(starting_player or 0),
            legs_per_set=int(legs_per_set or 3),
            sets_to_win=int(sets_to_win or 1),
            free_play=bool(free_play),
            player_settings=player_settings,
            game_variant=str(game_variant or "standard"),
            lms_total_legs=int(lms_total_legs or 3),
            teams=teams,
        )
        bot_levels: dict[int, int] = {}
        player_bot_sources: dict[int, str] = {}
        player_bot_won_legs: dict[int, list[dict[str, Any]]] = {}
        for idx, player in enumerate(players):
            payload = player or {}
            is_bot = bool(payload.get("isBot"))
            is_player_bot = bool(payload.get("isPlayerBot"))
            if not is_bot and not is_player_bot:
                continue
            bot_levels[idx] = int(payload.get("botLevel") or 4)
            if is_player_bot:
                source_player_id = str(payload.get("sourcePlayerId", "")).strip()
                if not source_player_id:
                    raise ValueError(f"Player bot '{payload.get('name', f'Player {idx + 1}')}' requires a source player profile.")
                won_legs = get_player_bot_won_legs(source_player_id, limit=50)
                if not won_legs:
                    won_legs = get_imported_player_bot_won_legs(source_player_id, limit=50)
                if len(won_legs) < 5:
                    raise ValueError(
                        f"Player bot '{payload.get('name', f'Player {idx + 1}')}' is locked. "
                        f"Source profile needs at least 5 won X01 legs (has {len(won_legs)})."
                    )
                player_bot_sources[idx] = source_player_id
                player_bot_won_legs[idx] = won_legs
        profile_ids = {
            idx: str((player or {}).get("profileId", "")).strip()
            for idx, player in enumerate(players)
            if (
                str((player or {}).get("profileId", "")).strip()
                and not bool((player or {}).get("isBot"))
                and not bool((player or {}).get("isPlayerBot"))
            )
        }
        now_iso = self._utc_now_iso()
        with self._lock:
            self._stop_active_locked()
            self._active_mode = "x01"
            self._x01 = X01GameSession(
                game=game,
                darts_recorded_in_turn=0,
                bot_levels=bot_levels,
                player_bot_sources=player_bot_sources,
                player_bot_won_legs=player_bot_won_legs,
                player_bot_replay_state={},
                profile_ids=profile_ids,
                leg_started_at=now_iso,
                match_started_at=now_iso,
                corrections_applied=0,
                analytics_source=str(analytics_source or "local"),
                analytics_match_reported=False,
                local_input_player_index=local_input_player_index,
            )
        publish_detection_event({"type": "x01_started"})
        wled.trigger_event_async("game_start", min_interval_ms=1000)
        self._mark_x01_player_replay_turn_from_state(state=game.get_state(), bot_levels=bot_levels)
        self._schedule_x01_bot_turn_if_needed()
        return self.get_x01_state() or game.get_state()

    def get_x01_state(self) -> dict[str, Any] | None:
        with self._lock:
            if self._x01 is None:
                return None
            session = self._x01
            state = session.game.get_state()
            self._maybe_enqueue_x01_match_summary_locked(session, state)
            current_player = state.get("currentPlayer")
            bot_levels = session.bot_levels or {}
            player_bot_sources = session.player_bot_sources or {}
            for idx, player in enumerate(state.get("players", [])):
                if idx in bot_levels:
                    player["isBot"] = True
                    player["botLevel"] = int(bot_levels[idx])
                    if idx in player_bot_sources:
                        player["isPlayerBot"] = True
                        player["sourcePlayerId"] = str(player_bot_sources[idx])
            current_is_bot = current_player is not None and int(current_player) in bot_levels
            remote_player_turn = (
                session.local_input_player_index is not None
                and current_player is not None
                and int(current_player) != int(session.local_input_player_index)
            )
            match_winner = state.get("matchWinner")
            winner = state.get("winner")
            turn_input_armed = (
                (not session.bot_turn_active)
                and (not current_is_bot)
                and (not remote_player_turn)
                and match_winner is None
                and winner is None
            )
            state["botTurnActive"] = bool(session.bot_turn_active)
            state["turnInputArmed"] = bool(turn_input_armed)
            if match_winner is not None or winner is not None:
                state["turnInputReason"] = "match_complete"
            elif session.bot_turn_active:
                state["turnInputReason"] = "bot_turn_active"
            elif current_is_bot:
                state["turnInputReason"] = "bot_player_turn"
            elif remote_player_turn:
                state["turnInputReason"] = "remote_player_turn"
            else:
                state["turnInputReason"] = "ready"
            return state

    def _maybe_enqueue_x01_match_summary_locked(self, session: X01GameSession, state: dict[str, Any]) -> None:
        if session.analytics_match_reported:
            return
        if str(session.analytics_source or "local").strip().lower() != "local":
            return
        match_winner = state.get("matchWinner")
        if match_winner is None:
            return
        print(
            "[owner-analytics] x01_match_complete "
            f"winner={match_winner} "
            f"current_leg={(state.get('match', {}) or {}).get('currentLeg')} "
            f"current_set={(state.get('match', {}) or {}).get('currentSet')}"
        )

        players = list(state.get("players", []) or [])
        match_stats = list(state.get("matchStats", []) or [])
        total_darts = sum(
            int(stat.get("dartsThrown", 0) or 0)
            for stat in match_stats
            if isinstance(stat, dict)
        )
        corrections_count = int(session.corrections_applied or 0)
        estimated_accuracy = 1.0
        if total_darts > 0:
            estimated_accuracy = max(0.0, min(1.0, float(total_darts - corrections_count) / float(total_darts)))

        get_owner_analytics_service().record_x01_match_summary(
            {
                "mode": "x01",
                "analytics_source": str(session.analytics_source or "local"),
                "started_at": session.match_started_at or session.leg_started_at or self._utc_now_iso(),
                "finished_at": self._utc_now_iso(),
                "players_count": len(players),
                "match_winner": int(match_winner),
                "corrections_count": corrections_count,
                "estimated_accuracy": round(estimated_accuracy, 4),
                "settings": {
                    "startScore": state.get("settings", {}).get("startScore"),
                    "inMode": state.get("settings", {}).get("inMode"),
                    "outMode": state.get("settings", {}).get("outMode"),
                    "legsPerSet": state.get("settings", {}).get("legsPerSet"),
                    "setsToWin": state.get("settings", {}).get("setsToWin"),
                    "freePlay": state.get("settings", {}).get("freePlay"),
                    "gameVariant": state.get("settings", {}).get("gameVariant"),
                },
                "players": [
                    {
                        "index": index,
                        "name": str(player.get("name", "") or f"Player {index + 1}"),
                        "isBot": bool(player.get("isBot", False)),
                        "legsWon": int(player.get("legsWon", 0) or 0),
                        "setsWon": int(player.get("setsWon", 0) or 0),
                        "score": int(player.get("score", 0) or 0),
                    }
                    for index, player in enumerate(players)
                    if isinstance(player, dict)
                ],
                "match_stats": match_stats,
            }
        )
        session.analytics_match_reported = True
        print("[owner-analytics] x01_match_summary_marked_reported")

    @staticmethod
    def _apply_turn_input_flags(
        *,
        state: dict[str, Any],
        bot_turn_active: bool,
        bot_levels: dict[int, int] | None,
        finished: bool,
    ) -> dict[str, Any]:
        current_player = state.get("currentPlayer")
        levels = bot_levels or {}
        current_is_bot = current_player is not None and int(current_player) in levels
        turn_input_armed = (not bot_turn_active) and (not current_is_bot) and (not finished)
        state["botTurnActive"] = bool(bot_turn_active)
        state["turnInputArmed"] = bool(turn_input_armed)
        if finished:
            state["turnInputReason"] = "match_complete"
        elif bot_turn_active:
            state["turnInputReason"] = "bot_turn_active"
        elif current_is_bot:
            state["turnInputReason"] = "bot_player_turn"
        else:
            state["turnInputReason"] = "ready"
        return state

    @staticmethod
    def _request_detection_resync() -> None:
        # Lazy import to avoid pulling heavy detection/cv2 modules during service import.
        try:
            from backend.core.detection.dartcounter import request_detection_reset

            request_detection_reset(reset_background=True)
        except Exception:
            pass

    @staticmethod
    def _mark_x01_player_replay_turn_from_state(
        *,
        state: dict[str, Any] | None,
        bot_levels: dict[int, int] | None,
    ) -> None:
        try:
            from backend.core.player_replay_camera import get_player_replay_camera_service

            replay_service = get_player_replay_camera_service()
            payload = state or {}
            current_player = payload.get("currentPlayer")
            match_winner = payload.get("matchWinner")
            winner = payload.get("winner")
            if match_winner is not None or winner is not None or current_player is None:
                replay_service.mark_non_human_turn_started()
                return
            levels = bot_levels or {}
            if int(current_player) in levels:
                replay_service.mark_non_human_turn_started()
                return
            replay_service.mark_human_turn_started(int(current_player))
        except Exception:
            pass

    @staticmethod
    def _wait_for_detection_zero_then_allow_next_turn(timeout_ms: int = 2500) -> None:
        """Request detector reset and wait until darts_on_board reaches 0."""
        try:
            from backend.core.detection.dartcounter import (
                get_detection_insights,
                request_detection_reset,
            )
        except Exception:
            # Detector module unavailable (e.g. api-only mode): do not block turn flow.
            return

        request_detection_reset(reset_background=True)
        deadline = time.perf_counter() + (max(200, int(timeout_ms)) / 1000.0)
        last_darts = 0
        while time.perf_counter() < deadline:
            try:
                insights = get_detection_insights() or {}
                last_darts = int(insights.get("darts_on_board", 0) or 0)
            except Exception:
                last_darts = 0
            if last_darts <= 0:
                return
            time.sleep(0.05)

        raise ValueError(
            f"Cannot advance turn yet. Waiting for board reset (darts_on_board={int(last_darts)})."
        )

    def stop_x01(self) -> None:
        with self._lock:
            self._stop_x01_locked()
        self._mark_x01_player_replay_turn_from_state(state=None, bot_levels=None)
        publish_detection_event({"type": "x01_stopped"})

    def force_next_turn(self) -> dict[str, Any]:
        self._wait_for_detection_zero_then_allow_next_turn()
        with self._lock:
            if self._x01 is None:
                raise ValueError("No active X01 game")
            session = self._x01
            before_state = session.game.get_state()
            self._debug_x01_sync("force_next_turn:start", before_state)
            session.game.complete_turn()
            self._persist_x01_leg_summary_locked(session)
            session.darts_recorded_in_turn = 0
            state = session.game.get_state()
            self._trigger_x01_turn_wled(state)
            self._debug_x01_sync("force_next_turn:end", state)
            bot_levels = dict(session.bot_levels or {})
        self._mark_x01_player_replay_turn_from_state(state=state, bot_levels=bot_levels)
        self._request_detection_resync()
        publish_detection_event({"type": "x01_turn_completed", "source": "force_next_turn"})
        self._schedule_x01_bot_turn_if_needed()
        return self.get_x01_state() or state

    def apply_remote_x01_turn(
        self,
        *,
        player_index: int,
        darts: list[dict[str, Any] | None],
    ) -> dict[str, Any]:
        with self._lock:
            if self._x01 is None:
                raise ValueError("No active X01 game")
            session = self._x01
            if session.bot_turn_active:
                raise ValueError("Cannot apply remote turn while bot turn is active")

            game = session.game
            state_before = game.get_state()
            current_player = state_before.get("currentPlayer")
            if current_player is None:
                raise ValueError("X01 game is not ready")
            self._debug_x01_sync(
                "apply_remote_turn:start",
                state_before,
                extra=f"target={int(player_index)} darts={[(dart or {}).get('score', 0) if isinstance(dart, dict) else None for dart in list(darts)[:3]]}",
            )

            target_player_index = int(player_index)
            players = state_before.get("players", []) or []
            if target_player_index < 0 or target_player_index >= len(players):
                raise ValueError("Invalid remote player index")

            current_turn = dict(state_before.get("currentTurn", {}) or {})
            current_turn_darts = list(current_turn.get("darts", []) or [])
            if int(current_player) != target_player_index:
                game.sync_to_player_turn(target_player_index)
            elif any(dart is not None for dart in current_turn_darts):
                raise ValueError("Cannot apply remote turn while local turn already has darts")

            session.darts_recorded_in_turn = 0
            applied_darts = 0
            for dart_index, dart_payload in enumerate(list(darts)[:3]):
                if not isinstance(dart_payload, dict):
                    continue
                score_value = int(dart_payload.get("score", 0) or 0)
                normalized = _normalize_score_payload(dart_payload, score_value)
                game.record_dart(dart_index, normalized)
                applied_darts = dart_index + 1
                session.darts_recorded_in_turn = applied_darts
                turn_state = dict(game.get_state().get("currentTurn", {}) or {})
                self._trigger_x01_live_wled(session, game.get_state())
                if bool(turn_state.get("bust")) or bool(turn_state.get("finished")):
                    break

            if applied_darts <= 0:
                raise ValueError("Remote turn must contain at least one scored dart")

            game.complete_turn()
            self._persist_x01_leg_summary_locked(session)
            session.darts_recorded_in_turn = 0
            state = game.get_state()
            self._trigger_x01_turn_wled(state)
            self._debug_x01_sync("apply_remote_turn:end", state, extra=f"target={target_player_index}")

        publish_detection_event({"type": "x01_state_updated", "source": "remote_turn", "state": state})
        return self.get_x01_state() or state

    def record_remote_x01_dart(
        self,
        *,
        player_index: int,
        dart_index: int,
        dart: dict[str, Any] | None,
    ) -> dict[str, Any]:
        with self._lock:
            if self._x01 is None:
                raise ValueError("No active X01 game")
            session = self._x01
            if session.bot_turn_active:
                raise ValueError("Cannot record remote dart while bot turn is active")

            game = session.game
            state_before = game.get_state()
            current_player = state_before.get("currentPlayer")
            if current_player is None:
                raise ValueError("X01 game is not ready")
            self._debug_x01_sync(
                "record_remote_dart:start",
                state_before,
                extra=f"target={int(player_index)} dartIndex={int(dart_index)} score={int((dart or {}).get('score', 0) or 0)}",
            )

            target_player_index = int(player_index)
            players = state_before.get("players", []) or []
            if target_player_index < 0 or target_player_index >= len(players):
                raise ValueError("Invalid remote player index")

            current_turn = dict(state_before.get("currentTurn", {}) or {})
            current_turn_darts = list(current_turn.get("darts", []) or [])
            if int(current_player) != target_player_index:
                if any(existing is not None for existing in current_turn_darts):
                    raise ValueError("Cannot sync remote dart to a different player while current turn already has darts")
                game.sync_to_player_turn(target_player_index)

            normalized_index = max(0, min(2, int(dart_index) - 1))
            score_value = int((dart or {}).get("score", 0) or 0)
            normalized = _normalize_score_payload(dart, score_value) if isinstance(dart, dict) else None
            game.record_dart(normalized_index, normalized)
            session.darts_recorded_in_turn = max(session.darts_recorded_in_turn, normalized_index + 1)
            state = game.get_state()
            self._trigger_x01_live_wled(session, state)
            self._debug_x01_sync(
                "record_remote_dart:end",
                state,
                extra=f"target={target_player_index} dartIndex={normalized_index + 1} score={score_value}",
            )

        publish_detection_event({"type": "x01_state_updated", "source": "remote_dart", "state": state})
        return self.get_x01_state() or state

    def commit_remote_x01_turn(
        self,
        *,
        player_index: int,
        darts: list[dict[str, Any] | None] | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            if self._x01 is None:
                raise ValueError("No active X01 game")
            session = self._x01
            if session.bot_turn_active:
                raise ValueError("Cannot commit remote turn while bot turn is active")

            game = session.game
            state_before = game.get_state()
            current_player = state_before.get("currentPlayer")
            if current_player is None:
                raise ValueError("X01 game is not ready")
            self._debug_x01_sync(
                "commit_remote_turn:start",
                state_before,
                extra=f"target={int(player_index)} fallbackDarts={[(dart or {}).get('score', 0) if isinstance(dart, dict) else None for dart in list(darts or [])[:3]]}",
            )

            target_player_index = int(player_index)
            players = state_before.get("players", []) or []
            if target_player_index < 0 or target_player_index >= len(players):
                raise ValueError("Invalid remote player index")

            current_turn = dict(state_before.get("currentTurn", {}) or {})
            current_turn_darts = list(current_turn.get("darts", []) or [])
            if int(current_player) != target_player_index:
                if any(existing is not None for existing in current_turn_darts):
                    raise ValueError("Cannot sync remote turn to a different player while current turn already has darts")
                game.sync_to_player_turn(target_player_index)
                state_before = game.get_state()
                current_turn = dict(state_before.get("currentTurn", {}) or {})
                current_turn_darts = list(current_turn.get("darts", []) or [])

            if not any(existing is not None for existing in current_turn_darts):
                provided_darts = list(darts or [])
                if not provided_darts:
                    raise ValueError("Remote turn has no preview darts and no fallback payload")
                applied_darts = 0
                for turn_dart_index, dart_payload in enumerate(provided_darts[:3]):
                    if not isinstance(dart_payload, dict):
                        continue
                    score_value = int(dart_payload.get("score", 0) or 0)
                    normalized = _normalize_score_payload(dart_payload, score_value)
                    game.record_dart(turn_dart_index, normalized)
                    applied_darts = turn_dart_index + 1
                    session.darts_recorded_in_turn = applied_darts
                    state_after_dart = game.get_state()
                    self._trigger_x01_live_wled(session, state_after_dart)
                    turn_state = dict(state_after_dart.get("currentTurn", {}) or {})
                    if bool(turn_state.get("bust")) or bool(turn_state.get("finished")):
                        break
                if applied_darts <= 0:
                    raise ValueError("Remote turn must contain at least one scored dart")

            game.complete_turn()
            self._persist_x01_leg_summary_locked(session)
            session.darts_recorded_in_turn = 0
            state = game.get_state()
            self._trigger_x01_turn_wled(state)
            self._debug_x01_sync("commit_remote_turn:end", state, extra=f"target={target_player_index}")

        publish_detection_event({"type": "x01_state_updated", "source": "remote_turn_commit", "state": state})
        return self.get_x01_state() or state

    def undo_x01_turn(self) -> dict[str, Any]:
        with self._lock:
            if self._x01 is None:
                raise ValueError("No active X01 game")
            session = self._x01
            if session.bot_turn_active:
                raise ValueError("Cannot undo while bot turn is active")
            ok = session.game.undo_last_turn()
            if not ok:
                raise ValueError("No undoable turn available")
            session.darts_recorded_in_turn = 0
            state = session.game.get_state()
            bot_levels = dict(session.bot_levels or {})
        self._mark_x01_player_replay_turn_from_state(state=state, bot_levels=bot_levels)
        self._request_detection_resync()
        publish_detection_event({"type": "x01_turn_undone"})
        self._schedule_x01_bot_turn_if_needed()
        return self.get_x01_state() or state

    def start_cricket(
        self,
        *,
        players: list[dict[str, Any]],
        mode: str,
        starting_player: int,
        legs_per_set: int,
        sets_to_win: int,
    ) -> dict[str, Any]:
        names = [str((p or {}).get("name", "")).strip() for p in players]
        names = [name for name in names if name]
        if not names:
            raise ValueError("At least one player name is required")

        game = CricketGame()
        game.start_game(
            names,
            mode=str(mode or "standard"),
            starting_player=int(starting_player or 0),
            legs_per_set=int(legs_per_set or 1),
            sets_to_win=int(sets_to_win or 1),
        )
        bot_levels = {
            idx: int((player or {}).get("botLevel") or 4)
            for idx, player in enumerate(players)
            if bool((player or {}).get("isBot"))
        }
        profile_ids = {
            idx: str((player or {}).get("profileId", "")).strip()
            for idx, player in enumerate(players)
            if str((player or {}).get("profileId", "")).strip() and not bool((player or {}).get("isBot"))
        }
        now_iso = self._utc_now_iso()
        state = game.get_state()
        for idx, player in enumerate(state.get("players", [])):
            if idx in bot_levels:
                player["isBot"] = True
                player["botLevel"] = int(bot_levels[idx])

        with self._lock:
            self._stop_active_locked()
            self._active_mode = "cricket"
            self._cricket = CricketGameSession(
                game=game,
                darts_recorded_in_turn=0,
                bot_levels=bot_levels,
                profile_ids=profile_ids,
                leg_started_at=now_iso,
            )
        publish_detection_event({"type": "cricket_started"})
        self._schedule_cricket_bot_turn_if_needed()
        return self.get_cricket_state() or state

    def get_cricket_state(self) -> dict[str, Any] | None:
        with self._lock:
            if self._cricket is None:
                return None
            session = self._cricket
            state = session.game.get_state()
            bot_levels = session.bot_levels or {}
            match_info = state.get("match", {}) or {}
            finished = match_info.get("matchWinner") is not None or state.get("winner") is not None
        for idx, player in enumerate(state.get("players", [])):
            if idx in bot_levels:
                player["isBot"] = True
                player["botLevel"] = int(bot_levels[idx])
        return self._apply_turn_input_flags(
            state=state,
            bot_turn_active=bool(session.bot_turn_active),
            bot_levels=bot_levels,
            finished=bool(finished),
        )

    def stop_cricket(self) -> None:
        with self._lock:
            self._stop_cricket_locked()
        publish_detection_event({"type": "cricket_stopped"})

    def force_next_turn_cricket(self) -> dict[str, Any]:
        self._wait_for_detection_zero_then_allow_next_turn()
        with self._lock:
            if self._cricket is None:
                raise ValueError("No active Cricket game")
            session = self._cricket
            session.game.complete_turn()
            self._persist_cricket_leg_summary_locked(session)
            session.darts_recorded_in_turn = 0
            state = session.game.get_state()
        self._request_detection_resync()
        publish_detection_event({"type": "cricket_state_updated", "source": "force_next_turn", "state": state})
        self._schedule_cricket_bot_turn_if_needed()
        return self.get_cricket_state() or state

    def start_around_the_clock(
        self,
        *,
        players: list[dict[str, Any]],
        mode: str,
        order: str,
        hits_required: int,
        starting_player: int,
        legs_per_set: int,
        sets_to_win: int,
    ) -> dict[str, Any]:
        names = [str((p or {}).get("name", "")).strip() for p in players]
        names = [name for name in names if name]
        if not names:
            raise ValueError("At least one player name is required")

        game = AroundTheClockGame()
        game.start_game(
            names,
            mode=str(mode or "full"),
            order=str(order or "1-20-bull"),
            hits_required=int(hits_required or 1),
            starting_player=int(starting_player or 0),
            legs_per_set=int(legs_per_set or 1),
            sets_to_win=int(sets_to_win or 1),
        )
        bot_levels = {
            idx: int((player or {}).get("botLevel") or 4)
            for idx, player in enumerate(players)
            if bool((player or {}).get("isBot"))
        }
        profile_ids = {
            idx: str((player or {}).get("profileId", "")).strip()
            for idx, player in enumerate(players)
            if str((player or {}).get("profileId", "")).strip() and not bool((player or {}).get("isBot"))
        }
        now_iso = self._utc_now_iso()
        state = game.get_state()
        for idx, player in enumerate(state.get("players", [])):
            if idx in bot_levels:
                player["isBot"] = True
                player["botLevel"] = int(bot_levels[idx])

        with self._lock:
            self._stop_active_locked()
            self._active_mode = "around_the_clock"
            self._around_the_clock = AroundTheClockGameSession(
                game=game,
                darts_recorded_in_turn=0,
                bot_levels=bot_levels,
                profile_ids=profile_ids,
                leg_started_at=now_iso,
            )
        publish_detection_event({"type": "around_the_clock_started"})
        self._schedule_around_the_clock_bot_turn_if_needed()
        return self.get_around_the_clock_state() or state

    def get_around_the_clock_state(self) -> dict[str, Any] | None:
        with self._lock:
            if self._around_the_clock is None:
                return None
            session = self._around_the_clock
            state = session.game.get_state()
            bot_levels = session.bot_levels or {}
            match_info = state.get("match", {}) or {}
            finished = match_info.get("matchWinner") is not None or state.get("winner") is not None
        for idx, player in enumerate(state.get("players", [])):
            if idx in bot_levels:
                player["isBot"] = True
                player["botLevel"] = int(bot_levels[idx])
        return self._apply_turn_input_flags(
            state=state,
            bot_turn_active=bool(session.bot_turn_active),
            bot_levels=bot_levels,
            finished=bool(finished),
        )

    def stop_around_the_clock(self) -> None:
        with self._lock:
            self._stop_around_the_clock_locked()
        publish_detection_event({"type": "around_the_clock_stopped"})

    def force_next_turn_around_the_clock(self) -> dict[str, Any]:
        self._wait_for_detection_zero_then_allow_next_turn()
        with self._lock:
            if self._around_the_clock is None:
                raise ValueError("No active Around the Clock game")
            session = self._around_the_clock
            session.game.complete_turn()
            session.darts_recorded_in_turn = 0
            state = session.game.get_state()
        self._request_detection_resync()
        publish_detection_event({"type": "around_the_clock_state_updated", "source": "force_next_turn", "state": state})
        self._schedule_around_the_clock_bot_turn_if_needed()
        return self.get_around_the_clock_state() or state

    def start_shanghai(
        self,
        *,
        players: list[dict[str, Any]],
        round_range: str,
        mode: str,
        starting_player: int,
        legs_per_set: int,
        sets_to_win: int,
    ) -> dict[str, Any]:
        names = [str((p or {}).get("name", "")).strip() for p in players]
        names = [name for name in names if name]
        if not names:
            raise ValueError("At least one player name is required")

        game = ShanghaiGame()
        game.start_game(
            names,
            round_range=str(round_range or "1-20"),
            mode=str(mode or "legs_sets"),
            starting_player=int(starting_player or 0),
            legs_per_set=int(legs_per_set or 1),
            sets_to_win=int(sets_to_win or 1),
        )
        bot_levels = {
            idx: int((player or {}).get("botLevel") or 4)
            for idx, player in enumerate(players)
            if bool((player or {}).get("isBot"))
        }
        state = game.get_state()
        for idx, player in enumerate(state.get("players", [])):
            if idx in bot_levels:
                player["isBot"] = True
                player["botLevel"] = int(bot_levels[idx])

        with self._lock:
            self._stop_active_locked()
            self._active_mode = "shanghai"
            self._shanghai = ShanghaiGameSession(game=game, darts_recorded_in_turn=0, bot_levels=bot_levels)
        publish_detection_event({"type": "shanghai_started"})
        self._schedule_shanghai_bot_turn_if_needed()
        return self.get_shanghai_state() or state

    def get_shanghai_state(self) -> dict[str, Any] | None:
        with self._lock:
            if self._shanghai is None:
                return None
            session = self._shanghai
            state = session.game.get_state()
            bot_levels = session.bot_levels or {}
            finished = state.get("matchWinnerIndex") is not None or state.get("winnerIndex") is not None
        for idx, player in enumerate(state.get("players", [])):
            if idx in bot_levels:
                player["isBot"] = True
                player["botLevel"] = int(bot_levels[idx])
        return self._apply_turn_input_flags(
            state=state,
            bot_turn_active=bool(session.bot_turn_active),
            bot_levels=bot_levels,
            finished=bool(finished),
        )

    def stop_shanghai(self) -> None:
        with self._lock:
            self._stop_shanghai_locked()
        publish_detection_event({"type": "shanghai_stopped"})

    def force_next_turn_shanghai(self) -> dict[str, Any]:
        self._wait_for_detection_zero_then_allow_next_turn()
        with self._lock:
            if self._shanghai is None:
                raise ValueError("No active Shanghai game")
            session = self._shanghai
            session.game.complete_turn()
            session.darts_recorded_in_turn = 0
            state = session.game.get_state()
        self._request_detection_resync()
        publish_detection_event({"type": "shanghai_state_updated", "source": "force_next_turn", "state": state})
        self._schedule_shanghai_bot_turn_if_needed()
        return self.get_shanghai_state() or state

    def start_beer_race(
        self,
        *,
        players: list[dict[str, Any]],
        target_score: int,
        starting_player: int,
        legs_per_set: int,
        sets_to_win: int,
    ) -> dict[str, Any]:
        names = [str((p or {}).get("name", "")).strip() for p in players]
        names = [name for name in names if name]
        if not names:
            raise ValueError("At least one player name is required")
        game = BeerRaceGame()
        game.start_game(
            names,
            target_score=int(target_score or 301),
            starting_player=int(starting_player or 0),
            legs_per_set=int(legs_per_set or 1),
            sets_to_win=int(sets_to_win or 1),
        )
        bot_levels = {
            idx: int((player or {}).get("botLevel") or 4)
            for idx, player in enumerate(players)
            if bool((player or {}).get("isBot"))
        }
        state = game.get_state()
        for idx, player in enumerate(state.get("players", [])):
            if idx in bot_levels:
                player["isBot"] = True
                player["botLevel"] = int(bot_levels[idx])
        with self._lock:
            self._stop_active_locked()
            self._active_mode = "beer_race"
            self._beer_race = BeerRaceGameSession(game=game, darts_recorded_in_turn=0, bot_levels=bot_levels)
        publish_detection_event({"type": "beer_race_started"})
        self._schedule_beer_race_bot_turn_if_needed()
        return self.get_beer_race_state() or state

    def get_beer_race_state(self) -> dict[str, Any] | None:
        with self._lock:
            if self._beer_race is None:
                return None
            session = self._beer_race
            state = session.game.get_state()
            bot_levels = session.bot_levels or {}
            finished = state.get("matchWinnerIndex") is not None or state.get("winnerIndex") is not None
        for idx, player in enumerate(state.get("players", [])):
            if idx in bot_levels:
                player["isBot"] = True
                player["botLevel"] = int(bot_levels[idx])
        return self._apply_turn_input_flags(
            state=state,
            bot_turn_active=bool(session.bot_turn_active),
            bot_levels=bot_levels,
            finished=bool(finished),
        )

    def stop_beer_race(self) -> None:
        with self._lock:
            self._stop_beer_race_locked()
        publish_detection_event({"type": "beer_race_stopped"})

    def force_next_turn_beer_race(self) -> dict[str, Any]:
        self._wait_for_detection_zero_then_allow_next_turn()
        with self._lock:
            if self._beer_race is None:
                raise ValueError("No active Beer Race game")
            session = self._beer_race
            session.game.complete_turn()
            session.darts_recorded_in_turn = 0
            state = session.game.get_state()
        self._request_detection_resync()
        publish_detection_event({"type": "beer_race_state_updated", "source": "force_next_turn", "state": state})
        self._schedule_beer_race_bot_turn_if_needed()
        return self.get_beer_race_state() or state

    def start_bermuda(
        self,
        *,
        players: list[dict[str, Any]],
        starting_player: int,
        mode: str,
        legs_per_set: int,
        sets_to_win: int,
    ) -> dict[str, Any]:
        if not players:
            raise ValueError("At least one player is required")
        game = BermudaTriangleGame()
        game.start_game(
            players,
            starting_player=int(starting_player or 0),
            mode=str(mode or "legs_sets"),
            legs_per_set=int(legs_per_set or 1),
            sets_to_win=int(sets_to_win or 1),
        )
        bot_levels = {
            idx: int((player or {}).get("botLevel") or 4)
            for idx, player in enumerate(players)
            if bool((player or {}).get("isBot"))
        }
        state = game.get_state()
        for idx, player in enumerate(state.get("players", [])):
            if idx in bot_levels:
                player["isBot"] = True
                player["botLevel"] = int(bot_levels[idx])
        with self._lock:
            self._stop_active_locked()
            self._active_mode = "bermuda"
            self._bermuda = BermudaGameSession(game=game, darts_recorded_in_turn=0, bot_levels=bot_levels)
        publish_detection_event({"type": "bermuda_started"})
        self._schedule_bermuda_bot_turn_if_needed()
        return self.get_bermuda_state() or state

    def get_bermuda_state(self) -> dict[str, Any] | None:
        with self._lock:
            if self._bermuda is None:
                return None
            session = self._bermuda
            state = session.game.get_state()
            bot_levels = session.bot_levels or {}
            finished = state.get("matchWinnerIndex") is not None
        for idx, player in enumerate(state.get("players", [])):
            if idx in bot_levels:
                player["isBot"] = True
                player["botLevel"] = int(bot_levels[idx])
        return self._apply_turn_input_flags(
            state=state,
            bot_turn_active=bool(session.bot_turn_active),
            bot_levels=bot_levels,
            finished=bool(finished),
        )

    def stop_bermuda(self) -> None:
        with self._lock:
            self._stop_bermuda_locked()
        publish_detection_event({"type": "bermuda_stopped"})

    def force_next_turn_bermuda(self) -> dict[str, Any]:
        self._wait_for_detection_zero_then_allow_next_turn()
        with self._lock:
            if self._bermuda is None:
                raise ValueError("No active Bermuda game")
            session = self._bermuda
            session.game.complete_turn()
            session.darts_recorded_in_turn = 0
            state = session.game.get_state()
        self._request_detection_resync()
        publish_detection_event({"type": "bermuda_state_updated", "source": "force_next_turn", "state": state})
        self._schedule_bermuda_bot_turn_if_needed()
        return self.get_bermuda_state() or state

    def start_bob27(
        self,
        *,
        players: list[dict[str, Any]],
        include_bull: bool,
        allow_negative: bool,
        starting_player: int,
        total_legs: int,
    ) -> dict[str, Any]:
        if not players:
            raise ValueError("At least one player is required")
        game = Bob27Game()
        game.start_game(
            players,
            include_bull=bool(include_bull),
            allow_negative=bool(allow_negative),
            starting_player=int(starting_player or 0),
            total_legs=int(total_legs or 1),
        )
        bot_levels = {
            idx: int((player or {}).get("botLevel") or 4)
            for idx, player in enumerate(players)
            if bool((player or {}).get("isBot"))
        }
        state = game.get_state()
        with self._lock:
            self._stop_active_locked()
            self._active_mode = "bob27"
            self._bob27 = Bob27GameSession(game=game, darts_recorded_in_turn=0, bot_levels=bot_levels)
        publish_detection_event({"type": "bob27_started"})
        self._schedule_bob27_bot_turn_if_needed()
        return self.get_bob27_state() or state

    def get_bob27_state(self) -> dict[str, Any] | None:
        with self._lock:
            if self._bob27 is None:
                return None
            session = self._bob27
            state = session.game.get_state()
            bot_levels = session.bot_levels or {}
            finished = state.get("matchWinnerIndex") is not None
        for idx, player in enumerate(state.get("players", [])):
            if idx in bot_levels:
                player["isBot"] = True
                player["botLevel"] = int(bot_levels[idx])
        return self._apply_turn_input_flags(
            state=state,
            bot_turn_active=bool(session.bot_turn_active),
            bot_levels=bot_levels,
            finished=bool(finished),
        )

    def stop_bob27(self) -> None:
        with self._lock:
            self._stop_bob27_locked()
        publish_detection_event({"type": "bob27_stopped"})

    def force_next_turn_bob27(self) -> dict[str, Any]:
        self._wait_for_detection_zero_then_allow_next_turn()
        with self._lock:
            if self._bob27 is None:
                raise ValueError("No active Bob27 game")
            session = self._bob27
            session.game.complete_turn()
            session.darts_recorded_in_turn = 0
            state = session.game.get_state()
        self._request_detection_resync()
        publish_detection_event({"type": "bob27_state_updated", "source": "force_next_turn", "state": state})
        self._schedule_bob27_bot_turn_if_needed()
        return self.get_bob27_state() or state

    def start_one_two_one(
        self,
        *,
        players: list[dict[str, Any]],
        starting_target: int,
        target_limit: int | None,
        failure_policy: str,
        out_rule: str,
        starting_player: int,
        legs_per_set: int,
        sets_to_win: int,
    ) -> dict[str, Any]:
        names = [str((p or {}).get("name", "")).strip() for p in players]
        names = [name for name in names if name]
        if not names:
            raise ValueError("At least one player name is required")
        game = OneTwoOneGame()
        game.start_game(
            names,
            starting_target=int(starting_target or 121),
            target_limit=(None if target_limit in (None, 0) else int(target_limit)),
            failure_policy=str(failure_policy or "stay"),
            out_rule=str(out_rule or "double"),
            starting_player=int(starting_player or 0),
            legs_per_set=int(legs_per_set or 1),
            sets_to_win=int(sets_to_win or 1),
        )
        bot_levels = {
            idx: int((player or {}).get("botLevel") or 4)
            for idx, player in enumerate(players)
            if bool((player or {}).get("isBot"))
        }
        state = game.get_state()
        for idx, player in enumerate(state.get("players", [])):
            if idx in bot_levels:
                player["isBot"] = True
                player["botLevel"] = int(bot_levels[idx])
        with self._lock:
            self._stop_active_locked()
            self._active_mode = "one_two_one"
            self._one_two_one = OneTwoOneGameSession(game=game, darts_recorded_in_turn=0, bot_levels=bot_levels)
        publish_detection_event({"type": "one_two_one_started"})
        self._schedule_one_two_one_bot_turn_if_needed()
        return self.get_one_two_one_state() or state

    def get_one_two_one_state(self) -> dict[str, Any] | None:
        with self._lock:
            if self._one_two_one is None:
                return None
            session = self._one_two_one
            state = session.game.get_state()
            bot_levels = session.bot_levels or {}
            match_info = state.get("match", {}) or {}
            finished = match_info.get("matchWinner") is not None or state.get("winnerIndex") is not None
        for idx, player in enumerate(state.get("players", [])):
            if idx in bot_levels:
                player["isBot"] = True
                player["botLevel"] = int(bot_levels[idx])
        return self._apply_turn_input_flags(
            state=state,
            bot_turn_active=bool(session.bot_turn_active),
            bot_levels=bot_levels,
            finished=bool(finished),
        )

    def stop_one_two_one(self) -> None:
        with self._lock:
            self._stop_one_two_one_locked()
        publish_detection_event({"type": "one_two_one_stopped"})

    def force_next_turn_one_two_one(self) -> dict[str, Any]:
        self._wait_for_detection_zero_then_allow_next_turn()
        with self._lock:
            if self._one_two_one is None:
                raise ValueError("No active One Two One game")
            session = self._one_two_one
            session.game.complete_turn()
            session.darts_recorded_in_turn = 0
            state = session.game.get_state()
        self._request_detection_resync()
        publish_detection_event({"type": "one_two_one_state_updated", "source": "force_next_turn", "state": state})
        self._schedule_one_two_one_bot_turn_if_needed()
        return self.get_one_two_one_state() or state

    def start_target_trainer(
        self,
        *,
        players: list[dict[str, Any]],
        target_type: str,
        target_number: int,
        required_hits: float,
        allow_close: bool,
        shared_target: bool,
        starting_player: int,
        legs_per_set: int,
        sets_to_win: int,
    ) -> dict[str, Any]:
        if not players:
            raise ValueError("At least one player is required")
        game = TargetTrainerGame()
        game.start_game(
            players,
            target_type=str(target_type or "treble"),
            target_number=int(target_number or 20),
            required_hits=float(required_hits or 10),
            allow_close=bool(allow_close),
            shared_target=bool(shared_target),
            starting_player=int(starting_player or 0),
            legs_per_set=int(legs_per_set or 1),
            sets_to_win=int(sets_to_win or 1),
        )
        bot_levels = {
            idx: int((player or {}).get("botLevel") or 4)
            for idx, player in enumerate(players)
            if bool((player or {}).get("isBot"))
        }
        state = game.get_state()
        with self._lock:
            self._stop_active_locked()
            self._active_mode = "target_trainer"
            self._target_trainer = TargetTrainerGameSession(game=game, darts_recorded_in_turn=0, bot_levels=bot_levels)
        publish_detection_event({"type": "target_trainer_started"})
        self._schedule_target_trainer_bot_turn_if_needed()
        return self.get_target_trainer_state() or state

    def start_pacman(
        self,
        *,
        players: list[dict[str, Any]],
        lives_per_player: int,
        starting_player: int,
    ) -> dict[str, Any]:
        names = [str((p or {}).get("name", "")).strip() for p in players]
        names = [name for name in names if name]
        if not names:
            raise ValueError("At least one player name is required")
        game = PacmanGame()
        game.start_game(
            names,
            lives_per_player=int(lives_per_player or 5),
            starting_player=int(starting_player or 0),
        )
        bot_levels = {
            idx: int((player or {}).get("botLevel") or 4)
            for idx, player in enumerate(players)
            if bool((player or {}).get("isBot"))
        }
        state = game.get_state()
        for idx, player in enumerate(state.get("players", [])):
            if idx in bot_levels:
                player["isBot"] = True
                player["botLevel"] = int(bot_levels[idx])
        with self._lock:
            self._stop_active_locked()
            self._active_mode = "pacman"
            self._pacman = PacmanGameSession(game=game, darts_recorded_in_turn=0, bot_levels=bot_levels)
        publish_detection_event({"type": "pacman_started"})
        self._schedule_pacman_bot_turn_if_needed()
        return self.get_pacman_state() or state

    def get_pacman_state(self) -> dict[str, Any] | None:
        with self._lock:
            if self._pacman is None:
                return None
            session = self._pacman
            state = session.game.get_state()
            bot_levels = session.bot_levels or {}
            match_info = state.get("match", {}) or {}
            finished = match_info.get("matchWinner") is not None or state.get("winnerIndex") is not None
        for idx, player in enumerate(state.get("players", [])):
            if idx in bot_levels:
                player["isBot"] = True
                player["botLevel"] = int(bot_levels[idx])
        return self._apply_turn_input_flags(
            state=state,
            bot_turn_active=bool(session.bot_turn_active),
            bot_levels=bot_levels,
            finished=bool(finished),
        )

    def stop_pacman(self) -> None:
        with self._lock:
            self._stop_pacman_locked()
        publish_detection_event({"type": "pacman_stopped"})

    def force_next_turn_pacman(self) -> dict[str, Any]:
        self._wait_for_detection_zero_then_allow_next_turn()
        with self._lock:
            if self._pacman is None:
                raise ValueError("No active Pacman game")
            session = self._pacman
            session.game.complete_turn()
            session.darts_recorded_in_turn = 0
            state = session.game.get_state()
        self._request_detection_resync()
        publish_detection_event({"type": "pacman_state_updated", "source": "force_next_turn", "state": state})
        self._schedule_pacman_bot_turn_if_needed()
        return self.get_pacman_state() or state

    def get_target_trainer_state(self) -> dict[str, Any] | None:
        with self._lock:
            if self._target_trainer is None:
                return None
            session = self._target_trainer
            state = session.game.get_state()
            bot_levels = session.bot_levels or {}
            match_winner = state.get("matchWinner")
            winner = state.get("winnerIndex")
            finished = match_winner is not None or winner is not None
        for idx, player in enumerate(state.get("players", [])):
            if idx in bot_levels:
                player["isBot"] = True
                player["botLevel"] = int(bot_levels[idx])
        return self._apply_turn_input_flags(
            state=state,
            bot_turn_active=bool(session.bot_turn_active),
            bot_levels=bot_levels,
            finished=bool(finished),
        )

    def stop_target_trainer(self) -> None:
        with self._lock:
            self._stop_target_trainer_locked()
        publish_detection_event({"type": "target_trainer_stopped"})

    def force_next_turn_target_trainer(self) -> dict[str, Any]:
        self._wait_for_detection_zero_then_allow_next_turn()
        with self._lock:
            if self._target_trainer is None:
                raise ValueError("No active Target Trainer game")
            session = self._target_trainer
            session.game.complete_turn()
            session.darts_recorded_in_turn = 0
            state = session.game.get_state()
        self._request_detection_resync()
        publish_detection_event({"type": "target_trainer_state_updated", "source": "force_next_turn", "state": state})
        self._schedule_target_trainer_bot_turn_if_needed()
        return self.get_target_trainer_state() or state

    def _stop_active_locked(self) -> None:
        self._stop_x01_locked()
        self._stop_cricket_locked()
        self._stop_around_the_clock_locked()
        self._stop_shanghai_locked()
        self._stop_beer_race_locked()
        self._stop_bermuda_locked()
        self._stop_bob27_locked()
        self._stop_one_two_one_locked()
        self._stop_target_trainer_locked()
        self._stop_pacman_locked()
        self._active_mode = None

    def _stop_x01_locked(self) -> None:
        if self._x01 is not None:
            session = self._x01
            try:
                state = session.game.get_state()
                self._maybe_enqueue_x01_match_summary_locked(session, state)
            except Exception:
                pass
            session.bot_turn_token += 1
        self._x01 = None
        if self._active_mode == "x01":
            self._active_mode = None

    def _stop_cricket_locked(self) -> None:
        if self._cricket is not None:
            self._cricket.bot_turn_token += 1
        self._cricket = None
        if self._active_mode == "cricket":
            self._active_mode = None

    def _stop_around_the_clock_locked(self) -> None:
        if self._around_the_clock is not None:
            self._around_the_clock.bot_turn_token += 1
        self._around_the_clock = None
        if self._active_mode == "around_the_clock":
            self._active_mode = None

    def _stop_shanghai_locked(self) -> None:
        if self._shanghai is not None:
            self._shanghai.bot_turn_token += 1
        self._shanghai = None
        if self._active_mode == "shanghai":
            self._active_mode = None

    def _stop_beer_race_locked(self) -> None:
        if self._beer_race is not None:
            self._beer_race.bot_turn_token += 1
        self._beer_race = None
        if self._active_mode == "beer_race":
            self._active_mode = None

    def _stop_bermuda_locked(self) -> None:
        if self._bermuda is not None:
            self._bermuda.bot_turn_token += 1
        self._bermuda = None
        if self._active_mode == "bermuda":
            self._active_mode = None

    def _stop_bob27_locked(self) -> None:
        if self._bob27 is not None:
            self._bob27.bot_turn_token += 1
        self._bob27 = None
        if self._active_mode == "bob27":
            self._active_mode = None

    def _stop_one_two_one_locked(self) -> None:
        if self._one_two_one is not None:
            self._one_two_one.bot_turn_token += 1
        self._one_two_one = None
        if self._active_mode == "one_two_one":
            self._active_mode = None

    def _stop_target_trainer_locked(self) -> None:
        if self._target_trainer is not None:
            self._target_trainer.bot_turn_token += 1
        self._target_trainer = None
        if self._active_mode == "target_trainer":
            self._active_mode = None

    def _stop_pacman_locked(self) -> None:
        if self._pacman is not None:
            self._pacman.bot_turn_token += 1
        self._pacman = None
        if self._active_mode == "pacman":
            self._active_mode = None

    def _persist_x01_leg_summary_locked(self, session: X01GameSession) -> None:
        summaries = session.game.consume_leg_summary()
        if not summaries:
            return
        started_at = session.leg_started_at or self._utc_now_iso()
        finished_at = self._utc_now_iso()
        record_x01_leg_for_profiles(
            profile_ids_by_index=session.profile_ids or {},
            summaries=summaries,
            started_at=started_at,
            finished_at=finished_at,
        )
        bot_levels = session.bot_levels or {}
        player_bot_indices = set((session.player_bot_sources or {}).keys())
        for idx, level in bot_levels.items():
            if idx in player_bot_indices:
                continue
            if idx < 0 or idx >= len(summaries):
                continue
            summary = summaries[idx]
            if isinstance(summary, dict):
                record_x01_bot_leg(bot_level=int(level), summary=summary, max_legs=50)
        session.leg_started_at = finished_at

    def _persist_cricket_leg_summary_locked(self, session: CricketGameSession) -> None:
        summaries = session.game.consume_leg_summary()
        if not summaries:
            return
        started_at = session.leg_started_at or self._utc_now_iso()
        finished_at = self._utc_now_iso()
        record_cricket_leg_for_profiles(
            profile_ids_by_index=session.profile_ids or {},
            summaries=summaries,
            started_at=started_at,
            finished_at=finished_at,
        )
        session.leg_started_at = finished_at

    def _persist_around_the_clock_leg_summary_locked(self, session: AroundTheClockGameSession) -> None:
        summaries = session.game.consume_leg_summary()
        if not summaries:
            return
        started_at = session.leg_started_at or self._utc_now_iso()
        finished_at = self._utc_now_iso()
        record_around_the_clock_leg_for_profiles(
            profile_ids_by_index=session.profile_ids or {},
            summaries=summaries,
            started_at=started_at,
            finished_at=finished_at,
        )
        session.leg_started_at = finished_at

    def _handle_detection_event(self, event: dict[str, Any]) -> None:
        event_type = str(event.get("type", ""))
        if event_type == "dart_score":
            self._handle_dart_score(event)
        elif event_type == "dart_score_unavailable":
            self._handle_dart_score_unavailable(event)
        elif event_type == "dart_score_corrected":
            self._handle_dart_score_corrected(event)
        elif event_type == "takeout_complete":
            self._handle_takeout_complete()

    def _is_bot_turn_active_locked(self) -> bool:
        mode = self._active_mode
        if mode == "x01":
            return bool(self._x01 and self._x01.bot_turn_active)
        if mode == "cricket":
            return bool(self._cricket and self._cricket.bot_turn_active)
        if mode == "around_the_clock":
            return bool(self._around_the_clock and self._around_the_clock.bot_turn_active)
        if mode == "shanghai":
            return bool(self._shanghai and self._shanghai.bot_turn_active)
        if mode == "beer_race":
            return bool(self._beer_race and self._beer_race.bot_turn_active)
        if mode == "bermuda":
            return bool(self._bermuda and self._bermuda.bot_turn_active)
        if mode == "bob27":
            return bool(self._bob27 and self._bob27.bot_turn_active)
        if mode == "one_two_one":
            return bool(self._one_two_one and self._one_two_one.bot_turn_active)
        if mode == "target_trainer":
            return bool(self._target_trainer and self._target_trainer.bot_turn_active)
        if mode == "pacman":
            return bool(self._pacman and self._pacman.bot_turn_active)
        return False

    @staticmethod
    def _x01_local_detection_allowed(session: X01GameSession) -> bool:
        if session.local_input_player_index is None:
            return True
        state = session.game.get_state()
        current_player = state.get("currentPlayer")
        if current_player is None:
            return False
        try:
            return int(current_player) == int(session.local_input_player_index)
        except Exception:
            return False

    def _handle_dart_score(self, event: dict[str, Any]) -> None:
        ignored = False
        ignored_mode: str | None = None
        ignored_source = "bot_turn_active"
        with self._lock:
            mode = self._active_mode
            if self._is_bot_turn_active_locked():
                ignored = True
                ignored_mode = mode
            else:
                score_value = int(event.get("score_value", 0) or 0)
                score_payload = _normalize_score_payload(event.get("score"), score_value)
                if mode == "x01" and self._x01 is not None:
                    session = self._x01
                    if not self._x01_local_detection_allowed(session):
                        ignored = True
                        ignored_mode = mode
                        ignored_source = "remote_player_turn"
                    elif session.darts_recorded_in_turn >= 3:
                        return
                    else:
                        dart_index = session.darts_recorded_in_turn
                        session.game.record_dart(dart_index, score_payload)
                        session.darts_recorded_in_turn += 1
                        state = session.game.get_state()
                        self._trigger_x01_live_wled(session, state)
                        publish_type = "x01_state_updated"
                        source = "dart_score"
                elif mode == "cricket" and self._cricket is not None:
                    session = self._cricket
                    if session.darts_recorded_in_turn >= 3:
                        return
                    dart_index = session.darts_recorded_in_turn
                    session.game.record_dart(dart_index, score_payload)
                    session.darts_recorded_in_turn += 1
                    state = session.game.get_state()
                    publish_type = "cricket_state_updated"
                    source = "dart_score"
                elif mode == "around_the_clock" and self._around_the_clock is not None:
                    session = self._around_the_clock
                    if session.darts_recorded_in_turn >= 3:
                        return
                    dart_index = session.darts_recorded_in_turn
                    session.game.record_dart(dart_index, score_payload)
                    session.darts_recorded_in_turn += 1
                    state = session.game.get_state()
                    publish_type = "around_the_clock_state_updated"
                    source = "dart_score"
                elif mode == "shanghai" and self._shanghai is not None:
                    session = self._shanghai
                    if session.darts_recorded_in_turn >= 3:
                        return
                    dart_index = session.darts_recorded_in_turn
                    session.game.record_dart(dart_index, score_payload)
                    session.darts_recorded_in_turn += 1
                    state = session.game.get_state()
                    publish_type = "shanghai_state_updated"
                    source = "dart_score"
                elif mode == "beer_race" and self._beer_race is not None:
                    session = self._beer_race
                    if session.darts_recorded_in_turn >= 3:
                        return
                    dart_index = session.darts_recorded_in_turn
                    session.game.record_dart(dart_index, score_payload)
                    session.darts_recorded_in_turn += 1
                    state = session.game.get_state()
                    publish_type = "beer_race_state_updated"
                    source = "dart_score"
                elif mode == "bermuda" and self._bermuda is not None:
                    session = self._bermuda
                    if session.darts_recorded_in_turn >= 3:
                        return
                    dart_index = session.darts_recorded_in_turn
                    session.game.record_dart(dart_index, score_payload)
                    session.darts_recorded_in_turn += 1
                    state = session.game.get_state()
                    publish_type = "bermuda_state_updated"
                    source = "dart_score"
                elif mode == "bob27" and self._bob27 is not None:
                    session = self._bob27
                    if session.darts_recorded_in_turn >= 3:
                        return
                    dart_index = session.darts_recorded_in_turn
                    session.game.record_dart(dart_index, score_payload)
                    session.darts_recorded_in_turn += 1
                    state = session.game.get_state()
                    publish_type = "bob27_state_updated"
                    source = "dart_score"
                elif mode == "one_two_one" and self._one_two_one is not None:
                    session = self._one_two_one
                    if session.darts_recorded_in_turn >= 3:
                        return
                    dart_index = session.darts_recorded_in_turn
                    session.game.record_dart(dart_index, score_payload)
                    session.darts_recorded_in_turn += 1
                    state = session.game.get_state()
                    publish_type = "one_two_one_state_updated"
                    source = "dart_score"
                elif mode == "target_trainer" and self._target_trainer is not None:
                    session = self._target_trainer
                    if session.darts_recorded_in_turn >= 3:
                        return
                    dart_index = session.darts_recorded_in_turn
                    session.game.record_dart(dart_index, score_payload)
                    session.darts_recorded_in_turn += 1
                    state = session.game.get_state()
                    publish_type = "target_trainer_state_updated"
                    source = "dart_score"
                elif mode == "pacman" and self._pacman is not None:
                    session = self._pacman
                    if session.darts_recorded_in_turn >= 3:
                        return
                    dart_index = session.darts_recorded_in_turn
                    session.game.record_dart(dart_index, score_payload)
                    session.darts_recorded_in_turn += 1
                    state = session.game.get_state()
                    publish_type = "pacman_state_updated"
                    source = "dart_score"
                else:
                    return

        if ignored:
            self._request_detection_resync()
            publish_detection_event(
                {
                    "type": "dart_score_ignored",
                    "source": ignored_source,
                    "mode": ignored_mode,
                    "resync_requested": True,
                }
            )
            return

        publish_detection_event(
            {
                "type": publish_type,
                "source": source,
                "dart_index": dart_index,
                "state": state,
            }
        )

    def _handle_takeout_complete(self) -> None:
        with self._lock:
            mode = self._active_mode
            if mode == "x01" and self._x01 is not None:
                session = self._x01
                if session.darts_recorded_in_turn <= 0:
                    return
                bot_levels = dict(session.bot_levels or {})
                session.game.complete_turn()
                self._persist_x01_leg_summary_locked(session)
                session.darts_recorded_in_turn = 0
                state = session.game.get_state()
                self._trigger_x01_turn_wled(state)
                self._maybe_enqueue_x01_match_summary_locked(session, state)
                publish_type = "x01_state_updated"
            elif mode == "cricket" and self._cricket is not None:
                session = self._cricket
                if session.darts_recorded_in_turn <= 0:
                    return
                session.game.complete_turn()
                self._persist_cricket_leg_summary_locked(session)
                session.darts_recorded_in_turn = 0
                state = session.game.get_state()
                publish_type = "cricket_state_updated"
            elif mode == "around_the_clock" and self._around_the_clock is not None:
                session = self._around_the_clock
                if session.darts_recorded_in_turn <= 0:
                    return
                session.game.complete_turn()
                self._persist_around_the_clock_leg_summary_locked(session)
                session.darts_recorded_in_turn = 0
                state = session.game.get_state()
                publish_type = "around_the_clock_state_updated"
            elif mode == "shanghai" and self._shanghai is not None:
                session = self._shanghai
                if session.darts_recorded_in_turn <= 0:
                    return
                session.game.complete_turn()
                session.darts_recorded_in_turn = 0
                state = session.game.get_state()
                publish_type = "shanghai_state_updated"
            elif mode == "beer_race" and self._beer_race is not None:
                session = self._beer_race
                if session.darts_recorded_in_turn <= 0:
                    return
                session.game.complete_turn()
                session.darts_recorded_in_turn = 0
                state = session.game.get_state()
                publish_type = "beer_race_state_updated"
            elif mode == "bermuda" and self._bermuda is not None:
                session = self._bermuda
                if session.darts_recorded_in_turn <= 0:
                    return
                session.game.complete_turn()
                session.darts_recorded_in_turn = 0
                state = session.game.get_state()
                publish_type = "bermuda_state_updated"
            elif mode == "bob27" and self._bob27 is not None:
                session = self._bob27
                if session.darts_recorded_in_turn <= 0:
                    return
                session.game.complete_turn()
                session.darts_recorded_in_turn = 0
                state = session.game.get_state()
                publish_type = "bob27_state_updated"
            elif mode == "one_two_one" and self._one_two_one is not None:
                session = self._one_two_one
                if session.darts_recorded_in_turn <= 0:
                    return
                session.game.complete_turn()
                session.darts_recorded_in_turn = 0
                state = session.game.get_state()
                publish_type = "one_two_one_state_updated"
            elif mode == "target_trainer" and self._target_trainer is not None:
                session = self._target_trainer
                if session.darts_recorded_in_turn <= 0:
                    return
                session.game.complete_turn()
                session.darts_recorded_in_turn = 0
                state = session.game.get_state()
                publish_type = "target_trainer_state_updated"
            elif mode == "pacman" and self._pacman is not None:
                session = self._pacman
                if session.darts_recorded_in_turn <= 0:
                    return
                session.game.complete_turn()
                session.darts_recorded_in_turn = 0
                state = session.game.get_state()
                publish_type = "pacman_state_updated"
            else:
                return

        if mode == "x01":
            self._mark_x01_player_replay_turn_from_state(state=state, bot_levels=bot_levels)
        publish_detection_event(
            {
                "type": publish_type,
                "source": "takeout_complete",
                "state": state,
            }
        )
        if mode == "x01":
            self._schedule_x01_bot_turn_if_needed()
        elif mode == "cricket":
            self._schedule_cricket_bot_turn_if_needed()
        elif mode == "around_the_clock":
            self._schedule_around_the_clock_bot_turn_if_needed()
        elif mode == "shanghai":
            self._schedule_shanghai_bot_turn_if_needed()
        elif mode == "beer_race":
            self._schedule_beer_race_bot_turn_if_needed()
        elif mode == "bermuda":
            self._schedule_bermuda_bot_turn_if_needed()
        elif mode == "bob27":
            self._schedule_bob27_bot_turn_if_needed()
        elif mode == "one_two_one":
            self._schedule_one_two_one_bot_turn_if_needed()
        elif mode == "target_trainer":
            self._schedule_target_trainer_bot_turn_if_needed()
        elif mode == "pacman":
            self._schedule_pacman_bot_turn_if_needed()

    def _handle_dart_score_unavailable(self, event: dict[str, Any]) -> None:
        ignored = False
        ignored_mode: str | None = None
        ignored_source = "bot_turn_active"
        with self._lock:
            mode = self._active_mode
            if self._is_bot_turn_active_locked():
                ignored = True
                ignored_mode = mode
            elif mode == "x01" and self._x01 is not None:
                session = self._x01
                if not self._x01_local_detection_allowed(session):
                    ignored = True
                    ignored_mode = mode
                    ignored_source = "remote_player_turn"
                elif session.darts_recorded_in_turn >= 3:
                    return
                else:
                    dart_index = session.darts_recorded_in_turn
                    score_payload = {
                        "score": 0,
                        "multiplier": 0,
                        "segment": "0",
                        "zone": "miss",
                        "confidence": 0.0,
                    }
                    session.game.record_dart(dart_index, score_payload)
                    session.darts_recorded_in_turn += 1
                    state = session.game.get_state()
                    publish_type = "x01_state_updated"
            elif mode == "cricket" and self._cricket is not None:
                session = self._cricket
                if session.darts_recorded_in_turn >= 3:
                    return
                dart_index = session.darts_recorded_in_turn
                score_payload = {
                    "score": 0,
                    "multiplier": 0,
                    "segment": "0",
                    "zone": "miss",
                    "confidence": 0.0,
                }
                session.game.record_dart(dart_index, score_payload)
                session.darts_recorded_in_turn += 1
                state = session.game.get_state()
                publish_type = "cricket_state_updated"
            elif mode == "around_the_clock" and self._around_the_clock is not None:
                session = self._around_the_clock
                if session.darts_recorded_in_turn >= 3:
                    return
                dart_index = session.darts_recorded_in_turn
                score_payload = {
                    "score": 0,
                    "multiplier": 0,
                    "segment": "0",
                    "zone": "miss",
                    "confidence": 0.0,
                }
                session.game.record_dart(dart_index, score_payload)
                session.darts_recorded_in_turn += 1
                state = session.game.get_state()
                publish_type = "around_the_clock_state_updated"
            elif mode == "shanghai" and self._shanghai is not None:
                session = self._shanghai
                if session.darts_recorded_in_turn >= 3:
                    return
                dart_index = session.darts_recorded_in_turn
                score_payload = {
                    "score": 0,
                    "multiplier": 0,
                    "segment": "0",
                    "zone": "miss",
                    "confidence": 0.0,
                }
                session.game.record_dart(dart_index, score_payload)
                session.darts_recorded_in_turn += 1
                state = session.game.get_state()
                publish_type = "shanghai_state_updated"
            elif mode == "beer_race" and self._beer_race is not None:
                session = self._beer_race
                if session.darts_recorded_in_turn >= 3:
                    return
                dart_index = session.darts_recorded_in_turn
                score_payload = {
                    "score": 0,
                    "multiplier": 0,
                    "segment": "0",
                    "zone": "miss",
                    "confidence": 0.0,
                }
                session.game.record_dart(dart_index, score_payload)
                session.darts_recorded_in_turn += 1
                state = session.game.get_state()
                publish_type = "beer_race_state_updated"
            elif mode == "bermuda" and self._bermuda is not None:
                session = self._bermuda
                if session.darts_recorded_in_turn >= 3:
                    return
                dart_index = session.darts_recorded_in_turn
                score_payload = {
                    "score": 0,
                    "multiplier": 0,
                    "segment": "0",
                    "zone": "miss",
                    "confidence": 0.0,
                }
                session.game.record_dart(dart_index, score_payload)
                session.darts_recorded_in_turn += 1
                state = session.game.get_state()
                publish_type = "bermuda_state_updated"
            elif mode == "bob27" and self._bob27 is not None:
                session = self._bob27
                if session.darts_recorded_in_turn >= 3:
                    return
                dart_index = session.darts_recorded_in_turn
                score_payload = {
                    "score": 0,
                    "multiplier": 0,
                    "segment": "0",
                    "zone": "miss",
                    "confidence": 0.0,
                }
                session.game.record_dart(dart_index, score_payload)
                session.darts_recorded_in_turn += 1
                state = session.game.get_state()
                publish_type = "bob27_state_updated"
            elif mode == "one_two_one" and self._one_two_one is not None:
                session = self._one_two_one
                if session.darts_recorded_in_turn >= 3:
                    return
                dart_index = session.darts_recorded_in_turn
                score_payload = {
                    "score": 0,
                    "multiplier": 0,
                    "segment": "0",
                    "zone": "miss",
                    "confidence": 0.0,
                }
                session.game.record_dart(dart_index, score_payload)
                session.darts_recorded_in_turn += 1
                state = session.game.get_state()
                publish_type = "one_two_one_state_updated"
            elif mode == "target_trainer" and self._target_trainer is not None:
                session = self._target_trainer
                if session.darts_recorded_in_turn >= 3:
                    return
                dart_index = session.darts_recorded_in_turn
                score_payload = {
                    "score": 0,
                    "multiplier": 0,
                    "segment": "0",
                    "zone": "miss",
                    "confidence": 0.0,
                }
                session.game.record_dart(dart_index, score_payload)
                session.darts_recorded_in_turn += 1
                state = session.game.get_state()
                publish_type = "target_trainer_state_updated"
            elif mode == "pacman" and self._pacman is not None:
                session = self._pacman
                if session.darts_recorded_in_turn >= 3:
                    return
                dart_index = session.darts_recorded_in_turn
                score_payload = {
                    "score": 0,
                    "multiplier": 0,
                    "segment": "0",
                    "zone": "miss",
                    "confidence": 0.0,
                }
                session.game.record_dart(dart_index, score_payload)
                session.darts_recorded_in_turn += 1
                state = session.game.get_state()
                publish_type = "pacman_state_updated"
            else:
                return

        if ignored:
            self._request_detection_resync()
            publish_detection_event(
                {
                    "type": "dart_score_unavailable_ignored",
                    "source": ignored_source,
                    "mode": ignored_mode,
                    "resync_requested": True,
                }
            )
            return

        publish_detection_event(
            {
                "type": publish_type,
                "source": "dart_score_unavailable",
                "reason": str(event.get("reason", "unknown") or "unknown"),
                "treated_as_miss": True,
                "dart_index": dart_index,
                "state": state,
            }
        )

    def _handle_dart_score_corrected(self, event: dict[str, Any]) -> None:
        with self._lock:
            mode = self._active_mode
            dart_index = int(event.get("dart_index", -1))
            if dart_index < 0 or dart_index >= 3:
                return
            is_bouncer = bool(event.get("bouncer", False))

            corrected_score = dict(event.get("corrected_score") or {})
            if not corrected_score:
                corrected_score = {
                    "score": int(event.get("corrected_score_value", 0) or 0),
                    "multiplier": 0,
                    "segment": "0",
                    "zone": "miss",
                    "confidence": 1.0,
                }

            if mode == "x01" and self._x01 is not None:
                session = self._x01
                session.corrections_applied += 1
                try:
                    current_turn = session.game.get_state().get("currentTurn", {}) or {}
                    existing_darts = current_turn.get("darts", []) if isinstance(current_turn, dict) else []
                    existing = existing_darts[dart_index] if isinstance(existing_darts, list) and dart_index < len(existing_darts) else None
                    if isinstance(existing, dict):
                        for key in ("boardX", "boardY", "boardDisplayX", "boardDisplayY", "boardRotationDeg", "board"):
                            if key in existing and key not in corrected_score:
                                corrected_score[key] = copy.deepcopy(existing[key])
                except Exception:
                    pass
                session.game.record_dart(dart_index, corrected_score)
                session.darts_recorded_in_turn = max(session.darts_recorded_in_turn, dart_index + 1)
                state = session.game.get_state()
                publish_type = "x01_state_updated"
            elif mode == "cricket" and self._cricket is not None:
                session = self._cricket
                session.game.record_dart(dart_index, corrected_score)
                session.darts_recorded_in_turn = max(session.darts_recorded_in_turn, dart_index + 1)
                state = session.game.get_state()
                publish_type = "cricket_state_updated"
            elif mode == "around_the_clock" and self._around_the_clock is not None:
                session = self._around_the_clock
                session.game.record_dart(dart_index, corrected_score)
                session.darts_recorded_in_turn = max(session.darts_recorded_in_turn, dart_index + 1)
                state = session.game.get_state()
                publish_type = "around_the_clock_state_updated"
            elif mode == "shanghai" and self._shanghai is not None:
                session = self._shanghai
                session.game.record_dart(dart_index, corrected_score)
                session.darts_recorded_in_turn = max(session.darts_recorded_in_turn, dart_index + 1)
                state = session.game.get_state()
                publish_type = "shanghai_state_updated"
            elif mode == "beer_race" and self._beer_race is not None:
                session = self._beer_race
                session.game.record_dart(dart_index, corrected_score)
                session.darts_recorded_in_turn = max(session.darts_recorded_in_turn, dart_index + 1)
                state = session.game.get_state()
                publish_type = "beer_race_state_updated"
            elif mode == "bermuda" and self._bermuda is not None:
                session = self._bermuda
                session.game.record_dart(dart_index, corrected_score)
                session.darts_recorded_in_turn = max(session.darts_recorded_in_turn, dart_index + 1)
                state = session.game.get_state()
                publish_type = "bermuda_state_updated"
            elif mode == "bob27" and self._bob27 is not None:
                session = self._bob27
                session.game.record_dart(dart_index, corrected_score)
                session.darts_recorded_in_turn = max(session.darts_recorded_in_turn, dart_index + 1)
                state = session.game.get_state()
                publish_type = "bob27_state_updated"
            elif mode == "one_two_one" and self._one_two_one is not None:
                session = self._one_two_one
                session.game.record_dart(dart_index, corrected_score)
                session.darts_recorded_in_turn = max(session.darts_recorded_in_turn, dart_index + 1)
                state = session.game.get_state()
                publish_type = "one_two_one_state_updated"
            elif mode == "target_trainer" and self._target_trainer is not None:
                session = self._target_trainer
                session.game.record_dart(dart_index, corrected_score)
                session.darts_recorded_in_turn = max(session.darts_recorded_in_turn, dart_index + 1)
                state = session.game.get_state()
                publish_type = "target_trainer_state_updated"
            elif mode == "pacman" and self._pacman is not None:
                session = self._pacman
                session.game.record_dart(dart_index, corrected_score)
                session.darts_recorded_in_turn = max(session.darts_recorded_in_turn, dart_index + 1)
                state = session.game.get_state()
                publish_type = "pacman_state_updated"
            else:
                return

        try:
            current_turn = dict(state.get("currentTurn", {}) or {})
            turn_darts = current_turn.get("darts", []) if isinstance(current_turn, dict) else []
            manual_turn_darts = int(sum(1 for d in (turn_darts or []) if d is not None))
        except Exception:
            manual_turn_darts = int(max(0, dart_index + 1))

        # Keep UI dart counter aligned with backend turn truth after manual add/correction.
        publish_detection_event(
            {
                "type": "detection_status_update",
                "source": "manual_score_sync",
                "dart_count": int(manual_turn_darts),
            }
        )
        try:
            from backend.core.detection.dartcounter import request_detection_dart_count_sync

            request_detection_dart_count_sync(int(manual_turn_darts))
        except Exception:
            pass
        publish_detection_event(
            {
                "type": publish_type,
                "source": "dart_score_corrected",
                "bouncer": is_bouncer,
                "dart_index": dart_index,
                "state": state,
            }
        )


    def get_bot_speed(self) -> str:
        with self._lock:
            return self._bot_speed

    def set_bot_speed(self, speed: str) -> str:
        normalized = str(speed or "normal").strip().lower()
        if normalized not in self._BOT_SPEED_DELAYS:
            raise ValueError("speed must be one of: slow, normal, fast")
        with self._lock:
            self._bot_speed = normalized
            _save_game_settings({"bot_speed": normalized})
        return normalized

    def _schedule_x01_bot_turn_if_needed(self) -> None:
        with self._lock:
            if self._active_mode != "x01" or self._x01 is None:
                return
            session = self._x01
            state = session.game.get_state()
            current_player = state.get("currentPlayer")
            match_winner = state.get("matchWinner")
            winner = state.get("winner")
            bot_levels = session.bot_levels or {}

            if session.bot_turn_active:
                return
            if match_winner is not None or winner is not None:
                return
            if current_player is None or int(current_player) not in bot_levels:
                return

            session.bot_turn_active = True
            session.bot_turn_token += 1
            token = session.bot_turn_token

        worker = threading.Thread(target=self._run_x01_bot_turns, args=(token,), name="x01-bot-turn", daemon=True)
        worker.start()

    def _schedule_cricket_bot_turn_if_needed(self) -> None:
        with self._lock:
            if self._active_mode != "cricket" or self._cricket is None:
                return
            session = self._cricket
            state = session.game.get_state()
            current_player = state.get("currentPlayer")
            match_info = state.get("match", {}) or {}
            match_winner = match_info.get("matchWinner")
            winner = state.get("winner")
            bot_levels = session.bot_levels or {}

            if session.bot_turn_active:
                return
            if match_winner is not None or winner is not None:
                return
            if current_player is None or int(current_player) not in bot_levels:
                return

            session.bot_turn_active = True
            session.bot_turn_token += 1
            token = session.bot_turn_token

        worker = threading.Thread(target=self._run_cricket_bot_turns, args=(token,), name="cricket-bot-turn", daemon=True)
        worker.start()

    def _schedule_around_the_clock_bot_turn_if_needed(self) -> None:
        with self._lock:
            if self._active_mode != "around_the_clock" or self._around_the_clock is None:
                return
            session = self._around_the_clock
            state = session.game.get_state()
            current_player = state.get("currentPlayer")
            match_info = state.get("match", {}) or {}
            match_winner = match_info.get("matchWinner")
            winner = state.get("winner")
            bot_levels = session.bot_levels or {}

            if session.bot_turn_active:
                return
            if match_winner is not None or winner is not None:
                return
            if current_player is None or int(current_player) not in bot_levels:
                return

            session.bot_turn_active = True
            session.bot_turn_token += 1
            token = session.bot_turn_token

        worker = threading.Thread(target=self._run_around_the_clock_bot_turns, args=(token,), name="around-the-clock-bot-turn", daemon=True)
        worker.start()

    def _schedule_shanghai_bot_turn_if_needed(self) -> None:
        with self._lock:
            if self._active_mode != "shanghai" or self._shanghai is None:
                return
            session = self._shanghai
            state = session.game.get_state()
            current_player = state.get("currentPlayer")
            match_winner = state.get("matchWinnerIndex")
            winner = state.get("winnerIndex")
            bot_levels = session.bot_levels or {}

            if session.bot_turn_active:
                return
            if match_winner is not None or winner is not None:
                return
            if current_player is None or int(current_player) not in bot_levels:
                return

            session.bot_turn_active = True
            session.bot_turn_token += 1
            token = session.bot_turn_token

        worker = threading.Thread(target=self._run_shanghai_bot_turns, args=(token,), name="shanghai-bot-turn", daemon=True)
        worker.start()

    def _schedule_beer_race_bot_turn_if_needed(self) -> None:
        with self._lock:
            if self._active_mode != "beer_race" or self._beer_race is None:
                return
            session = self._beer_race
            state = session.game.get_state()
            current_player = state.get("currentPlayer")
            match_winner = state.get("matchWinnerIndex")
            winner = state.get("winnerIndex")
            bot_levels = session.bot_levels or {}
            if session.bot_turn_active or match_winner is not None or winner is not None:
                return
            if current_player is None or int(current_player) not in bot_levels:
                return
            session.bot_turn_active = True
            session.bot_turn_token += 1
            token = session.bot_turn_token
        threading.Thread(target=self._run_beer_race_bot_turns, args=(token,), name="beer-race-bot-turn", daemon=True).start()

    def _schedule_bermuda_bot_turn_if_needed(self) -> None:
        with self._lock:
            if self._active_mode != "bermuda" or self._bermuda is None:
                return
            session = self._bermuda
            state = session.game.get_state()
            current_player = state.get("currentPlayer")
            match_winner = state.get("matchWinnerIndex")
            bot_levels = session.bot_levels or {}
            if session.bot_turn_active or match_winner is not None:
                return
            if current_player is None or int(current_player) not in bot_levels:
                return
            session.bot_turn_active = True
            session.bot_turn_token += 1
            token = session.bot_turn_token
        threading.Thread(target=self._run_bermuda_bot_turns, args=(token,), name="bermuda-bot-turn", daemon=True).start()

    def _schedule_bob27_bot_turn_if_needed(self) -> None:
        with self._lock:
            if self._active_mode != "bob27" or self._bob27 is None:
                return
            session = self._bob27
            state = session.game.get_state()
            current_player = state.get("currentPlayer")
            match_winner = state.get("matchWinnerIndex")
            bot_levels = session.bot_levels or {}
            if session.bot_turn_active or match_winner is not None:
                return
            if current_player is None or int(current_player) not in bot_levels:
                return
            session.bot_turn_active = True
            session.bot_turn_token += 1
            token = session.bot_turn_token
        threading.Thread(target=self._run_bob27_bot_turns, args=(token,), name="bob27-bot-turn", daemon=True).start()

    def _schedule_target_trainer_bot_turn_if_needed(self) -> None:
        with self._lock:
            if self._active_mode != "target_trainer" or self._target_trainer is None:
                return
            session = self._target_trainer
            state = session.game.get_state()
            current_player = state.get("currentPlayer")
            match_winner = state.get("matchWinner")
            winner = state.get("winnerIndex")
            bot_levels = session.bot_levels or {}
            if session.bot_turn_active or match_winner is not None or winner is not None:
                return
            if current_player is None or int(current_player) not in bot_levels:
                return
            session.bot_turn_active = True
            session.bot_turn_token += 1
            token = session.bot_turn_token
        threading.Thread(target=self._run_target_trainer_bot_turns, args=(token,), name="target-trainer-bot-turn", daemon=True).start()

    def _schedule_one_two_one_bot_turn_if_needed(self) -> None:
        with self._lock:
            if self._active_mode != "one_two_one" or self._one_two_one is None:
                return
            session = self._one_two_one
            state = session.game.get_state()
            current_player = state.get("currentPlayer")
            match_info = state.get("match", {}) or {}
            match_winner = match_info.get("matchWinner")
            winner = state.get("winnerIndex")
            bot_levels = session.bot_levels or {}
            if session.bot_turn_active or match_winner is not None or winner is not None:
                return
            if current_player is None or int(current_player) not in bot_levels:
                return
            session.bot_turn_active = True
            session.bot_turn_token += 1
            token = session.bot_turn_token
        threading.Thread(target=self._run_one_two_one_bot_turns, args=(token,), name="one-two-one-bot-turn", daemon=True).start()

    def _schedule_pacman_bot_turn_if_needed(self) -> None:
        with self._lock:
            if self._active_mode != "pacman" or self._pacman is None:
                return
            session = self._pacman
            state = session.game.get_state()
            current_player = state.get("currentPlayer")
            match_info = state.get("match", {}) or {}
            match_winner = match_info.get("matchWinner")
            winner = state.get("winnerIndex")
            bot_levels = session.bot_levels or {}
            if session.bot_turn_active or match_winner is not None or winner is not None:
                return
            if current_player is None or int(current_player) not in bot_levels:
                return
            session.bot_turn_active = True
            session.bot_turn_token += 1
            token = session.bot_turn_token
        threading.Thread(target=self._run_pacman_bot_turns, args=(token,), name="pacman-bot-turn", daemon=True).start()

    def _clear_x01_bot_turn_active(self, token: int) -> None:
        with self._lock:
            if self._x01 is None:
                return
            if self._x01.bot_turn_token == token:
                self._x01.bot_turn_active = False

    def _clear_cricket_bot_turn_active(self, token: int) -> None:
        with self._lock:
            if self._cricket is None:
                return
            if self._cricket.bot_turn_token == token:
                self._cricket.bot_turn_active = False

    def _clear_around_the_clock_bot_turn_active(self, token: int) -> None:
        with self._lock:
            if self._around_the_clock is None:
                return
            if self._around_the_clock.bot_turn_token == token:
                self._around_the_clock.bot_turn_active = False

    def _clear_shanghai_bot_turn_active(self, token: int) -> None:
        with self._lock:
            if self._shanghai is None:
                return
            if self._shanghai.bot_turn_token == token:
                self._shanghai.bot_turn_active = False

    def _clear_beer_race_bot_turn_active(self, token: int) -> None:
        with self._lock:
            if self._beer_race is None:
                return
            if self._beer_race.bot_turn_token == token:
                self._beer_race.bot_turn_active = False

    def _clear_bermuda_bot_turn_active(self, token: int) -> None:
        with self._lock:
            if self._bermuda is None:
                return
            if self._bermuda.bot_turn_token == token:
                self._bermuda.bot_turn_active = False

    def _clear_bob27_bot_turn_active(self, token: int) -> None:
        with self._lock:
            if self._bob27 is None:
                return
            if self._bob27.bot_turn_token == token:
                self._bob27.bot_turn_active = False

    def _clear_target_trainer_bot_turn_active(self, token: int) -> None:
        with self._lock:
            if self._target_trainer is None:
                return
            if self._target_trainer.bot_turn_token == token:
                self._target_trainer.bot_turn_active = False

    def _clear_one_two_one_bot_turn_active(self, token: int) -> None:
        with self._lock:
            if self._one_two_one is None:
                return
            if self._one_two_one.bot_turn_token == token:
                self._one_two_one.bot_turn_active = False

    def _clear_pacman_bot_turn_active(self, token: int) -> None:
        with self._lock:
            if self._pacman is None:
                return
            if self._pacman.bot_turn_token == token:
                self._pacman.bot_turn_active = False

    @staticmethod
    def _payload_for_legacy_visit_score(value: int) -> dict[str, Any]:
        score = max(0, int(value or 0))
        if score == 0:
            return {"score": 0, "multiplier": 1, "segment": "0", "zone": "single", "confidence": 1.0}
        if score == 60:
            return {"score": 60, "multiplier": 3, "segment": "20", "zone": "triple", "confidence": 1.0}
        if score == 57:
            return {"score": 57, "multiplier": 3, "segment": "19", "zone": "triple", "confidence": 1.0}
        if score == 54:
            return {"score": 54, "multiplier": 3, "segment": "18", "zone": "triple", "confidence": 1.0}
        if score == 50:
            return {"score": 50, "multiplier": 2, "segment": "25", "zone": "inner_bull", "confidence": 1.0}
        if score == 25:
            return {"score": 25, "multiplier": 1, "segment": "25", "zone": "outer_bull", "confidence": 1.0}
        if 1 <= score <= 20:
            return {"score": score, "multiplier": 1, "segment": str(score), "zone": "single", "confidence": 1.0}
        if score % 3 == 0 and 1 <= (score // 3) <= 20:
            return {"score": score, "multiplier": 3, "segment": str(score // 3), "zone": "triple", "confidence": 1.0}
        if score % 2 == 0 and 1 <= (score // 2) <= 20:
            return {"score": score, "multiplier": 2, "segment": str(score // 2), "zone": "double", "confidence": 1.0}
        return {"score": score, "multiplier": 1, "segment": str(score), "zone": "single", "confidence": 1.0}

    @classmethod
    def _legacy_visit_to_darts(cls, visit_score: Any) -> list[dict[str, Any]]:
        try:
            remaining = max(0, int(visit_score or 0))
        except Exception:
            remaining = 0
        if remaining <= 0:
            return []
        return [cls._payload_for_legacy_visit_score(remaining)]

    @staticmethod
    def _extract_player_bot_turns(record: dict[str, Any]) -> list[list[dict[str, Any]]]:
        summary = record.get("summary") if isinstance(record, dict) else None
        if not isinstance(summary, dict):
            return []
        raw_turns = summary.get("turnDarts")
        if not isinstance(raw_turns, list):
            # Backward compatibility for older history entries.
            raw_scores = summary.get("turnAppliedScores")
            if isinstance(raw_scores, list):
                converted_turns: list[list[dict[str, Any]]] = []
                for score_turn in raw_scores:
                    if not isinstance(score_turn, list):
                        continue
                    darts: list[dict[str, Any]] = []
                    for score in score_turn:
                        try:
                            value = int(score or 0)
                        except Exception:
                            value = 0
                        if value <= 0:
                            continue
                        darts.append(GameService._payload_for_legacy_visit_score(value))
                    if darts:
                        converted_turns.append(darts)
                if converted_turns:
                    return converted_turns
            raw_visits = summary.get("visits")
            if not isinstance(raw_visits, list):
                return []
            converted_turns = []
            for visit_score in raw_visits:
                darts = GameService._legacy_visit_to_darts(visit_score)
                if darts:
                    converted_turns.append(darts)
            return converted_turns
        turns: list[list[dict[str, Any]]] = []
        for raw_turn in raw_turns:
            if not isinstance(raw_turn, list):
                continue
            darts: list[dict[str, Any]] = []
            for dart in raw_turn:
                if not isinstance(dart, dict):
                    continue
                payload = dict(dart)
                payload["score"] = int(payload.get("score", 0) or 0)
                payload["multiplier"] = int(payload.get("multiplier", 1) or 1)
                payload["segment"] = str(payload.get("segment", "0"))
                payload["zone"] = str(payload.get("zone", "single") or "single")
                payload["confidence"] = float(payload.get("confidence", 1.0) or 1.0)
                darts.append(payload)
            if darts:
                turns.append(darts)
        return turns

    def _resolve_x01_player_bot_turn(
        self,
        *,
        session: X01GameSession,
        player_index: int,
        state: dict[str, Any],
    ) -> list[dict[str, Any]]:
        won_legs_by_player = session.player_bot_won_legs or {}
        won_legs = won_legs_by_player.get(player_index) or []
        if not won_legs:
            return []

        match = state.get("match", {}) or {}
        leg_key = f"{match.get('currentSet', 1)}:{match.get('currentLeg', 1)}"

        replay_state_map = session.player_bot_replay_state or {}
        replay_state = replay_state_map.get(player_index) or {}
        turns = replay_state.get("turns")
        turn_index = int(replay_state.get("turnIndex", 0) or 0)

        if replay_state.get("legKey") != leg_key or not isinstance(turns, list) or not turns:
            turns = []
            selected_record_index: int | None = None
            last_record_index = replay_state.get("recordIndex")
            try:
                last_record_index_int = int(last_record_index) if last_record_index is not None else None
            except Exception:
                last_record_index_int = None
            candidate_indices = list(range(len(won_legs)))
            if (
                len(candidate_indices) > 1
                and last_record_index_int is not None
                and 0 <= last_record_index_int < len(won_legs)
            ):
                # Keep true random behavior, but avoid immediate same-leg repeat.
                candidate_indices = [i for i in candidate_indices if i != last_record_index_int]

            if candidate_indices:
                candidate_idx = int(random.choice(candidate_indices))
                candidate_turns = self._extract_player_bot_turns(won_legs[candidate_idx])
                if candidate_turns:
                    turns = candidate_turns
                    selected_record_index = candidate_idx

            # Fallback: if random pick had no usable scripted turns, try others.
            if (not turns) and won_legs:
                fallback_order = list(range(len(won_legs)))
                random.shuffle(fallback_order)
                for idx in fallback_order:
                    candidate_turns = self._extract_player_bot_turns(won_legs[idx])
                    if candidate_turns:
                        turns = candidate_turns
                        selected_record_index = int(idx)
                        break

            turn_index = 0
            replay_state = {
                "legKey": leg_key,
                "turns": turns,
                "turnIndex": 0,
                "recordIndex": selected_record_index,
            }
            replay_state_map[player_index] = replay_state
            session.player_bot_replay_state = replay_state_map

        if not isinstance(turns, list) or not turns:
            return []
        if turn_index >= len(turns):
            turn_index = len(turns) - 1
        scripted_turn = turns[turn_index] if 0 <= turn_index < len(turns) else []
        replay_state["turnIndex"] = turn_index + 1
        replay_state_map[player_index] = replay_state
        session.player_bot_replay_state = replay_state_map
        return [dict(dart) for dart in scripted_turn if isinstance(dart, dict)]

    def _run_x01_bot_turns(self, token: int) -> None:
        try:
            while True:
                with self._lock:
                    if self._active_mode != "x01" or self._x01 is None or self._x01.bot_turn_token != token:
                        return
                    session = self._x01
                    state = session.game.get_state()
                    current_player = state.get("currentPlayer")
                    match_winner = state.get("matchWinner")
                    winner = state.get("winner")
                    bot_levels = session.bot_levels or {}
                    speed = self._bot_speed

                    if match_winner is not None or winner is not None:
                        return
                    if current_player is None or int(current_player) not in bot_levels:
                        return

                    player_index = int(current_player)
                    scripted_turn: list[dict[str, Any]] = []
                    source_player_id = str((session.player_bot_sources or {}).get(player_index, "")).strip()
                    if source_player_id:
                        scripted_turn = self._resolve_x01_player_bot_turn(
                            session=session,
                            player_index=player_index,
                            state=state,
                        )
                    bot = X01Bot(level=int(bot_levels[player_index]))
                    delay_s = float(self._BOT_SPEED_DELAYS.get(speed, self._BOT_SPEED_DELAYS["normal"])) * random.uniform(0.9, 1.1)

                publish_detection_event({
                    "type": "x01_bot_turn_started",
                    "player_index": player_index,
                    "speed": speed,
                    "botType": "player_bot" if source_player_id else "ai_bot",
                })

                for dart_index in range(3):
                    time.sleep(delay_s)
                    with self._lock:
                        if self._active_mode != "x01" or self._x01 is None or self._x01.bot_turn_token != token:
                            return
                        session = self._x01
                        state = session.game.get_state()
                        if state.get("currentPlayer") != player_index:
                            break

                        if source_player_id:
                            if dart_index >= len(scripted_turn):
                                break
                            score_payload = dict(scripted_turn[dart_index])
                        else:
                            bot_throw = bot.throw(state, player_index)
                            score_payload = {
                                "score": int(bot_throw.score),
                                "multiplier": int(bot_throw.multiplier),
                                "segment": str(int(bot_throw.number)),
                                "zone": str(bot_throw.zone),
                                "confidence": float(bot_throw.confidence),
                            }
                        session.game.record_dart(dart_index, score_payload)
                        state = session.game.get_state()
                        self._trigger_x01_live_wled(session, state)

                    publish_detection_event({
                        "type": "x01_state_updated",
                        "source": "bot_dart",
                        "dart_index": dart_index,
                        "player_index": player_index,
                        "state": state,
                    })

                    turn_state = state.get("currentTurn", {}) or {}
                    if bool(turn_state.get("bust")) or bool(turn_state.get("finished")):
                        break
                    if source_player_id and scripted_turn and dart_index >= (len(scripted_turn) - 1):
                        break

                time.sleep(delay_s)
                with self._lock:
                    if self._active_mode != "x01" or self._x01 is None or self._x01.bot_turn_token != token:
                        return
                    session = self._x01
                    state = session.game.get_state()
                    if state.get("currentPlayer") != player_index:
                        continue
                    session.game.complete_turn()
                    self._persist_x01_leg_summary_locked(session)
                    session.darts_recorded_in_turn = 0
                    state = session.game.get_state()
                    self._trigger_x01_turn_wled(state)

                publish_detection_event({
                    "type": "x01_state_updated",
                    "source": "bot_turn",
                    "player_index": player_index,
                    "state": state,
                })
        finally:
            self._clear_x01_bot_turn_active(token)

    def _run_cricket_bot_turns(self, token: int) -> None:
        try:
            while True:
                with self._lock:
                    if self._active_mode != "cricket" or self._cricket is None or self._cricket.bot_turn_token != token:
                        return
                    session = self._cricket
                    state = session.game.get_state()
                    current_player = state.get("currentPlayer")
                    match_info = state.get("match", {}) or {}
                    match_winner = match_info.get("matchWinner")
                    winner = state.get("winner")
                    bot_levels = session.bot_levels or {}
                    speed = self._bot_speed

                    if match_winner is not None or winner is not None:
                        return
                    if current_player is None or int(current_player) not in bot_levels:
                        return

                    player_index = int(current_player)
                    bot = CricketBot(level=int(bot_levels[player_index]))
                    delay_s = float(self._BOT_SPEED_DELAYS.get(speed, self._BOT_SPEED_DELAYS["normal"])) * random.uniform(0.9, 1.1)

                publish_detection_event({
                    "type": "cricket_bot_turn_started",
                    "player_index": player_index,
                    "speed": speed,
                })

                for dart_index in range(3):
                    time.sleep(delay_s)
                    with self._lock:
                        if self._active_mode != "cricket" or self._cricket is None or self._cricket.bot_turn_token != token:
                            return
                        session = self._cricket
                        state = session.game.get_state()
                        if state.get("currentPlayer") != player_index:
                            break

                        bot_throw = bot.throw(state, player_index)
                        score_payload = {
                            "score": int(bot_throw.score),
                            "multiplier": int(bot_throw.multiplier),
                            "segment": str(int(bot_throw.number)),
                            "zone": str(bot_throw.zone),
                            "confidence": float(bot_throw.confidence),
                        }
                        session.game.record_dart(dart_index, score_payload)
                        state = session.game.get_state()

                    publish_detection_event({
                        "type": "cricket_state_updated",
                        "source": "bot_dart",
                        "dart_index": dart_index,
                        "player_index": player_index,
                        "state": state,
                    })

                time.sleep(delay_s)
                with self._lock:
                    if self._active_mode != "cricket" or self._cricket is None or self._cricket.bot_turn_token != token:
                        return
                    session = self._cricket
                    state = session.game.get_state()
                    if state.get("currentPlayer") != player_index:
                        continue
                    session.game.complete_turn()
                    self._persist_cricket_leg_summary_locked(session)
                    session.darts_recorded_in_turn = 0
                    state = session.game.get_state()

                publish_detection_event({
                    "type": "cricket_state_updated",
                    "source": "bot_turn",
                    "player_index": player_index,
                    "state": state,
                })
        finally:
            self._clear_cricket_bot_turn_active(token)

    def _run_around_the_clock_bot_turns(self, token: int) -> None:
        try:
            while True:
                with self._lock:
                    if self._active_mode != "around_the_clock" or self._around_the_clock is None or self._around_the_clock.bot_turn_token != token:
                        return
                    session = self._around_the_clock
                    state = session.game.get_state()
                    current_player = state.get("currentPlayer")
                    match_info = state.get("match", {}) or {}
                    match_winner = match_info.get("matchWinner")
                    winner = state.get("winner")
                    bot_levels = session.bot_levels or {}
                    speed = self._bot_speed

                    if match_winner is not None or winner is not None:
                        return
                    if current_player is None or int(current_player) not in bot_levels:
                        return

                    player_index = int(current_player)
                    bot = AroundTheClockBot(level=int(bot_levels[player_index]))
                    delay_s = float(self._BOT_SPEED_DELAYS.get(speed, self._BOT_SPEED_DELAYS["normal"])) * random.uniform(0.9, 1.1)

                publish_detection_event({
                    "type": "around_the_clock_bot_turn_started",
                    "player_index": player_index,
                    "speed": speed,
                })

                for dart_index in range(3):
                    time.sleep(delay_s)
                    with self._lock:
                        if self._active_mode != "around_the_clock" or self._around_the_clock is None or self._around_the_clock.bot_turn_token != token:
                            return
                        session = self._around_the_clock
                        state = session.game.get_state()
                        if state.get("currentPlayer") != player_index:
                            break

                        bot_throw = bot.throw(state, player_index)
                        score_payload = {
                            "score": int(bot_throw.score),
                            "multiplier": int(bot_throw.multiplier),
                            "segment": str(int(bot_throw.number)),
                            "zone": str(bot_throw.zone),
                            "confidence": float(bot_throw.confidence),
                        }
                        session.game.record_dart(dart_index, score_payload)
                        state = session.game.get_state()

                    publish_detection_event({
                        "type": "around_the_clock_state_updated",
                        "source": "bot_dart",
                        "dart_index": dart_index,
                        "player_index": player_index,
                        "state": state,
                    })

                    players = state.get("players", []) or []
                    if player_index >= len(players):
                        break
                    if bool(players[player_index].get("finished")):
                        break

                time.sleep(delay_s)
                with self._lock:
                    if self._active_mode != "around_the_clock" or self._around_the_clock is None or self._around_the_clock.bot_turn_token != token:
                        return
                    session = self._around_the_clock
                    state = session.game.get_state()
                    if state.get("currentPlayer") != player_index:
                        continue
                    session.game.complete_turn()
                    self._persist_around_the_clock_leg_summary_locked(session)
                    session.darts_recorded_in_turn = 0
                    state = session.game.get_state()

                publish_detection_event({
                    "type": "around_the_clock_state_updated",
                    "source": "bot_turn",
                    "player_index": player_index,
                    "state": state,
                })
        finally:
            self._clear_around_the_clock_bot_turn_active(token)

    def _run_shanghai_bot_turns(self, token: int) -> None:
        try:
            while True:
                with self._lock:
                    if self._active_mode != "shanghai" or self._shanghai is None or self._shanghai.bot_turn_token != token:
                        return
                    session = self._shanghai
                    state = session.game.get_state()
                    current_player = state.get("currentPlayer")
                    match_winner = state.get("matchWinnerIndex")
                    winner = state.get("winnerIndex")
                    bot_levels = session.bot_levels or {}
                    speed = self._bot_speed

                    if match_winner is not None or winner is not None:
                        return
                    if current_player is None or int(current_player) not in bot_levels:
                        return

                    player_index = int(current_player)
                    bot = ShanghaiBot(level=int(bot_levels[player_index]))
                    delay_s = float(self._BOT_SPEED_DELAYS.get(speed, self._BOT_SPEED_DELAYS["normal"])) * random.uniform(0.9, 1.1)

                publish_detection_event({
                    "type": "shanghai_bot_turn_started",
                    "player_index": player_index,
                    "speed": speed,
                })

                for dart_index in range(3):
                    time.sleep(delay_s)
                    with self._lock:
                        if self._active_mode != "shanghai" or self._shanghai is None or self._shanghai.bot_turn_token != token:
                            return
                        session = self._shanghai
                        state = session.game.get_state()
                        if state.get("currentPlayer") != player_index:
                            break

                        bot_throw = bot.throw(state, player_index)
                        score_payload = {
                            "score": int(bot_throw.score),
                            "multiplier": int(bot_throw.multiplier),
                            "segment": str(int(bot_throw.number)),
                            "zone": str(bot_throw.zone),
                            "confidence": float(bot_throw.confidence),
                        }
                        session.game.record_dart(dart_index, score_payload)
                        state = session.game.get_state()

                    publish_detection_event({
                        "type": "shanghai_state_updated",
                        "source": "bot_dart",
                        "dart_index": dart_index,
                        "player_index": player_index,
                        "state": state,
                    })

                    if state.get("winnerIndex") is not None or state.get("matchWinnerIndex") is not None:
                        break

                time.sleep(delay_s)
                with self._lock:
                    if self._active_mode != "shanghai" or self._shanghai is None or self._shanghai.bot_turn_token != token:
                        return
                    session = self._shanghai
                    state = session.game.get_state()
                    if state.get("currentPlayer") != player_index:
                        continue
                    session.game.complete_turn()
                    session.darts_recorded_in_turn = 0
                    state = session.game.get_state()

                publish_detection_event({
                    "type": "shanghai_state_updated",
                    "source": "bot_turn",
                    "player_index": player_index,
                    "state": state,
                })
        finally:
            self._clear_shanghai_bot_turn_active(token)

    def _run_beer_race_bot_turns(self, token: int) -> None:
        try:
            while True:
                with self._lock:
                    if self._active_mode != "beer_race" or self._beer_race is None or self._beer_race.bot_turn_token != token:
                        return
                    session = self._beer_race
                    state = session.game.get_state()
                    current_player = state.get("currentPlayer")
                    match_winner = state.get("matchWinnerIndex")
                    winner = state.get("winnerIndex")
                    bot_levels = session.bot_levels or {}
                    speed = self._bot_speed
                    if match_winner is not None or winner is not None:
                        return
                    if current_player is None or int(current_player) not in bot_levels:
                        return
                    player_index = int(current_player)
                    bot = BeerRaceBot(level=int(bot_levels[player_index]))
                    delay_s = float(self._BOT_SPEED_DELAYS.get(speed, self._BOT_SPEED_DELAYS["normal"])) * random.uniform(0.9, 1.1)

                publish_detection_event({"type": "beer_race_bot_turn_started", "player_index": player_index, "speed": speed})
                for dart_index in range(3):
                    time.sleep(delay_s)
                    with self._lock:
                        if self._active_mode != "beer_race" or self._beer_race is None or self._beer_race.bot_turn_token != token:
                            return
                        session = self._beer_race
                        state = session.game.get_state()
                        if state.get("currentPlayer") != player_index:
                            break
                        bot_throw = bot.throw(state, player_index)
                        score_payload = {
                            "score": int(bot_throw.score),
                            "multiplier": int(bot_throw.multiplier),
                            "segment": str(int(bot_throw.number)),
                            "zone": str(bot_throw.zone),
                            "confidence": float(bot_throw.confidence),
                        }
                        session.game.record_dart(dart_index, score_payload)
                        state = session.game.get_state()
                    publish_detection_event({"type": "beer_race_state_updated", "source": "bot_dart", "dart_index": dart_index, "player_index": player_index, "state": state})
                    if state.get("winnerIndex") is not None or state.get("matchWinnerIndex") is not None:
                        break
                time.sleep(delay_s)
                with self._lock:
                    if self._active_mode != "beer_race" or self._beer_race is None or self._beer_race.bot_turn_token != token:
                        return
                    session = self._beer_race
                    state = session.game.get_state()
                    if state.get("currentPlayer") != player_index:
                        continue
                    session.game.complete_turn()
                    session.darts_recorded_in_turn = 0
                    state = session.game.get_state()
                publish_detection_event({"type": "beer_race_state_updated", "source": "bot_turn", "player_index": player_index, "state": state})
        finally:
            self._clear_beer_race_bot_turn_active(token)

    def _run_bermuda_bot_turns(self, token: int) -> None:
        try:
            while True:
                with self._lock:
                    if self._active_mode != "bermuda" or self._bermuda is None or self._bermuda.bot_turn_token != token:
                        return
                    session = self._bermuda
                    state = session.game.get_state()
                    current_player = state.get("currentPlayer")
                    match_winner = state.get("matchWinnerIndex")
                    bot_levels = session.bot_levels or {}
                    speed = self._bot_speed
                    if match_winner is not None:
                        return
                    if current_player is None or int(current_player) not in bot_levels:
                        return
                    player_index = int(current_player)
                    bot = BermudaBot(level=int(bot_levels[player_index]))
                    delay_s = float(self._BOT_SPEED_DELAYS.get(speed, self._BOT_SPEED_DELAYS["normal"])) * random.uniform(0.9, 1.1)

                publish_detection_event({"type": "bermuda_bot_turn_started", "player_index": player_index, "speed": speed})
                for dart_index in range(3):
                    time.sleep(delay_s)
                    with self._lock:
                        if self._active_mode != "bermuda" or self._bermuda is None or self._bermuda.bot_turn_token != token:
                            return
                        session = self._bermuda
                        state = session.game.get_state()
                        if state.get("currentPlayer") != player_index:
                            break
                        bot_throw = bot.throw(state, player_index)
                        score_payload = {
                            "score": int(bot_throw.score),
                            "multiplier": int(bot_throw.multiplier),
                            "segment": str(int(bot_throw.number)),
                            "zone": str(bot_throw.zone),
                            "confidence": float(bot_throw.confidence),
                        }
                        session.game.record_dart(dart_index, score_payload)
                        state = session.game.get_state()
                    publish_detection_event({"type": "bermuda_state_updated", "source": "bot_dart", "dart_index": dart_index, "player_index": player_index, "state": state})
                time.sleep(delay_s)
                with self._lock:
                    if self._active_mode != "bermuda" or self._bermuda is None or self._bermuda.bot_turn_token != token:
                        return
                    session = self._bermuda
                    state = session.game.get_state()
                    if state.get("currentPlayer") != player_index:
                        continue
                    session.game.complete_turn()
                    session.darts_recorded_in_turn = 0
                    state = session.game.get_state()
                publish_detection_event({"type": "bermuda_state_updated", "source": "bot_turn", "player_index": player_index, "state": state})
        finally:
            self._clear_bermuda_bot_turn_active(token)

    def _run_bob27_bot_turns(self, token: int) -> None:
        try:
            while True:
                with self._lock:
                    if self._active_mode != "bob27" or self._bob27 is None or self._bob27.bot_turn_token != token:
                        return
                    session = self._bob27
                    state = session.game.get_state()
                    current_player = state.get("currentPlayer")
                    match_winner = state.get("matchWinnerIndex")
                    bot_levels = session.bot_levels or {}
                    speed = self._bot_speed
                    if match_winner is not None:
                        return
                    if current_player is None or int(current_player) not in bot_levels:
                        return
                    player_index = int(current_player)
                    bot = Bob27Bot(level=int(bot_levels[player_index]))
                    delay_s = float(self._BOT_SPEED_DELAYS.get(speed, self._BOT_SPEED_DELAYS["normal"])) * random.uniform(0.9, 1.1)

                publish_detection_event({"type": "bob27_bot_turn_started", "player_index": player_index, "speed": speed})
                for dart_index in range(3):
                    time.sleep(delay_s)
                    with self._lock:
                        if self._active_mode != "bob27" or self._bob27 is None or self._bob27.bot_turn_token != token:
                            return
                        session = self._bob27
                        state = session.game.get_state()
                        if state.get("currentPlayer") != player_index:
                            break
                        bot_throw = bot.throw(state, player_index)
                        score_payload = {
                            "score": int(bot_throw.score),
                            "multiplier": int(bot_throw.multiplier),
                            "segment": str(int(bot_throw.number)),
                            "zone": str(bot_throw.zone),
                            "confidence": float(bot_throw.confidence),
                        }
                        session.game.record_dart(dart_index, score_payload)
                        state = session.game.get_state()
                    publish_detection_event({"type": "bob27_state_updated", "source": "bot_dart", "dart_index": dart_index, "player_index": player_index, "state": state})
                time.sleep(delay_s)
                with self._lock:
                    if self._active_mode != "bob27" or self._bob27 is None or self._bob27.bot_turn_token != token:
                        return
                    session = self._bob27
                    state = session.game.get_state()
                    if state.get("currentPlayer") != player_index:
                        continue
                    session.game.complete_turn()
                    session.darts_recorded_in_turn = 0
                    state = session.game.get_state()
                publish_detection_event({"type": "bob27_state_updated", "source": "bot_turn", "player_index": player_index, "state": state})
        finally:
            self._clear_bob27_bot_turn_active(token)

    def _run_target_trainer_bot_turns(self, token: int) -> None:
        try:
            while True:
                with self._lock:
                    if self._active_mode != "target_trainer" or self._target_trainer is None or self._target_trainer.bot_turn_token != token:
                        return
                    session = self._target_trainer
                    state = session.game.get_state()
                    current_player = state.get("currentPlayer")
                    match_winner = state.get("matchWinner")
                    winner = state.get("winnerIndex")
                    bot_levels = session.bot_levels or {}
                    speed = self._bot_speed
                    if match_winner is not None or winner is not None:
                        return
                    if current_player is None or int(current_player) not in bot_levels:
                        return
                    player_index = int(current_player)
                    bot = TargetTrainerBot(level=int(bot_levels[player_index]))
                    delay_s = float(self._BOT_SPEED_DELAYS.get(speed, self._BOT_SPEED_DELAYS["normal"])) * random.uniform(0.9, 1.1)

                publish_detection_event({"type": "target_trainer_bot_turn_started", "player_index": player_index, "speed": speed})
                for dart_index in range(3):
                    time.sleep(delay_s)
                    with self._lock:
                        if self._active_mode != "target_trainer" or self._target_trainer is None or self._target_trainer.bot_turn_token != token:
                            return
                        session = self._target_trainer
                        state = session.game.get_state()
                        if state.get("currentPlayer") != player_index:
                            break
                        bot_throw = bot.throw(state, player_index)
                        score_payload = {
                            "score": int(bot_throw.score),
                            "multiplier": int(bot_throw.multiplier),
                            "segment": str(int(bot_throw.number)),
                            "zone": str(bot_throw.zone),
                            "confidence": float(bot_throw.confidence),
                        }
                        session.game.record_dart(dart_index, score_payload)
                        state = session.game.get_state()
                    publish_detection_event({"type": "target_trainer_state_updated", "source": "bot_dart", "dart_index": dart_index, "player_index": player_index, "state": state})
                    if state.get("winnerIndex") is not None or state.get("matchWinner") is not None:
                        break
                time.sleep(delay_s)
                with self._lock:
                    if self._active_mode != "target_trainer" or self._target_trainer is None or self._target_trainer.bot_turn_token != token:
                        return
                    session = self._target_trainer
                    state = session.game.get_state()
                    if state.get("currentPlayer") != player_index:
                        continue
                    session.game.complete_turn()
                    session.darts_recorded_in_turn = 0
                    state = session.game.get_state()
                publish_detection_event({"type": "target_trainer_state_updated", "source": "bot_turn", "player_index": player_index, "state": state})
        finally:
            self._clear_target_trainer_bot_turn_active(token)

    def _run_one_two_one_bot_turns(self, token: int) -> None:
        try:
            while True:
                with self._lock:
                    if self._active_mode != "one_two_one" or self._one_two_one is None or self._one_two_one.bot_turn_token != token:
                        return
                    session = self._one_two_one
                    state = session.game.get_state()
                    current_player = state.get("currentPlayer")
                    match_info = state.get("match", {}) or {}
                    match_winner = match_info.get("matchWinner")
                    winner = state.get("winnerIndex")
                    bot_levels = session.bot_levels or {}
                    speed = self._bot_speed
                    if match_winner is not None or winner is not None:
                        return
                    if current_player is None or int(current_player) not in bot_levels:
                        return
                    player_index = int(current_player)
                    bot = OneTwoOneBot(level=int(bot_levels[player_index]))
                    delay_s = float(self._BOT_SPEED_DELAYS.get(speed, self._BOT_SPEED_DELAYS["normal"])) * random.uniform(0.9, 1.1)

                publish_detection_event({"type": "one_two_one_bot_turn_started", "player_index": player_index, "speed": speed})
                for dart_index in range(3):
                    time.sleep(delay_s)
                    with self._lock:
                        if self._active_mode != "one_two_one" or self._one_two_one is None or self._one_two_one.bot_turn_token != token:
                            return
                        session = self._one_two_one
                        state = session.game.get_state()
                        if state.get("currentPlayer") != player_index:
                            break
                        bot_throw = bot.throw(state, player_index)
                        score_payload = {
                            "score": int(bot_throw.score),
                            "multiplier": int(bot_throw.multiplier),
                            "segment": str(int(bot_throw.number)),
                            "zone": str(bot_throw.zone),
                            "confidence": float(bot_throw.confidence),
                        }
                        session.game.record_dart(dart_index, score_payload)
                        session.darts_recorded_in_turn = max(session.darts_recorded_in_turn, dart_index + 1)
                        state = session.game.get_state()
                    publish_detection_event({"type": "one_two_one_state_updated", "source": "bot_dart", "dart_index": dart_index, "player_index": player_index, "state": state})
                    turn = state.get("currentTurn", {}) or {}
                    if bool(turn.get("bust")):
                        break

                time.sleep(delay_s)
                with self._lock:
                    if self._active_mode != "one_two_one" or self._one_two_one is None or self._one_two_one.bot_turn_token != token:
                        return
                    session = self._one_two_one
                    state = session.game.get_state()
                    if state.get("currentPlayer") != player_index:
                        continue
                    session.game.complete_turn()
                    session.darts_recorded_in_turn = 0
                    state = session.game.get_state()
                publish_detection_event({"type": "one_two_one_state_updated", "source": "bot_turn", "player_index": player_index, "state": state})
        finally:
            self._clear_one_two_one_bot_turn_active(token)

    def _run_pacman_bot_turns(self, token: int) -> None:
        try:
            while True:
                with self._lock:
                    if self._active_mode != "pacman" or self._pacman is None or self._pacman.bot_turn_token != token:
                        return
                    session = self._pacman
                    state = session.game.get_state()
                    current_player = state.get("currentPlayer")
                    match_info = state.get("match", {}) or {}
                    match_winner = match_info.get("matchWinner")
                    winner = state.get("winnerIndex")
                    bot_levels = session.bot_levels or {}
                    speed = self._bot_speed
                    if match_winner is not None or winner is not None:
                        return
                    if current_player is None or int(current_player) not in bot_levels:
                        return
                    player_index = int(current_player)
                    bot = PacmanBot(level=int(bot_levels[player_index]))
                    delay_s = float(self._BOT_SPEED_DELAYS.get(speed, self._BOT_SPEED_DELAYS["normal"])) * random.uniform(0.9, 1.1)

                publish_detection_event({"type": "pacman_bot_turn_started", "player_index": player_index, "speed": speed})
                for dart_index in range(3):
                    time.sleep(delay_s)
                    with self._lock:
                        if self._active_mode != "pacman" or self._pacman is None or self._pacman.bot_turn_token != token:
                            return
                        session = self._pacman
                        state = session.game.get_state()
                        if state.get("currentPlayer") != player_index:
                            break
                        bot_throw = bot.throw(state, player_index)
                        score_payload = {
                            "score": int(bot_throw.score),
                            "multiplier": int(bot_throw.multiplier),
                            "segment": str(int(bot_throw.number)),
                            "zone": str(bot_throw.zone),
                            "confidence": float(bot_throw.confidence),
                        }
                        session.game.record_dart(dart_index, score_payload)
                        session.darts_recorded_in_turn = max(session.darts_recorded_in_turn, dart_index + 1)
                        state = session.game.get_state()
                    publish_detection_event({"type": "pacman_state_updated", "source": "bot_dart", "dart_index": dart_index, "player_index": player_index, "state": state})

                time.sleep(delay_s)
                with self._lock:
                    if self._active_mode != "pacman" or self._pacman is None or self._pacman.bot_turn_token != token:
                        return
                    session = self._pacman
                    state = session.game.get_state()
                    if state.get("currentPlayer") != player_index:
                        continue
                    session.game.complete_turn()
                    session.darts_recorded_in_turn = 0
                    state = session.game.get_state()
                publish_detection_event({"type": "pacman_state_updated", "source": "bot_turn", "player_index": player_index, "state": state})
        finally:
            self._clear_pacman_bot_turn_active(token)


_SERVICE = GameService()


def get_game_service() -> GameService:
    return _SERVICE

