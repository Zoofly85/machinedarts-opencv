"""High-level package API for mask -> line/tip -> score."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Mapping, Optional

import cv2
import numpy as np

from .dart_tip_detection import CameraDartDetection, detect_dart_lines

from .scoring import DartScoringConfig, score_throw_summary


def detection_to_camera_summary(det: CameraDartDetection) -> dict:
    return {
        "camera_index": int(det.camera_index),
        "new_mask_pixels": 0,
        "bbox": [int(v) for v in det.bbox],
        "line_point": [float(v) for v in det.line_point],
        "line_direction": [float(v) for v in det.line_direction],
        "endpoint_a": [float(v) for v in det.endpoint_a],
        "endpoint_b": [float(v) for v in det.endpoint_b],
        "board_end_vote": [float(v) for v in det.board_end],
        "contour_area": float(det.contour_area),
        "confidence": float(det.confidence),
        "endpoint_a_width": float(det.endpoint_a_width),
        "endpoint_b_width": float(det.endpoint_b_width),
        "width_ratio": float(det.width_ratio),
        "used_width_tip": bool(det.used_width_tip),
    }


def _crop_mask_to_content(mask: np.ndarray, padding: int = 36) -> tuple[np.ndarray, tuple[int, int]]:
    mask_u8 = (mask > 0).astype(np.uint8)
    pts = cv2.findNonZero(mask_u8)
    if pts is None:
        return mask, (0, 0)

    x, y, w, h = cv2.boundingRect(pts)
    full_h, full_w = mask.shape[:2]
    x0 = max(0, int(x) - int(padding))
    y0 = max(0, int(y) - int(padding))
    x1 = min(full_w, int(x + w) + int(padding))
    y1 = min(full_h, int(y + h) + int(padding))
    return mask[y0:y1, x0:x1], (x0, y0)


def _shift_point(point: tuple[float, float], offset: tuple[int, int]) -> tuple[float, float]:
    return (float(point[0]) + float(offset[0]), float(point[1]) + float(offset[1]))


def _translate_detection(det: CameraDartDetection, offset: tuple[int, int]) -> CameraDartDetection:
    ox, oy = offset
    x, y, w, h = det.bbox
    return CameraDartDetection(
        camera_index=int(det.camera_index),
        bbox=(int(x + ox), int(y + oy), int(w), int(h)),
        line_point=_shift_point(det.line_point, offset),
        line_direction=(float(det.line_direction[0]), float(det.line_direction[1])),
        endpoint_a=_shift_point(det.endpoint_a, offset),
        endpoint_b=_shift_point(det.endpoint_b, offset),
        board_end=_shift_point(det.board_end, offset),
        contour_area=float(det.contour_area),
        confidence=float(det.confidence),
        endpoint_a_width=float(det.endpoint_a_width),
        endpoint_b_width=float(det.endpoint_b_width),
        width_ratio=float(det.width_ratio),
        used_width_tip=bool(det.used_width_tip),
        source_priority=int(det.source_priority),
    )


def _detect_one_camera_mask(
    item: tuple[int, np.ndarray],
    *,
    board_centers: Optional[Mapping[int, tuple[float, float]]],
    min_area: float,
    min_points: int,
    line_strategy: str,
) -> tuple[int, dict, List[CameraDartDetection]]:
    cam_i, mask = item
    center = board_centers.get(cam_i) if board_centers else None
    cropped_mask, offset = _crop_mask_to_content(mask)
    cropped_center = None
    if center is not None:
        cropped_center = (float(center[0]) - float(offset[0]), float(center[1]) - float(offset[1]))

    detections = detect_dart_lines(
        cropped_mask,
        camera_index=int(cam_i),
        board_center=cropped_center,
        min_area=min_area,
        min_points=min_points,
        line_strategy=line_strategy,
    )
    detections = [_translate_detection(det, offset) for det in detections]

    if detections:
        summary = detection_to_camera_summary(detections[0])
        summary["new_mask_pixels"] = int(np.count_nonzero(mask))
        summary["line_strategy"] = str(line_strategy)
    else:
        summary = {
            "camera_index": int(cam_i),
            "new_mask_pixels": int(np.count_nonzero(mask)),
            "detections": [],
            "reason": "no dart line found in new mask",
        }

    summary["crop_offset"] = [int(offset[0]), int(offset[1])]
    summary["crop_size"] = [int(cropped_mask.shape[1]), int(cropped_mask.shape[0])]
    return int(cam_i), summary, detections


def detections_from_masks(
    masks: Mapping[int, np.ndarray],
    *,
    board_centers: Optional[Mapping[int, tuple[float, float]]] = None,
    min_area: float = 40.0,
    min_points: int = 25,
    line_strategy: str = "full_centerline",
) -> dict:
    """Run line/tip detection on per-camera new-dart masks.

    `masks` should contain only the new dart pixels for each camera. Existing
    darts should already be excluded by the caller's detector state.
    """
    items = [(int(cam_i), mask) for cam_i, mask in sorted(masks.items())]
    if len(items) > 1:
        with ThreadPoolExecutor(max_workers=min(3, len(items))) as pool:
            results = list(
                pool.map(
                    lambda item: _detect_one_camera_mask(
                        item,
                        board_centers=board_centers,
                        min_area=min_area,
                        min_points=min_points,
                        line_strategy=line_strategy,
                    ),
                    items,
                )
            )
    else:
        results = [
            _detect_one_camera_mask(
                item,
                board_centers=board_centers,
                min_area=min_area,
                min_points=min_points,
                line_strategy=line_strategy,
            )
            for item in items
        ]

    cameras: List[dict] = []
    raw_detections: Dict[int, List[CameraDartDetection]] = {}
    for cam_i, summary, detections in sorted(results, key=lambda row: row[0]):
        raw_detections[int(cam_i)] = detections
        cameras.append(summary)
    return {"cameras": cameras, "raw_detections": raw_detections}


def detect_and_score_from_masks(
    masks: Mapping[int, np.ndarray],
    calibrators: Mapping[int, object],
    *,
    detection_counter: int = 0,
    config: Optional[DartScoringConfig] = None,
    board_centers: Optional[Mapping[int, tuple[float, float]]] = None,
    line_strategy: str = "full_centerline",
) -> dict:
    """Detect lines from masks and score them with existing app calibrators."""
    detection_result = detections_from_masks(masks, board_centers=board_centers, line_strategy=line_strategy)
    throw_summary = {
        "detection_counter": int(detection_counter),
        "cameras": detection_result["cameras"],
    }
    score_throw_summary(throw_summary, calibrators, config=config)
    return throw_summary
