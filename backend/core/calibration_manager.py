from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
from typing import Any
import threading

import cv2
import numpy as np
import math

from backend.calibration.calibration import DartboardCalibrator
from backend.config.settings import settings


@dataclass
class CalibratorState:
    calibrator: DartboardCalibrator


class CalibrationManager:
    """Owns per-camera calibrators (ellipse/radial path only)."""

    def __init__(self, num_cameras: int, calibration_dir: str = "backend/data/calibration"):
        base_dir = Path(calibration_dir)
        base_dir.mkdir(parents=True, exist_ok=True)
        self._items: list[CalibratorState] = []
        for i in range(num_cameras):
            cam_dir = base_dir / f"camera_{i}"
            cam_dir.mkdir(parents=True, exist_ok=True)
            self._items.append(
                CalibratorState(
                    calibrator=DartboardCalibrator(calibration_dir=str(cam_dir))
                )
            )

    def status(self, camera_index: int) -> dict[str, Any]:
        status = self._items[camera_index].calibrator.get_calibration_status()
        return {**status, "camera_index": camera_index}

    def calibrators(self, limit: int | None = None) -> list[DartboardCalibrator]:
        items = self._items if limit is None else self._items[: max(0, int(limit))]
        return [item.calibrator for item in items]

    def score(self, camera_index: int, x: float, y: float) -> dict[str, Any]:
        calibrator = self._items[camera_index].calibrator
        # Force ellipse/radial scoring path by ensuring ellipse calibration is preferred.
        return calibrator.get_dart_score(x, y)

    def project_to_model(self, camera_index: int, x: float, y: float) -> dict[str, Any]:
        """Project camera-space point to model-space (front-on) coordinates.

        Returns model coordinates plus normalized values in [0..1] range when possible.
        """
        calibrator = self._items[camera_index].calibrator
        model_x, model_y = calibrator.transform_point_to_model((float(x), float(y)))
        width = float(getattr(calibrator, "image_width", 0.0) or 0.0)
        height = float(getattr(calibrator, "image_height", 0.0) or 0.0)
        norm_x = (float(model_x) / width) if width > 0 else None
        norm_y = (float(model_y) / height) if height > 0 else None
        return {
            "model_x": float(model_x),
            "model_y": float(model_y),
            "norm_x": float(norm_x) if norm_x is not None else None,
            "norm_y": float(norm_y) if norm_y is not None else None,
        }

    def describe_board_point(self, camera_index: int, x: float, y: float) -> dict[str, Any]:
        """Describe a camera-space point relative to the calibrated dartboard."""
        calibrator = self._items[camera_index].calibrator
        model_x, model_y = calibrator.transform_point_to_model((float(x), float(y)))
        center_x = float(calibrator.model_center[0])
        center_y = float(calibrator.model_center[1])
        dx_px = float(model_x) - center_x
        dy_px = float(model_y) - center_y
        pixels_per_mm = float(getattr(calibrator, "pixels_per_mm", 0.0) or 0.0)
        distance_mm = (float(np.hypot(dx_px, dy_px)) / pixels_per_mm) if pixels_per_mm > 0 else None
        total_rotation = float(getattr(calibrator, "fronton_offset", 0.0) or 0.0) + float(
            getattr(calibrator, "rotation_angle", 0.0) or 0.0
        )
        outer_radius_mm = float(getattr(calibrator, "dartboard_diameter_mm", 340.0) or 340.0) / 2.0
        norm_x = (float(dx_px) / pixels_per_mm / outer_radius_mm) if pixels_per_mm > 0 and outer_radius_mm > 0 else None
        norm_y = (float(dy_px) / pixels_per_mm / outer_radius_mm) if pixels_per_mm > 0 and outer_radius_mm > 0 else None
        display_x = None
        display_y = None
        radius_norm = float(np.hypot(norm_x, norm_y)) if norm_x is not None and norm_y is not None else None
        if radius_norm is not None:
            display_angle_deg = self._fronton_display_angle_deg(calibrator, model_x, model_y)
            display_angle_rad = np.radians(display_angle_deg)
            display_x = float(np.cos(display_angle_rad) * radius_norm)
            display_y = float(np.sin(display_angle_rad) * radius_norm)
        return {
            "x": float(norm_x) if norm_x is not None else None,
            "y": float(norm_y) if norm_y is not None else None,
            "display_x": display_x,
            "display_y": display_y,
            "distance_mm": float(distance_mm) if distance_mm is not None else None,
            "rotation_deg": float(total_rotation),
            "mapped": bool(getattr(calibrator, "is_calibrated", False)),
            "board": {
                "model_x": float(model_x),
                "model_y": float(model_y),
            },
        }

    @staticmethod
    def _fronton_display_angle_deg(calibrator: Any, model_x: float, model_y: float) -> float:
        """Map model-space angle to display space where the 20 center is at top."""
        center_x = float(calibrator.model_center[0])
        center_y = float(calibrator.model_center[1])
        point_angle = float(np.degrees(np.arctan2(float(model_y) - center_y, float(model_x) - center_x))) % 360.0

        actual_twenty_angle = None
        ellipse_cal = getattr(calibrator, "ellipse_calibration", None)
        twenty_point = getattr(ellipse_cal, "twenty_point", None) if ellipse_cal is not None else None
        if twenty_point is not None:
            try:
                twenty_x, twenty_y = calibrator.transform_point_to_model((float(twenty_point[0]), float(twenty_point[1])))
                actual_twenty_angle = float(np.degrees(np.arctan2(float(twenty_y) - center_y, float(twenty_x) - center_x))) % 360.0
            except Exception:
                actual_twenty_angle = None

        if actual_twenty_angle is None:
            try:
                actual_twenty_angle = float(calibrator._calculate_twenty_center_angle_warped(calibrator.homography_matrix))
            except Exception:
                actual_twenty_angle = None
        if actual_twenty_angle is None:
            try:
                actual_twenty_angle = float(calibrator._calculate_twenty_mid_angle_warped(calibrator.homography_matrix))
            except Exception:
                actual_twenty_angle = None
        if actual_twenty_angle is None:
            try:
                actual_twenty_angle = float(calibrator._calculate_segment_camera_angle(20))
            except Exception:
                actual_twenty_angle = None
        if actual_twenty_angle is None or not math.isfinite(actual_twenty_angle):
            actual_twenty_angle = (float(getattr(calibrator, "homography_rotation_offset", 0.0) or 0.0) + float(
                getattr(calibrator, "rotation_angle", 0.0) or 0.0
            )) % 360.0

        return (point_angle - actual_twenty_angle + 270.0) % 360.0

    def rotate_next(self, camera_index: int) -> int:
        return self._items[camera_index].calibrator.rotate_to_next_segment()

    def save(self, camera_index: int) -> bool:
        return bool(self._items[camera_index].calibrator.save_calibration())

    def capture_calibration(
        self,
        camera_index: int,
        frame,
        cal_points,
        cal1_points,
        cal2_points=None,
        cal3_points=None,
        twenty_points=None,
        bull_boxes=None,
        bullseye_boxes=None,
    ) -> bool:
        return self._items[camera_index].calibrator.capture_calibration(
            frame,
            cal_points,
            cal1_points,
            cal2_points or [],
            cal3_points or [],
            twenty_points or [],
            bull_boxes or [],
            bullseye_boxes or [],
        )

    def overlay(self, camera_index: int, frame):
        return self._items[camera_index].calibrator.draw_dartboard_overlay(frame)

    def fronton(self, camera_index: int, frame):
        return self._items[camera_index].calibrator.get_fronton_view(frame)

    def encode_jpeg(self, frame, quality: int = 70) -> bytes | None:
        ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
        if not ok:
            return None
        return jpeg.tobytes()

    def get_saved_reference_frame(self, camera_index: int):
        calibrator = self._items[camera_index].calibrator
        in_mem = getattr(calibrator, "calibration_image", None)
        if isinstance(in_mem, np.ndarray):
            return in_mem.copy()
        ref_path = Path(str(calibrator.calibration_dir)) / "calibration_reference.jpg"
        if ref_path.exists():
            img = cv2.imread(str(ref_path), cv2.IMREAD_COLOR)
            if isinstance(img, np.ndarray):
                return img
        return None


_SHARED_MANAGER: CalibrationManager | None = None
_SHARED_MANAGER_LOCK = threading.Lock()


def get_shared_calibration_manager(
    num_cameras: int | None = None,
    calibration_dir: str | None = None,
) -> CalibrationManager:
    global _SHARED_MANAGER
    with _SHARED_MANAGER_LOCK:
        if _SHARED_MANAGER is None:
            _SHARED_MANAGER = CalibrationManager(
                num_cameras=int(num_cameras if num_cameras is not None else len(settings.camera_indices)),
                calibration_dir=str(calibration_dir if calibration_dir is not None else settings.calibration_data_dir),
            )
        return _SHARED_MANAGER
