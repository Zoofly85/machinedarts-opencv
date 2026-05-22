"""X01 bot implementation for automated throws."""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import Dict, Tuple

from .cricket_bot import Field, BoardDim, BotThrow

# Optimal checkout paths for double out mode
NEXT_TARGET_DOUBLE_OUT = {
    170: (Field.TRIPLE, 20), 167: (Field.TRIPLE, 20), 164: (Field.TRIPLE, 20), 161: (Field.TRIPLE, 20),
    160: (Field.TRIPLE, 20), 158: (Field.TRIPLE, 20), 157: (Field.TRIPLE, 20), 156: (Field.TRIPLE, 20),
    155: (Field.TRIPLE, 20), 154: (Field.TRIPLE, 20), 153: (Field.TRIPLE, 20), 152: (Field.TRIPLE, 20),
    151: (Field.TRIPLE, 20), 150: (Field.TRIPLE, 20), 149: (Field.TRIPLE, 20), 148: (Field.TRIPLE, 20),
    147: (Field.TRIPLE, 20), 146: (Field.TRIPLE, 20), 145: (Field.TRIPLE, 20), 144: (Field.TRIPLE, 20),
    143: (Field.TRIPLE, 20), 142: (Field.TRIPLE, 20), 141: (Field.TRIPLE, 20), 140: (Field.TRIPLE, 20),
    139: (Field.TRIPLE, 20), 138: (Field.TRIPLE, 20), 137: (Field.TRIPLE, 20), 136: (Field.TRIPLE, 20),
    135: (Field.TRIPLE, 20), 134: (Field.TRIPLE, 20), 133: (Field.TRIPLE, 20), 132: (Field.TRIPLE, 20),
    131: (Field.TRIPLE, 20), 130: (Field.TRIPLE, 20), 129: (Field.TRIPLE, 19), 128: (Field.TRIPLE, 20),
    127: (Field.TRIPLE, 20), 126: (Field.TRIPLE, 19), 125: (Field.TRIPLE, 20), 124: (Field.TRIPLE, 20),
    123: (Field.TRIPLE, 19), 122: (Field.TRIPLE, 18), 121: (Field.TRIPLE, 20), 120: (Field.TRIPLE, 20),
    119: (Field.TRIPLE, 19), 118: (Field.TRIPLE, 20), 117: (Field.TRIPLE, 19), 116: (Field.TRIPLE, 20),
    115: (Field.TRIPLE, 19), 114: (Field.TRIPLE, 20), 113: (Field.TRIPLE, 19), 112: (Field.TRIPLE, 20),
    111: (Field.TRIPLE, 19), 110: (Field.TRIPLE, 20), 109: (Field.TRIPLE, 19), 108: (Field.TRIPLE, 20),
    107: (Field.TRIPLE, 19), 106: (Field.TRIPLE, 20), 105: (Field.TRIPLE, 19), 104: (Field.TRIPLE, 20),
    103: (Field.TRIPLE, 19), 102: (Field.TRIPLE, 20), 101: (Field.TRIPLE, 17),
    100: (Field.TRIPLE, 20), 99: (Field.TRIPLE, 19), 98: (Field.TRIPLE, 20), 97: (Field.TRIPLE, 19),
    96: (Field.TRIPLE, 20), 95: (Field.TRIPLE, 19), 94: (Field.TRIPLE, 18), 93: (Field.TRIPLE, 19),
    92: (Field.TRIPLE, 20), 91: (Field.TRIPLE, 17), 90: (Field.TRIPLE, 18), 89: (Field.TRIPLE, 19),
    88: (Field.TRIPLE, 16), 87: (Field.TRIPLE, 17), 86: (Field.TRIPLE, 18), 85: (Field.TRIPLE, 15),
    84: (Field.TRIPLE, 16), 83: (Field.TRIPLE, 17), 82: (Field.TRIPLE, 14), 81: (Field.TRIPLE, 15),
    80: (Field.TRIPLE, 16), 79: (Field.TRIPLE, 13), 78: (Field.TRIPLE, 18), 77: (Field.TRIPLE, 15),
    76: (Field.TRIPLE, 20), 75: (Field.TRIPLE, 13), 74: (Field.TRIPLE, 14), 73: (Field.TRIPLE, 19),
    72: (Field.TRIPLE, 16), 71: (Field.TRIPLE, 13), 70: (Field.TRIPLE, 18), 69: (Field.SINGLE, 19),
    68: (Field.TRIPLE, 20), 67: (Field.TRIPLE, 17), 66: (Field.TRIPLE, 10), 65: (Field.TRIPLE, 19),
    64: (Field.TRIPLE, 16), 63: (Field.TRIPLE, 13), 62: (Field.TRIPLE, 10), 61: (Field.TRIPLE, 15),
    60: (Field.SINGLE, 20), 59: (Field.SINGLE, 19), 58: (Field.SINGLE, 18), 57: (Field.SINGLE, 17),
    56: (Field.SINGLE, 16), 55: (Field.SINGLE, 15), 54: (Field.SINGLE, 14), 53: (Field.SINGLE, 13),
    52: (Field.SINGLE, 12), 51: (Field.SINGLE, 19), 50: (Field.DOUBLE, 25),
    49: (Field.SINGLE, 17), 48: (Field.SINGLE, 16), 47: (Field.SINGLE, 15), 46: (Field.SINGLE, 6),
    45: (Field.SINGLE, 13), 44: (Field.SINGLE, 12), 43: (Field.SINGLE, 3), 42: (Field.SINGLE, 10),
    41: (Field.SINGLE, 9), 40: (Field.DOUBLE, 20), 39: (Field.SINGLE, 7), 38: (Field.DOUBLE, 19),
    37: (Field.SINGLE, 5), 36: (Field.DOUBLE, 18), 35: (Field.SINGLE, 3), 34: (Field.DOUBLE, 17),
    33: (Field.SINGLE, 1), 32: (Field.DOUBLE, 16), 31: (Field.SINGLE, 15), 30: (Field.DOUBLE, 15),
    29: (Field.SINGLE, 13), 28: (Field.DOUBLE, 14), 27: (Field.SINGLE, 11), 26: (Field.DOUBLE, 13),
    25: (Field.SINGLE, 9), 24: (Field.DOUBLE, 12), 23: (Field.SINGLE, 7), 22: (Field.DOUBLE, 11),
    21: (Field.SINGLE, 5), 20: (Field.DOUBLE, 10), 19: (Field.SINGLE, 3), 18: (Field.DOUBLE, 9),
    17: (Field.SINGLE, 1), 16: (Field.DOUBLE, 8), 15: (Field.SINGLE, 7), 14: (Field.DOUBLE, 7),
    13: (Field.SINGLE, 5), 12: (Field.DOUBLE, 6), 11: (Field.SINGLE, 3), 10: (Field.DOUBLE, 5),
    9: (Field.SINGLE, 1), 8: (Field.DOUBLE, 4), 7: (Field.SINGLE, 3), 6: (Field.DOUBLE, 3),
    5: (Field.SINGLE, 1), 4: (Field.DOUBLE, 2), 3: (Field.SINGLE, 1), 2: (Field.DOUBLE, 1),
}

