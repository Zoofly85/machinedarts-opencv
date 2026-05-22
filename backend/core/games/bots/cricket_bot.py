"""Cricket bot implementation for automated throws."""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from enum import Enum
from typing import Dict, List, Tuple

CRICKET_ORDER: List[int] = [20, 19, 18, 17, 16, 15, 25]

SIGMA_BY_LEVEL: Dict[int, float] = {
    1: 4.0,
    2: 3.0,
    3: 2.25,
    4: 1.75,
    5: 1.5,
    6: 1.25,
    7: 1.0,
    8: 0.75,
    9: 0.5,
}


class Field(str, Enum):
    """Simple representation of dartboard field types."""

    SINGLE = "S"
    DOUBLE = "D"
    TRIPLE = "T"


@dataclass
class BotThrow:
    """Result of a single automated dart throw."""

    number: int
    multiplier: int
    zone: str
    score: int
    confidence: float


class BoardDim:
    """Geometric helper for mapping coordinates to dartboard fields."""

    bull: float = 1.27 / 2
    outer_bull: float = 3.18 / 2
    triple: float = 10.7
    double: float = 17.0
    width: float = 0.9
    angle_diff: float = 2 * math.pi / 20
    nums: List[int] = [
        20,
        5,
        12,
        9,
        14,
        11,
        8,
        16,
        7,
        19,
        3,
        17,
        2,
        15,
        10,
        6,
        13,
        4,
        18,
        1,
    ]

    def get_number(self, x: float, y: float) -> Tuple[int, Field]:
        angle = math.atan2(y, x) % (2 * math.pi)
        num = self.nums[int(angle / self.angle_diff)]
        radius = math.sqrt(x ** 2 + y ** 2)

        if radius <= self.bull:
            return 25, Field.DOUBLE
        if radius <= self.outer_bull:
            return 25, Field.SINGLE
        if radius > self.double:
            return 0, Field.SINGLE
        if self.triple - self.width <= radius <= self.triple:
            return num, Field.TRIPLE
        if self.double - self.width <= radius <= self.double:
            return num, Field.DOUBLE
        return num, Field.SINGLE


BOARD_DIM = BoardDim()


def _target_coordinates(target: Tuple[Field, int], sigma: float) -> Tuple[int, Field]:
    number = target[1]
    field = target[0]
    if number == 25:
        angle = 0.0
        radius = 0.0 if field == Field.DOUBLE else BOARD_DIM.outer_bull * 0.75
    else:
        try:
            index = BOARD_DIM.nums.index(number)
        except ValueError:
            index = 0
        angle = index * BOARD_DIM.angle_diff + BOARD_DIM.angle_diff / 2
        if field == Field.TRIPLE:
            radius = BOARD_DIM.triple
        elif field == Field.DOUBLE:
            radius = BOARD_DIM.double
        else:
            radius = (BOARD_DIM.triple + BOARD_DIM.double) / 2

    x_target = math.cos(angle) * radius
    y_target = math.sin(angle) * radius

    u1 = random.uniform(0.0001, 1.0)
    u2 = random.uniform(0.0, 1.0)
    deviation = sigma * math.sqrt(-2 * math.log(u1))
    offset_x = deviation * math.cos(2 * math.pi * u2)
    offset_y = deviation * math.sin(2 * math.pi * u2)

    x = x_target + offset_x
    y = y_target + offset_y
    number_result, field_result = BOARD_DIM.get_number(x, y)
    return number_result, field_result


