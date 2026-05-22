"""High-level package API for mask -> line/tip -> score."""

from __future__ import annotations

from typing import Dict, List, Mapping, Optional

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
    cameras: List[dict] = []
    raw_detections: Dict[int, List[CameraDartDetection]] = {}
    for cam_i, mask in sorted(masks.items()):
        center = board_centers.get(cam_i) if board_centers else None
        detections = detect_dart_lines(
            mask,
            camera_index=int(cam_i),
            board_center=center,
            min_area=min_area,
            min_points=min_points,
            line_strategy=line_strategy,
        )
        raw_detections[int(cam_i)] = detections
        if detections:
            item = detection_to_camera_summary(detections[0])
            item["new_mask_pixels"] = int(np.count_nonzero(mask))
            item["line_strategy"] = str(line_strategy)
            cameras.append(item)
        else:
            cameras.append(
                {
                    "camera_index": int(cam_i),
                    "new_mask_pixels": int(np.count_nonzero(mask)),
                    "detections": [],
                    "reason": "no dart line found in new mask",
                }
            )
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