# Optimal paths for straight out mode
NEXT_TARGET_SINGLE_OUT = {
    60: (Field.TRIPLE, 20), 59: (Field.TRIPLE, 19), 58: (Field.TRIPLE, 19), 57: (Field.TRIPLE, 19),
    56: (Field.TRIPLE, 18), 55: (Field.TRIPLE, 18), 54: (Field.TRIPLE, 18), 53: (Field.TRIPLE, 17),
    52: (Field.TRIPLE, 17), 51: (Field.TRIPLE, 17), 50: (Field.DOUBLE, 25),
    49: (Field.TRIPLE, 16), 48: (Field.TRIPLE, 16), 47: (Field.TRIPLE, 15), 46: (Field.TRIPLE, 15),
    45: (Field.TRIPLE, 15), 44: (Field.TRIPLE, 14), 43: (Field.TRIPLE, 14), 42: (Field.TRIPLE, 14),
    41: (Field.TRIPLE, 13), 40: (Field.SINGLE, 20), 39: (Field.SINGLE, 20), 38: (Field.SINGLE, 20),
    37: (Field.SINGLE, 20), 36: (Field.SINGLE, 20), 35: (Field.SINGLE, 20), 34: (Field.SINGLE, 20),
    33: (Field.SINGLE, 20), 32: (Field.SINGLE, 20), 31: (Field.SINGLE, 20), 30: (Field.SINGLE, 20),
    29: (Field.SINGLE, 20), 28: (Field.SINGLE, 20), 27: (Field.SINGLE, 20), 26: (Field.SINGLE, 20),
    25: (Field.SINGLE, 20), 24: (Field.SINGLE, 20), 23: (Field.SINGLE, 20), 22: (Field.SINGLE, 20),
    21: (Field.SINGLE, 20), 20: (Field.SINGLE, 20), 19: (Field.SINGLE, 19), 18: (Field.SINGLE, 18),
    17: (Field.SINGLE, 17), 16: (Field.SINGLE, 16), 15: (Field.SINGLE, 15), 14: (Field.SINGLE, 14),
    13: (Field.SINGLE, 13), 12: (Field.SINGLE, 12), 11: (Field.SINGLE, 11), 10: (Field.SINGLE, 10),
    9: (Field.SINGLE, 9), 8: (Field.SINGLE, 8), 7: (Field.SINGLE, 7), 6: (Field.SINGLE, 6),
    5: (Field.SINGLE, 5), 4: (Field.SINGLE, 4), 3: (Field.SINGLE, 3), 2: (Field.SINGLE, 2),
    1: (Field.SINGLE, 1),
}

