"""Pacman darts mode.

Rules:
- Every player has their own pellet board (S1-20, D1-20, T1-20, OB, IB).
- Hitting a target with a pellet eats it and awards that dart score.
- Hitting a target that already has no pellet (or miss) costs one life.
- Players throw up to 3 darts per turn, then turn advances on takeout/reset.
- Match winner is highest score when all players are game-over.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

MAX_DARTS_PER_TURN = 3

SEGMENT_RING_KEYS = [
    *(f"SI{i}" for i in range(1, 21)),
    *(f"SO{i}" for i in range(1, 21)),
    *(f"D{i}" for i in range(1, 21)),
    *(f"T{i}" for i in range(1, 21)),
]
ALL_PELLET_KEYS = [*SEGMENT_RING_KEYS, "OB", "IB"]


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return default


def _normalize_target(raw_score: Optional[Dict[str, Any]]) -> tuple[str, int]:
    if not raw_score:
        return "MISS", 0
    zone = str(raw_score.get("zone", "") or "").lower()
    segment = _safe_int(raw_score.get("segment"), 0)
    score = max(0, _safe_int(raw_score.get("score"), 0))

    if zone == "inner_bull":
        return "IB", score or 50
    if zone == "outer_bull":
        return "OB", score or 25
    if zone == "triple" and 1 <= segment <= 20:
        return f"T{segment}", score or (segment * 3)
    if zone == "double" and 1 <= segment <= 20:
        return f"D{segment}", score or (segment * 2)
    if zone == "single_inner" and 1 <= segment <= 20:
        return f"SI{segment}", score or segment
    if zone == "single_outer" and 1 <= segment <= 20:
        return f"SO{segment}", score or segment
    if zone == "single" and 1 <= segment <= 20:
        # Fallback if zone detail is unavailable: treat as outer single.
        return f"SO{segment}", score or segment
    return "MISS", score


@dataclass
class PacmanDartResult:
    player_index: int
    score: int
    target_key: str
    ate_pellet: bool
    life_lost: bool
    raw_score: Optional[Dict[str, Any]]


@dataclass
class PacmanPlayerState:
    name: str
    lives: int
    score: int = 0
    game_over: bool = False
    pellets: set[str] = field(default_factory=lambda: set(ALL_PELLET_KEYS))
    darts_thrown: int = 0
    pellets_eaten: int = 0
    misses_or_empty_hits: int = 0
    last_pacman_target: Optional[str] = None
    last_eaten_target: Optional[str] = None


class PacmanGame:
    def __init__(self) -> None:
        self.players: List[PacmanPlayerState] = []
        self.current_player_index: int = 0
        self.lives_per_player: int = 5
        self.current_turn_raw_scores: List[Optional[Dict[str, Any]]] = [None] * MAX_DARTS_PER_TURN
        self.current_turn_darts: List[Optional[PacmanDartResult]] = [None] * MAX_DARTS_PER_TURN
        self.last_completed_turn: List[Optional[PacmanDartResult]] = [None] * MAX_DARTS_PER_TURN
        self.current_turn_scored: int = 0
        self.current_turn_lives_lost: int = 0
        self._turn_start_snapshot: Optional[Dict[str, Any]] = None
        self.winner_index: Optional[int] = None
        self.turn_history: List[Dict[str, Any]] = []

    def start_game(
        self,
        players: List[str],
        *,
        lives_per_player: int = 5,
        starting_player: int = 0,
    ) -> None:
        names = [str(name or "").strip() for name in players]
        names = [name for name in names if name]
        if not names:
            raise ValueError("At least one player name is required")

        self.lives_per_player = max(1, int(lives_per_player or 5))
        self.players = [
            PacmanPlayerState(name=name, lives=self.lives_per_player) for name in names
        ]
        self.current_player_index = max(0, min(int(starting_player or 0), len(self.players) - 1))
        self.winner_index = None
        self.turn_history = []
        self._reset_turn_buffers()
        self._start_turn_snapshot()

    def _reset_turn_buffers(self) -> None:
        self.current_turn_raw_scores = [None] * MAX_DARTS_PER_TURN
        self.current_turn_darts = [None] * MAX_DARTS_PER_TURN
        self.current_turn_scored = 0
        self.current_turn_lives_lost = 0
        self._turn_start_snapshot = None

    def _start_turn_snapshot(self) -> None:
        if not self.players:
            return
        player = self.players[self.current_player_index]
        self._turn_start_snapshot = {
            "score": int(player.score),
            "lives": int(player.lives),
            "game_over": bool(player.game_over),
            "pellets": set(player.pellets),
            "darts_thrown": int(player.darts_thrown),
            "pellets_eaten": int(player.pellets_eaten),
            "misses_or_empty_hits": int(player.misses_or_empty_hits),
            "last_pacman_target": player.last_pacman_target,
            "last_eaten_target": player.last_eaten_target,
        }

    def record_dart(self, dart_index: int, score: Optional[Dict[str, Any]]) -> None:
        if self.winner_index is not None:
            return
        if dart_index < 0 or dart_index >= MAX_DARTS_PER_TURN or not self.players:
            return
        if self._turn_start_snapshot is None:
            self._start_turn_snapshot()

        self.current_turn_raw_scores[dart_index] = dict(score or {})
        self._replay_current_turn()

    def _replay_current_turn(self) -> None:
        if not self.players or self._turn_start_snapshot is None:
            return
        player = self.players[self.current_player_index]

        # Restore to turn-start and replay all currently known dart slots.
        player.score = int(self._turn_start_snapshot["score"])
        player.lives = int(self._turn_start_snapshot["lives"])
        player.game_over = bool(self._turn_start_snapshot["game_over"])
        player.pellets = set(self._turn_start_snapshot["pellets"])
        player.darts_thrown = int(self._turn_start_snapshot["darts_thrown"])
        player.pellets_eaten = int(self._turn_start_snapshot["pellets_eaten"])
        player.misses_or_empty_hits = int(self._turn_start_snapshot["misses_or_empty_hits"])
        player.last_pacman_target = self._turn_start_snapshot["last_pacman_target"]
        player.last_eaten_target = self._turn_start_snapshot["last_eaten_target"]

        self.current_turn_darts = [None] * MAX_DARTS_PER_TURN
        self.current_turn_scored = 0
        self.current_turn_lives_lost = 0

        for i in range(MAX_DARTS_PER_TURN):
            raw = self.current_turn_raw_scores[i]
            if raw is None:
                continue
            if player.game_over:
                # Keep explicit inert result for UI consistency.
                self.current_turn_darts[i] = PacmanDartResult(
                    player_index=self.current_player_index,
                    score=0,
                    target_key="GAME_OVER",
                    ate_pellet=False,
                    life_lost=False,
                    raw_score=raw,
                )
                continue

            target_key, dart_score = _normalize_target(raw)
            player.last_pacman_target = target_key if target_key != "MISS" else player.last_pacman_target
            ate_pellet = target_key in player.pellets
            life_lost = False
            applied_score = 0

            if ate_pellet:
                player.pellets.remove(target_key)
                player.score += dart_score
                player.pellets_eaten += 1
                player.last_eaten_target = target_key
                applied_score = dart_score
            else:
                life_lost = True
                player.lives = max(0, player.lives - 1)
                player.misses_or_empty_hits += 1
                if player.lives <= 0:
                    player.game_over = True

            player.darts_thrown += 1
            self.current_turn_scored += applied_score
            if life_lost:
                self.current_turn_lives_lost += 1

            self.current_turn_darts[i] = PacmanDartResult(
                player_index=self.current_player_index,
                score=applied_score,
                target_key=target_key,
                ate_pellet=ate_pellet,
                life_lost=life_lost,
                raw_score=raw,
            )

    def complete_turn(self) -> None:
        if not self.players:
            return

        # Persist turn snapshot for UI/stats.
        self.last_completed_turn = [entry for entry in self.current_turn_darts]
        self.turn_history.append(
            {
                "playerIndex": int(self.current_player_index),
                "darts": [self._dart_to_dict(entry) if entry is not None else None for entry in self.current_turn_darts],
                "scored": int(self.current_turn_scored),
                "livesLost": int(self.current_turn_lives_lost),
            }
        )

        # Finalize winner only when the turn is committed (takeout / force-next-turn).
        # This keeps a correction window open after a "last life" dart.
        self._update_winner_if_finished()
        if self.winner_index is not None:
            self._reset_turn_buffers()
            return

        # Advance to next alive player.
        next_index = self.current_player_index
        for _ in range(len(self.players)):
            next_index = (next_index + 1) % len(self.players)
            if not self.players[next_index].game_over:
                self.current_player_index = next_index
                break

        self._reset_turn_buffers()
        self._start_turn_snapshot()

    def _update_winner_if_finished(self) -> None:
        if not self.players:
            self.winner_index = None
            return
        if any(not player.game_over for player in self.players):
            self.winner_index = None
            return
        best_score = max(player.score for player in self.players)
        for idx, player in enumerate(self.players):
            if player.score == best_score:
                self.winner_index = idx
                break

    def _dart_to_dict(self, result: PacmanDartResult) -> Dict[str, Any]:
        return {
            "playerIndex": int(result.player_index),
            "score": int(result.score),
            "targetKey": str(result.target_key),
            "atePellet": bool(result.ate_pellet),
            "lifeLost": bool(result.life_lost),
            "rawScore": dict(result.raw_score or {}),
        }

    def get_state(self) -> Dict[str, Any]:
        players = []
        for player in self.players:
            players.append(
                {
                    "name": player.name,
                    "score": int(player.score),
                    "lives": int(player.lives),
                    "gameOver": bool(player.game_over),
                    "pelletsRemaining": int(len(player.pellets)),
                    "pelletsEaten": int(player.pellets_eaten),
                    "pellets": sorted(player.pellets),
                    "dartsThrown": int(player.darts_thrown),
                    "missesOrEmptyHits": int(player.misses_or_empty_hits),
                    "lastPacmanTarget": player.last_pacman_target,
                    "lastEatenTarget": player.last_eaten_target,
                }
            )

        return {
            "mode": "pacman",
            "settings": {
                "livesPerPlayer": int(self.lives_per_player),
                "totalPellets": int(len(ALL_PELLET_KEYS)),
                "pelletKeys": list(ALL_PELLET_KEYS),
            },
            "players": players,
            "currentPlayer": int(self.current_player_index if self.players else 0),
            "currentTurn": {
                "darts": [self._dart_to_dict(entry) if entry is not None else None for entry in self.current_turn_darts],
                "scored": int(self.current_turn_scored),
                "livesLost": int(self.current_turn_lives_lost),
            },
            "lastCompletedTurn": [self._dart_to_dict(entry) if entry is not None else None for entry in self.last_completed_turn],
            "winnerIndex": self.winner_index,
            "match": {
                "matchWinner": self.winner_index,
            },
            "turnHistory": list(self.turn_history),
        }
