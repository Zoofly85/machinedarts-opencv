"""Target Trainer bot implementation."""

from __future__ import annotations

import random
from typing import Dict, Any

from .cricket_bot import BotThrow, Field
from .x01_bot import _target_coordinates, SIGMA_BY_LEVEL as X01_SIGMA


class TargetTrainerBot:
    """Simple bot that aims at the configured Target Trainer target."""

    def __init__(self, level: int = 4):
        self.level = max(1, min(level, 9))

    def throw(self, game_state: Dict[str, Any], player_index: int) -> BotThrow:
        settings = game_state.get("settings", {})
        target_type = settings.get("targetType", "treble")
        target_number = int(settings.get("targetNumber", 20) or 20)
        allow_close = bool(settings.get("allowClose"))

        # Use the same sigma-based spread as other games (X01/Cricket)
        sigma = X01_SIGMA.get(self.level, 2.0)

        # Map target type to Field + number
        if target_type == "treble":
            target_field = Field.TRIPLE
        elif target_type == "double":
            target_field = Field.DOUBLE
        elif target_type == "single":
            target_field = Field.SINGLE
        elif target_type == "inner_bull":
            target_field = Field.DOUBLE  # inner bull uses double ring logic
            target_number = 25
        else:  # outer_bull
            target_field = Field.SINGLE
            target_number = 25

        landed_number, landed_field = _target_coordinates((target_field, target_number), sigma)

        # Convert Field to multiplier/zone
        if landed_number == 25:
            if landed_field == Field.DOUBLE:
                multiplier, zone = 2, "inner_bull"
            else:
                multiplier, zone = 1, "outer_bull"
        else:
            if landed_field == Field.TRIPLE:
                multiplier, zone = 3, "triple"
            elif landed_field == Field.DOUBLE:
                multiplier, zone = 2, "double"
            else:
                multiplier, zone = 1, "single"

        number = landed_number
        score = 50 if zone == "inner_bull" else 25 if zone == "outer_bull" else number * multiplier

        # Confidence falls as sigma increases
        confidence = max(0.25, 1.0 - sigma / 5.0)

        # If close credit is allowed and we missed the ring but kept the number, keep that throw;
        # scoring logic will award 0.5 appropriately.
        if not allow_close and number == target_number and landed_field != target_field:
            # force a true miss to avoid over-credit when close mode is off
            number = random.choice([n for n in range(1, 21) if n != target_number])
            multiplier = random.choice([1, 2, 3])
            zone = {1: "single", 2: "double", 3: "triple"}[multiplier]
            score = number * multiplier

        return BotThrow(
            number=number,
            multiplier=multiplier,
            zone=zone,
            score=score,
            confidence=confidence,
        )