# Sigma values for different bot levels (lower = more accurate)
# Adjusted for X01 gameplay which includes checkout phase
SIGMA_BY_LEVEL = {
    1: 5.0,    # Beginner - ~18-22 avg
    2: 3.5,    # Novice - ~25-30 avg
    3: 2.5,    # Intermediate - ~35-40 avg
    4: 2.0,    # Advanced - ~45-50 avg
    5: 1.6,    # Expert - ~55-60 avg
    6: 1.3,    # Professional - ~65-70 avg
    7: 1.0,    # World Class - ~75-80 avg
    8: 0.75,   # Elite - ~85-90 avg
    9: 0.5,    # Superhuman - ~95-100 avg
}

BOARD_DIM = BoardDim()


def _target_coordinates(target: Tuple[Field, int], sigma: float) -> Tuple[int, Field]:
    """
    Calculate where a dart lands given a target and accuracy (sigma).
    Uses Box-Muller transform for Gaussian distribution.
    """
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
    
    # Box-Muller transform for Gaussian distribution
    u1 = random.uniform(0.0001, 1.0)
    u2 = random.uniform(0.0, 1.0)
    deviation = sigma * math.sqrt(-2 * math.log(u1))
    offset_x = deviation * math.cos(2 * math.pi * u2)
    offset_y = deviation * math.sin(2 * math.pi * u2)
    
    x = x_target + offset_x
    y = y_target + offset_y
    number_result, field_result = BOARD_DIM.get_number(x, y)
    return number_result, field_result


class X01Bot:
    """Bot for X01 games with configurable skill levels."""
    
    def __init__(self, level: int):
        self.level = max(1, min(level, 9))
    
    def select_target(self, game_state: Dict, player_index: int) -> Tuple[Field, int]:
        """
        Select the optimal target based on current score and game settings.
        """
        players = game_state.get("players", [])
        if not players or player_index >= len(players):
            return (Field.TRIPLE, 20)
        
        player = players[player_index]
        
        # Check if this is the current player's turn and use the updated score from currentTurn
        current_player_index = game_state.get("currentPlayer")
        if current_player_index == player_index:
            current_turn = game_state.get("currentTurn", {})
            # Use the remaining score from current turn (updated after each dart)
            remaining = current_turn.get("remaining", player.get("score", 501))
            has_in = current_turn.get("hasInAfter", player.get("hasIn", True))
        else:
            # Not current player, use stored score
            remaining = player.get("score", 501)
            has_in = player.get("hasIn", True)
        
        settings = game_state.get("settings", {})
        in_mode = settings.get("inMode", "straight")
        out_mode = settings.get("outMode", "double")
        
        # If player needs to get "in", aim for appropriate target
        if not has_in:
            if in_mode == "double":
                return (Field.DOUBLE, 20)
            elif in_mode == "master":
                # Aim for triple 20 (easier than double for most players)
                return (Field.TRIPLE, 20)
            else:
                # Straight in - just score normally
                return (Field.TRIPLE, 20)
        
        # Select target based on remaining score
        if out_mode == "double":
            target = NEXT_TARGET_DOUBLE_OUT.get(remaining)
        else:
            target = NEXT_TARGET_SINGLE_OUT.get(remaining)
        
        # If no specific checkout path, aim for high scores
        if target is None:
            if remaining > 170:
                return (Field.TRIPLE, 20)
            else:
                return (Field.TRIPLE, 19)
        
        return target
    
    def throw(self, game_state: Dict, player_index: int) -> BotThrow:
        """
        Execute a throw with the bot's accuracy level.
        """
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


__all__ = ["X01Bot"]