"""Beer Race bot implementation."""

from __future__ import annotations

import math
import random
from typing import Dict, Tuple, DefaultDict
from collections import defaultdict

from .cricket_bot import BoardDim, Field, BotThrow, SIGMA_BY_LEVEL

BOARD_DIM = BoardDim()


def _target_coordinates(target: Tuple[Field, int], sigma: float) -> Tuple[int, Field]:
    """Sample a coordinate around the intended target."""
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


class BeerRaceBot:
    """Simple power-scoring bot that alternates T20/T19 after miss streaks."""

    def __init__(self, level: int):
        self.level = max(1, min(level, 9))
        self.current_target: DefaultDict[int, int] = defaultdict(lambda: 20)
        self.miss_streak: DefaultDict[int, int] = defaultdict(int)

    def _select_target(self, player_index: int) -> Tuple[Field, int]:
        number = self.current_target[player_index]
        return (Field.TRIPLE, number)

    def _update_strategy(self, player_index: int, hit_triple: bool) -> None:
        if hit_triple:
            self.miss_streak[player_index] = 0
            return

        self.miss_streak[player_index] += 1
        if self.miss_streak[player_index] >= 3:
            next_target = 19 if self.current_target[player_index] == 20 else 20
            self.current_target[player_index] = next_target
            self.miss_streak[player_index] = 0

    def throw(self, _game_state: Dict, player_index: int) -> BotThrow:
        target = self._select_target(player_index)
        sigma = SIGMA_BY_LEVEL.get(self.level, 1.75)
        number, field = _target_coordinates(target, sigma)

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

        self._update_strategy(player_index, field == Field.TRIPLE and number in (19, 20))

        return BotThrow(
            number=number,
            multiplier=multiplier,
            zone=zone,
            score=score,
            confidence=max(0.25, 1.0 - sigma / 5.0),
        )
