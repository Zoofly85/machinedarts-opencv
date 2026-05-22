"""Around the Clock bot implementation for automated throws."""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from enum import Enum
from typing import Dict, List, Tuple


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


# Shared sigma values by bot level (same as Cricket/X01)
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
    10: 0.5,  # Level 10 same as 9
}


class BoardDim:
    """Geometric helper for mapping coordinates to dartboard fields."""

    bull: float = 1.27 / 2  # Inner bull radius in cm
    outer_bull: float = 3.18 / 2  # Outer bull radius in cm
    triple: float = 10.7  # Triple ring radius in cm
    double: float = 17.0  # Double ring radius in cm
    width: float = 0.9  # Ring width in cm
    angle_diff: float = 2 * math.pi / 20  # Angle between segments
    nums: List[int] = [
        20, 5, 12, 9, 14, 11, 8, 16, 7, 19,
        3, 17, 2, 15, 10, 6, 13, 4, 18, 1,
    ]

    def get_number(self, x: float, y: float) -> Tuple[int, Field]:
        """Convert x,y coordinates to dartboard number and field."""
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
    """
    Calculate throw result with Gaussian distribution around target.
    
    Args:
        target: Tuple of (Field, number) to aim for
        sigma: Standard deviation for throw accuracy
        
    Returns:
        Tuple of (number, Field) where dart landed
    """
    number = target[1]
    field = target[0]
    
    if number == 25:
        # Bull target
        angle = 0.0
        radius = 0.0 if field == Field.DOUBLE else BOARD_DIM.outer_bull * 0.75
    else:
        # Regular number target
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

    # Apply Gaussian distribution
    u1 = random.uniform(0.0001, 1.0)
    u2 = random.uniform(0.0, 1.0)
    deviation = sigma * math.sqrt(-2 * math.log(u1))
    offset_x = deviation * math.cos(2 * math.pi * u2)
    offset_y = deviation * math.sin(2 * math.pi * u2)

    x = x_target + offset_x
    y = y_target + offset_y
    number_result, field_result = BOARD_DIM.get_number(x, y)
    return number_result, field_result


class AroundTheClockBot:
    """Bot player for Around the Clock game."""

    def __init__(self, level: int = 5):
        """
        Initialize bot with difficulty level.
        
        Args:
            level: Difficulty level 1-10 (10 = expert)
        """
        self.level = max(1, min(10, level))

    def select_target(self, game_state: Dict, player_index: int) -> Tuple[Field, int]:
        """
        Select target based on current game state.
        
        Args:
            game_state: Current game state dictionary
            player_index: Index of the bot player
            
        Returns:
            Tuple of (Field, number) to aim for
        """
        players = game_state.get("players", [])
        if player_index >= len(players):
            return (Field.SINGLE, 1)
        
        player = players[player_index]
        target_number = player.get("currentTarget", 1)
        mode = game_state.get("mode", "full")
        
        # After hitting 1-20, target becomes 21, which means aim for bull (25)
        if target_number > 20:
            # Bull target
            if mode == "double" or mode == "triple":
                # Need inner bull (bullseye = 50 points)
                # Both double and triple modes require the bullseye
                return (Field.DOUBLE, 25)
            else:
                # Full or single mode - aim for outer bull (easier, larger target)
                return (Field.SINGLE, 25)
        else:
            # Regular number target (1-20)
            if mode == "full":
                # Aim for single (largest area)
                return (Field.SINGLE, target_number)
            elif mode == "single":
                return (Field.SINGLE, target_number)
            elif mode == "double":
                return (Field.DOUBLE, target_number)
            elif mode == "triple":
                return (Field.TRIPLE, target_number)
            else:
                return (Field.SINGLE, target_number)

    def throw(self, game_state: Dict, player_index: int) -> BotThrow:
        """
        Execute a throw for the current target.
        
        Args:
            game_state: Current game state dictionary
            player_index: Index of the bot player
            
        Returns:
            BotThrow object with throw result
        """
        # Select target
        target = self.select_target(game_state, player_index)
        
        # Get sigma for this bot level
        sigma = SIGMA_BY_LEVEL.get(self.level, 1.5)
        
        # Calculate throw result
        number, field = _target_coordinates(target, sigma)
        
        # Convert to BotThrow format
        if number == 0:
            # Miss
            return BotThrow(
                number=0,
                multiplier=0,
                zone="miss",
                score=0,
                confidence=0.25
            )
        elif number == 25:
            # Bull
            if field == Field.DOUBLE:
                # Inner bull
                return BotThrow(
                    number=25,
                    multiplier=2,
                    zone="inner_bull",
                    score=50,
                    confidence=0.8
                )
            else:
                # Outer bull
                return BotThrow(
                    number=25,
                    multiplier=1,
                    zone="outer_bull",
                    score=25,
                    confidence=0.75
                )
        else:
            # Regular number
            if field == Field.TRIPLE:
                multiplier = 3
                zone = "triple"
            elif field == Field.DOUBLE:
                multiplier = 2
                zone = "double"
            else:
                multiplier = 1
                zone = "single"
            
            score = number * multiplier
            confidence = 0.7 if field == target[0] else 0.5
            
            return BotThrow(
                number=number,
                multiplier=multiplier,
                zone=zone,
                score=score,
                confidence=confidence
            )