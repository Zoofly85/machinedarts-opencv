from __future__ import annotations

import math
from typing import Any, Mapping

import cv2
import numpy as np

from backend.calibration.ellipse_calibration import (
    get_segment_number_from_boundaries,
    line_ellipse_intersection_float,
)

from .geometry import BoardCalibration


RINGS = {
    "doubleOuters": "outer_double_ellipse",
    "doubleInner": "inner_double_ellipse",
    "trebleOuters": "outer_triple_ellipse",
    "trebleInner": "inner_triple_ellipse",
}


def dynamic_config(outer_height: int) -> dict[str, Any]:
    height = max(1.0, float(outer_height))
    return {
        "motionMinChange": max(1, int(round(0.05 * height))),
        "motionMinContourArea": round(0.02025 * height, 2),
        "motionMinDartPixels": max(1, int(round(0.10 * height))),
        "motionMinHandForegroundPixels": max(1, int(round(0.05 * height))),
        "motionMinHandBackgroundPixels": max(1, int(round(7.58 * height))),
        "motionMinDartFrames": 2,
        "detectionMinContourArea": round(0.081 * height, 2),
        "detectionHoughThreshold": max(1, int(round(0.04 * height))),
        "detectionMinNewDartPixelRatio": 0.6,
        "detectionMinNewPixels": max(1, int(round(0.40 * height))),
        "takeoutMinCoverage": 0.8,
        "takeoutMinHandFrames": 3,
        "takeoutMinCompletedFrames": 30,
        "takeoutCompletedStableMultiplier": 10,
        "startupWaitFrames": 15,
        "detectionWaitFrames": 6,
        "takeoutWaitFrames": 10,
    }


def _ordered_boundaries(calibration: Any, rotation: float) -> list[float]:
    angles = sorted(float(angle) % 360.0 for angle in calibration.segment_angles)
    for index, angle in enumerate(angles):
        next_angle = angles[(index + 1) % len(angles)]
        sample_angle = (angle + ((next_angle - angle) % 360.0) * 0.5) % 360.0
        sample = (
            calibration.center[0] + math.cos(math.radians(sample_angle)) * 100.0,
            calibration.center[1] + math.sin(math.radians(sample_angle)) * 100.0,
        )
        if get_segment_number_from_boundaries(
            sample,
            calibration.center,
            angles,
            rotation_offset_deg=rotation,
        ) == 1:
            return [angles[(index + offset) % 20] for offset in range(20)]
    raise ValueError("Could not locate the 20/1 calibration boundary")


def _ring_points(calibration: Any, ellipse: Any, angles: list[float]) -> list[list[float]]:
    points = []
    for angle in angles:
        direction = (math.cos(math.radians(angle)), math.sin(math.radians(angle)))
        x, y = line_ellipse_intersection_float(calibration.center, direction, ellipse)
        points.append([round(float(x), 3), round(float(y), 3)])
    return points


def build_vision_configuration(calibrators: Mapping[int, object]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    dartboards: dict[str, Any] = {}
    dynamic: list[dict[str, Any]] = []
    for camera in sorted(calibrators):
        calibrator = calibrators[camera]
        ellipse = getattr(calibrator, "ellipse_calibration", None)
        if ellipse is None or len(getattr(ellipse, "segment_angles", [])) != 20:
            raise ValueError(f"Camera {camera} has no valid ellipse calibration")
        rotation = float(getattr(calibrator, "rotation_angle", 0.0) or getattr(ellipse, "auto_rotation_offset_deg", 0.0) or 0.0)
        angles = _ordered_boundaries(ellipse, rotation)
        board: dict[str, Any] = {"bull": [float(ellipse.center[0]), float(ellipse.center[1])]}
        for key, attribute in RINGS.items():
            ring = getattr(ellipse, attribute, None)
            if ring is None:
                raise ValueError(f"Camera {camera} is missing {attribute}")
            board[key] = _ring_points(ellipse, ring, angles)
        dartboards[str(camera)] = board
        outer = np.asarray(board["doubleOuters"], dtype=np.float32)
        _x, _y, _width, height = cv2.boundingRect(outer.reshape(-1, 1, 2))
        dynamic.append(dynamic_config(height))
    config = {
        "motion": {"scale": 4, "kernel": 3, "threshold": 16, "stable_num_frames": 3},
        "detection": {"kernel": 5, "threshold": 16},
        "dartboard": dartboards,
    }
    return config, dynamic


def build_board_calibrations(config: Mapping[str, Any]) -> dict[int, BoardCalibration]:
    return {
        int(camera): BoardCalibration.from_config(int(camera), board)
        for camera, board in (config.get("dartboard") or {}).items()
    }
