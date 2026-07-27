from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np

from .models import Segment


SEGMENTS = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5]
RING_RADII = {
    "doubleOuters": 1.0,
    "doubleInner": 160.0 / 170.0,
    "trebleOuters": 107.0 / 170.0,
    # This compatibility fit outperforms the recovered 97 mm target on dumps.
    "trebleInner": 98.0 / 170.0,
}
SCORE_BULL_RADIUS = 7.0 / 170.0
SCORE_OUTER_BULL_RADIUS = 17.0 / 170.0
SCORE_TREBLE_INNER_RADIUS = 97.0 / 170.0
SCORE_TREBLE_OUTER_RADIUS = 107.0 / 170.0
SCORE_DOUBLE_INNER_RADIUS = 160.0 / 170.0
SCORE_DOUBLE_OUTER_RADIUS = 1.0


def score_point(point: tuple[float, float]) -> Segment:
    x, y = float(point[0]), float(point[1])
    radius = math.hypot(x, y)
    clockwise = (90.0 - math.degrees(math.atan2(y, x))) % 360.0
    number = SEGMENTS[int(((clockwise + 9.0) % 360.0) // 18.0)]
    if radius <= SCORE_BULL_RADIUS:
        return Segment(25, 2, "Bull")
    if radius <= SCORE_OUTER_BULL_RADIUS:
        return Segment(25, 1, "OuterBull")
    if radius > SCORE_DOUBLE_OUTER_RADIUS:
        return Segment(number, 0, "Outside")
    if SCORE_TREBLE_INNER_RADIUS < radius <= SCORE_TREBLE_OUTER_RADIUS:
        return Segment(number, 3, "Triple")
    if SCORE_DOUBLE_INNER_RADIUS < radius <= SCORE_DOUBLE_OUTER_RADIUS:
        return Segment(number, 2, "Double")
    return Segment(number, 1, "Single")


@dataclass
class BoardCalibration:
    camera: int
    homography: np.ndarray
    outer_points: np.ndarray
    _support_masks: dict[tuple[int, int, float], np.ndarray] = field(
        default_factory=dict,
        init=False,
        repr=False,
        compare=False,
    )

    @classmethod
    def from_config(cls, camera: int, dartboard: dict[str, Any]) -> "BoardCalibration":
        source: list[list[float]] = []
        target: list[list[float]] = []
        for index in range(20):
            angle = math.radians(81.0 - index * 18.0)
            for key, radius in RING_RADII.items():
                source.append([float(v) for v in dartboard[key][index]])
                target.append([radius * math.cos(angle), radius * math.sin(angle)])
        homography, _ = cv2.findHomography(np.float32(source), np.float32(target), 0)
        if homography is None:
            raise RuntimeError(f"Could not calibrate camera {camera}")
        return cls(camera=camera, homography=homography, outer_points=np.float32(dartboard["doubleOuters"]))

    def point(self, image_point: tuple[float, float]) -> tuple[float, float]:
        src = np.array([[[float(image_point[0]), float(image_point[1])]]], dtype=np.float32)
        out = cv2.perspectiveTransform(src, self.homography)[0, 0]
        return float(out[0]), float(out[1])

    def line(self, image_line: tuple[tuple[float, float], tuple[float, float]]) -> tuple[tuple[float, float], tuple[float, float]]:
        return self.point(image_line[0]), self.point(image_line[1])

    def support_mask(self, shape: tuple[int, ...], scale: float = 1.3235294117647058) -> np.ndarray:
        key = (int(shape[0]), int(shape[1]), float(scale))
        cached = self._support_masks.get(key)
        if cached is not None:
            return cached
        mask = np.zeros(shape[:2], dtype=np.uint8)
        points = self.outer_points.reshape(-1, 1, 2).astype(np.float32)
        if len(points) >= 5:
            (cx, cy), (width, height), angle = cv2.fitEllipse(points)
            cv2.ellipse(mask, ((cx, cy), (width * scale, height * scale), angle), 255, -1)
        else:
            cv2.fillPoly(mask, [points.astype(np.int32)], 255)
        self._support_masks[key] = mask
        return mask


def line_intersection(
    first: tuple[tuple[float, float], tuple[float, float]],
    second: tuple[tuple[float, float], tuple[float, float]],
) -> tuple[float, float]:
    """Recover geometry.Line.Intersect, including its exact-parallel fallback."""

    x1, y1 = (float(value) for value in first[0])
    x2, y2 = (float(value) for value in first[1])
    x3, y3 = (float(value) for value in second[0])
    x4, y4 = (float(value) for value in second[1])
    first_det = x1 * y2 - y1 * x2
    second_det = x3 * y4 - y3 * x4
    denominator = (y3 - y4) * (x1 - x2) - (x3 - x4) * (y1 - y2)
    if denominator == 0.0:
        denominator += 1e-6
    x = ((x3 - x4) * first_det - (x1 - x2) * second_det) / denominator
    y = ((y3 - y4) * first_det - (y1 - y2) * second_det) / denominator
    return float(x), float(y)


def point_distance(
    first: tuple[float, float],
    second: tuple[float, float],
) -> float:
    return float(np.hypot(float(first[0]) - float(second[0]), float(first[1]) - float(second[1])))


def point_line_distance(point: tuple[float, float], line: tuple[tuple[float, float], tuple[float, float]]) -> float:
    p = np.asarray(point, dtype=np.float64)
    a = np.asarray(line[0], dtype=np.float64)
    b = np.asarray(line[1], dtype=np.float64)
    direction = b - a
    norm = float(np.linalg.norm(direction))
    if norm <= 1e-9:
        return float("inf")
    rel = p - a
    return abs(float(rel[0] * direction[1] - rel[1] * direction[0])) / norm
