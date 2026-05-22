"""X01 game management for the dart detector backend."""
from __future__ import annotations

from dataclasses import dataclass
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


def _is_inner_bull(dart: Optional[Dict]) -> bool:
    if not dart:
        return False
    if dart.get("zone") == "inner_bull":
        return True
    try:
        segment = int(dart.get("segment", 0))
    except (TypeError, ValueError):
        segment = 0
    return segment == 25 and int(dart.get("score") or 0) == 50


def _is_double(dart: Optional[Dict]) -> bool:
    if not dart:
        return False
    if _is_inner_bull(dart):
        return True
    if dart.get("zone") == "double":
        return True
    try:
        return int(dart.get("multiplier") or 0) == 2
    except (TypeError, ValueError):
        return False


def _is_triple(dart: Optional[Dict]) -> bool:
    if not dart:
        return False
    if dart.get("zone") == "triple":
        return True
    try:
        return int(dart.get("multiplier") or 0) == 3
    except (TypeError, ValueError):
        return False


def _qualifies_for_in(dart: Dict, mode: str) -> bool:
    if mode == "straight":
        return True
    if mode == "double":
        return _is_double(dart)
    if mode == "master":
        return _is_double(dart) or _is_triple(dart)
    return True


def _is_valid_checkout(dart: Dict, mode: str) -> bool:
    if mode == "straight":
        return True
    if mode == "double":
        return _is_double(dart)
    if mode == "master":
        return _is_double(dart) or _is_triple(dart)
    return True


def _score_value(dart: Optional[Dict]) -> int:
    if not dart:
        return 0
    try:
        return max(0, int(round(float(dart.get("score", 0) or 0))))
    except (TypeError, ValueError):
        return 0


@dataclass
class X01PlayerState:
    name: str
    starting_score: int
    score: int
    has_in: bool
    in_mode: str = "straight"
    out_mode: str = "double"
    darts_thrown: int = 0
    total_scored: int = 0
    legs_won: int = 0
    sets_won: int = 0
    team_id: Optional[int] = None  # Team assignment for team play mode


@dataclass
class X01TeamState:
    """Team state for team play mode."""
    team_id: int
    team_name: str
    player_indices: List[int]
    score: int
    starting_score: int
    has_in: bool
    legs_won: int = 0
    sets_won: int = 0
    team_color: str = "#ef4444"  # Default to red


@dataclass
class X01TurnResult:
    darts: List[Optional[Dict]]
    applied_scores: List[int]
    scored: int
    remaining: int
    bust: bool
    finished: bool
    darts_used: int
    score_before: int
    has_in_before: bool
    has_in_after: bool


