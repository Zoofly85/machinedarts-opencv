"""Bermuda Triangle bot implementation."""

from __future__ import annotations

import math
import random
from typing import Dict, Tuple

from .cricket_bot import BoardDim, Field, BotThrow
from .x01_bot import SIGMA_BY_LEVEL as X01_SIGMA
from ..bermuda_triangle_game import TARGET_SEQUENCE

BOARD_DIM = BoardDim()


def _target_coordinates(target: Tuple[Field, int], sigma: float) -> Tuple[int, Field]:
    number = target[1]
    field = target[0]

    if number == 25:
        angle = 0.0
        radius = BOARD_DIM.outer_bull * 0.75
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
            radius = (BOARD_DIM.double + BOARD_DIM.triple) / 2

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


class BermudaBot:
    """Bot that aims best scoring option for the current round target."""

    def __init__(self, level: int):
        self.level = max(1, min(level, 9))

    def _aim_for_round(self, game_state: Dict) -> Tuple[Field, int]:
        round_index = max(0, int(game_state.get("currentRound", 1)) - 1)
        target = TARGET_SEQUENCE[min(round_index, len(TARGET_SEQUENCE) - 1)]
        if target.isdigit():
            # Aim triple of the target number
            return Field.TRIPLE, int(target)
        if target == "double":
            return Field.DOUBLE, 20
        if target == "triple":
            return Field.TRIPLE, 20
        if target == "bull":
            return Field.DOUBLE, 25  # inner bull
        if target == "50":
            return Field.DOUBLE, 25
        return Field.TRIPLE, 20

    def throw(self, game_state: Dict, _player_index: int) -> BotThrow:
        field_target, number_target = self._aim_for_round(game_state)
        sigma = X01_SIGMA.get(self.level, 2.0)
        number, field = _target_coordinates((field_target, number_target), sigma)

        if number == 25:
            multiplier = 2 if field == Field.DOUBLE else 1
        elif number == 0:
            multiplier = 0
        else:
            if field == Field.TRIPLE:
                multiplier = 3
            elif field == Field.DOUBLE:
                multiplier = 2
            else:
                multiplier = 1

        score = number * multiplier
        zone = "miss"
        if number == 25:
            zone = "inner_bull" if multiplier == 2 else "outer_bull"
        elif multiplier == 3:
            zone = "triple"
        elif multiplier == 2:
            zone = "double"
        elif multiplier == 1:
            zone = "single"

        return BotThrow(
            number=number,
            multiplier=multiplier,
            zone=zone,
            score=score,
            confidence=max(0.25, 1.0 - sigma / 5.0),
        )


__all__ = ["BermudaBot"]
