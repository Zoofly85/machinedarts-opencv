"""One Two One bot with sigma-based throw spread."""

from __future__ import annotations

import math
import random
from typing import Dict, Tuple

from .cricket_bot import BoardDim, BotThrow, Field
from .x01_bot import NEXT_TARGET_DOUBLE_OUT, NEXT_TARGET_SINGLE_OUT, SIGMA_BY_LEVEL

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


class OneTwoOneBot:
    def __init__(self, level: int):
        self.level = max(1, min(level, 9))

    def _select_target(self, game_state: Dict, player_index: int) -> Tuple[Field, int]:
        players = game_state.get("players", []) or []
        if player_index >= len(players):
            return (Field.TRIPLE, 20)
        player = players[player_index] or {}
        remaining = int(player.get("attemptRemaining", 121) or 121)
        out_rule = str(player.get("outRule", "double") or "double").lower()

        if remaining > 170:
            return (Field.TRIPLE, 20)
        if out_rule == "double":
            return NEXT_TARGET_DOUBLE_OUT.get(remaining, (Field.TRIPLE, 20))
        return NEXT_TARGET_SINGLE_OUT.get(remaining, (Field.TRIPLE, 20))

    def throw(self, game_state: Dict, player_index: int) -> BotThrow:
        target = self._select_target(game_state, player_index)
        sigma = float(SIGMA_BY_LEVEL.get(self.level, 1.75))
        number, field = _target_coordinates(target, sigma)

        if number == 0:
            return BotThrow(number=0, multiplier=0, zone="miss", score=0, confidence=0.25)

        if number == 25:
            multiplier = 2 if field == Field.DOUBLE else 1
            zone = "inner_bull" if multiplier == 2 else "outer_bull"
            return BotThrow(number=25, multiplier=multiplier, zone=zone, score=25 * multiplier, confidence=0.8)

        multiplier = 3 if field == Field.TRIPLE else 2 if field == Field.DOUBLE else 1
        zone = "triple" if field == Field.TRIPLE else "double" if field == Field.DOUBLE else "single_outer"
        return BotThrow(number=number, multiplier=multiplier, zone=zone, score=number * multiplier, confidence=max(0.25, 1.0 - sigma / 5.0))

