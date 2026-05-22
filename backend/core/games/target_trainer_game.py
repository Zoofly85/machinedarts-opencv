"""Target Trainer game management."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
import copy

MAX_DARTS_PER_TURN = 3


@dataclass
class TargetTrainerPlayerState:
    name: str
    hits: float = 0.0
    required_hits: float = 10.0
    darts_thrown: int = 0
    total_hits: float = 0.0
    total_darts: int = 0
    best_streak: int = 0
    current_streak: int = 0
    best_streak_overall: int = 0
    is_bot: bool = False
    bot_level: Optional[int] = None


@dataclass
class TargetTrainerDartResult:
    player_index: int
    hit_value: float
    raw_score: Optional[Dict]
    remaining: float


class TargetTrainerGame:
    """Lightweight scorer for the Target Trainer mode."""

    def __init__(self) -> None:
        self.target_type: str = "treble"
        self.target_number: int = 20
        self.required_hits: float = 10.0
        self.allow_close: bool = False
        self.shared_target: bool = True
        self.players: List[TargetTrainerPlayerState] = []
        self.current_player_index: int = 0
        self.current_turn_darts: List[Optional[TargetTrainerDartResult]] = [None] * MAX_DARTS_PER_TURN
        self.last_completed_turn: List[Optional[TargetTrainerDartResult]] = [None] * MAX_DARTS_PER_TURN
        self.turn_history: List[Tuple[int, List[TargetTrainerDartResult]]] = []
        self.winner_index: Optional[int] = None
        # Match tracking
        self.legs_per_set: int = 1
        self.sets_to_win: int = 1
        self.current_leg: int = 1
        self.current_set: int = 1
        self.leg_wins: List[int] = []
        self.leg_wins_total: List[int] = []
        self.set_wins: List[int] = []
        self.leg_winner: Optional[int] = None
        self.set_winner: Optional[int] = None
        self.match_winner: Optional[int] = None

    # ------------------------------------------------------------------
    # Setup
    # ------------------------------------------------------------------
    def start_game(
        self,
        players: List[Dict[str, Any]],
        target_type: str = "treble",
        target_number: int = 20,
        required_hits: float = 10.0,
        allow_close: bool = False,
        shared_target: bool = True,
        starting_player: int = 0,
        legs_per_set: int = 1,
        sets_to_win: int = 1,
    ) -> None:
        if not players:
            raise ValueError("At least one player is required")

        self.target_type = target_type or "treble"
        self.target_number = int(target_number or 20)
        self.required_hits = float(required_hits or 10)
        self.allow_close = bool(allow_close)
        self.shared_target = bool(shared_target)
        self.legs_per_set = max(1, int(legs_per_set or 1))
        self.sets_to_win = max(1, int(sets_to_win or 1))

        self.players = [
            TargetTrainerPlayerState(
                name=p.get("name") or f"Player {idx+1}",
                hits=0.0,
                required_hits=self.required_hits,
                darts_thrown=0,
                total_hits=0.0,
                total_darts=0,
                is_bot=bool(p.get("isBot")),
                bot_level=p.get("botLevel"),
            )
            for idx, p in enumerate(players)
        ]
        self.current_player_index = max(0, min(starting_player, len(self.players) - 1))
        self.current_turn_darts = [None] * MAX_DARTS_PER_TURN
        self.last_completed_turn = [None] * MAX_DARTS_PER_TURN
        self.turn_history = []
        self.winner_index = None
        self.match_winner = None
        self.leg_winner = None
        self.set_winner = None
        self.leg_wins = [0 for _ in self.players]
        self.leg_wins_total = [0 for _ in self.players]
        self.set_wins = [0 for _ in self.players]
        self.current_leg = 1
        self.current_set = 1

    def reset_match(self) -> None:
        for player in self.players:
            player.hits = 0.0
            player.darts_thrown = 0
            player.best_streak = 0
            player.current_streak = 0
            # totals are preserved across legs
        self.current_player_index = 0
        self.current_turn_darts = [None] * MAX_DARTS_PER_TURN
        self.last_completed_turn = [None] * MAX_DARTS_PER_TURN
        self.turn_history = []
        self.winner_index = None
        self.match_winner = None
        self.leg_winner = None
        self.set_winner = None
        self.leg_wins = [0 for _ in self.players]
        self.leg_wins_total = [0 for _ in self.players]
        self.set_wins = [0 for _ in self.players]
        self.current_leg = 1
        self.current_set = 1

    # ------------------------------------------------------------------
    # Turn handling
    # ------------------------------------------------------------------
    def _score_hit_value(self, score: Optional[Dict]) -> float:
        """Return hit credit (1.0 exact, 0.5 close, 0 otherwise)."""
        if score is None:
            return 0.0
        try:
            segment = int(score.get("segment") or 0)
        except (TypeError, ValueError):
            segment = 0
        zone = str(score.get("zone") or "")
        multiplier = int(score.get("multiplier") or 0)

        # Determine ring match
        is_bull_target = self.target_type in ("outer_bull", "inner_bull")
        if is_bull_target:
            if self.target_type == "inner_bull":
                if zone == "inner_bull" or (segment == 25 and multiplier >= 2):
                    return 1.0
                if self.allow_close and (zone == "outer_bull" or segment == 25):
                    return 0.5
            else:  # outer bull target
                if zone == "outer_bull" or (segment == 25 and multiplier == 1):
                    return 1.0
                if self.allow_close and (zone == "inner_bull" or (segment == 25 and multiplier >= 2)):
                    return 1.0  # allow full credit inner on outer target
            return 0.0

        # Numbered target
        if segment != self.target_number:
            return 0.0

        # Exact ring check
        if self.target_type == "treble" and multiplier == 3:
            return 1.0
        if self.target_type == "double" and (multiplier == 2 or zone == "double"):
            return 1.0
        if self.target_type == "single":
            if multiplier == 1 or zone == "single":
                return 1.0
        # Close-enough credit
        if self.allow_close and segment == self.target_number:
            return 0.5
        return 0.0

    def record_dart(self, dart_index: int, score: Optional[Dict]) -> None:
        if not self.players or self.winner_index is not None:
            return
        if dart_index < 0 or dart_index >= MAX_DARTS_PER_TURN:
            return
        player = self.players[self.current_player_index]
        hit_value = self._score_hit_value(score)
        player.hits += hit_value
        player.darts_thrown += 1
        player.total_hits += hit_value
        player.total_darts += 1
        if hit_value > 0:
            player.current_streak += 1
            player.best_streak = max(player.best_streak, player.current_streak)
            player.best_streak_overall = max(player.best_streak_overall, player.current_streak)
        else:
            player.current_streak = 0

        remaining = max(0.0, player.required_hits - player.hits)
        self.current_turn_darts[dart_index] = TargetTrainerDartResult(
            player_index=self.current_player_index,
            hit_value=hit_value,
            raw_score=copy.deepcopy(score) if score is not None else None,
            remaining=remaining,
        )
        if player.hits >= player.required_hits and self.winner_index is None:
            self.winner_index = self.current_player_index

    def _start_next_leg(self, starting_player: int) -> None:
        for player in self.players:
            player.hits = 0.0
            player.darts_thrown = 0
            player.best_streak = 0
            player.current_streak = 0
            player.required_hits = self.required_hits
        self.current_player_index = starting_player
        self.current_turn_darts = [None] * MAX_DARTS_PER_TURN
        self.last_completed_turn = [None] * MAX_DARTS_PER_TURN
        self.turn_history = []
        self.winner_index = None
        self.leg_winner = None
        self.set_winner = None

    def complete_turn(self) -> Optional[int]:
        if not self.players:
            return None

        # snapshot last turn
        self.last_completed_turn = [copy.deepcopy(d) if d is not None else None for d in self.current_turn_darts]
        self.turn_history.append(
            (
                self.current_player_index,
                [copy.deepcopy(d) if d is not None else None for d in self.current_turn_darts],
            )
        )

        # Reset turn darts
        self.current_turn_darts = [None] * MAX_DARTS_PER_TURN

        leg_winner_index: Optional[int] = None
        if self.winner_index is not None:
            leg_winner_index = self.winner_index
            self.leg_winner = leg_winner_index
            self.leg_wins[leg_winner_index] += 1
            self.leg_wins_total[leg_winner_index] += 1

            if self.leg_wins[leg_winner_index] >= self.legs_per_set:
                self.set_winner = leg_winner_index
                self.set_wins[leg_winner_index] += 1
                self.leg_wins = [0 for _ in self.players]
                self.current_set += 1

            if self.set_wins[leg_winner_index] >= self.sets_to_win:
                self.match_winner = leg_winner_index

            if self.match_winner is None:
                self.current_leg += 1
                next_start = (self.current_player_index + 1) % len(self.players)
                self._start_next_leg(starting_player=next_start)

        if self.match_winner is None:
            # advance player if no leg was won
            if leg_winner_index is None:
                self.current_player_index = (self.current_player_index + 1) % len(self.players)

        return leg_winner_index

    # ------------------------------------------------------------------
    # State helpers
    # ------------------------------------------------------------------
    def get_state(self) -> Dict[str, Any]:
        return {
            "mode": "target_trainer",
            "settings": {
                "targetType": self.target_type,
                "targetNumber": self.target_number,
                "requiredHits": self.required_hits,
                "allowClose": self.allow_close,
                "sharedTarget": self.shared_target,
                "legsPerSet": self.legs_per_set,
                "setsToWin": self.sets_to_win,
            },
            "currentPlayer": self.current_player_index,
            "currentLeg": self.current_leg,
            "currentSet": self.current_set,
            "players": [
                {
                    "name": p.name,
                    "hits": p.hits,
                    "requiredHits": p.required_hits,
                    "dartsThrown": p.darts_thrown,
                    "bestStreak": p.best_streak,
                    "currentStreak": p.current_streak,
                    "totalHits": p.total_hits,
                    "totalDarts": p.total_darts,
                    "bestStreakOverall": p.best_streak_overall,
                    "isBot": p.is_bot,
                    "botLevel": p.bot_level,
                    "legsWon": self.leg_wins_total[idx] if idx < len(self.leg_wins_total) else 0,
                    "setsWon": self.set_wins[idx] if idx < len(self.set_wins) else 0,
                    "accuracy": (p.total_hits / p.total_darts) if p.total_darts > 0 else ((p.hits / p.darts_thrown) if p.darts_thrown > 0 else None),
                }
                for idx, p in enumerate(self.players)
            ],
            "currentTurn": {
                "darts": [d.raw_score if d else None for d in self.current_turn_darts],
                "hitsThisTurn": sum(d.hit_value for d in self.current_turn_darts if d),
            },
            "lastTurn": {
                "darts": [d.raw_score if d else None for d in self.last_completed_turn],
                "hitsThisTurn": sum(d.hit_value for d in self.last_completed_turn if d),
                "playerIndex": self.turn_history[-1][0] if self.turn_history else None,
            } if self.turn_history else None,
            "winnerIndex": self.winner_index,
            "turnHistory": [
                {
                    "playerIndex": entry[0],
                    "darts": [d.raw_score if d else None for d in entry[1]],
                    "hitsThisTurn": sum(d.hit_value for d in entry[1] if d),
                }
                for entry in self.turn_history[-20:]  # recent history
            ],
            "legWinner": self.leg_winner,
            "setWinner": self.set_winner,
            "matchWinner": self.match_winner,
        }
