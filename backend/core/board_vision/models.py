from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np


@dataclass(frozen=True)
class Segment:
    number: int
    multiplier: int
    bed: str

    @property
    def label(self) -> str:
        if self.multiplier == 0:
            return f"M{self.number}" if self.number else "MISS"
        if self.number == 25:
            return "Bull" if self.multiplier == 2 else "25"
        return f"{ {1: 'S', 2: 'D', 3: 'T'}[self.multiplier] }{self.number}"

@dataclass
class Segmentation:
    selected: np.ndarray
    throw_diff: np.ndarray
    darts_before: np.ndarray
    darts_after: np.ndarray
    stationary: np.ndarray
    moved: np.ndarray
    new: np.ndarray
    old: np.ndarray


@dataclass
class CameraVote:
    camera: int
    abstention: bool
    segment: Segment
    image_tip: tuple[float, float] | None = None
    board_tip: tuple[float, float] | None = None
    image_line: tuple[tuple[float, float], tuple[float, float]] | None = None
    board_line: tuple[tuple[float, float], tuple[float, float]] | None = None
    error: float | None = None
    mask_pixels: int = 0
    selected_mask: np.ndarray | None = None
    bouncer: bool = False
    debug: dict[str, Any] = field(default_factory=dict)


@dataclass
class IntersectionVote:
    cam1: int
    cam2: int
    abstention: bool
    segment: Segment
    coords: tuple[float, float] | None = None
    cam1_error: float | None = None
    cam2_error: float | None = None


@dataclass
class DetectionResult:
    segment: Segment
    method: str
    coords: tuple[float, float] | None
    cameras: list[CameraVote]
    intersections: list[IntersectionVote]
    bouncer: bool = False
