"""Shanghai bot implementation."""

from __future__ import annotations

import math
import random
from typing import Dict, Tuple, DefaultDict
from collections import defaultdict

from .cricket_bot import BoardDim, Field, BotThrow
from .x01_bot import SIGMA_BY_LEVEL as X01_SIGMA

BOARD_DIM = BoardDim()


def _target_coordinates(target: Tuple[Field, int], sigma: float) -> Tuple[int, Field]:
    """Sample a landing spot around a target."""
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


class ShanghaiBot:
    """Bot that targets current round number; aims for Shanghai combo."""

    def __init__(self, level: int):
        self.level = max(1, min(level, 9))
        self.throw_cycle: DefaultDict[int, int] = defaultdict(int)  # 0=triple,1=double,2=single

    def _next_target_field(self, player_index: int) -> Field:
        step = self.throw_cycle[player_index] % 3
        if step == 0:
            return Field.TRIPLE
        if step == 1:
            return Field.DOUBLE
        return Field.SINGLE

    def throw(self, game_state: Dict, player_index: int) -> BotThrow:
        target_number = game_state.get("currentTurn", {}).get("target") or 20
        field_choice = self._next_target_field(player_index)
        self.throw_cycle[player_index] += 1

        sigma = X01_SIGMA.get(self.level, 2.0)
        number, field = _target_coordinates((field_choice, target_number), sigma)

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
        zone = "outer"
        if number == 25:
            zone = "inner_bull" if multiplier == 2 else "outer_bull"
        elif multiplier == 3:
            zone = "triple"
        elif multiplier == 2:
            zone = "double"

        return BotThrow(
            number=number,
            multiplier=multiplier,
            zone=zone,
            score=score,
            confidence=max(0.3, 1.0 - sigma / 5.0),
        )


__all__ = ["ShanghaiBot"]
