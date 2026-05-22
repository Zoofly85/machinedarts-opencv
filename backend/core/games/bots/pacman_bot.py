"""Pacman bot with ring-aware pellet targeting."""

from __future__ import annotations

import math
import random
from typing import Dict, Iterable, Tuple

from .cricket_bot import BoardDim, BotThrow, Field
from .x01_bot import SIGMA_BY_LEVEL

BOARD_DIM = BoardDim()

def _parse_pellet_key(pellet_key: str) -> Tuple[str, int]:
    key = str(pellet_key or "").strip().upper()
    if key == "IB":
        return ("IB", 25)
    if key == "OB":
        return ("OB", 25)
    if key[:2] in {"SI", "SO"}:
        try:
            number = int(key[2:])
            if 1 <= number <= 20:
                return (key[:2], number)
        except ValueError:
            pass
    if key[:1] in {"D", "T"}:
        try:
            number = int(key[1:])
            if 1 <= number <= 20:
                return (key[:1], number)
        except ValueError:
            pass
    return ("T", 20)


def _target_value_from_pellet(pellet_key: str) -> int:
    ring, number = _parse_pellet_key(pellet_key)
    if ring == "IB":
        return 50
    if ring == "OB":
        return 25
    if ring == "T":
        return number * 3
    if ring == "D":
        return number * 2
    return number


def _neighbor_numbers(number: int) -> Tuple[int, int]:
    try:
        idx = BOARD_DIM.nums.index(number)
    except ValueError:
        return (20, 1)
    left = BOARD_DIM.nums[(idx - 1) % len(BOARD_DIM.nums)]
    right = BOARD_DIM.nums[(idx + 1) % len(BOARD_DIM.nums)]
    return (left, right)


def _aim_center_for_pellet(pellet_key: str) -> Tuple[float, float]:
    ring, number = _parse_pellet_key(pellet_key)
    if number == 25:
        angle = 0.0
    else:
        try:
            index = BOARD_DIM.nums.index(number)
        except ValueError:
            index = 0
        angle = index * BOARD_DIM.angle_diff + BOARD_DIM.angle_diff / 2

    if ring == "IB":
        radius = BOARD_DIM.bull * 0.5
    elif ring == "OB":
        radius = (BOARD_DIM.bull + BOARD_DIM.outer_bull) / 2
    elif ring == "T":
        radius = BOARD_DIM.triple - (BOARD_DIM.width / 2)
    elif ring == "D":
        radius = BOARD_DIM.double - (BOARD_DIM.width / 2)
    elif ring == "SI":
        # Center of inner-single band (between outer bull and triple band).
        radius = (BOARD_DIM.outer_bull + (BOARD_DIM.triple - BOARD_DIM.width)) / 2
    else:
        # SO: center of outer-single band (between triple and double bands).
        radius = (BOARD_DIM.triple + (BOARD_DIM.double - BOARD_DIM.width)) / 2
    return (math.cos(angle) * radius, math.sin(angle) * radius)


def _sample_throw_from_pellet(pellet_key: str, sigma: float) -> Tuple[int, int, str, int]:
    x_target, y_target = _aim_center_for_pellet(pellet_key)
    u1 = random.uniform(0.0001, 1.0)
    u2 = random.uniform(0.0, 1.0)
    deviation = sigma * math.sqrt(-2 * math.log(u1))
    offset_x = deviation * math.cos(2 * math.pi * u2)
    offset_y = deviation * math.sin(2 * math.pi * u2)
    x = x_target + offset_x
    y = y_target + offset_y

    number, field = BOARD_DIM.get_number(x, y)
    radius = math.sqrt(x * x + y * y)
    if number == 0:
        return (0, 0, "miss", 0)
    if number == 25:
        if field == Field.DOUBLE:
            return (25, 2, "inner_bull", 50)
        return (25, 1, "outer_bull", 25)
    if field == Field.TRIPLE:
        return (number, 3, "triple", number * 3)
    if field == Field.DOUBLE:
        return (number, 2, "double", number * 2)
    if radius <= (BOARD_DIM.triple - BOARD_DIM.width):
        return (number, 1, "single_inner", number)
    return (number, 1, "single_outer", number)


