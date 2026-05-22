"""Around the Clock game management for the dart detector backend."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
import copy
import random

MAX_DARTS_PER_TURN = 3


@dataclass
class AroundTheClockPlayerState:
    """Runtime state for an Around the Clock player."""
    
    name: str
    current_target_index: int = 0  # Index in target_sequence
    current_target_hits: int = 0  # Number of hits on current target
    darts_thrown: int = 0
    hits_per_target: List[int] = field(default_factory=list)  # Darts taken to hit each target
    attempts_per_target: List[int] = field(default_factory=lambda: [0] * 21)
    hits_count_per_target: List[int] = field(default_factory=lambda: [0] * 21)
    legs_won: int = 0
    sets_won: int = 0
    finished: bool = False


@dataclass
class AroundTheClockDartResult:
    """Stores how a dart affected state."""
    
    player_index: int
    target_hit: bool
    target_number: int
    raw_score: Optional[Dict]


class AroundTheClockGame:
    """Around the Clock game scorer."""
    
    def __init__(self) -> None:
        self.mode: str = "full"  # "full", "single", "double", "triple"
        self.order: str = "1-20-bull"  # "1-20-bull", "20-1-bull", "random-bull"
        self.hits_required: int = 1  # 1, 2, or 3 hits per target
        self.target_sequence: List[int] = []  # Generated sequence based on order
        self.players: List[AroundTheClockPlayerState] = []
        self.current_player_index: int = 0
        self.current_turn_darts: List[Optional[AroundTheClockDartResult]] = [None] * MAX_DARTS_PER_TURN
        self.last_completed_turn: List[Optional[Dict]] = [None] * MAX_DARTS_PER_TURN
        self.winner_index: Optional[int] = None
        self.turn_history: List[Tuple[int, List[AroundTheClockDartResult]]] = []
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
        mode: str = "full",
        order: str = "1-20-bull",
        hits_required: int = 1,
        starting_player: int = 0,
        legs_per_set: int = 3,
        sets_to_win: int = 1
    ) -> None:
        """
        Start a new Around the Clock game.
        
        Args:
            players: List of player names
            mode: Game mode - "full" (any segment), "single", "double", "triple"
            order: Target order - "1-20-bull", "20-1-bull", "random-bull"
            hits_required: Number of hits required per target (1, 2, or 3)
            starting_player: Index of starting player
            legs_per_set: Number of legs per set
            sets_to_win: Number of sets to win the match
        """
        filtered = [p.strip() for p in players if p and p.strip()]
        if not filtered:
            raise ValueError("At least one player name is required")
        
        self.mode = mode or "full"
        self.order = order or "1-20-bull"
        self.hits_required = max(1, min(hits_required or 1, 3))
        
        # Generate target sequence based on order
        self.target_sequence = self._generate_target_sequence(self.order)
        
        self.players = [AroundTheClockPlayerState(name=name) for name in filtered]
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
    
    def _generate_target_sequence(self, order: str) -> List[int]:
        """
        Generate the target sequence based on order setting.
        
        Args:
            order: "1-20-bull", "20-1-bull", or "random-bull"
            
        Returns:
            List of target numbers in order
        """
        if order == "20-1-bull":
            # Reverse: 20, 19, 18, ..., 2, 1, then bull (25)
            return list(range(20, 0, -1)) + [25]
        elif order == "random-bull":
            # Random order of 1-20, then bull
            targets = list(range(1, 21))
            random.shuffle(targets)
            return targets + [25]
        else:  # "1-20-bull" (default)
            # Normal: 1, 2, 3, ..., 19, 20, then bull (25)
            return list(range(1, 21)) + [25]
    
    def reset_match(self) -> None:
        """Reset the match to initial state."""
        if not self.players:
            return
        for player in self.players:
            player.current_target_index = 0
            player.current_target_hits = 0
            player.darts_thrown = 0
            player.hits_per_target = []
            player.attempts_per_target = [0] * 21
            player.hits_count_per_target = [0] * 21
            player.finished = False
        self.start_turn()
        self.last_completed_turn = [None] * MAX_DARTS_PER_TURN
        self.winner_index = None
        self.turn_history = []
        self._last_leg_summary = None
        self.completed_leg_summaries = []
        self.darts_since_last_hit = 0
    
    # ------------------------------------------------------------------
    # Turn handling
    # ------------------------------------------------------------------
    def start_turn(self) -> None:
        """Reset buffers for the current player without advancing turn."""
        self._reset_turn_buffers()
    
    def record_dart(self, dart_index: int, score: Optional[Dict]) -> None:
        """
        Apply or re-apply a dart result for the active player.
        
        Args:
            dart_index: Index of the dart (0-2)
            score: Score dictionary for the dart
        """
        if not self.players or dart_index < 0 or dart_index >= MAX_DARTS_PER_TURN:
            return
        
        self._ensure_turn_slot(dart_index)
        
        # Revert previous dart if exists
        previous = self.current_turn_darts[dart_index]
        if previous is not None:
            self._revert_dart(previous)
        
        # Compute and apply new dart
        result = self._compute_result(score)
        self.current_turn_darts[dart_index] = result
        self._update_winner()
    
    def complete_turn(self) -> None:
        """Finalize the active player's turn and rotate to the next player."""
        if not self.players:
            return
        
        # Fill in any missing darts as misses
        for dart_index in range(MAX_DARTS_PER_TURN):
            if self.current_turn_darts[dart_index] is None:
                player = self.players[self.current_player_index]
                target = (
                    self.target_sequence[player.current_target_index]
                    if player.current_target_index < len(self.target_sequence)
                    else 25
                )
                self.current_turn_darts[dart_index] = AroundTheClockDartResult(
                    player_index=self.current_player_index,
                    target_hit=False,
                    target_number=target,
                    raw_score={
                        "score": 0,
                        "multiplier": 0,
                        "segment": "0",
                        "zone": "miss",
                        "confidence": 1.0,
                    },
                )
        
        # Save turn to history
        turn_owner = self.current_player_index
        turn_snapshot = [copy.deepcopy(dart) for dart in self.current_turn_darts if dart is not None]
        if turn_snapshot:
            self.turn_history.append((turn_owner, turn_snapshot))
        
        # Save last completed turn
        self.last_completed_turn = [
            dart.raw_score if dart is not None else None
            for dart in self.current_turn_darts
        ]
        
        # Move to next player (skip finished players)
        self._advance_to_next_player()
        self.start_turn()
        self._update_winner()
        
        # Check if leg is won and handle leg/set completion
        if self.winner_index is not None and self.leg_winner_index is None:
            self.leg_winner_index = self.winner_index
            self._complete_leg()
    
    def _reset_turn_buffers(self) -> None:
        """Reset turn buffers."""
        self.current_turn_darts = [None] * MAX_DARTS_PER_TURN
    
    def _ensure_turn_slot(self, dart_index: int) -> None:
        """Ensure turn slots exist up to dart_index."""
        if len(self.current_turn_darts) < MAX_DARTS_PER_TURN:
            self.current_turn_darts.extend([None] * (MAX_DARTS_PER_TURN - len(self.current_turn_darts)))
        if dart_index >= len(self.current_turn_darts):
            self.current_turn_darts.extend([None] * (dart_index - len(self.current_turn_darts) + 1))
    
    # ------------------------------------------------------------------
    # Helpers for dart application
    # ------------------------------------------------------------------
    def _compute_result(self, score: Optional[Dict]) -> AroundTheClockDartResult:
        """
        Compute the result of a dart throw.
        
        Args:
            score: Score dictionary from dart detection
            
        Returns:
            AroundTheClockDartResult with hit status
        """
        player = self.players[self.current_player_index]
        
        # If player already finished, don't process any more hits
        if player.finished:
            raw_score = {
                "score": int(score.get("score", 0) or 0) if score else 0,
                "multiplier": int(score.get("multiplier", 0) or 0) if score else 0,
                "segment": str(score.get("segment", "0") or "0") if score else "0",
                "zone": (score.get("zone") or "miss").lower() if score else "miss",
                "confidence": float(score.get("confidence", 0.0) or 0.0) if score else 0.0,
            }
            # Get current target from sequence
            target = self.target_sequence[player.current_target_index] if player.current_target_index < len(self.target_sequence) else 25
            return AroundTheClockDartResult(
                player_index=self.current_player_index,
                target_hit=False,
                target_number=target,
                raw_score=raw_score,
            )
        
        # Get current target from sequence
        if player.current_target_index >= len(self.target_sequence):
            # Player has completed all targets
            target = 25
        else:
            target = self.target_sequence[player.current_target_index]
        
        if score is None:
            raw_score = {
                "score": 0,
                "multiplier": 0,
                "segment": "0",
                "zone": "miss",
                "confidence": 0.0,
            }
            return AroundTheClockDartResult(
                player_index=self.current_player_index,
                target_hit=False,
                target_number=target,
                raw_score=raw_score,
            )
        
        # Extract segment and zone
        zone = (score.get("zone") or "").lower()
        try:
            segment = int(score.get("segment", 0) or 0)
        except (TypeError, ValueError):
            segment = 0
        
        try:
            multiplier = int(score.get("multiplier", 0) or 0)
        except (TypeError, ValueError):
            multiplier = 0
        
        # Check if target is hit based on mode
        target_hit = self._check_target_hit(target, segment, zone, multiplier)
        
        # Track attempts and hits per target
        target_index = self._target_number_to_index(target)
        if target_index is not None:
            self._ensure_target_tracking_capacity(player)
            player.attempts_per_target[target_index] += 1
            if target_hit:
                player.hits_count_per_target[target_index] += 1
        
        # Increment darts since last hit (initialize if not exists for backward compatibility)
        if not hasattr(self, 'darts_since_last_hit'):
            self.darts_since_last_hit = 0
        self.darts_since_last_hit += 1
        
        # If hit, increment hit counter
        if target_hit:
            player.current_target_hits += 1
            player.darts_thrown += 1
            
            # Check if player has hit the target enough times
            if player.current_target_hits >= self.hits_required:
                # Track darts taken for this target
                player.hits_per_target.append(self.darts_since_last_hit)
                
                # Reset counter for next target
                self.darts_since_last_hit = 0
                player.current_target_hits = 0
                
                # Move to next target
                player.current_target_index += 1
                
                # Check if player finished all targets
                if player.current_target_index >= len(self.target_sequence):
                    player.finished = True
        else:
            player.darts_thrown += 1
        
        raw_score = {
            "score": int(score.get("score", 0) or 0),
            "multiplier": multiplier,
            "segment": str(segment),
            "zone": zone or "miss",
            "confidence": float(score.get("confidence", 0.0) or 0.0),
        }
        
        return AroundTheClockDartResult(
            player_index=self.current_player_index,
            target_hit=target_hit,
            target_number=target,
            raw_score=raw_score,
        )
    
    def _check_target_hit(self, target: int, segment: int, zone: str, multiplier: int) -> bool:
        """
        Check if the dart hit the target based on game mode.
        
        Args:
            target: Target number (1-20 for numbers, 25 for bull)
            segment: Segment hit
            zone: Zone hit
            multiplier: Multiplier (1=single, 2=double, 3=triple)
            
        Returns:
            True if target was hit according to mode rules
        """
        # Handle bull (target 25)
        if target == 25:
            # Check if it's a bull by zone OR by segment 25
            is_bull = zone in {"inner_bull", "outer_bull"} or segment == 25
            if is_bull:
                if self.mode == "full":
                    # Any bull counts
                    return True
                elif self.mode == "single":
                    # Any bull counts (inner or outer)
                    return True
                elif self.mode == "double":
                    # Must hit bullseye (inner bull = 50 points)
                    return zone == "inner_bull" or (segment == 25 and multiplier == 2)
                elif self.mode == "triple":
                    # Must hit bullseye (inner bull = 50 points, no triple bull exists)
                    return zone == "inner_bull" or (segment == 25 and multiplier == 2)
            return False
        
        # Handle regular numbers (1-20)
        if segment != target:
            return False
        
        if self.mode == "full":
            return True
        elif self.mode == "single":
            return multiplier == 1 or zone.startswith("single")
        elif self.mode == "double":
            return multiplier == 2 or zone == "double"
        elif self.mode == "triple":
            return multiplier == 3 or zone == "triple"
        
        return False
    
    def _revert_dart(self, result: AroundTheClockDartResult) -> None:
        """
        Revert a dart result (for corrections).
        
        Args:
            result: The dart result to revert
        """
        player = self.players[result.player_index]
        target_index = self._target_number_to_index(result.target_number)
        if target_index is not None:
            self._ensure_target_tracking_capacity(player)
            if target_index < len(player.attempts_per_target) and player.attempts_per_target[target_index] > 0:
                player.attempts_per_target[target_index] -= 1
            if (
                result.target_hit
                and target_index < len(player.hits_count_per_target)
                and player.hits_count_per_target[target_index] > 0
            ):
                player.hits_count_per_target[target_index] -= 1
        if result.target_hit:
            player.darts_thrown -= 1
            # If we had completed this target, revert it
            if player.current_target_hits == 0 and player.current_target_index > 0:
                player.current_target_index -= 1
                player.current_target_hits = self.hits_required - 1
                if player.hits_per_target:
                    player.hits_per_target.pop()
            else:
                # Just decrement the hit counter
                player.current_target_hits = max(0, player.current_target_hits - 1)
            player.finished = False
        else:
            player.darts_thrown -= 1
        self._update_winner()
    
    def _advance_to_next_player(self) -> None:
        """Move to the next player who hasn't finished."""
        if not self.players:
            return
        
        # Reset darts counter when changing players
        self.darts_since_last_hit = 0
        
        # Find next unfinished player
        start_index = self.current_player_index
        for _ in range(len(self.players)):
            self.current_player_index = (self.current_player_index + 1) % len(self.players)
            if not self.players[self.current_player_index].finished:
                return
        
        # If all players finished, stay on current
        self.current_player_index = start_index
    
    def _update_winner(self) -> None:
        """Check if any player has won."""
        if not self.players:
            self.winner_index = None
            return
        
        for idx, player in enumerate(self.players):
            if player.finished:
                self.winner_index = idx
                return
        
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
        """Consume and return the leg summary."""
        summary = self._last_leg_summary
        self._last_leg_summary = None
        return summary
    
    def _generate_leg_summary(self) -> List[Dict[str, Any]]:
        """
        Capture per-player statistics for the just-completed leg.
        
        Returns:
            List of player summaries with statistics
        """
        summaries: List[Dict[str, Any]] = []
        if not self.players:
            return summaries
        
        for idx, player in enumerate(self.players):
            target_attempts, target_hits = self._collect_target_stats(idx)
            target_accuracies: List[float] = [0.0] * 21
            
            for target_idx in range(21):
                attempts = target_attempts[target_idx]
                hits = target_hits[target_idx]
                if attempts > 0:
                    target_accuracies[target_idx] = (hits / attempts) * 100.0
            
            # Targets completed
            targets_hit = len(player.hits_per_target)
            
            total_attempts = sum(target_attempts)
            total_hits = sum(target_hits)
            overall_accuracy = (total_hits / total_attempts * 100.0) if total_attempts > 0 else 0.0
            
            summary = {
                "mode": "around_the_clock",
                "gameMode": self.mode,
                "darts": player.darts_thrown,
                "targetsHit": targets_hit,
                "totalTargets": 21,  # 1-20 + bull
                "hitsPerTarget": list(player.hits_per_target),
                "targetAttempts": target_attempts,
                "targetHitsCount": target_hits,
                "targetAccuracies": [round(acc, 2) for acc in target_accuracies],
                "overallAccuracy": round(overall_accuracy, 2),
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
        """Reset for a new leg."""
        # Regenerate target sequence for random mode
        if self.order == "random-bull":
            self.target_sequence = self._generate_target_sequence(self.order)
        
        # Reset all player states
        for player in self.players:
            player.current_target_index = 0
            player.current_target_hits = 0
            player.darts_thrown = 0
            player.hits_per_target = []
            player.attempts_per_target = [0] * 21
            player.hits_count_per_target = [0] * 21
            player.finished = False
        
        # Reset game state
        self.winner_index = None
        self.leg_winner_index = None
        self.set_winner_index = None
        self.turn_history = []
        self.last_completed_turn = [None] * MAX_DARTS_PER_TURN
        self.darts_since_last_hit = 0
        
        # Rotate starting player based on leg number (leg 1 = player 0, leg 2 = player 1, etc.)
        self.current_player_index = (self.current_leg - 1) % len(self.players)
        self.start_turn()
    
    @staticmethod
    def _target_number_to_index(target_number: int) -> Optional[int]:
        """Map a target number to the stats index (0-20)."""
        if 1 <= target_number <= 20:
            return target_number - 1
        if target_number == 25:
            return 20
        return None
    
    def _ensure_target_tracking_capacity(self, player: AroundTheClockPlayerState) -> None:
        """Ensure per-target tracking lists are sized for all targets."""
        if len(player.attempts_per_target) < 21:
            player.attempts_per_target.extend([0] * (21 - len(player.attempts_per_target)))
        elif len(player.attempts_per_target) > 21:
            player.attempts_per_target = player.attempts_per_target[:21]
        
        if len(player.hits_count_per_target) < 21:
            player.hits_count_per_target.extend([0] * (21 - len(player.hits_count_per_target)))
        elif len(player.hits_count_per_target) > 21:
            player.hits_count_per_target = player.hits_count_per_target[:21]
    
    def _collect_target_stats(self, player_index: int) -> Tuple[List[int], List[int]]:
        """Return copies of per-target attempt and hit counts for a player."""
        player = self.players[player_index]
        self._ensure_target_tracking_capacity(player)
        return (
            list(player.attempts_per_target[:21]),
            list(player.hits_count_per_target[:21]),
        )
    
    # ------------------------------------------------------------------
    # State exposure
    # ------------------------------------------------------------------
    def get_state(self) -> Dict:
        """
        Get the current game state.
        
        Returns:
            Dictionary containing complete game state
        """
        state = {
            "mode": self.mode,
            "currentPlayer": self.current_player_index if self.players else None,
            "players": [
                {
                    "name": player.name,
                    "currentTarget": self.target_sequence[player.current_target_index] if player.current_target_index < len(self.target_sequence) else 25,
                    "currentTargetIndex": player.current_target_index,
                    "currentTargetHits": player.current_target_hits,
                    "dartsThrown": player.darts_thrown,
                    "hitsPerTarget": list(player.hits_per_target),
                    "finished": player.finished,
                    "legsWon": player.legs_won,
                    "setsWon": player.sets_won,
                }
                for player in self.players
            ],
            "targetSequence": list(self.target_sequence),
            "order": self.order,
            "hitsRequired": self.hits_required,
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
        
        # Add statistics if available
        stats_summary = self._build_current_stats()
        if stats_summary:
            state["stats"] = stats_summary
        
        # Add match statistics
        match_stats = self._build_match_stats()
        if match_stats:
            state["matchStats"] = match_stats
        
        # Add leg statistics
        leg_stats = self._build_leg_stats()
        if leg_stats:
            state["legStats"] = leg_stats
        
        return state
    
    def _build_current_stats(self) -> List[Dict[str, Any]]:
        """Build current game statistics."""
        stats: List[Dict[str, Any]] = []
        
        for idx, player in enumerate(self.players):
            target_attempts, target_hits = self._collect_target_stats(idx)
            target_accuracies: List[float] = [0.0] * 21
            
            for target_idx in range(21):
                attempts = target_attempts[target_idx]
                hits = target_hits[target_idx]
                if attempts > 0:
                    target_accuracies[target_idx] = (hits / attempts) * 100.0
            
            targets_hit = len(player.hits_per_target)
            total_attempts = sum(target_attempts)
            total_hits = sum(target_hits)
            overall_accuracy = (total_hits / total_attempts * 100.0) if total_attempts > 0 else 0.0
            
            stat = {
                "darts": player.darts_thrown,
                "targetsHit": targets_hit,
                "totalTargets": 21,
                "overallAccuracy": round(overall_accuracy, 2),
                "targetAccuracies": [round(acc, 2) for acc in target_accuracies],
            }
            stats.append(stat)
        
        return stats
    
    def _build_match_stats(self) -> List[Dict[str, Any]]:
        """Build cumulative match statistics from all completed legs."""
        if not self.completed_leg_summaries:
            return []
        
        player_count = len(self.players)
        totals: List[Dict[str, Any]] = []
        for _ in range(player_count):
            totals.append(
                {
                    "darts": 0,
                    "targetsHit": 0,
                    "totalTargets": 0,
                    "targetAttempts": [0] * 21,
                    "targetHits": [0] * 21,
                }
            )
        
        # Aggregate from all completed legs
        for leg_summary in self.completed_leg_summaries:
            raw_summaries = leg_summary.get("rawSummaries", [])
            for idx, summary in enumerate(raw_summaries):
                if idx < player_count:
                    totals[idx]["darts"] += summary.get("darts", 0)
                    totals[idx]["targetsHit"] += summary.get("targetsHit", 0)
                    totals[idx]["totalTargets"] += summary.get("totalTargets", 0)
                    
                    attempts_list = summary.get("targetAttempts")
                    hits_list = summary.get("targetHitsCount") or summary.get("targetHits")
                    if isinstance(attempts_list, list) and isinstance(hits_list, list):
                        for target_idx in range(21):
                            attempt_value = attempts_list[target_idx] if target_idx < len(attempts_list) else 0
                            hit_value = hits_list[target_idx] if target_idx < len(hits_list) else 0
                            totals[idx]["targetAttempts"][target_idx] += int(attempt_value)
                            totals[idx]["targetHits"][target_idx] += int(hit_value)
                    else:
                        hits_per_target = summary.get("hitsPerTarget") or []
                        for target_idx, darts_taken in enumerate(hits_per_target):
                            if 0 <= target_idx < 21 and darts_taken:
                                totals[idx]["targetAttempts"][target_idx] += int(darts_taken)
                                totals[idx]["targetHits"][target_idx] += self.hits_required

        # Convert to final stats
        match_stats: List[Dict[str, Any]] = []
        for total_idx, total in enumerate(totals):
            darts = total["darts"]
            targets_hit = total["targetsHit"]
            total_attempts = sum(total["targetAttempts"])
            total_hits = sum(total["targetHits"])
            overall_accuracy = (total_hits / total_attempts * 100.0) if total_attempts > 0 else 0.0

            target_accuracies: List[float] = []
            for target_idx in range(21):
                hits = total["targetHits"][target_idx]
                attempts = total["targetAttempts"][target_idx]
                if attempts > 0:
                    target_accuracy = (hits / attempts) * 100.0
                else:
                    target_accuracy = 0.0
                target_accuracies.append(round(target_accuracy, 2))

            stat = {
                "darts": darts,
                "targetsHit": targets_hit,
                "totalTargets": total["totalTargets"],
                "overallAccuracy": round(overall_accuracy, 2),
                "targetAccuracies": target_accuracies,
            }
            match_stats.append(stat)
        
        return match_stats
    
    def _build_leg_stats(self) -> List[Dict[str, Any]]:
        """Build leg-by-leg statistics."""
        return [
            {
                "setNumber": leg["setNumber"],
                "legNumber": leg["legNumber"],
                "winnerIndex": leg["winnerIndex"],
                "stats": leg["rawSummaries"],
            }
            for leg in self.completed_leg_summaries
        ]


__all__ = ["AroundTheClockGame", "AroundTheClockPlayerState", "AroundTheClockDartResult"]
