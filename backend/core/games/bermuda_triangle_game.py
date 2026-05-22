"""Bermuda Triangle training game management."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
import copy

MAX_DARTS_PER_TURN = 3

TARGET_SEQUENCE: List[str] = [
    "12",
    "13",
    "14",
    "double",  # any double
    "15",
    "16",
    "17",
    "triple",  # any triple
    "18",
    "19",
    "20",
    "bull",   # 25 / 50
    "50",     # double bull only
]


@dataclass
class BermudaDartResult:
    player_index: int
    score: int
    target: str
    raw_score: Optional[Dict]


@dataclass
class BermudaPlayerState:
    name: str
    score: int = 0
    darts_thrown: int = 0
    per_round_scores: List[int] = field(default_factory=list)
    legs_won: int = 0
    sets_won: int = 0


class BermudaTriangleGame:
    """Manage Bermuda Triangle turns and scoring."""

    def __init__(self) -> None:
        self.players: List[BermudaPlayerState] = []
        self.current_player_index: int = 0
        self.current_round_index: int = 0
        self.current_turn_darts: List[Optional[BermudaDartResult]] = [None] * MAX_DARTS_PER_TURN
        self.last_completed_turn: List[Optional[BermudaDartResult]] = [None] * MAX_DARTS_PER_TURN
        self.turn_history: List[Tuple[int, int, List[Optional[BermudaDartResult]], int]] = []
        self.match_winner_index: Optional[int] = None
        self.mode: str = "legs_sets"
        self.legs_per_set: int = 1
        self.sets_to_win: int = 1
        self.current_leg: int = 1
        self.current_set: int = 1
        self.leg_winner_index: Optional[int] = None

    # Setup
    def start_game(
        self,
        players: List[Dict[str, Any]],
        starting_player: int = 0,
        mode: str = "legs_sets",
        legs_per_set: int = 1,
        sets_to_win: int = 1,
    ) -> None:
        if not players:
            raise ValueError("At least one player is required")
        self.players = [
            BermudaPlayerState(
                name=p.get("name") or f"Player {idx+1}",
                score=0,
                per_round_scores=[],
                legs_won=0,
                sets_won=0,
            )
            for idx, p in enumerate(players)
        ]
        self.current_player_index = max(0, min(starting_player, len(self.players) - 1))
        self.current_round_index = 0
        self.current_turn_darts = [None] * MAX_DARTS_PER_TURN
        self.last_completed_turn = [None] * MAX_DARTS_PER_TURN
        self.turn_history = []
        self.match_winner_index = None
        self.mode = mode if mode in ("legs_sets", "free_play") else "legs_sets"
        self.legs_per_set = max(1, legs_per_set)
        self.sets_to_win = max(1, sets_to_win)
        self.current_leg = 1
        self.current_set = 1
        self.leg_winner_index = None

    def reset_match(self) -> None:
        if not self.players:
            return
        for p in self.players:
            p.score = 0
            p.darts_thrown = 0
            p.per_round_scores = []
            p.legs_won = 0
            p.sets_won = 0
        self.current_player_index = 0
        self.current_round_index = 0
        self.current_turn_darts = [None] * MAX_DARTS_PER_TURN
        self.last_completed_turn = [None] * MAX_DARTS_PER_TURN
        self.turn_history = []
        self.match_winner_index = None
        self.current_leg = 1
        self.current_set = 1
        self.leg_winner_index = None

    # Helpers
    def _current_target(self) -> str:
        return TARGET_SEQUENCE[min(self.current_round_index, len(TARGET_SEQUENCE) - 1)]

    def _score_dart(self, target: str, raw: Optional[Dict]) -> int:
        if raw is None:
            return 0
        try:
            number = int(raw.get("segment") or 0)
        except (TypeError, ValueError):
            number = 0
        try:
            mult = int(raw.get("multiplier") or 0)
        except (TypeError, ValueError):
            mult = 0
        zone = str(raw.get("zone") or "")

        if target.isdigit():
            tnum = int(target)
            if number == tnum:
                return tnum * mult
            return 0

        if target == "double":
            if mult == 2 or zone == "double":
                return number * 2
            return 0

        if target == "triple":
            if mult == 3 or zone == "triple":
                return number * 3
            return 0

        if target == "bull":
            if number == 25 or zone in ("inner_bull", "outer_bull"):
                return 50 if (mult == 2 or zone == "inner_bull") else 25
            return 0

        if target == "50":
            if (mult == 2 and number == 25) or zone == "inner_bull":
                return 50
            return 0

        return 0

    # Turn lifecycle
    def record_dart(self, dart_index: int, score: Optional[Dict]) -> None:
        if not self.players:
            return
        if dart_index < 0 or dart_index >= MAX_DARTS_PER_TURN:
            return
        target = self._current_target()
        dart_score = self._score_dart(target, score)
        self.current_turn_darts[dart_index] = BermudaDartResult(
            player_index=self.current_player_index,
            score=dart_score,
            target=target,
            raw_score=copy.deepcopy(score) if score is not None else None,
        )

    def complete_turn(self) -> None:
        if not self.players:
            return
        player = self.players[self.current_player_index]
        round_score = sum(d.score for d in self.current_turn_darts if d is not None)

        player.score += round_score
        player.darts_thrown += sum(1 for d in self.current_turn_darts if d is not None)
        player.per_round_scores.append(round_score)

        self.last_completed_turn = [copy.deepcopy(d) if d is not None else None for d in self.current_turn_darts]
        self.turn_history.append(
            (
                self.current_player_index,
                self.current_round_index,
                [copy.deepcopy(d) if d is not None else None for d in self.current_turn_darts],
                round_score,
            )
        )

        if round_score == 0 and player.score > 0:
            player.score = player.score // 2

        # Advance player/round
        self.current_player_index = (self.current_player_index + 1) % len(self.players)
        if self.current_player_index == 0:
            self.current_round_index += 1
            if self.current_round_index >= len(TARGET_SEQUENCE):
                self._finish_leg()
                return

        self.current_turn_darts = [None] * MAX_DARTS_PER_TURN

    def _finish_leg(self) -> None:
        leg_winner = self._winner_by_score()
        self.leg_winner_index = leg_winner
        # Free play: never end match automatically
        if self.mode == "free_play":
            self._reset_for_next_leg()
            return

        # Increment leg/set counts
        self.players[leg_winner].legs_won += 1
        if self.players[leg_winner].legs_won >= self.legs_per_set:
            self.players[leg_winner].sets_won += 1
            # reset legs for all players
            for p in self.players:
                p.legs_won = 0
            self.current_set += 1
            if self.players[leg_winner].sets_won >= self.sets_to_win:
                self.match_winner_index = leg_winner
                return

        # Prepare next leg
        self.current_leg += 1
        self._reset_for_next_leg()

    def _reset_for_next_leg(self) -> None:
        for p in self.players:
            p.score = 0
            p.darts_thrown = 0
            p.per_round_scores = []
        self.current_round_index = 0
        self.current_turn_darts = [None] * MAX_DARTS_PER_TURN
        self.last_completed_turn = [None] * MAX_DARTS_PER_TURN
        self.turn_history = []
        self.match_winner_index = None
        self.current_player_index = 0
        self.leg_winner_index = None

    def _winner_by_score(self) -> int:
        best = -10_000
        winner_idx = 0
        for idx, p in enumerate(self.players):
            if p.score > best:
                best = p.score
                winner_idx = idx
        return winner_idx

    # State
    def get_state(self) -> Dict[str, Any]:
        return {
            "mode": "bermuda",
            "currentRound": self.current_round_index + 1,
            "totalRounds": len(TARGET_SEQUENCE),
            "currentTarget": self._current_target(),
            "currentPlayer": self.current_player_index,
            "currentLeg": self.current_leg,
            "currentSet": self.current_set,
            "legsPerSet": self.legs_per_set,
            "setsToWin": self.sets_to_win,
            "legWinnerIndex": self.leg_winner_index,
            "players": [
                {
                    "name": p.name,
                    "score": p.score,
                    "dartsThrown": p.darts_thrown,
                    "perRoundScores": p.per_round_scores,
                    "legsWon": p.legs_won,
                    "setsWon": p.sets_won,
                }
                for p in self.players
            ],
            "currentTurn": {"darts": [self._dart_to_dict(d) for d in self.current_turn_darts]},
            "lastTurn": [self._dart_to_dict(d) for d in self.last_completed_turn],
            "turnHistory": [
                {
                    "playerIndex": idx,
                    "roundIndex": r_idx,
                    "target": TARGET_SEQUENCE[r_idx] if 0 <= r_idx < len(TARGET_SEQUENCE) else "",
                    "darts": [self._dart_to_dict(d) for d in darts],
                    "roundScore": rscore,
                }
                for (idx, r_idx, darts, rscore) in self.turn_history[-30:]
            ],
            "matchWinnerIndex": self.match_winner_index,
        }

    def _dart_to_dict(self, dart: Optional[BermudaDartResult]) -> Optional[Dict[str, Any]]:
        if dart is None:
            return None
        return {
            "score": dart.score,
            "segment": dart.raw_score.get("segment") if dart.raw_score else None,
            "multiplier": dart.raw_score.get("multiplier") if dart.raw_score else None,
            "zone": dart.raw_score.get("zone") if dart.raw_score else None,
            "confidence": 1.0,
        }

    def consume_leg_summary(self) -> Optional[List[Dict[str, Any]]]:
        # Bermuda has no leg concept; provided for interface compatibility.
        return None


__all__ = ["BermudaTriangleGame", "TARGET_SEQUENCE"]
