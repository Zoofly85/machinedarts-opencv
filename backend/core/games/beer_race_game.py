"""Beer Race game management for the dart detector backend."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
import copy

MAX_DARTS_PER_TURN = 3
VISIT_BUCKET_KEYS = [
    "40plus",
    "60plus",
    "80plus",
    "100plus",
    "120plus",
    "140plus",
    "170plus",
    "180",
]


def _score_from_raw(raw_score: Optional[Dict]) -> int:
    if not raw_score:
        return 0
    try:
        return max(0, int(round(float(raw_score.get("score", 0) or 0))))
    except (TypeError, ValueError):
        return 0


@dataclass
class BeerRaceDartResult:
    player_index: int
    score: int
    raw_score: Optional[Dict]


@dataclass
class BeerRacePlayerState:
    name: str
    total_scored: int = 0  # Current leg score
    darts_thrown: int = 0  # Current leg darts
    visits_played: int = 0  # Current leg visits
    best_visit: int = 0  # Current leg best
    legs_won: int = 0
    sets_won: int = 0
    finished: bool = False
    visit_buckets: Dict[str, int] = field(default_factory=lambda: {key: 0 for key in VISIT_BUCKET_KEYS})
    # Cumulative match statistics
    match_total_scored: int = 0
    match_darts_thrown: int = 0
    match_visits_played: int = 0
    match_best_visit: int = 0
    match_visit_buckets: Dict[str, int] = field(default_factory=lambda: {key: 0 for key in VISIT_BUCKET_KEYS})


class BeerRaceGame:
    """Power-scoring race to a target score."""

    def __init__(self) -> None:
        self.target_score: int = 301
        self.players: List[BeerRacePlayerState] = []
        self.current_player_index: int = 0
        self.current_turn_darts: List[Optional[BeerRaceDartResult]] = [None] * MAX_DARTS_PER_TURN
        self.last_completed_turn: List[Optional[BeerRaceDartResult]] = [None] * MAX_DARTS_PER_TURN
        self.winner_index: Optional[int] = None
        self.match_winner_index: Optional[int] = None
        self.leg_winner_index: Optional[int] = None
        self.set_winner_index: Optional[int] = None
        self.turn_history: List[Tuple[int, List[Optional[BeerRaceDartResult]]]] = []
        self.completed_leg_summaries: List[Dict[str, Any]] = []
        self._last_leg_summary: Optional[List[Dict[str, Any]]] = None
        self.legs_per_set: int = 1
        self.sets_to_win: int = 1
        self.current_leg: int = 1
        self.current_set: int = 1

    # ------------------------------------------------------------------
    # Game setup
    # ------------------------------------------------------------------
    def start_game(
        self,
        players: List[str],
        target_score: int = 301,
        starting_player: int = 0,
        legs_per_set: int = 1,
        sets_to_win: int = 1,
    ) -> None:
        filtered = [p.strip() for p in players if p and p.strip()]
        if not filtered:
            raise ValueError("At least one player name is required")

        self.target_score = max(1, target_score)
        self.players = [BeerRacePlayerState(name=name) for name in filtered]
        self.current_player_index = max(0, min(starting_player, len(self.players) - 1))
        self.winner_index = None
        self.match_winner_index = None
        self.leg_winner_index = None
        self.set_winner_index = None
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
            player.visits_played = 0
            player.best_visit = 0
            player.finished = False
            player.legs_won = 0
            player.sets_won = 0
            player.visit_buckets = {key: 0 for key in VISIT_BUCKET_KEYS}
        self.winner_index = None
        self.match_winner_index = None
        self.leg_winner_index = None
        self.set_winner_index = None
        self.current_leg = 1
        self.current_set = 1
        self.turn_history = []
        self.completed_leg_summaries = []
        self._last_leg_summary = None
        self._reset_turn_buffers()

    # ------------------------------------------------------------------
    # Turn lifecycle
    # ------------------------------------------------------------------
    def start_turn(self) -> None:
        self._reset_turn_buffers()

    def record_dart(self, dart_index: int, score: Optional[Dict]) -> None:
        if not self.players:
            return
        if dart_index < 0 or dart_index >= MAX_DARTS_PER_TURN:
            return
        self._ensure_turn_slot(dart_index)
        if score is None:
            self.current_turn_darts[dart_index] = BeerRaceDartResult(
                player_index=self.current_player_index,
                score=0,
                raw_score=None,
            )
        else:
            self.current_turn_darts[dart_index] = BeerRaceDartResult(
                player_index=self.current_player_index,
                score=_score_from_raw(score),
                raw_score=copy.deepcopy(score),
            )
        
        # Check if player has reached target score after this dart
        player = self.players[self.current_player_index]
        turn_total_so_far = sum(dart.score for dart in self.current_turn_darts if dart is not None)
        projected_total = player.total_scored + turn_total_so_far
        
        if projected_total >= self.target_score and not player.finished:
            # Set winner_index immediately so bot knows to stop throwing
            self.winner_index = self.current_player_index

    def complete_turn(self) -> None:
        if not self.players:
            return

        player = self.players[self.current_player_index]
        darts_used = sum(1 for dart in self.current_turn_darts if dart is not None)
        turn_scores = [dart.score if dart is not None else 0 for dart in self.current_turn_darts]
        turn_total = sum(turn_scores)
        player.darts_thrown += darts_used
        player.visits_played += 1 if darts_used > 0 else 0
        player.total_scored += turn_total
        player.best_visit = max(player.best_visit, turn_total)
        self._update_bucket_counts(player, turn_total)

        self.last_completed_turn = [copy.deepcopy(dart) if dart is not None else None for dart in self.current_turn_darts]
        self.turn_history.append(
            (
                self.current_player_index,
                [copy.deepcopy(dart) if dart is not None else None for dart in self.current_turn_darts],
            )
        )

        if player.total_scored >= self.target_score and not player.finished:
            player.finished = True
            self.winner_index = self.current_player_index
            self.leg_winner_index = self.current_player_index
            self._complete_leg()
            return

        self.current_player_index = (self.current_player_index + 1) % len(self.players)
        self._reset_turn_buffers()

    def consume_leg_summary(self) -> Optional[List[Dict[str, Any]]]:
        summary = self._last_leg_summary
        self._last_leg_summary = None
        return summary

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _complete_leg(self) -> None:
        if self.leg_winner_index is None:
            return

        self._last_leg_summary = self._generate_leg_summary()
        
        # Accumulate leg stats into match stats for all players
        for player in self.players:
            player.match_total_scored += player.total_scored
            player.match_darts_thrown += player.darts_thrown
            player.match_visits_played += player.visits_played
            player.match_best_visit = max(player.match_best_visit, player.best_visit)
            for key in VISIT_BUCKET_KEYS:
                player.match_visit_buckets[key] += player.visit_buckets.get(key, 0)
        
        winner = self.players[self.leg_winner_index]
        winner.legs_won += 1

        if winner.legs_won >= self.legs_per_set:
            self.set_winner_index = self.leg_winner_index
            self._complete_set()
            return

        self.current_leg += 1
        self._start_new_leg()

    def _complete_set(self) -> None:
        if self.set_winner_index is None:
            return

        winner = self.players[self.set_winner_index]
        winner.sets_won += 1

        if winner.sets_won >= self.sets_to_win:
            # Match is won! Ensure final leg stats are accumulated
            # (This should already be done in _complete_leg, but double-check)
            self.match_winner_index = self.set_winner_index
        else:
            self.current_set += 1
            self.current_leg = 1
            self._start_new_leg()

    def _start_new_leg(self) -> None:
        # Reset per-leg stats (match stats are preserved)
        for player in self.players:
            player.total_scored = 0
            player.darts_thrown = 0
            player.visits_played = 0
            player.best_visit = 0
            player.finished = False
            player.visit_buckets = {key: 0 for key in VISIT_BUCKET_KEYS}
        
        self.winner_index = None
        self.leg_winner_index = None
        self.set_winner_index = None
        self.turn_history = []
        self.last_completed_turn = [None] * MAX_DARTS_PER_TURN
        
        # Rotate starting player based on leg number (leg 1 = player 0, leg 2 = player 1, etc.)
        self.current_player_index = (self.current_leg - 1) % len(self.players)
        self._reset_turn_buffers()

    def _reset_turn_buffers(self) -> None:
        self.current_turn_darts = [None] * MAX_DARTS_PER_TURN

    def _ensure_turn_slot(self, dart_index: int) -> None:
        while len(self.current_turn_darts) <= dart_index:
            self.current_turn_darts.append(None)

    def _update_bucket_counts(self, player: BeerRacePlayerState, visit_total: int) -> None:
        thresholds = [
            ("180", 180),
            ("170plus", 170),
            ("140plus", 140),
            ("120plus", 120),
            ("100plus", 100),
            ("80plus", 80),
            ("60plus", 60),
            ("40plus", 40),
        ]
        for key, threshold in thresholds:
            if visit_total >= threshold:
                player.visit_buckets[key] += 1
                break

    def _generate_leg_summary(self) -> List[Dict[str, Any]]:
        summaries: List[Dict[str, Any]] = []
        if not self.players:
            return summaries

        for idx, player in enumerate(self.players):
            darts = player.darts_thrown
            total = player.total_scored
            ppr = (total / darts) * 3.0 if darts else 0.0

            summaries.append(
                {
                    "mode": "beer_race",
                    "darts": darts,
                    "score": total,
                    "ppr": round(ppr, 2),
                    "bucketCounts": copy.deepcopy(player.visit_buckets),
                    "bestVisit": player.best_visit,
                    "winner": idx == self.leg_winner_index,
                }
            )

        if summaries:
            self.completed_leg_summaries.append(
                {
                    "setNumber": self.current_set,
                    "legNumber": self.current_leg,
                    "winnerIndex": self.leg_winner_index,
                    "rawSummaries": copy.deepcopy(summaries),
                }
            )

        return summaries

    # ------------------------------------------------------------------
    # State builders
    # ------------------------------------------------------------------
    def get_state(self) -> Dict[str, Any]:
        players_payload: List[Dict[str, Any]] = []
        current_turn_scores = [dart.score if dart is not None else 0 for dart in self.current_turn_darts]
        current_turn_darts = [copy.deepcopy(dart.raw_score) if dart is not None else None for dart in self.current_turn_darts]
        pending_total = sum(current_turn_scores)

        for idx, player in enumerate(self.players):
            pending = pending_total if idx == self.current_player_index else 0
            display_total = player.total_scored + pending
            darts_pending = sum(1 for dart in self.current_turn_darts if dart is not None) if idx == self.current_player_index else 0
            darts_display = player.darts_thrown + darts_pending
            visits_display = player.visits_played + (1 if idx == self.current_player_index and darts_pending else 0)
            ppr = (player.total_scored / player.darts_thrown * 3.0) if player.darts_thrown else 0.0

            players_payload.append(
                {
                    "name": player.name,
                    "totalScored": display_total,
                    "dartsThrown": darts_display,
                    "visits": visits_display,
                    "bestVisit": player.best_visit if idx != self.current_player_index else max(player.best_visit, pending_total),
                    "ppr": round(ppr, 2),
                    "targetScore": self.target_score,
                    "remaining": max(self.target_score - display_total, 0),
                    "bucketCounts": copy.deepcopy(player.visit_buckets),
                    "finished": player.finished,
                    "legsWon": player.legs_won,
                    "setsWon": player.sets_won,
                }
            )

        return {
            "mode": "beer_race",
            "targetScore": self.target_score,
            "players": players_payload,
            "currentPlayer": self.current_player_index,
            "match": {
                "currentSet": self.current_set,
                "currentLeg": self.current_leg,
                "legsPerSet": self.legs_per_set,
                "setsToWin": self.sets_to_win,
                "legWinner": self.leg_winner_index,
                "setWinner": self.set_winner_index,
                "matchWinner": self.match_winner_index,
            },
            "currentTurn": {
                "darts": current_turn_darts,
                "scores": current_turn_scores,
                "turnTotal": pending_total,
                "remaining": max(self.target_score - (self.players[self.current_player_index].total_scored + pending_total), 0)
                if self.players
                else 0,
            },
            "lastTurn": [copy.deepcopy(dart.raw_score) if dart is not None else None for dart in self.last_completed_turn],
            "winnerIndex": self.winner_index,
            "legWinnerIndex": self.leg_winner_index,
            "setWinnerIndex": self.set_winner_index,
            "matchWinnerIndex": self.match_winner_index,
            "stats": self._build_match_stats(),
        }

    def _build_match_stats(self) -> List[Dict[str, Any]]:
        stats: List[Dict[str, Any]] = []
        for player in self.players:
            # Use match stats (cumulative across all legs) for final statistics
            darts = player.match_darts_thrown
            total = player.match_total_scored
            ppr = (total / darts) * 3.0 if darts else 0.0
            stats.append(
                {
                    "dartsThrown": darts,
                    "totalScored": total,
                    "ppr": round(ppr, 2),
                    "bucketCounts": copy.deepcopy(player.match_visit_buckets),
                    "bestVisit": player.match_best_visit,
                }
            )
        return stats


__all__ = ["BeerRaceGame", "BeerRacePlayerState", "BeerRaceDartResult"]
