"""Shanghai game management for the dart detector backend."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
import copy

MAX_DARTS_PER_TURN = 3


def _score_from_raw(raw_score: Optional[Dict]) -> Tuple[int, int, int, str]:
    """
    Convert raw score dict to (score, number, multiplier, zone).
    Only the target number scores points; caller decides target number.
    """
    if not raw_score:
        return 0, 0, 0, "miss"
    try:
        number = int(raw_score.get("segment") or 0)
    except (TypeError, ValueError):
        number = 0
    try:
        multiplier = int(raw_score.get("multiplier") or 0)
    except (TypeError, ValueError):
        multiplier = 0

    zone = str(raw_score.get("zone") or "")
    try:
        score = int(round(float(raw_score.get("score", 0) or 0)))
    except (TypeError, ValueError):
        score = 0
    return max(0, score), max(0, number), max(0, multiplier), zone


@dataclass
class ShanghaiDartResult:
    player_index: int
    score: int
    number: int
    multiplier: int
    zone: str
    raw_score: Optional[Dict]


@dataclass
class ShanghaiPlayerState:
    name: str
    total_scored: int = 0
    darts_thrown: int = 0
    legs_won: int = 0
    sets_won: int = 0
    shanghai_hits: int = 0  # Number of legs won by Shanghai
    match_total_scored: int = 0
    match_darts_thrown: int = 0
    rounds_played: int = 0


class ShanghaiGame:
    """Turn/leg management for Shanghai."""

    def __init__(self) -> None:
        self.round_range: str = "1-20"
        self.target_sequence: List[int] = list(range(1, 21))
        self.total_rounds: int = len(self.target_sequence)
        self.mode: str = "legs_sets"  # "legs_sets" | "free_play"
        self.players: List[ShanghaiPlayerState] = []
        self.current_player_index: int = 0
        self.current_round: int = 1
        self.current_turn_darts: List[Optional[ShanghaiDartResult]] = [None] * MAX_DARTS_PER_TURN
        self.last_completed_turn: List[Optional[ShanghaiDartResult]] = [None] * MAX_DARTS_PER_TURN
        self.turn_history: List[Tuple[int, List[Optional[ShanghaiDartResult]]]] = []
        self.winner_index: Optional[int] = None
        self.leg_winner_index: Optional[int] = None
        self.set_winner_index: Optional[int] = None
        self.match_winner_index: Optional[int] = None
        self.legs_per_set: int = 3
        self.sets_to_win: int = 1
        self.current_leg: int = 1
        self.current_set: int = 1
        self._last_leg_summary: Optional[List[Dict[str, Any]]] = None
        self.completed_leg_summaries: List[Dict[str, Any]] = []

    # ------------------------------------------------------------------
    # Setup
    # ------------------------------------------------------------------
    def start_game(
        self,
        players: List[str],
        round_range: str = "1-20",
        mode: str = "legs_sets",
        starting_player: int = 0,
        legs_per_set: int = 3,
        sets_to_win: int = 1,
    ) -> None:
        filtered = [p.strip() for p in players if p and p.strip()]
        if not filtered:
            raise ValueError("At least one player name is required")

        self.round_range = round_range if round_range in ("1-10", "1-20") else "1-20"
        self.target_sequence = list(range(1, 11)) if self.round_range == "1-10" else list(range(1, 21))
        self.total_rounds = len(self.target_sequence)
        self.mode = mode if mode in ("legs_sets", "free_play") else "legs_sets"
        self.players = [ShanghaiPlayerState(name=name) for name in filtered]
        self.current_player_index = max(0, min(starting_player, len(self.players) - 1))
        self.current_round = 1
        self.winner_index = None
        self.leg_winner_index = None
        self.set_winner_index = None
        self.match_winner_index = None
        self.current_leg = 1
        self.current_set = 1
        self.legs_per_set = max(1, legs_per_set)
        self.sets_to_win = max(1, sets_to_win)
        self.turn_history = []
        self.completed_leg_summaries = []
        self._last_leg_summary = None
        self._reset_turn_buffers()

    def reset_match(self) -> None:
        if not self.players:
            return
        for player in self.players:
            player.total_scored = 0
            player.darts_thrown = 0
            player.legs_won = 0
            player.sets_won = 0
            player.shanghai_hits = 0
            player.match_total_scored = 0
            player.match_darts_thrown = 0
            player.rounds_played = 0
        self.current_round = 1
        self.current_leg = 1
        self.current_set = 1
        self.winner_index = None
        self.leg_winner_index = None
        self.set_winner_index = None
        self.match_winner_index = None
        self.turn_history = []
        self.completed_leg_summaries = []
        self._last_leg_summary = None
        self._reset_turn_buffers()

    # ------------------------------------------------------------------
    # Turn handling
    # ------------------------------------------------------------------
    def _reset_turn_buffers(self) -> None:
        self.current_turn_darts = [None] * MAX_DARTS_PER_TURN

    def _ensure_turn_slot(self, dart_index: int) -> None:
        if len(self.current_turn_darts) < MAX_DARTS_PER_TURN:
            self.current_turn_darts = [None] * MAX_DARTS_PER_TURN
        if dart_index < 0 or dart_index >= MAX_DARTS_PER_TURN:
            return

    def record_dart(self, dart_index: int, score: Optional[Dict]) -> None:
        if not self.players:
            return
        if dart_index < 0 or dart_index >= MAX_DARTS_PER_TURN:
            return
        self._ensure_turn_slot(dart_index)

        parsed_score, number, multiplier, zone = _score_from_raw(score)
        self.current_turn_darts[dart_index] = ShanghaiDartResult(
            player_index=self.current_player_index,
            score=parsed_score,
            number=number,
            multiplier=multiplier,
            zone=zone,
            raw_score=copy.deepcopy(score) if score is not None else None,
        )

        # If Shanghai is hit mid-turn, mark winner immediately
        if self._turn_hits_shanghai():
            self.winner_index = self.current_player_index
            self.leg_winner_index = self.current_player_index

    def _turn_hits_shanghai(self) -> bool:
        target = self._current_target_number()
        saw_single = False
        saw_double = False
        saw_triple = False
        for dart in self.current_turn_darts:
            if dart is None or dart.number != target:
                continue
            if dart.multiplier == 1:
                saw_single = True
            elif dart.multiplier == 2:
                saw_double = True
            elif dart.multiplier == 3:
                saw_triple = True
        return saw_single and saw_double and saw_triple

    def _current_target_number(self) -> int:
        index = min(max(self.current_round - 1, 0), len(self.target_sequence) - 1)
        return self.target_sequence[index]

    def _score_turn_for_player(self, player: ShanghaiPlayerState) -> int:
        target = self._current_target_number()
        total = 0
        for dart in self.current_turn_darts:
            if dart is None:
                continue
            if dart.number == target:
                total += dart.number * dart.multiplier
        return total

    def _advance_round_if_needed(self) -> None:
        # Round advances when we loop back to player 0
        if self.current_player_index == 0:
            self.current_round += 1

    def _complete_leg(self, winner_index: int, won_by_shanghai: bool) -> None:
        player = self.players[winner_index]
        player.legs_won += 1
        if won_by_shanghai:
            player.shanghai_hits += 1
        self.leg_winner_index = winner_index
        # Update match stats
        for p in self.players:
            p.match_total_scored += p.total_scored
            p.match_darts_thrown += p.darts_thrown

        if self.mode == "legs_sets":
            if player.legs_won >= self.legs_per_set:
                player.sets_won += 1
                self.set_winner_index = winner_index
                # Reset legs for next set unless match complete
                for p in self.players:
                    p.legs_won = 0

                if player.sets_won >= self.sets_to_win:
                    self.match_winner_index = winner_index

        # Build leg summary
        summary = []
        for idx, p in enumerate(self.players):
            summary.append(
                {
                    "playerIndex": idx,
                    "name": p.name,
                    "legScore": p.total_scored,
                    "darts": p.darts_thrown,
                    "wonByShanghai": won_by_shanghai and idx == winner_index,
                }
            )
        self._last_leg_summary = summary
        self.completed_leg_summaries.append(
            {
                "leg": self.current_leg,
                "set": self.current_set,
                "winnerIndex": winner_index,
                "wonByShanghai": won_by_shanghai,
                "players": summary,
            }
        )

        # Prepare next leg unless match done
        self.current_leg += 1
        if self.mode == "legs_sets" and self.set_winner_index is not None and self.players[self.set_winner_index].sets_won >= self.sets_to_win:
            # Match complete
            return
        self._start_next_leg()

    def _start_next_leg(self) -> None:
        for p in self.players:
            p.total_scored = 0
            p.darts_thrown = 0
        self.current_round = 1
        self.winner_index = None
        self.leg_winner_index = None
        self.set_winner_index = None
        self._reset_turn_buffers()

    def complete_turn(self) -> None:
        if not self.players:
            return

        player = self.players[self.current_player_index]
        darts_used = sum(1 for dart in self.current_turn_darts if dart is not None)
        turn_score = self._score_turn_for_player(player)
        player.total_scored += turn_score
        player.darts_thrown += darts_used
        player.rounds_played += 1 if darts_used > 0 else 0

        self.last_completed_turn = [copy.deepcopy(dart) if dart is not None else None for dart in self.current_turn_darts]
        self.turn_history.append(
            (
                self.current_player_index,
                [copy.deepcopy(dart) if dart is not None else None for dart in self.current_turn_darts],
            )
        )

        won_by_shanghai = self._turn_hits_shanghai()
        if won_by_shanghai:
            self._complete_leg(self.current_player_index, won_by_shanghai=True)
            return

        # Advance player
        self.current_player_index = (self.current_player_index + 1) % len(self.players)
        if self.current_player_index == 0:
            # Completed a full round of turns
            if self.current_round >= self.total_rounds:
                # Leg decided on points
                winner = self._find_points_winner()
                if winner is not None:
                    self._complete_leg(winner, won_by_shanghai=False)
                    return
            self._advance_round_if_needed()

        self._reset_turn_buffers()

    def _find_points_winner(self) -> Optional[int]:
        if not self.players:
            return None
        best_score = -1
        winner_index = None
        for idx, player in enumerate(self.players):
            if player.total_scored > best_score:
                best_score = player.total_scored
                winner_index = idx
        return winner_index

    def consume_leg_summary(self) -> Optional[List[Dict[str, Any]]]:
        summary = self._last_leg_summary
        self._last_leg_summary = None
        return summary

    # ------------------------------------------------------------------
    # State
    # ------------------------------------------------------------------
    def get_state(self) -> Dict[str, Any]:
        players_state = []
        for player in self.players:
            players_state.append(
                {
                    "name": player.name,
                    "totalScored": player.total_scored,
                    "dartsThrown": player.darts_thrown,
                    "legsWon": player.legs_won,
                    "setsWon": player.sets_won,
                    "shanghaiHits": player.shanghai_hits,
                    "matchTotalScored": player.match_total_scored,
                    "matchDartsThrown": player.match_darts_thrown,
                }
            )

        return {
            "mode": "shanghai",
            "settings": {
                "roundRange": self.round_range,
                "totalRounds": self.total_rounds,
                "modeType": self.mode,
                "legsPerSet": self.legs_per_set,
                "setsToWin": self.sets_to_win,
            },
            "currentRound": self.current_round,
            "currentPlayer": self.current_player_index,
            "players": players_state,
            "currentTurn": {
                "darts": [self._dart_to_dict(d) for d in self.current_turn_darts],
                "target": self._current_target_number(),
            },
            "lastTurn": [self._dart_to_dict(d) for d in self.last_completed_turn],
            "turnHistory": [
                {"playerIndex": idx, "darts": [self._dart_to_dict(d) for d in darts]}
                for idx, darts in self.turn_history[-20:]
            ],
            "winnerIndex": self.winner_index,
            "legWinnerIndex": self.leg_winner_index,
            "setWinnerIndex": self.set_winner_index,
            "matchWinnerIndex": self.match_winner_index,
            "completedLegs": self.completed_leg_summaries,
        }

    def _dart_to_dict(self, dart: Optional[ShanghaiDartResult]) -> Optional[Dict[str, Any]]:
        if dart is None:
            return None
        return {
            "score": dart.score,
            "segment": str(dart.number),
            "multiplier": dart.multiplier,
            "zone": dart.zone,
            "confidence": 1.0,
        }


__all__ = ["ShanghaiGame"]
