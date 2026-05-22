"""Bob's 27 training game management."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
import copy

MAX_DARTS_PER_TURN = 3


@dataclass
class Bob27DartResult:
    player_index: int
    hit: bool
    number: int
    multiplier: int
    zone: str
    raw_score: Optional[Dict]


@dataclass
class Bob27PlayerState:
    name: str
    score: int = 27
    darts_thrown: int = 0
    hits: int = 0
    attempts: int = 0
    best_round: int = 0
    rounds_played: int = 0
    per_double_hits: Dict[int, int] = field(default_factory=dict)
    per_double_attempts: Dict[int, int] = field(default_factory=dict)
    is_bot: bool = False
    bot_level: Optional[int] = None


class Bob27Game:
    """Manage Bob's 27 turns and scoring."""

    def __init__(self) -> None:
        self.include_bull: bool = True
        self.allow_negative: bool = False
        self.players: List[Bob27PlayerState] = []
        self.current_player_index: int = 0
        self.target_sequence: List[int] = list(range(1, 21))
        self.current_target_index: int = 0
        self.total_legs: int = 1
        self.current_leg: int = 1
        self.current_turn_darts: List[Optional[Bob27DartResult]] = [None] * MAX_DARTS_PER_TURN
        self.last_completed_turn: List[Optional[Bob27DartResult]] = [None] * MAX_DARTS_PER_TURN
        self.turn_history: List[Tuple[int, int, List[Optional[Bob27DartResult]], int]] = []
        self.match_winner_index: Optional[int] = None
        self._last_summary: Optional[List[Dict[str, Any]]] = None

    # ------------------------------------------------------------------
    # Setup
    # ------------------------------------------------------------------
    def start_game(
        self,
        players: List[Dict[str, Any]],
        include_bull: bool = True,
        allow_negative: bool = True,
        starting_player: int = 0,
        total_legs: int = 1,
    ) -> None:
        if not players:
            raise ValueError("At least one player is required")

        sequence = list(range(1, 21))
        if include_bull:
            sequence.append(25)
        self.target_sequence = sequence
        self.include_bull = include_bull
        self.allow_negative = allow_negative
        self.total_legs = max(1, total_legs)
        self.current_leg = 1
        self.players = [
            Bob27PlayerState(
                name=p.get("name") or f"Player {idx+1}",
                score=27,
                per_double_hits={n: 0 for n in sequence},
                per_double_attempts={n: 0 for n in sequence},
                is_bot=bool(p.get("isBot")),
                bot_level=p.get("botLevel"),
            )
            for idx, p in enumerate(players)
        ]
        self.current_player_index = max(0, min(starting_player, len(self.players) - 1))
        self.current_target_index = 0
        self.current_turn_darts = [None] * MAX_DARTS_PER_TURN
        self.last_completed_turn = [None] * MAX_DARTS_PER_TURN
        self.turn_history = []
        self.match_winner_index = None
        self._last_summary = None

    def reset_match(self) -> None:
        if not self.players:
            return
        sequence = self.target_sequence or list(range(1, 21))
        for p in self.players:
            p.score = 27
            p.darts_thrown = 0
            p.hits = 0
            p.attempts = 0
            p.best_round = 0
            p.rounds_played = 0
            p.per_double_hits = {n: 0 for n in sequence}
            p.per_double_attempts = {n: 0 for n in sequence}
        self.current_target_index = 0
        self.current_player_index = 0
        self.current_turn_darts = [None] * MAX_DARTS_PER_TURN
        self.last_completed_turn = [None] * MAX_DARTS_PER_TURN
        self.turn_history = []
        self.match_winner_index = None
        self._last_summary = None

    # ------------------------------------------------------------------
    # Turn handling
    # ------------------------------------------------------------------
    def _current_target(self) -> int:
        if not self.target_sequence:
            return 1
        return self.target_sequence[min(self.current_target_index, len(self.target_sequence) - 1)]

    def record_dart(self, dart_index: int, score: Optional[Dict]) -> None:
        if not self.players:
            return
        if dart_index < 0 or dart_index >= MAX_DARTS_PER_TURN:
            return
        # Parse score
        number = 0
        multiplier = 0
        zone = "miss"
        if score is not None:
            try:
                number = int(score.get("segment") or 0)
            except (TypeError, ValueError):
                number = 0
            try:
                multiplier = int(score.get("multiplier") or 0)
            except (TypeError, ValueError):
                multiplier = 0
            zone = str(score.get("zone") or "miss")

        target = self._current_target()
        is_hit = number == target and multiplier == 2

        self.current_turn_darts[dart_index] = Bob27DartResult(
            player_index=self.current_player_index,
            hit=is_hit,
            number=number,
            multiplier=multiplier,
            zone=zone,
            raw_score=copy.deepcopy(score) if score is not None else None,
        )

    def complete_turn(self) -> None:
        if not self.players:
            return

        player = self.players[self.current_player_index]
        target = self._current_target()
        hits = sum(1 for d in self.current_turn_darts if d and d.hit)
        player_hits = player.per_double_hits.get(target, 0)
        player_attempts = player.per_double_attempts.get(target, 0)

        player.per_double_attempts[target] = player_attempts + MAX_DARTS_PER_TURN
        player_hits += hits
        player.per_double_hits[target] = player_hits

        round_score = hits * target * 2
        if hits == 0:
            round_score = -target * 2

        player.score += round_score
        player.darts_thrown += sum(1 for d in self.current_turn_darts if d is not None)
        player.hits += hits
        player.attempts += MAX_DARTS_PER_TURN
        player.rounds_played += 1
        player.best_round = max(player.best_round, round_score)

        self.last_completed_turn = [copy.deepcopy(dart) if dart is not None else None for dart in self.current_turn_darts]
        self.turn_history.append(
            (
                self.current_player_index,
                target,
                [copy.deepcopy(dart) if dart is not None else None for dart in self.current_turn_darts],
                round_score,
            )
        )

        # Check bust/zero-lose condition when negatives are disallowed
        if not self.allow_negative and player.score <= 0:
            self._finish_leg()
            return

        # Advance player/target
        self.current_player_index = (self.current_player_index + 1) % len(self.players)
        if self.current_player_index == 0:
            self.current_target_index += 1
            if self.current_target_index >= len(self.target_sequence):
                self._finish_leg()
                return

        self.current_turn_darts = [None] * MAX_DARTS_PER_TURN

    def _finish_leg(self) -> None:
        winner = self._winner_by_score()
        summary = []
        for idx, p in enumerate(self.players):
            summary.append(
                {
                    "playerIndex": idx,
                    "name": p.name,
                    "score": p.score,
                    "dartsThrown": p.darts_thrown,
                }
            )
        self._last_summary = summary

        # Advance leg or finish match
        if self.current_leg >= self.total_legs:
            self.match_winner_index = winner
            return

        # Prepare next leg
        self.current_leg += 1
        for p in self.players:
            p.score = 27
            p.darts_thrown = 0
            p.hits = 0
            p.attempts = 0
            p.best_round = 0
            p.rounds_played = 0
        self.current_target_index = 0
        self.current_player_index = 0
        self.current_turn_darts = [None] * MAX_DARTS_PER_TURN
        self.turn_history = []
        self.match_winner_index = None

    def _winner_by_score(self) -> int:
        best = -10_000
        winner_idx = 0
        for idx, p in enumerate(self.players):
            if p.score > best:
                best = p.score
                winner_idx = idx
        return winner_idx

    # ------------------------------------------------------------------
    # State & summary
    # ------------------------------------------------------------------
    def get_state(self) -> Dict[str, Any]:
        target = self._current_target()
        return {
            "mode": "bob27",
            "settings": {
                "includeBull": self.include_bull,
                "allowNegative": self.allow_negative,
            },
            "currentTarget": target,
            "currentTargetIndex": self.current_target_index,
            "totalTargets": len(self.target_sequence),
            "currentLeg": self.current_leg,
            "totalLegs": self.total_legs,
            "currentPlayer": self.current_player_index,
            "players": [
                {
                    "name": p.name,
                    "score": p.score,
                    "dartsThrown": p.darts_thrown,
                    "hits": p.hits,
                    "attempts": p.attempts,
                    "bestRound": p.best_round,
                    "roundsPlayed": p.rounds_played,
                    "perDoubleHits": p.per_double_hits,
                    "perDoubleAttempts": p.per_double_attempts,
                    "isBot": p.is_bot,
                    "botLevel": p.bot_level,
                }
                for p in self.players
            ],
            "currentTurn": {
                "darts": [self._dart_to_dict(d) for d in self.current_turn_darts],
            },
            "lastTurn": [self._dart_to_dict(d) for d in self.last_completed_turn],
            "turnHistory": [
                {
                    "playerIndex": idx,
                    "target": tgt,
                    "darts": [self._dart_to_dict(d) for d in darts],
                    "roundScore": rscore,
                }
                for (idx, tgt, darts, rscore) in self.turn_history[-30:]
            ],
            "matchWinnerIndex": self.match_winner_index,
        }

    def _dart_to_dict(self, dart: Optional[Bob27DartResult]) -> Optional[Dict[str, Any]]:
        if dart is None:
            return None
        return {
            "score": dart.number * dart.multiplier,
            "segment": str(dart.number),
            "multiplier": dart.multiplier,
            "zone": dart.zone,
            "confidence": 1.0,
        }

    def consume_leg_summary(self) -> Optional[List[Dict[str, Any]]]:
        summary = self._last_summary
        self._last_summary = None
        return summary


__all__ = ["Bob27Game"]