class X01Game:
    """Backend turn/leg management for X01."""

    def __init__(self) -> None:
        self.start_score: int = 501
        self.in_mode: str = "straight"
        self.out_mode: str = "double"
        self.players: List[X01PlayerState] = []
        self.current_player_index: int = 0
        self.current_turn_darts: List[Optional[Dict]] = [None] * MAX_DARTS_PER_TURN
        self.current_turn_result: X01TurnResult = self._make_empty_turn_result()
        self.last_completed_turn: List[Optional[Dict]] = [None] * MAX_DARTS_PER_TURN
        self.last_committed_turn: Optional[Dict[str, Any]] = None
        self.turn_history: List[Tuple[int, X01TurnResult]] = []
        self.winner_index: Optional[int] = None
        self.starting_player_index: int = 0
        self.next_leg_starting_player_index: int = 0
        self._turn_start_score: int = self.start_score
        self._turn_start_has_in: bool = True
        self._last_leg_summary: Optional[List[Dict[str, Any]]] = None
        self.completed_leg_summaries: List[Dict[str, Any]] = []
        
        # Match format
        self.legs_per_set: int = 3  # Best of 5 legs = first to 3
        self.sets_to_win: int = 1   # Single set match by default
        self.current_set: int = 1
        self.current_leg: int = 1
        self.leg_winner_index: Optional[int] = None
        self.set_winner_index: Optional[int] = None
        self.match_winner_index: Optional[int] = None
        self.free_play: bool = False
        
        # Last Man Standing mode
        self.game_variant: str = "standard"  # "standard" | "last_man_standing" | "team_play"
        self.lms_total_legs: int = 3
        self.lms_current_leg: int = 1
        self.lms_leg_results: List[List[int]] = []  # [leg_index][player_index] = finish_position
        self.lms_player_points: List[int] = []  # Total points per player
        self.lms_finished_players: List[bool] = []  # Track who finished current leg
        self.lms_finish_order: List[int] = []  # Player indices in finish order for current leg
        
        # Team Play mode
        self.teams: List[X01TeamState] = []  # Team configurations
        self.current_team_index: int = 0  # Current team taking turn
        self.team_turn_order: List[int] = []  # Order of player indices for team rotation

    # ------------------------------------------------------------------
    # Game setup
    # ------------------------------------------------------------------
    def start_game(
        self,
        player_names: List[str],
        *,
        start_score: int,
        in_mode: str,
        out_mode: str,
        starting_player: int = 0,
        legs_per_set: int = 3,
        sets_to_win: int = 1,
        free_play: bool = False,
        player_settings: Optional[List[Dict[str, Any]]] = None,
        game_variant: str = "standard",
        lms_total_legs: int = 3,
        teams: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        names = [name.strip() for name in player_names if name and name.strip()]
        if not names:
            raise ValueError("At least one player name is required")

        self.start_score = int(start_score)
        self.in_mode = in_mode or "straight"
        self.out_mode = out_mode or "double"
        self.legs_per_set = max(1, int(legs_per_set))
        self.sets_to_win = max(1, int(sets_to_win))
        self.free_play = bool(free_play)
        
        # Set game variant
        self.game_variant = game_variant or "standard"
        self.lms_total_legs = max(1, int(lms_total_legs))
        self.lms_current_leg = 1

        # Create players with individual or global settings
        self.players = []
        for idx, name in enumerate(names):
            # Get per-player settings if provided
            if player_settings and idx < len(player_settings):
                p_settings = player_settings[idx]
                p_start_score = int(p_settings.get("startScore", self.start_score))
                p_in_mode = p_settings.get("inMode", self.in_mode) or "straight"
                p_out_mode = p_settings.get("outMode", self.out_mode) or "double"
                p_team_id = p_settings.get("teamId")
            else:
                p_start_score = self.start_score
                p_in_mode = self.in_mode
                p_out_mode = self.out_mode
                p_team_id = None
            
            needs_in = p_in_mode != "straight"
            self.players.append(
                X01PlayerState(
                    name=name,
                    starting_score=p_start_score,
                    score=p_start_score,
                    has_in=not needs_in,
                    in_mode=p_in_mode,
                    out_mode=p_out_mode,
                    legs_won=0,
                    sets_won=0,
                    team_id=p_team_id,
                )
            )
        
        # Initialize team play mode if teams are provided
        if self.game_variant == "team_play" and teams:
            self._initialize_teams(teams)
        self.starting_player_index = max(0, min(starting_player, len(self.players) - 1))
        self.next_leg_starting_player_index = (
            (self.starting_player_index + 1) % len(self.players) if self.players else 0
        )
        self.current_player_index = self.starting_player_index
        self.winner_index = None
        self.leg_winner_index = None
        self.set_winner_index = None
        self.match_winner_index = None
        self.current_set = 1
        self.current_leg = 1
        self.turn_history = []
        self.last_completed_turn = [None] * MAX_DARTS_PER_TURN
        self.last_committed_turn = None
        self._last_leg_summary = None
        self.completed_leg_summaries = []
        
        # Initialize Last Man Standing state
        if self.game_variant == "last_man_standing":
            self.lms_player_points = [0] * len(self.players)
            self.lms_leg_results = []
            self.lms_finished_players = [False] * len(self.players)
            self.lms_finish_order = []
        
        # Set initial turn state
        if self.game_variant == "team_play":
            active_player_idx = self.team_turn_order[0] if self.team_turn_order else 0
            self.current_player_index = active_player_idx
            team = self._get_player_team(active_player_idx)
            if team:
                self._turn_start_score = team.score
                self._turn_start_has_in = team.has_in
            else:
                active_player = self.players[active_player_idx]
                self._turn_start_score = active_player.score
                self._turn_start_has_in = active_player.has_in
        else:
            active_player = self.players[self.current_player_index]
            self._turn_start_score = active_player.score
            self._turn_start_has_in = active_player.has_in
        self._reset_turn_buffers()

    def reset_match(self) -> None:
        if not self.players:
            return
        for player in self.players:
            needs_in = player.in_mode != "straight"
            player.score = player.starting_score
            player.has_in = not needs_in
            player.darts_thrown = 0
            player.total_scored = 0
        self.winner_index = None
        self.turn_history = []
        self.last_completed_turn = [None] * MAX_DARTS_PER_TURN
        self.last_committed_turn = None
        self._last_leg_summary = None
        self.completed_leg_summaries = []
        self.current_player_index = self.starting_player_index if self.players else 0
        self.next_leg_starting_player_index = (
            (self.starting_player_index + 1) % len(self.players) if self.players else 0
        )
        active = self.players[self.current_player_index]
        self._turn_start_score = active.score
        self._turn_start_has_in = active.has_in
        self._reset_turn_buffers()

    # ------------------------------------------------------------------
    # Turn lifecycle
    # ------------------------------------------------------------------
    def start_turn(self) -> None:
        if not self.players:
            return
        active_player = self.players[self.current_player_index]
        self._turn_start_score = active_player.score
        self._turn_start_has_in = active_player.has_in
        self._reset_turn_buffers()

    def sync_to_player_turn(self, player_index: int) -> None:
        """Force the active turn owner when network sync says another seat is up next.

        This is only safe while the current turn is empty.
        """
        if not self.players:
            return
        if any(dart is not None for dart in self.current_turn_darts):
            raise ValueError("Cannot sync turn owner while current turn already has darts")
        if player_index < 0 or player_index >= len(self.players):
            raise ValueError("Invalid player index")
        self.current_player_index = player_index
        active_player = self.players[self.current_player_index]
        self._turn_start_score = active_player.score
        self._turn_start_has_in = active_player.has_in
        self._reset_turn_buffers()

    def record_dart(self, dart_index: int, score: Optional[Dict]) -> None:
        if not self.players:
            return
        if dart_index < 0 or dart_index >= MAX_DARTS_PER_TURN:
            return
        self._ensure_turn_slot(dart_index)
        self.current_turn_darts[dart_index] = copy.deepcopy(score) if score is not None else None
        self.current_turn_result = self._evaluate_current_turn()
        
        # Update player score immediately after each dart for live feedback
        player = self.players[self.current_player_index]
        result = self.current_turn_result
        
        # Temporarily update the score (will be finalized in complete_turn)
        if result.bust:
            player.score = self._turn_start_score
        else:
            player.score = result.remaining
        
        # Update has_in status
        player.has_in = result.has_in_after
        
        # In team play mode, also update team score
        if self.game_variant == "team_play":
            team = self._get_player_team(self.current_player_index)
            if team:
                if result.bust:
                    team.score = self._turn_start_score
                else:
                    team.score = result.remaining
                team.has_in = result.has_in_after

    def complete_turn(self) -> None:
        if not self.players:
            return

        self.current_turn_result = self._evaluate_current_turn()
        result = self.current_turn_result
        turn_index = len(self.turn_history) + 1

        player = self.players[self.current_player_index]

        player.darts_thrown += result.darts_used
        player.total_scored += result.scored

        # In team play mode, update team score and sync to all team members
        if self.game_variant == "team_play":
            team = self._get_player_team(self.current_player_index)
            if team:
                if result.bust:
                    team.score = self._turn_start_score
                else:
                    team.score = result.remaining
                team.has_in = result.has_in_after
                
                # Sync team score to all team members
                for player_idx in team.player_indices:
                    self.players[player_idx].score = team.score
                    self.players[player_idx].has_in = team.has_in
        else:
            # Standard mode: update individual player score
            if result.bust:
                player.score = self._turn_start_score
            else:
                player.score = result.remaining
            player.has_in = result.has_in_after
        
        self.last_completed_turn = [copy.deepcopy(d) if d is not None else None for d in self.current_turn_darts]
        self.turn_history.append((self.current_player_index, copy.deepcopy(result)))
        self.last_committed_turn = self._build_turn_payload(self.current_player_index, result, turn_index)

        if result.finished:
            if self.game_variant == "last_man_standing":
                self._complete_leg_lms()
            elif self.game_variant == "team_play":
                self.winner_index = self.current_player_index
                self.leg_winner_index = self.current_player_index
                self._complete_leg_team_play()
            else:
                self.winner_index = self.current_player_index
                self.leg_winner_index = self.current_player_index
                self._complete_leg()
            return

        # Advance to next player
        if self.game_variant == "last_man_standing":
            # In LMS mode, skip players who have already finished
            self._advance_to_next_unfinished_player()
        elif self.game_variant == "team_play":
            # Team play mode: use team turn order
            self._advance_to_next_player_team_play()
        else:
            # Standard mode: simple rotation
            self.current_player_index = (self.current_player_index + 1) % len(self.players)
            next_player = self.players[self.current_player_index]
            self._turn_start_score = next_player.score
            self._turn_start_has_in = next_player.has_in
            self._reset_turn_buffers()

    def undo_last_turn(self) -> bool:
        """Undo the last committed turn within the current leg."""
        if not self.players:
            return False
        # Keep undo safe and deterministic: only while leg/set/match is still live.
        if self.match_winner_index is not None or self.winner_index is not None:
            return False
        if self.leg_winner_index is not None or self.set_winner_index is not None:
            return False
        if not self.turn_history:
            return False
        # LMS uses finish-order side effects once players start checking out.
        # Until that point, undo is safe and behaves like standard X01.
        if self.game_variant == "last_man_standing":
            if any(self.lms_finished_players) or bool(self.lms_finish_order):
                return False

        owner_idx, turn = self.turn_history.pop()
        if owner_idx < 0 or owner_idx >= len(self.players):
            return False

        player = self.players[owner_idx]
        player.darts_thrown = max(0, int(player.darts_thrown) - int(turn.darts_used))
        player.total_scored = max(0, int(player.total_scored) - int(turn.scored))

        self.current_player_index = owner_idx
        if self.game_variant == "team_play":
            team = self._get_player_team(owner_idx)
            if team is not None:
                team.score = int(turn.score_before)
                team.has_in = bool(turn.has_in_before)
                for teammate_idx in team.player_indices:
                    if 0 <= teammate_idx < len(self.players):
                        teammate = self.players[teammate_idx]
                        teammate.score = team.score
                        teammate.has_in = team.has_in
                self._turn_start_score = team.score
                self._turn_start_has_in = team.has_in
            else:
                # Fallback safety if team mapping is missing.
                player.score = int(turn.score_before)
                player.has_in = bool(turn.has_in_before)
                self._turn_start_score = player.score
                self._turn_start_has_in = player.has_in
        else:
            player.score = int(turn.score_before)
            player.has_in = bool(turn.has_in_before)
            self._turn_start_score = player.score
            self._turn_start_has_in = player.has_in

        self._reset_turn_buffers()

        if self.turn_history:
            _, prev_turn = self.turn_history[-1]
            self.last_completed_turn = [copy.deepcopy(d) if d is not None else None for d in prev_turn.darts]
            owner_idx, turn = self.turn_history[-1]
            self.last_committed_turn = self._build_turn_payload(owner_idx, turn, len(self.turn_history))
        else:
            self.last_completed_turn = [None] * MAX_DARTS_PER_TURN
            self.last_committed_turn = None
        return True

    def _complete_leg(self) -> None:
        """Complete the current leg and check for set/match completion."""
        if self.leg_winner_index is None:
            return
        
        self._last_leg_summary = self._generate_leg_summary()
        
        # Award leg to winner
        winner = self.players[self.leg_winner_index]
        winner.legs_won += 1

        if self.free_play:
            self.current_leg += 1
            self._start_new_leg()
            return
        
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

        bucket_thresholds = [
            ("40plus", 40),
            ("60plus", 60),
            ("80plus", 80),
            ("100plus", 100),
            ("120plus", 120),
            ("140plus", 140),
            ("170plus", 170),
            ("180", 180),
        ]

        # Build per-player turn list
        per_player_turns: List[List[X01TurnResult]] = [[] for _ in self.players]
        for owner_idx, turn in self.turn_history:
            if 0 <= owner_idx < len(per_player_turns):
                per_player_turns[owner_idx].append(turn)

        for idx, player in enumerate(self.players):
            turns = per_player_turns[idx]
            darts_total = 0
            score_total = 0
            per_dart_scores: List[int] = []
            visit_buckets = {key: 0 for key, _ in bucket_thresholds}
            visit_totals: List[int] = []
            checkout_attempts = 0
            checkout_successes = 0
            turn_darts: List[List[Dict[str, Any]]] = []
            turn_applied_scores: List[List[int]] = []

            for turn in turns:
                darts_total += turn.darts_used
                score_total += turn.scored
                per_dart_scores.extend(turn.applied_scores[: turn.darts_used])
                turn_darts.append(
                    [
                        copy.deepcopy(dart)
                        for dart in turn.darts[: turn.darts_used]
                        if isinstance(dart, dict)
                    ]
                )
                turn_applied_scores.append(list(turn.applied_scores[: turn.darts_used]))
                visit_total = sum(turn.applied_scores[: turn.darts_used])
                visit_totals.append(visit_total)
                # Find the highest bucket this visit qualifies for
                matched_bucket = None
                for bucket_key, threshold in reversed(bucket_thresholds):
                    if visit_total >= threshold:
                        matched_bucket = bucket_key
                        break
                if matched_bucket:
                    visit_buckets[matched_bucket] += 1
                if turn.score_before <= 170:
                    checkout_attempts += 1
                if turn.finished:
                    checkout_successes += 1

            first_nine_scores = per_dart_scores[:9]
            first_nine_darts = len(first_nine_scores)
            first_nine_total = sum(first_nine_scores)

            remaining = self.start_score
            pre170_darts = 0
            pre170_score = 0
            for value in per_dart_scores:
                if remaining <= 170:
                    break
                pre170_darts += 1
                pre170_score += value
                remaining -= value

            summary = {
                "mode": "x01",
                "darts": darts_total,
                "score": score_total,
                "firstNineScore": first_nine_total,
                "firstNineDarts": first_nine_darts,
                "pre170Score": pre170_score,
                "pre170Darts": pre170_darts,
                "checkoutAttempts": checkout_attempts,
                "checkoutSuccesses": checkout_successes,
                "visitBuckets": visit_buckets,
                "visitCount": len(turns),
                "visits": visit_totals,
                "turnDarts": turn_darts,
                "turnAppliedScores": turn_applied_scores,
                "winner": bool(self.leg_winner_index == idx),
            }
            summaries.append(summary)

        if summaries:
            winner_team_id = None
            if self.game_variant == "team_play" and self.leg_winner_index is not None:
                winning_team = self._get_player_team(self.leg_winner_index)
                winner_team_id = winning_team.team_id if winning_team is not None else None
            self.completed_leg_summaries.append(
                {
                    "setNumber": self.current_set,
                    "legNumber": self.current_leg,
                    "winnerIndex": self.leg_winner_index,
                    "winnerTeamId": winner_team_id,
                    "rawSummaries": copy.deepcopy(summaries),
                }
            )

        return summaries
    
    def _complete_set(self) -> None:
        """Complete the current set and check for match completion."""
        if self.set_winner_index is None:
            return

        if self.free_play:
            self.current_set += 1
            self.current_leg = 1
            self._start_new_leg()
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
        """Reset scores and state for a new leg."""
        # Reset all player scores to their individual starting scores
        for player in self.players:
            player.score = player.starting_score
            needs_in = player.in_mode != "straight"
            player.has_in = not needs_in
        
        # Reset leg-specific state
        self.winner_index = None
        self.leg_winner_index = None
        self.set_winner_index = None
        self.turn_history = []
        self.last_completed_turn = [None] * MAX_DARTS_PER_TURN
        
        # Rotate the leg opener continuously from the original opener so
        # bull-off winners do not keep starting consecutive legs or sets.
        self.current_player_index = self.next_leg_starting_player_index % len(self.players)
        self.next_leg_starting_player_index = (self.current_player_index + 1) % len(self.players)
        active_player = self.players[self.current_player_index]
        self._turn_start_score = active_player.score
        self._turn_start_has_in = active_player.has_in
        self._reset_turn_buffers()
    
    # ------------------------------------------------------------------
    # Last Man Standing mode methods
    # ------------------------------------------------------------------
    def _complete_leg_lms(self) -> None:
        """Handle leg completion in Last Man Standing mode."""
        if self.current_player_index >= len(self.lms_finished_players):
            return
        
        # Mark player as finished and record their position
        if not self.lms_finished_players[self.current_player_index]:
            self.lms_finished_players[self.current_player_index] = True
            self.lms_finish_order.append(self.current_player_index)
        
        # Check if only one player remains (they automatically get last place)
        unfinished_count = sum(1 for finished in self.lms_finished_players if not finished)
        if unfinished_count == 1:
            # Find the last player and mark them as finished
            for idx, finished in enumerate(self.lms_finished_players):
                if not finished:
                    self.lms_finished_players[idx] = True
                    self.lms_finish_order.append(idx)
                    break
        
        # Check if all players have finished
        if all(self.lms_finished_players):
            self._award_lms_points()
            self._last_leg_summary = self._generate_leg_summary()

            if self.free_play:
                self.lms_current_leg += 1
                self._start_new_leg_lms()
            else:
                # Check if we need more legs or if match is complete
                if self.lms_current_leg < self.lms_total_legs:
                    # Start next leg
                    self.lms_current_leg += 1
                    self._start_new_leg_lms()
                else:
                    # All legs complete, check for ties
                    self._check_lms_match_winner()
        else:
            # Clear winner_index so game continues
            self.winner_index = None
            self.leg_winner_index = None
            # Move to next player who hasn't finished
            self._advance_to_next_unfinished_player()
    
    def _award_lms_points(self) -> None:
        """Award points based on finish positions in current leg."""
        # Points: 1st=6, 2nd=5, 3rd=4, 4th=3, 5th=2, 6th=1
        points_map = {0: 6, 1: 5, 2: 4, 3: 3, 4: 2, 5: 1}
        
        # Record leg results
        leg_result = [0] * len(self.players)
        for position, player_idx in enumerate(self.lms_finish_order):
            finish_position = position + 1
            leg_result[player_idx] = finish_position
            
            # Award points
            points = points_map.get(position, 0)
            if player_idx < len(self.lms_player_points):
                self.lms_player_points[player_idx] += points
        
        self.lms_leg_results.append(leg_result)
    
    def _check_lms_match_winner(self) -> None:
        """Check if match is complete and determine winner."""
        if not self.lms_player_points:
            return
        
        max_points = max(self.lms_player_points)
        winners = [i for i, pts in enumerate(self.lms_player_points) if pts == max_points]
        
        if len(winners) == 1:
            # Clear winner
            self.match_winner_index = winners[0]
            self.winner_index = winners[0]
        else:
            # Tie - would need sudden death (for now, just pick first)
            # TODO: Implement sudden death in future
            self.match_winner_index = winners[0]
            self.winner_index = winners[0]
    
    def _start_new_leg_lms(self) -> None:
        """Reset scores and state for a new leg in LMS mode."""
        # Reset all player scores to their individual starting scores
        for player in self.players:
            player.score = player.starting_score
            needs_in = player.in_mode != "straight"
            player.has_in = not needs_in
        
        # Reset leg-specific state
        self.winner_index = None
        self.leg_winner_index = None
        self.turn_history = []
        self.last_completed_turn = [None] * MAX_DARTS_PER_TURN
        self.lms_finished_players = [False] * len(self.players)
        self.lms_finish_order = []
        
        # Reset to first player for new leg
        self.current_player_index = self.starting_player_index if self.players else 0
        self.next_leg_starting_player_index = (
            (self.starting_player_index + 1) % len(self.players) if self.players else 0
        )
        active_player = self.players[self.current_player_index]
        self._turn_start_score = active_player.score
        self._turn_start_has_in = active_player.has_in
        self._reset_turn_buffers()
    
    def _advance_to_next_unfinished_player(self) -> None:
        """Move to the next player who hasn't finished the leg."""
        if not self.players:
            return
        
        start_index = self.current_player_index
        attempts = 0
        max_attempts = len(self.players)
        
        while attempts < max_attempts:
            self.current_player_index = (self.current_player_index + 1) % len(self.players)
            attempts += 1
            
            # Check if this player hasn't finished
            if not self.lms_finished_players[self.current_player_index]:
                next_player = self.players[self.current_player_index]
    
    # ------------------------------------------------------------------
    # Team Play mode methods
    # ------------------------------------------------------------------
    def _initialize_teams(self, teams_config: List[Dict[str, Any]]) -> None:
        """Initialize teams for team play mode."""
        self.teams = []
        self.team_turn_order = []
        
        for team_data in teams_config:
            team_id = team_data.get("teamId", 0)
            team_name = team_data.get("teamName", f"Team {team_id + 1}")
            player_indices = team_data.get("playerIndices", [])
            team_color = team_data.get("teamColor", "#ef4444")  # Default to red
            
            if not player_indices:
                continue
            
            # Get team start score from first player in team
            first_player_idx = player_indices[0]
            if first_player_idx < len(self.players):
                first_player = self.players[first_player_idx]
                team_start_score = first_player.starting_score
                needs_in = first_player.in_mode != "straight"
            else:
                team_start_score = self.start_score
                needs_in = self.in_mode != "straight"
            
            team = X01TeamState(
                team_id=team_id,
                team_name=team_name,
                player_indices=player_indices,
                score=team_start_score,
                starting_score=team_start_score,
                has_in=not needs_in,
                legs_won=0,
                sets_won=0,
                team_color=team_color,
            )
            self.teams.append(team)
        
        # Build turn order: alternate between teams, cycling through team members
        if self.teams:
            self._build_team_turn_order()
            self.current_player_index = self.team_turn_order[0] if self.team_turn_order else 0
    
    def _build_team_turn_order(self) -> None:
        """Build the turn order for team play (alternating teams)."""
        if not self.teams:
            return
        
        # Find max players per team
        max_players = max(len(team.player_indices) for team in self.teams)
        
        # Build turn order by alternating teams, then cycling through positions
        self.team_turn_order = []
        for position in range(max_players):
            for team in self.teams:
                if position < len(team.player_indices):
                    self.team_turn_order.append(team.player_indices[position])
    
    def _get_player_team(self, player_index: int) -> Optional[X01TeamState]:
        """Get the team for a given player index."""
        for team in self.teams:
            if player_index in team.player_indices:
                return team
        return None
    
    def _complete_leg_team_play(self) -> None:
        """Handle leg completion in team play mode."""
        if not self.teams:
            return
        
        # Find which team won
        winning_team = self._get_player_team(self.current_player_index)
        if not winning_team:
            return
        
        self._last_leg_summary = self._generate_leg_summary()
        
        # Award leg to winning team
        winning_team.legs_won += 1

        if self.free_play:
            self.current_leg += 1
            self._start_new_leg_team_play()
            return
        
        # Check if team won the set
        if winning_team.legs_won >= self.legs_per_set:
            self.set_winner_index = winning_team.team_id
            self._complete_set_team_play()
            return
        
        # Start next leg in same set
        self.current_leg += 1
        self._start_new_leg_team_play()
    
    def _complete_set_team_play(self) -> None:
        """Complete the current set in team play mode."""
        if self.set_winner_index is None:
            return

        if self.free_play:
            self.current_set += 1
            self.current_leg = 1
            self._start_new_leg_team_play()
            return
        
        # Find winning team
        winning_team = None
        for team in self.teams:
            if team.team_id == self.set_winner_index:
                winning_team = team
                break
        
        if not winning_team:
            return
        
        # Award set to winning team
        winning_team.sets_won += 1
        
        # Reset leg counts for all teams
        for team in self.teams:
            team.legs_won = 0
        
        # Check if team won the match
        if winning_team.sets_won >= self.sets_to_win:
            self.match_winner_index = winning_team.team_id
            return
        
        # Start next set
        self.current_set += 1
        self.current_leg = 1
        self._start_new_leg_team_play()
    
    def _start_new_leg_team_play(self) -> None:
        """Reset scores and state for a new leg in team play mode."""
        # Reset all team scores
        for team in self.teams:
            team.score = team.starting_score
            # Determine if team needs "in" based on first player's settings
            if team.player_indices:
                first_player = self.players[team.player_indices[0]]
                needs_in = first_player.in_mode != "straight"
                team.has_in = not needs_in
        
        # Reset all player scores (they share team score)
        for player in self.players:
            player.score = player.starting_score
            needs_in = player.in_mode != "straight"
            player.has_in = not needs_in
        
        # Reset leg-specific state
        self.winner_index = None
        self.leg_winner_index = None
        self.set_winner_index = None
        self.turn_history = []
        self.last_completed_turn = [None] * MAX_DARTS_PER_TURN
        
        # Reset to first player in turn order
        self.current_player_index = self.team_turn_order[0] if self.team_turn_order else 0
        active_player = self.players[self.current_player_index]
        self._turn_start_score = active_player.score
        self._turn_start_has_in = active_player.has_in
        self._reset_turn_buffers()
    
    def _advance_to_next_player_team_play(self) -> None:
        """Move to the next player in team turn order."""
        if not self.team_turn_order:
            return
        
        # Find current position in turn order
        try:
            current_pos = self.team_turn_order.index(self.current_player_index)
            next_pos = (current_pos + 1) % len(self.team_turn_order)
            self.current_player_index = self.team_turn_order[next_pos]
        except ValueError:
            # Current player not in turn order, start from beginning
            self.current_player_index = self.team_turn_order[0]
        
        # Use team score, not individual player score
        team = self._get_player_team(self.current_player_index)
        if team:
            self._turn_start_score = team.score
            self._turn_start_has_in = team.has_in
        else:
            next_player = self.players[self.current_player_index]
            self._turn_start_score = next_player.score
            self._turn_start_has_in = next_player.has_in
        self._reset_turn_buffers()

    def _advance_to_next_unfinished_player(self) -> None:
        """Move to the next player who hasn't finished the leg."""
        if not self.players:
            return
        
        start_index = self.current_player_index
        attempts = 0
        max_attempts = len(self.players)
        
        while attempts < max_attempts:
            self.current_player_index = (self.current_player_index + 1) % len(self.players)
            attempts += 1
            
            # Check if this player hasn't finished
            if not self.lms_finished_players[self.current_player_index]:
                next_player = self.players[self.current_player_index]
                self._turn_start_score = next_player.score
                self._turn_start_has_in = next_player.has_in
                self._reset_turn_buffers()
                return
        
        # If we get here, all players have finished (shouldn't happen)
        # Just stay on current player
        active_player = self.players[self.current_player_index]
        self._turn_start_score = active_player.score
        self._turn_start_has_in = active_player.has_in
        self._reset_turn_buffers()

    def _reset_leg_for_new_game(self) -> None:
        """Reset all player scores to their individual starting scores."""
        for player in self.players:
            player.score = player.starting_score
            needs_in = player.in_mode != "straight"
            player.has_in = not needs_in
        
        # Reset game state
        self.winner_index = None
        self.leg_winner_index = None
        self.set_winner_index = None
        self.turn_history = []
        self.last_completed_turn = [None] * MAX_DARTS_PER_TURN
        
        # Reset to first player for new leg
        self.current_player_index = 0
        active_player = self.players[self.current_player_index]
        self._turn_start_score = active_player.score
        self._turn_start_has_in = active_player.has_in
        self._reset_turn_buffers()

    # ------------------------------------------------------------------
    # State exposure
    # ------------------------------------------------------------------
    def get_state(self) -> Dict:
        players_payload: List[Dict] = []
        for idx, player in enumerate(self.players):
            darts_thrown = player.darts_thrown
            total_scored = player.total_scored
            average = (total_scored / darts_thrown * 3) if darts_thrown else 0.0

            per_dart_scores: List[int] = []
            for owner_idx, turn in self.turn_history:
                if owner_idx == idx:
                    per_dart_scores.extend(turn.applied_scores[:turn.darts_used])
            if idx == self.current_player_index:
                per_dart_scores.extend(self.current_turn_result.applied_scores[: self.current_turn_result.darts_used])

            first_nine_scores = per_dart_scores[:9]
            first_nine_average = (sum(first_nine_scores) / len(first_nine_scores) * 3) if first_nine_scores else average

            players_payload.append(
                {
                    "name": player.name,
                    "score": player.score,
                    "startingScore": player.starting_score,
                    "hasIn": player.has_in,
                    "inMode": player.in_mode,
                    "outMode": player.out_mode,
                    "dartsThrown": darts_thrown,
                    "totalScored": total_scored,
                    "average": round(average, 2),
                    "firstNineAverage": round(first_nine_average, 2),
                    "legsWon": player.legs_won,
                    "setsWon": player.sets_won,
                }
            )

        state = {
            "settings": {
                "startScore": self.start_score,
                "inMode": self.in_mode,
                "outMode": self.out_mode,
                "legsPerSet": self.legs_per_set,
                "setsToWin": self.sets_to_win,
                "freePlay": self.free_play,
                "gameVariant": self.game_variant,
            },
            "match": {
                "currentSet": self.current_set,
                "currentLeg": self.current_leg,
                "legWinner": self.leg_winner_index,
                "setWinner": self.set_winner_index,
                "matchWinner": self.match_winner_index,
            },
            "currentPlayer": self.current_player_index if self.players else None,
            "players": players_payload,
            "currentTurn": {
                "darts": [copy.deepcopy(d) if d is not None else None for d in self.current_turn_darts],
                "appliedScores": list(self.current_turn_result.applied_scores),
                "scored": self.current_turn_result.scored,
                "remaining": self.current_turn_result.remaining,
                "bust": self.current_turn_result.bust,
                "finished": self.current_turn_result.finished,
                "dartsUsed": self.current_turn_result.darts_used,
                "scoreBefore": self.current_turn_result.score_before,
                "hasInBefore": self.current_turn_result.has_in_before,
                "hasInAfter": self.current_turn_result.has_in_after,
                "turnIndex": len(self.turn_history) + 1,
            },
            "lastCompletedTurn": [copy.deepcopy(d) if d is not None else None for d in self.last_completed_turn],
            "winner": self.winner_index,
            "legWinner": self.leg_winner_index,
            "setWinner": self.set_winner_index,
            "matchWinner": self.match_winner_index,
        }
        
        # Add Last Man Standing specific state
        if self.game_variant == "last_man_standing":
            state["lms"] = {
                "totalLegs": self.lms_total_legs,
                "currentLeg": self.lms_current_leg,
                "playerPoints": list(self.lms_player_points),
                "legResults": [list(leg) for leg in self.lms_leg_results],
                "finishOrder": list(self.lms_finish_order),
                "matchComplete": self.match_winner_index is not None,
            }
        
        # Add Team Play specific state
        if self.game_variant == "team_play" and self.teams:
            teams_payload = []
            for team in self.teams:
                teams_payload.append({
                    "teamId": team.team_id,
                    "teamName": team.team_name,
                    "playerIndices": list(team.player_indices),
                    "score": team.score,
                    "startingScore": team.starting_score,
                    "hasIn": team.has_in,
                    "legsWon": team.legs_won,
                    "setsWon": team.sets_won,
                    "teamColor": team.team_color,
                })
            state["teams"] = teams_payload

        history_payload: List[Dict] = []
        for index, (owner_idx, turn) in enumerate(self.turn_history, start=1):
            history_payload.append(self._build_turn_payload(owner_idx, turn, index))

        state["turnHistory"] = history_payload
        state["lastTurn"] = history_payload[-1] if history_payload else None
        state["lastCommittedTurn"] = copy.deepcopy(self.last_committed_turn) if self.last_committed_turn is not None else None
        state["matchStats"] = self._build_match_stats()
        state["legStats"] = self._build_leg_stats()
        return state

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _reset_turn_buffers(self) -> None:
        self.current_turn_darts = [None] * MAX_DARTS_PER_TURN
        self.current_turn_result = self._make_empty_turn_result(
            score_before=self._turn_start_score,
            has_in_before=self._turn_start_has_in,
        )

    @staticmethod
    def _build_turn_payload(owner_idx: int, turn: X01TurnResult, turn_index: int) -> Dict[str, Any]:
        return {
            "turnIndex": int(turn_index),
            "playerIndex": int(owner_idx),
            "darts": [copy.deepcopy(d) if d is not None else None for d in turn.darts],
            "appliedScores": list(turn.applied_scores),
            "scored": turn.scored,
            "remaining": turn.remaining,
            "bust": turn.bust,
            "finished": turn.finished,
            "dartsUsed": turn.darts_used,
            "scoreBefore": turn.score_before,
            "hasInBefore": turn.has_in_before,
            "hasInAfter": turn.has_in_after,
        }

    def _ensure_turn_slot(self, dart_index: int) -> None:
        while len(self.current_turn_darts) < MAX_DARTS_PER_TURN:
            self.current_turn_darts.append(None)

    def _evaluate_current_turn(self) -> X01TurnResult:
        return self._evaluate_turn(
            darts=self.current_turn_darts,
            start_score=self._turn_start_score,
            has_in=self._turn_start_has_in,
        )

    def _evaluate_turn(self, darts: List[Optional[Dict]], start_score: int, has_in: bool) -> X01TurnResult:
        applied_scores = [0] * MAX_DARTS_PER_TURN
        remaining = start_score
        in_state = has_in
        got_in = False
        bust = False
        finished = False
        darts_used = 0

        # Get current player's in/out modes
        current_player = self.players[self.current_player_index] if self.players else None
        player_in_mode = current_player.in_mode if current_player else self.in_mode
        player_out_mode = current_player.out_mode if current_player else self.out_mode

        for index in range(MAX_DARTS_PER_TURN):
            dart = darts[index] if index < len(darts) else None
            if dart is None:
                continue

            darts_used += 1
            value = _score_value(dart)

            if not in_state:
                if _qualifies_for_in(dart, player_in_mode):
                    in_state = True
                    got_in = True
                else:
                    continue

            if value == 0:
                continue

            next_remaining = remaining - value

            if next_remaining < 0:
                bust = True
                break

            if next_remaining == 0:
                if _is_valid_checkout(dart, player_out_mode):
                    applied_scores[index] = value
                    remaining = 0
                    finished = True
                else:
                    bust = True
                break

            if next_remaining == 1 and player_out_mode != "straight":
                bust = True
                break

            applied_scores[index] = value
            remaining = next_remaining

        if bust:
            remaining = start_score
            applied_scores = [0] * MAX_DARTS_PER_TURN

        scored = sum(applied_scores)
        return X01TurnResult(
            darts=[copy.deepcopy(d) if d is not None else None for d in darts],
            applied_scores=applied_scores,
            scored=scored,
            remaining=remaining,
            bust=bust,
            finished=finished,
            darts_used=darts_used,
            score_before=start_score,
            has_in_before=has_in,
            has_in_after=in_state or got_in,
        )

    def _make_empty_turn_result(
        self,
        *,
        score_before: int = 0,
        has_in_before: bool = True,
    ) -> X01TurnResult:
        return X01TurnResult(
            darts=[None] * MAX_DARTS_PER_TURN,
            applied_scores=[0] * MAX_DARTS_PER_TURN,
            scored=0,
            remaining=score_before,
            bust=False,
            finished=False,
            darts_used=0,
            score_before=score_before,
            has_in_before=has_in_before,
            has_in_after=has_in_before,
        )

    def _convert_summary_to_stats(self, summary: Dict[str, Any]) -> Dict[str, Any]:
        darts = int(summary.get("darts", 0) or 0)
        total_scored = int(summary.get("score", 0) or 0)
        first_nine_score = int(summary.get("firstNineScore", 0) or 0)
        first_nine_darts = int(summary.get("firstNineDarts", 0) or 0)
        pre170_score = int(summary.get("pre170Score", 0) or 0)
        pre170_darts = int(summary.get("pre170Darts", 0) or 0)
        checkout_attempts = int(summary.get("checkoutAttempts", 0) or 0)
        checkout_successes = int(summary.get("checkoutSuccesses", 0) or 0)
        visit_buckets: Dict[str, int] = summary.get("visitBuckets", {}) or {}

        average = (total_scored / darts * 3.0) if darts else 0.0
        first_nine_average = (first_nine_score / first_nine_darts * 3.0) if first_nine_darts else 0.0
        average_to_170 = (pre170_score / pre170_darts * 3.0) if pre170_darts else 0.0
        checkout_percentage = (checkout_successes / checkout_attempts * 100.0) if checkout_attempts else 0.0

        buckets_for_display = {
            key: int(visit_buckets.get(key, 0) or 0)
            for key in ("60plus", "80plus", "100plus", "120plus", "140plus", "170plus", "180")
        }

        return {
            "dartsThrown": darts,
            "totalScored": total_scored,
            "average": round(average, 2),
            "firstNineAverage": round(first_nine_average, 2),
            "averageTo170": round(average_to_170, 2),
            "checkoutAttempts": checkout_attempts,
            "checkoutSuccesses": checkout_successes,
            "checkoutPercentage": round(checkout_percentage, 1),
            "turnBuckets": buckets_for_display,
            "turnDarts": copy.deepcopy(summary.get("turnDarts", []) or []),
        }

    def _build_match_stats(self) -> List[Dict[str, Any]]:
        player_count = len(self.players)
        totals: List[Dict[str, Any]] = [
            {
                "darts": 0,
                "score": 0,
                "firstNineScore": 0,
                "firstNineDarts": 0,
                "pre170Score": 0,
                "pre170Darts": 0,
                "checkoutAttempts": 0,
                "checkoutSuccesses": 0,
                "visitBuckets": {key: 0 for key in VISIT_BUCKET_KEYS},
                "turnDarts": [],
            }
            for _ in range(player_count)
        ]

        for entry in self.completed_leg_summaries:
            summaries = entry.get("rawSummaries") or []
            for idx, summary in enumerate(summaries):
                if idx >= player_count:
                    continue
                bucket_totals = totals[idx]
                bucket_totals["darts"] += int(summary.get("darts", 0) or 0)
                bucket_totals["score"] += int(summary.get("score", 0) or 0)
                bucket_totals["firstNineScore"] += int(summary.get("firstNineScore", 0) or 0)
                bucket_totals["firstNineDarts"] += int(summary.get("firstNineDarts", 0) or 0)
                bucket_totals["pre170Score"] += int(summary.get("pre170Score", 0) or 0)
                bucket_totals["pre170Darts"] += int(summary.get("pre170Darts", 0) or 0)
                bucket_totals["checkoutAttempts"] += int(summary.get("checkoutAttempts", 0) or 0)
                bucket_totals["checkoutSuccesses"] += int(summary.get("checkoutSuccesses", 0) or 0)
                raw_buckets: Dict[str, int] = summary.get("visitBuckets", {}) or {}
                for key in VISIT_BUCKET_KEYS:
                    bucket_totals["visitBuckets"][key] += int(raw_buckets.get(key, 0) or 0)
                raw_turn_darts = summary.get("turnDarts", []) or []
                if isinstance(raw_turn_darts, list):
                    bucket_totals["turnDarts"].extend(copy.deepcopy(raw_turn_darts))

        stats: List[Dict[str, Any]] = []
        for total in totals:
            darts = total["darts"]
            score = total["score"]
            first_nine_darts = total["firstNineDarts"]
            first_nine_score = total["firstNineScore"]
            pre170_darts = total["pre170Darts"]
            pre170_score = total["pre170Score"]
            attempts = total["checkoutAttempts"]
            successes = total["checkoutSuccesses"]

            average = (score / darts * 3.0) if darts else 0.0
            first_nine_average = (first_nine_score / first_nine_darts * 3.0) if first_nine_darts else 0.0
            average_to_170 = (pre170_score / pre170_darts * 3.0) if pre170_darts else 0.0
            checkout_percentage = (successes / attempts * 100.0) if attempts else 0.0

            buckets_for_display = {
                key: total["visitBuckets"].get(key, 0)
                for key in ("60plus", "80plus", "100plus", "120plus", "140plus", "170plus", "180")
            }

            stats.append(
                {
                    "dartsThrown": darts,
                    "totalScored": score,
                    "average": round(average, 2),
                    "firstNineAverage": round(first_nine_average, 2),
                    "averageTo170": round(average_to_170, 2),
                    "checkoutAttempts": attempts,
                    "checkoutSuccesses": successes,
                    "checkoutPercentage": round(checkout_percentage, 1),
                    "turnBuckets": buckets_for_display,
                    "turnDarts": copy.deepcopy(total.get("turnDarts", []) or []),
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
                    "winnerTeamId": entry.get("winnerTeamId"),
                    "stats": stats,
                }
            )
        return leg_stats


__all__ = ["X01Game", "X01PlayerState", "X01TeamState", "X01TurnResult"]
