"""OpenCV dart detection and scoring helpers.

This package is intentionally camera-app agnostic. Your app should own camera
capture, calibration storage, and game state. This package consumes new-dart
masks plus per-camera calibration objects and returns line/tip detections and a
hybrid score.
"""

from .dart_tip_detection import CameraDartDetection, bridge_mask_gaps, detect_dart_lines, draw_detections

from .pipeline import detect_and_score_from_masks, detections_from_masks
from .scoring import DartScoringConfig, format_score, score_throw_summary

__all__ = [
    "CameraDartDetection",
    "DartScoringConfig",
    "bridge_mask_gaps",
    "detect_and_score_from_masks",
    "detect_dart_lines",
    "detections_from_masks",
    "draw_detections",
    "format_score",
    "score_throw_summary",
]
