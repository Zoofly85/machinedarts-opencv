"""Cricket game management for the dart detector backend."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
import copy

CRICKET_NUMBERS: List[int] = [20, 19, 18, 17, 16, 15, 25]
NUMBER_TO_INDEX: Dict[int, int] = {value: idx for idx, value in enumerate(CRICKET_NUMBERS)}
MAX_DARTS_PER_TURN = 3


@dataclass
class CricketPlayerState:
    """Runtime state for a cricket player."""

    name: str
    marks: List[int] = field(default_factory=lambda: [0] * len(CRICKET_NUMBERS))
    score: int = 0
    legs_won: int = 0
    sets_won: int = 0


@dataclass
class CricketDartResult:
    """Stores how a dart affected state so corrections can undo it."""

    player_index: int
    number_index: Optional[int]
    marks_awarded: int
    points_scored: int
    raw_score: Optional[Dict]


class CricketGame:
    """Cricket scorer that mirrors the detector's turn lifecycle."""

    def __init__(self) -> None:
        self.mode: str = "standard"
        self.players: List[CricketPlayerState] = []
        self.current_player_index: int = 0
        self.current_turn_darts: List[Optional[CricketDartResult]] = [None] * MAX_DARTS_PER_TURN
        self.last_completed_turn: List[Optional[Dict]] = [None] * MAX_DARTS_PER_TURN
        self.winner_index: Optional[int] = None
        self.turn_history: List[Tuple[int, List[CricketDartResult]]] = []
        self._last_leg_summary: Optional[List[Dict[str, Any]]] = None
        self.completed_leg_summaries: List[Dict[str, Any]] = []
        
        # Match format tracking
        self.legs_per_set: int = 3
        self.sets_to_win: int = 1
        self.current_set: int = 1
        self.current_leg: int = 1
        self.leg_winner_index: Optional[int] = None
        self.set_winner_index: Optional[int] = None
        self.match_winner_index: Optional[int] = None

    # ------------------------------------------------------------------
    # Game setup
    # ------------------------------------------------------------------
    def start_game(
        self,
        players: List[str],
        mode: str = "standard",
        starting_player: int = 0,
        legs_per_set: int = 3,
        sets_to_win: int = 1
    ) -> None:
        filtered = [p.strip() for p in players if p and p.strip()]
        if not filtered:
            raise ValueError("At least one player name is required")

        self.mode = mode or "standard"
        self.players = [CricketPlayerState(name=name) for name in filtered]
        self.current_player_index = max(0, min(starting_player, len(self.players) - 1))
        self.start_turn()
        self.last_completed_turn = [None] * MAX_DARTS_PER_TURN
        self.winner_index = None
        self.turn_history = []
        self._last_leg_summary = None
        self.completed_leg_summaries = []
        
        # Initialize match format
        self.legs_per_set = max(1, legs_per_set)
        self.sets_to_win = max(1, sets_to_win)
        self.current_set = 1
        self.current_leg = 1
        self.leg_winner_index = None
        self.set_winner_index = None
        self.match_winner_index = None

    def reset_match(self) -> None:
        if not self.players:
            return
        for player in self.players:
            player.marks = [0] * len(CRICKET_NUMBERS)
            player.score = 0
        self.start_turn()
        self.last_completed_turn = [None] * MAX_DARTS_PER_TURN
        self.winner_index = None
        self.turn_history = []
        self._last_leg_summary = None
        self.completed_leg_summaries = []

    # ------------------------------------------------------------------
    # Turn handling
    # ------------------------------------------------------------------
    def start_turn(self) -> None:
        """Reset buffers for the current player without advancing turn."""
        self._reset_turn_buffers()

    def record_dart(self, dart_index: int, score: Optional[Dict]) -> None:
        """Apply or re-apply a dart result for the active player."""
        if not self.players or dart_index < 0 or dart_index >= MAX_DARTS_PER_TURN:
            return

        self._ensure_turn_slot(dart_index)

        previous = self.current_turn_darts[dart_index]
        if previous is not None:
            self._revert_dart(previous)

        result = self._compute_result(score)
        self.current_turn_darts[dart_index] = result
        self._update_winner()

    def complete_turn(self) -> None:
        """Finalize the active player's turn and rotate to the next player."""
        if not self.players:
            return

        for dart_index in range(MAX_DARTS_PER_TURN):
            if self.current_turn_darts[dart_index] is None:
                self.current_turn_darts[dart_index] = CricketDartResult(
                    player_index=self.current_player_index,
                    number_index=None,
                    marks_awarded=0,
                    points_scored=0,
                    raw_score={
                        "score": 0,
                        "multiplier": 0,
                        "segment": "0",
                        "zone": "miss",
                        "confidence": 1.0,
                    },
                )

        turn_owner = self.current_player_index
        turn_snapshot = [copy.deepcopy(dart) for dart in self.current_turn_darts if dart is not None]
        if turn_snapshot:
            self.turn_history.append((turn_owner, turn_snapshot))

        self.last_completed_turn = [
            dart.raw_score if dart is not None else None
            for dart in self.current_turn_darts
        ]

        self.current_player_index = (self.current_player_index + 1) % len(self.players)
        self.start_turn()
        self._update_winner()
        
        # Check if leg is won and handle leg/set completion
        if self.winner_index is not None and self.leg_winner_index is None:
            self.leg_winner_index = self.winner_index
            self._complete_leg()

    def _reset_turn_buffers(self) -> None:
        self.current_turn_darts = [None] * MAX_DARTS_PER_TURN

    def _ensure_turn_slot(self, dart_index: int) -> None:
        if len(self.current_turn_darts) < MAX_DARTS_PER_TURN:
            self.current_turn_darts.extend([None] * (MAX_DARTS_PER_TURN - len(self.current_turn_darts)))
        if dart_index >= len(self.current_turn_darts):
            self.current_turn_darts.extend([None] * (dart_index - len(self.current_turn_darts) + 1))

    # ------------------------------------------------------------------
    # Helpers for dart application
    # ------------------------------------------------------------------
    def _compute_result(self, score: Optional[Dict]) -> CricketDartResult:
        if score is None:
            raw_score = {
                "score": 0,
                "multiplier": 0,
                "segment": "0",
                "zone": "miss",
                "confidence": 0.0,
            }
            return CricketDartResult(
                player_index=self.current_player_index,
                number_index=None,
                marks_awarded=0,
                points_scored=0,
                raw_score=raw_score,
            )

        zone = (score.get("zone") or "").lower()
        try:
            multiplier = int(score.get("multiplier", 0) or 0)
        except (TypeError, ValueError):
            multiplier = 0

        number = self._extract_number(score, zone)
        number_index = NUMBER_TO_INDEX.get(number) if number is not None else None

        hits = self._determine_hits(zone, multiplier)
        marks_awarded = 0
        points_scored = 0

        if number_index is not None and hits > 0:
            marks_awarded, points_scored = self._apply_hits(number_index, hits)

        raw_score = {
            "score": int(score.get("score", 0) or 0),
            "multiplier": multiplier,
            "segment": str(score.get("segment", number or 0)),
            "zone": zone or "miss",
            "confidence": float(score.get("confidence", 0.0) or 0.0),
        }

        return CricketDartResult(
            player_index=self.current_player_index,
            number_index=number_index,
            marks_awarded=marks_awarded,
            points_scored=points_scored,
            raw_score=raw_score,
        )

    def _extract_number(self, score: Dict, zone: str) -> Optional[int]:
        if zone in {"inner_bull", "outer_bull"}:
            return 25
        try:
            segment = score.get("segment")
            if segment is None:
                return None
            segment_int = int(segment)
            if segment_int in NUMBER_TO_INDEX:
                return segment_int
        except (TypeError, ValueError):
            return None
        return None

    def _determine_hits(self, zone: str, multiplier: int) -> int:
        # Handle bullseye zones
        if zone == "inner_bull":
            bulls_hits = 2
        elif zone == "outer_bull":
            bulls_hits = 1
        else:
            bulls_hits = 0
        
        # For bullseye, apply mode filtering
        if bulls_hits > 0:
            if self.mode == "triples_only":
                # Only inner bull (double bull) counts as 1 mark in triples_only
                return 1 if zone == "inner_bull" else 0
            elif self.mode == "doubles_only":
                # Inner bull (double bull) counts as 1 mark in doubles_only (it's a double!)
                return 1 if zone == "inner_bull" else 0
            else:
                return bulls_hits
        
        # Handle misses
        if zone in {"miss", ""}:
            return 0
        
        # Determine base hits from multiplier
        if multiplier <= 0 and zone.startswith("single"):
            hits = 1
        else:
            hits = max(0, multiplier)
        
        # Apply mode-specific filtering
        if self.mode == "triples_only":
            # Only triples count, and they count as 1 mark (not 3)
            return 1 if multiplier == 3 else 0
        elif self.mode == "doubles_only":
            # Only doubles count, and they count as 1 mark (not 2)
            return 1 if multiplier == 2 else 0
        else:
            # Standard, cutthroat, no_score: all hits count normally
            return hits

    def _apply_hits(self, number_index: int, hits: int) -> Tuple[int, int]:
        player = self.players[self.current_player_index]
        marks_awarded = 0
        points_scored = 0
        value = CRICKET_NUMBERS[number_index]

        for _ in range(hits):
            if player.marks[number_index] < 3:
                player.marks[number_index] += 1
                marks_awarded += 1
            else:
                if self.mode != "no_score" and not self._is_number_closed(number_index):
                    player.score += value
                    points_scored += value

        return marks_awarded, points_scored

    def _revert_dart(self, result: CricketDartResult) -> None:
        player = self.players[result.player_index]
        if result.number_index is not None and result.marks_awarded:
            player.marks[result.number_index] = max(0, player.marks[result.number_index] - result.marks_awarded)
        if result.points_scored:
            player.score = max(0, player.score - result.points_scored)
        self._update_winner()

    def _is_number_closed(self, number_index: int) -> bool:
        return all(player.marks[number_index] >= 3 for player in self.players)

    def _player_has_closed_all_numbers(self, player: CricketPlayerState) -> bool:
        return all(mark >= 3 for mark in player.marks)

    def _update_winner(self) -> None:
        if not self.players:
            self.winner_index = None
            return

        if self.mode == "standard":
            scores = [player.score for player in self.players]
            for idx, player in enumerate(self.players):
                if self._player_has_closed_all_numbers(player):
                    if all(player.score >= scores[other_idx]
                           for other_idx in range(len(self.players)) if other_idx != idx):
                        self.winner_index = idx
                        return
            self.winner_index = None
        elif self.mode == "cutthroat":
            scores = [player.score for player in self.players]
            for idx, player in enumerate(self.players):
                if self._player_has_closed_all_numbers(player):
                    if all(scores[idx] <= scores[other_idx]
                           for other_idx in range(len(self.players)) if other_idx != idx):
                        self.winner_index = idx
                        return
            self.winner_index = None
        elif self.mode == "no_score":
            for idx, player in enumerate(self.players):
                if self._player_has_closed_all_numbers(player):
                    self.winner_index = idx
                    return
            self.winner_index = None
        else:
            self.winner_index = None
    
    def _complete_leg(self) -> None:
        """Complete the current leg and check for set/match completion."""
        if self.leg_winner_index is None:
            return
        
        self._last_leg_summary = self._generate_leg_summary()
        
        # Award leg to winner
        winner = self.players[self.leg_winner_index]
        winner.legs_won += 1
        
        # Check if set is won
        if winner.legs_won >= self.legs_per_set:
            self.set_winner_index = self.leg_winner_index
            self._complete_set()
            return
        
        # Start next leg in same set
        self.current_leg += 1
        self._start_new_leg()
    def consume_leg_summary(self) -> Optional[List[Dict[str, Any]]]:
        summary = self._last_leg_summary
        self._last_leg_summary = None
        return summary

    def _generate_leg_summary(self) -> List[Dict[str, Any]]:
        """Capture per-player statistics for the just-completed leg."""
        summaries: List[Dict[str, Any]] = []
        if not self.players:
            return summaries

        marks_keys = [str(k) for k in range(3, 10)]

        # Build lookup of darts per player in chronological order
        per_player_turns: List[List[List[CricketDartResult]]] = [[] for _ in self.players]
        for owner_idx, darts in self.turn_history:
            if 0 <= owner_idx < len(per_player_turns):
                per_player_turns[owner_idx].append(darts)

        for idx, player in enumerate(self.players):
            turn_groups = per_player_turns[idx]
            darts_thrown = 0
            marks_total = 0
            points_total = 0
            per_dart_marks: List[int] = []
            turn_marks: List[int] = []
            mark_counts = {key: 0 for key in marks_keys}
            best_score = 0

            for turn in turn_groups:
                turn_mark_sum = 0
                for dart in turn:
                    darts_thrown += 1
                    marks_total += dart.marks_awarded
                    points_total += dart.points_scored
                    per_dart_marks.append(dart.marks_awarded)
                    turn_mark_sum += dart.marks_awarded
                    if dart.raw_score:
                        best_score = max(best_score, int(dart.raw_score.get("score", 0) or 0))
                turn_marks.append(turn_mark_sum)
                if turn_mark_sum >= 3:
                    bucket_key = str(min(max(turn_mark_sum, 3), 9))
                    mark_counts[bucket_key] += 1

            first_nine = per_dart_marks[:9]
            first_nine_marks = sum(first_nine)
            first_nine_darts = len(first_nine)
            best_turn_marks = max(turn_marks) if turn_marks else 0

            summary = {
                "mode": "cricket",
                "darts": darts_thrown,
                "marks": marks_total,
                "firstNineMarks": first_nine_marks,
                "firstNineDarts": first_nine_darts,
                "points": points_total,
                "turnMarks": turn_marks,
                "markCounts": mark_counts,
                "bestTurnMarks": best_turn_marks,
                "bestScore": best_score,
                "winner": bool(self.leg_winner_index == idx),
            }
            summaries.append(summary)

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
    
    def _complete_set(self) -> None:
        """Complete the current set and check for match completion."""
        if self.set_winner_index is None:
            return
        
        # Award set to winner
        winner = self.players[self.set_winner_index]
        winner.sets_won += 1
        
        # Reset leg counts for all players
        for player in self.players:
            player.legs_won = 0
        
        # Check if match is won
        if winner.sets_won >= self.sets_to_win:
            self.match_winner_index = self.set_winner_index
            return
        
        # Start next set
        self.current_set += 1
        self.current_leg = 1
        self._start_new_leg()
    
    def _start_new_leg(self) -> None:
        """Reset marks and scores for a new leg."""
        # Reset all player marks and scores
        for player in self.players:
            player.marks = [0] * len(CRICKET_NUMBERS)
            player.score = 0
        
        # Reset game state
        self.winner_index = None
        self.leg_winner_index = None
        self.set_winner_index = None
        self.turn_history = []
        self.last_completed_turn = [None] * MAX_DARTS_PER_TURN
        
        # Rotate starting player based on leg number (leg 1 = player 0, leg 2 = player 1, etc.)
        self.current_player_index = (self.current_leg - 1) % len(self.players)
        self.start_turn()

    # ------------------------------------------------------------------
    # State exposure
    # ------------------------------------------------------------------
    def get_state(self) -> Dict:
        state = {
            "mode": self.mode,
            "numbers": CRICKET_NUMBERS,
            "currentPlayer": self.current_player_index if self.players else None,
            "players": [
                {
                    "name": player.name,
                    "score": player.score,
                    "marks": list(player.marks),
                    "legsWon": player.legs_won,
                    "setsWon": player.sets_won,
                }
                for player in self.players
            ],
            "currentTurn": {
                "darts": [
                    dart.raw_score if dart is not None else None
                    for dart in self.current_turn_darts
                ]
            },
            "lastCompletedTurn": list(self.last_completed_turn),
            "winner": self.winner_index,
            "match": {
                "legsPerSet": self.legs_per_set,
                "setsToWin": self.sets_to_win,
                "currentSet": self.current_set,
                "currentLeg": self.current_leg,
                "legWinner": self.leg_winner_index,
                "setWinner": self.set_winner_index,
                "matchWinner": self.match_winner_index,
            },
        }

        stats_summary = []
        for idx, _player in enumerate(self.players):
            darts: List[CricketDartResult] = []
            turn_marks: List[int] = []

            for player_index, darts_list in self.turn_history:
                if player_index == idx:
                    darts.extend(darts_list)
                    turn_marks.append(sum(d.marks_awarded for d in darts_list))

            if idx == self.current_player_index:
                current_darts = [dart for dart in self.current_turn_darts if dart is not None]
                if current_darts:
                    darts.extend(current_darts)
                    turn_marks.append(sum(d.marks_awarded for d in current_darts))

            darts_thrown = len(darts)
            marks_total = sum(d.marks_awarded for d in darts)
            mpr = 0.0
            if darts_thrown:
                mpr = round((marks_total / darts_thrown) * 3.0, 2)

            first_nine = darts[:9]
            first_nine_mpr = 0.0
            if first_nine:
                marks_first_nine = sum(d.marks_awarded for d in first_nine)
                first_nine_mpr = round((marks_first_nine / len(first_nine)) * 3.0, 2)

            best_turn = max(turn_marks) if turn_marks else 0
            mark_counts = {str(k): sum(1 for marks in turn_marks if marks == k) for k in range(3, 10)}
            best_score = max((d.raw_score.get("score", 0) if d.raw_score else 0) for d in darts) if darts else 0

            stats_summary.append({
                "dartsThrown": darts_thrown,
                "marksTotal": marks_total,
                "mpr": mpr,
                "firstNineMpr": first_nine_mpr,
                "bestTurnMarks": best_turn,
                "markCounts": mark_counts,
                "bestScore": best_score,
            })

        state["stats"] = stats_summary
        state["matchStats"] = self._build_match_stats()
        state["legStats"] = self._build_leg_stats()
        return state

    def _convert_summary_to_stats(self, summary: Dict[str, Any]) -> Dict[str, Any]:
        darts = int(summary.get("darts", 0) or 0)
        marks_total = int(summary.get("marks", 0) or 0)
        first_nine_marks = int(summary.get("firstNineMarks", 0) or 0)
        first_nine_darts = int(summary.get("firstNineDarts", min(darts, 9)) or min(darts, 9))
        best_turn_marks = int(summary.get("bestTurnMarks", 0) or 0)
        best_score = int(summary.get("bestScore", 0) or 0)
        mark_counts_raw: Dict[str, int] = summary.get("markCounts", {}) or {}

        mpr = (marks_total / darts * 3.0) if darts else 0.0
        first_nine_mpr = (first_nine_marks / first_nine_darts * 3.0) if first_nine_darts else 0.0

        mark_counts = {str(k): int(mark_counts_raw.get(str(k), 0) or 0) for k in range(3, 10)}

        return {
            "dartsThrown": darts,
            "marksTotal": marks_total,
            "mpr": round(mpr, 2),
            "firstNineMpr": round(first_nine_mpr, 2),
            "bestTurnMarks": best_turn_marks,
            "bestScore": best_score,
            "markCounts": mark_counts,
        }

    def _build_match_stats(self) -> List[Dict[str, Any]]:
        player_count = len(self.players)
        totals: List[Dict[str, Any]] = [
            {
                "darts": 0,
                "marks": 0,
                "firstNineMarks": 0,
                "firstNineDarts": 0,
                "bestTurnMarks": 0,
                "bestScore": 0,
                "markCounts": {str(k): 0 for k in range(3, 10)},
            }
            for _ in range(player_count)
        ]

        for entry in self.completed_leg_summaries:
            summaries = entry.get("rawSummaries") or []
            for idx, summary in enumerate(summaries):
                if idx >= player_count:
                    continue
                total = totals[idx]
                leg_darts = int(summary.get("darts", 0) or 0)
                leg_marks = int(summary.get("marks", 0) or 0)
                leg_first_nine_marks = int(summary.get("firstNineMarks", 0) or 0)
                leg_first_nine_darts = int(summary.get("firstNineDarts", min(leg_darts, 9)) or min(leg_darts, 9))
                total["darts"] += leg_darts
                total["marks"] += leg_marks
                total["firstNineMarks"] += leg_first_nine_marks
                total["firstNineDarts"] += leg_first_nine_darts
                total["bestTurnMarks"] = max(total["bestTurnMarks"], int(summary.get("bestTurnMarks", 0) or 0))
                total["bestScore"] = max(total["bestScore"], int(summary.get("bestScore", 0) or 0))
                mark_counts_raw: Dict[str, int] = summary.get("markCounts", {}) or {}
                for key in total["markCounts"]:
                    total["markCounts"][key] += int(mark_counts_raw.get(key, 0) or 0)

        stats: List[Dict[str, Any]] = []
        for total in totals:
            darts = total["darts"]
            marks = total["marks"]
            first_nine_marks = total["firstNineMarks"]
            first_nine_darts = total["firstNineDarts"] if total["firstNineDarts"] else min(darts, 9)

            mpr = (marks / darts * 3.0) if darts else 0.0
            first_nine_mpr = (first_nine_marks / first_nine_darts * 3.0) if first_nine_darts else 0.0

            stats.append(
                {
                    "dartsThrown": darts,
                    "marksTotal": marks,
                    "mpr": round(mpr, 2),
                    "firstNineMpr": round(first_nine_mpr, 2),
                    "bestTurnMarks": total["bestTurnMarks"],
                    "bestScore": total["bestScore"],
                    "markCounts": dict(total["markCounts"]),
                }
            )

        return stats

    def _build_leg_stats(self) -> List[Dict[str, Any]]:
        leg_stats: List[Dict[str, Any]] = []
        for entry in self.completed_leg_summaries:
            summaries = entry.get("rawSummaries") or []
            stats = [self._convert_summary_to_stats(summary) for summary in summaries]
            leg_stats.append(
                {
                    "setNumber": entry.get("setNumber"),
                    "legNumber": entry.get("legNumber"),
                    "winnerIndex": entry.get("winnerIndex"),
                    "stats": stats,
                }
            )
        return leg_stats


__all__ = [
    "CricketGame",
    "CricketPlayerState",
    "CRICKET_NUMBERS",
]