class CricketBot:
    """Simple probabilistic bot for cricket games."""

    def __init__(self, level: int):
        self.level = max(1, min(level, 9))

    def select_target(self, game_state: Dict, player_index: int) -> Tuple[Field, int]:
        players = game_state.get("players", [])
        if not players:
            return (Field.TRIPLE, 20)

        my_marks: List[int] = players[player_index]["marks"]
        my_score: int = players[player_index].get("score", 0)
        opponent_marks = [p["marks"] for i, p in enumerate(players) if i != player_index]
        opponent_scores = [p.get("score", 0) for i, p in enumerate(players) if i != player_index]
        variant = game_state.get("mode", "standard")

        # TRIPLES_ONLY MODE: Only aim for triples (and inner bull for 25)
        if variant == "triples_only":
            for number in CRICKET_ORDER:
                idx = CRICKET_ORDER.index(number)
                if idx < len(my_marks) and my_marks[idx] < 3:
                    # For bull (25), aim for inner bull (double bull)
                    if number == 25:
                        return (Field.DOUBLE, 25)
                    return (Field.TRIPLE, number)
            # All closed, try to score
            scoring_target = self._find_best_scoring_target(my_marks, opponent_marks, variant)
            if scoring_target:
                return scoring_target
            return (Field.TRIPLE, 20)

        # DOUBLES_ONLY MODE: Only aim for doubles (and inner bull for 25)
        if variant == "doubles_only":
            for number in CRICKET_ORDER:
                idx = CRICKET_ORDER.index(number)
                if idx < len(my_marks) and my_marks[idx] < 3:
                    # For bull (25), aim for inner bull (double bull)
                    if number == 25:
                        return (Field.DOUBLE, 25)
                    return (Field.DOUBLE, number)
            # All closed, try to score
            scoring_target = self._find_best_scoring_target(my_marks, opponent_marks, variant)
            if scoring_target:
                return scoring_target
            return (Field.DOUBLE, 20)

        # CUTTHROAT MODE: Completely different strategy
        if variant == "cutthroat":
            return self._select_cutthroat_target(my_marks, opponent_marks, opponent_scores, variant)

        # NO_SCORE MODE: Just close numbers, no scoring
        if variant == "no_score":
            for number in CRICKET_ORDER:
                idx = CRICKET_ORDER.index(number)
                if idx < len(my_marks) and my_marks[idx] < 3:
                    return self._aim_for_number(number, my_marks[idx], variant)
            return (Field.SINGLE, 25)

        # STANDARD MODE: Point differential awareness
        max_opponent_score = max(opponent_scores) if opponent_scores else 0
        score_deficit = max_opponent_score - my_score
        
        # If behind by 40+ points, prioritize scoring over closing
        if score_deficit >= 40:
            scoring_target = self._find_best_scoring_target(my_marks, opponent_marks, variant)
            if scoring_target:
                return scoring_target

        # Normal closing strategy
        for number in CRICKET_ORDER:
            idx = CRICKET_ORDER.index(number)
            if idx < len(my_marks) and my_marks[idx] < 3:
                return self._aim_for_number(number, my_marks[idx], variant)

        # All numbers closed - focus on scoring
        scoring_target = self._find_best_scoring_target(my_marks, opponent_marks, variant)
        if scoring_target:
            return scoring_target

        # No scoring opportunities left - default to T20
        return (Field.TRIPLE, 20)

    def throw(self, game_state: Dict, player_index: int) -> BotThrow:
        target = self.select_target(game_state, player_index)
        sigma = SIGMA_BY_LEVEL.get(self.level, 1.75)
        number, field = _target_coordinates(target, sigma)

        if number == 0:
            return BotThrow(number=0, multiplier=0, zone="miss", score=0, confidence=0.25)

        if number == 25:
            multiplier = 2 if field == Field.DOUBLE else 1
            zone = "inner_bull" if multiplier == 2 else "outer_bull"
            score = 25 * multiplier
            return BotThrow(number=25, multiplier=multiplier, zone=zone, score=score, confidence=0.8)

        multiplier = 3 if field == Field.TRIPLE else 2 if field == Field.DOUBLE else 1
        zone = "triple" if field == Field.TRIPLE else "double" if field == Field.DOUBLE else "single"
        score = number * multiplier
        return BotThrow(number=number, multiplier=multiplier, zone=zone, score=score, confidence=0.75)

    def _find_best_scoring_target(self, my_marks: List[int], opponent_marks: List[List[int]], variant: str = "standard") -> Tuple[Field, int] | None:
        """
        Find the best number to score on.
        Rules: We must have it closed (>=3), and at least one opponent must NOT have it closed (<3).
        If ALL players have a number closed, it's dead and cannot be scored on.
        """
        scoring_candidates: List[Tuple[int, int]] = []  # (number, value)
        
        for idx, number in enumerate(CRICKET_ORDER):
            if idx >= len(my_marks):
                continue
            
            # Check if we have it closed
            if my_marks[idx] < 3:
                continue
            
            # Check if at least one opponent still has it open (can score on it)
            can_score = any(op[idx] < 3 for op in opponent_marks if idx < len(op))
            
            if can_score:
                # Calculate scoring value (triple value for regular numbers, 50 for bull)
                value = 50 if number == 25 else number * 3
                scoring_candidates.append((number, value))
        
        if not scoring_candidates:
            return None
        
        # Sort by value (highest first)
        scoring_candidates.sort(key=lambda x: x[1], reverse=True)
        target_number = scoring_candidates[0][0]
        
        if target_number == 25:
            # In both triples_only and doubles_only modes, aim for inner bull (double bull)
            if variant in ["triples_only", "doubles_only"]:
                return (Field.DOUBLE, 25)
            else:
                return (Field.DOUBLE, 25)
        
        # Aim for appropriate field based on mode
        if variant == "triples_only":
            return (Field.TRIPLE, target_number)
        elif variant == "doubles_only":
            return (Field.DOUBLE, target_number)
        else:
            return (Field.TRIPLE, target_number)

    def _select_cutthroat_target(self, my_marks: List[int], opponent_marks: List[List[int]], opponent_scores: List[int], variant: str = "standard") -> Tuple[Field, int]:
        """
        Cutthroat strategy: Give points to opponents (highest score loses).
        - Target numbers that are closed by opponents but not by us
        - Prioritize giving points to the player with the lowest score
        """
        if not opponent_marks or not opponent_scores:
            return (Field.TRIPLE, 20)
        
        # Find player with lowest score (they need the most points)
        target_opponent_idx = opponent_scores.index(min(opponent_scores))
        target_opponent_marks = opponent_marks[target_opponent_idx]
        
        # Find numbers closed by target opponent but not by us
        give_points_candidates: List[int] = []
        for idx, number in enumerate(CRICKET_ORDER):
            if idx >= len(my_marks) or idx >= len(target_opponent_marks):
                continue
            # They have it closed (>=3), we don't (< 3)
            if target_opponent_marks[idx] >= 3 and my_marks[idx] < 3:
                give_points_candidates.append(number)
        
        if give_points_candidates:
            # Prioritize highest value numbers to give maximum points
            target_number = give_points_candidates[0]  # Already in order 20-15
            if target_number == 25:
                return (Field.DOUBLE, 25)
            return (Field.TRIPLE, target_number)
        
        # If no one to give points to, close our own numbers
        for number in CRICKET_ORDER:
            idx = CRICKET_ORDER.index(number)
            if idx < len(my_marks) and my_marks[idx] < 3:
                return self._aim_for_number(number, my_marks[idx], variant)
        
        # Default fallback
        return (Field.TRIPLE, 20)

    @staticmethod
    def _aim_for_number(number: int, marks: int, variant: str = "standard") -> Tuple[Field, int]:
        # In triples_only mode, always aim for triples (inner bull for 25)
        if variant == "triples_only":
            if number == 25:
                return (Field.DOUBLE, 25)  # Inner bull (double bull) counts in triples_only
            return (Field.TRIPLE, number)
        
        # In doubles_only mode, always aim for doubles (inner bull for 25)
        if variant == "doubles_only":
            if number == 25:
                return (Field.DOUBLE, 25)  # Inner bull (double bull) counts in doubles_only
            return (Field.DOUBLE, number)
        
        # Standard/cutthroat/no_score modes: smart targeting
        if number == 25:
            if marks <= 0:
                return (Field.SINGLE, 25)
            return (Field.DOUBLE, 25)

        if marks <= 1:
            return (Field.TRIPLE, number)
        if marks == 2:
            return (Field.DOUBLE, number)
        return (Field.TRIPLE, number)