def _base_hit_probability(level: int, pellet_key: str) -> float:
    ring, _ = _parse_pellet_key(pellet_key)
    norm = (max(1, min(level, 9)) - 1) / 8.0
    if ring == "T":
        return 0.16 + (0.34 * norm)
    if ring == "D":
        return 0.28 + (0.42 * norm)
    if ring in {"SI", "SO"}:
        return 0.72 + (0.23 * norm)
    if ring == "IB":
        return 0.20 + (0.30 * norm)
    # OB
    return 0.45 + (0.35 * norm)


def _miss_profile(pellet_key: str) -> tuple[list[tuple[str, float]], float]:
    ring, number = _parse_pellet_key(pellet_key)
    if ring in {"IB", "OB"}:
        # Bulls are relatively isolated; misses mostly spill into other bull or miss.
        if ring == "IB":
            return ([("OB", 0.45)], 0.30)
        return ([("IB", 0.20)], 0.20)

    left, right = _neighbor_numbers(number)
    if ring == "T":
        likely = [
            (f"SI{number}", 0.22),
            (f"SO{number}", 0.28),
            (f"T{left}", 0.08),
            (f"T{right}", 0.08),
            (f"SO{left}", 0.07),
            (f"SO{right}", 0.07),
            (f"D{number}", 0.06),
        ]
        return (likely, 0.14)
    if ring == "D":
        likely = [
            (f"SO{number}", 0.35),
            (f"D{left}", 0.10),
            (f"D{right}", 0.10),
            (f"SO{left}", 0.10),
            (f"SO{right}", 0.10),
            (f"T{number}", 0.05),
        ]
        return (likely, 0.20)
    if ring == "SI":
        likely = [
            (f"T{number}", 0.10),
            (f"SI{left}", 0.13),
            (f"SI{right}", 0.13),
            (f"SO{number}", 0.12),
        ]
        return (likely, 0.08)
    # SO
    likely = [
        (f"D{number}", 0.12),
        (f"SO{left}", 0.13),
        (f"SO{right}", 0.13),
        (f"T{number}", 0.08),
    ]
    return (likely, 0.12)


def _life_penalty_from_lives(lives: int) -> float:
    if lives <= 1:
        return 95.0
    if lives == 2:
        return 70.0
    if lives == 3:
        return 52.0
    return 38.0


def _risk_empty_probability(pellet_key: str, pellets_remaining: set[str]) -> float:
    likely_hits, miss_prob = _miss_profile(pellet_key)
    empty_prob = float(miss_prob)
    for key, weight in likely_hits:
        if key not in pellets_remaining:
            empty_prob += float(weight)
    return min(1.0, max(0.0, empty_prob))


class PacmanBot:
    def __init__(self, level: int):
        self.level = max(1, min(level, 9))

    def _select_target(self, game_state: Dict, player_index: int) -> str:
        players = game_state.get("players", []) or []
        if player_index >= len(players):
            return "T20"
        player = players[player_index] if isinstance(players[player_index], dict) else {}
        pellets = player.get("pellets", []) or []
        if not pellets:
            return "T20"
        pellets_remaining = {str(p).upper() for p in pellets if str(p).strip()}
        lives = int(player.get("lives", 3) or 3)
        life_penalty = _life_penalty_from_lives(lives)

        # Higher level -> more aggressive on high-value risky targets.
        aggression = 0.85 + ((self.level - 1) / 8.0) * 0.45

        best_key = "T20"
        best_utility = -10**9
        for key in pellets_remaining:
            value = float(_target_value_from_pellet(key))
            p_hit = _base_hit_probability(self.level, key)
            p_empty_life_loss = _risk_empty_probability(key, pellets_remaining)

            # Expected utility: score gain minus life-loss risk cost.
            utility = (value * p_hit * aggression) - (life_penalty * p_empty_life_loss)

            # Tie-breaker toward higher score targets.
            utility += value * 0.02

            if utility > best_utility:
                best_utility = utility
                best_key = key
        return best_key

    def throw(self, game_state: Dict, player_index: int) -> BotThrow:
        target_pellet = self._select_target(game_state, player_index)
        sigma = float(SIGMA_BY_LEVEL.get(self.level, 1.75))
        number, multiplier, zone, score = _sample_throw_from_pellet(target_pellet, sigma)
        return BotThrow(
            number=number,
            multiplier=multiplier,
            zone=zone,
            score=score,
            confidence=max(0.25, 1.0 - sigma / 5.0),
        )
