from __future__ import annotations

import time
from collections import Counter
from typing import Any, Mapping, Optional

import numpy as np

from backend.config.settings import settings
from backend.core.calibration_manager import CalibrationManager, get_shared_calibration_manager

from .calibration_adapter import build_vision_configuration
from .models import DetectionResult, Segment
from .motion import MotionAnalyzer, MotionLifecycle
from .pipeline import BoardVisionDetector


def _score_dict(segment: Segment) -> dict[str, Any]:
    if int(segment.multiplier) <= 0:
        return {"score": 0, "multiplier": 1, "segment": 0, "zone": "miss"}
    if int(segment.number) == 25:
        if int(segment.multiplier) == 2:
            return {"score": 50, "multiplier": 2, "segment": 25, "zone": "inner_bull"}
        return {"score": 25, "multiplier": 1, "segment": 25, "zone": "outer_bull"}
    multiplier = int(segment.multiplier)
    return {
        "score": int(segment.number) * multiplier,
        "multiplier": multiplier,
        "segment": int(segment.number),
        "zone": {1: "single", 2: "double", 3: "triple"}.get(multiplier, "single"),
    }


class BoardVisionService:
    def __init__(self, calibration_dir: str | None = None) -> None:
        manager = (
            CalibrationManager(num_cameras=3, calibration_dir=calibration_dir)
            if calibration_dir is not None
            else get_shared_calibration_manager(
                num_cameras=len(settings.camera_indices),
                calibration_dir=settings.calibration_data_dir,
            )
        )
        calibrators = {
            index: calibrator
            for index, calibrator in enumerate(manager.calibrators(limit=3))
            if getattr(calibrator, "is_calibrated", False)
        }
        if len(calibrators) != 3:
            raise RuntimeError("Three calibrated scoring cameras are required")
        self.config, self.dynamic = build_vision_configuration(calibrators)
        self.detector = BoardVisionDetector(self.config, self.dynamic, segmentation_mode="throw")
        motion = self.config.get("motion") or {}
        self.motion = MotionAnalyzer(
            self.detector.calibrations,
            self.dynamic,
            scale=int(motion.get("scale") or 4),
            threshold=int(motion.get("threshold") or 16),
            kernel=int(motion.get("kernel") or 3),
        )
        self.stable_frames = int(motion.get("stable_num_frames") or 3)

    def lifecycle(self, frames: Mapping[int, np.ndarray]) -> MotionLifecycle:
        return MotionLifecycle.start(self.motion, self.dynamic, self.stable_frames, dict(frames))

    def score_frames(
        self,
        *,
        empty: Mapping[int, np.ndarray],
        before: Mapping[int, np.ndarray],
        after: Mapping[int, np.ndarray],
        dart_index: int,
    ) -> dict[str, Any]:
        started = time.perf_counter()
        result = self.detector.detect(dict(empty), dict(before), dict(after))
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        return self._result_payload(result, dart_index=dart_index, elapsed_ms=elapsed_ms)

    @staticmethod
    def _result_payload(result: DetectionResult, *, dart_index: int, elapsed_ms: float) -> dict[str, Any]:
        final_score = _score_dict(result.segment)
        final_label = result.segment.label
        camera_votes = []
        candidates = []
        selected_tips = []
        for vote in result.cameras:
            score = None if vote.abstention else _score_dict(vote.segment)
            camera_item = {
                "camera_index": int(vote.camera),
                "score": score,
                "label": None if vote.abstention else vote.segment.label,
                "vote": list(vote.image_tip) if vote.image_tip is not None else None,
                "board_vote": list(vote.board_tip) if vote.board_tip is not None else None,
                "confidence": max(0.0, min(1.0, 1.0 - float(vote.error or 0.0))) if not vote.abstention else 0.0,
                "error": vote.error,
                "mask_pixels": int(vote.mask_pixels),
                "bouncer": bool(vote.bouncer),
                "debug": dict(vote.debug),
            }
            camera_votes.append(camera_item)
            if vote.image_tip is not None:
                selected_tips.append(
                    {
                        "camera_index": int(vote.camera),
                        "x": float(vote.image_tip[0]),
                        "y": float(vote.image_tip[1]),
                    }
                )
            if score is not None:
                candidates.append(
                    {
                        "camera_index": int(vote.camera),
                        "tip": {"x": float(vote.image_tip[0]), "y": float(vote.image_tip[1])} if vote.image_tip else None,
                        "confidence": camera_item["confidence"],
                        "score": score,
                        "score_value": int(score["score"]),
                        "is_miss": int(score["score"]) <= 0,
                        "label": vote.segment.label,
                    }
                )
        intersections = [
            {
                "pair": f"{vote.cam1}-{vote.cam2}",
                "score": None if vote.abstention else _score_dict(vote.segment),
                "label": None if vote.abstention else vote.segment.label,
                "point": list(vote.coords) if vote.coords is not None else None,
                "errors": [vote.cam1_error, vote.cam2_error],
            }
            for vote in result.intersections
        ]
        camera_agreement = Counter(
            vote.segment.label for vote in result.cameras if not vote.abstention
        ).get(final_label, 0)
        intersection_agreement = Counter(
            vote.segment.label for vote in result.intersections if not vote.abstention
        ).get(final_label, 0)
        agreement = max(1, int(camera_agreement), int(intersection_agreement))
        if result.method == "Cam+Intersection":
            agreement = max(1, int(camera_agreement) + int(intersection_agreement))
        board = {
            "x": float(result.coords[0]) if result.coords is not None else None,
            "y": float(result.coords[1]) if result.coords is not None else None,
            "display_x": float(result.coords[0]) if result.coords is not None else None,
            "display_y": float(result.coords[1]) if result.coords is not None else None,
            "rotation_deg": 0.0 if result.coords is not None else None,
            "model_x": None,
            "model_y": None,
            "opencv_source": result.method,
            "model_point": list(result.coords) if result.coords is not None else None,
        }
        voted_score = {**final_score, "board": board}
        timings = {
            "total_ms": round(float(elapsed_ms), 2),
            "preprocess_ms": None,
            "inference_ms": 0.0,
            "decode_ms": 0.0,
            "calibration_ms": 0.0,
            "vote_ms": None,
            "board_vision_score_ms": round(float(elapsed_ms), 2),
        }
        scoring = {
            "source": result.method,
            "predicted_label": final_label,
            "uncertain": result.method in {"BestCamera", "Failed"},
            "final": {
                "score": final_score,
                "label": final_label,
                "agreement": agreement,
                "cameras": len(result.cameras),
                "model_point": list(result.coords) if result.coords is not None else None,
            },
            "camera_votes": camera_votes,
            "intersections": intersections,
            "bouncer": bool(result.bouncer),
        }
        return {
            "ok": True,
            "active_model_id": "board-vision-v1",
            "voted_score_value": int(final_score["score"]),
            "voted_score": voted_score,
            "votes": agreement,
            "miss_reason": "bounce" if result.bouncer else ("miss" if int(final_score["score"]) <= 0 else None),
            "diagnostics": {
                "camera_count": len(result.cameras),
                "opencv_source": result.method,
                "mask_mode": "one_frame",
            },
            "candidates": candidates,
            "selected_new_tips": selected_tips,
            "masks": [
                vote.selected_mask
                for vote in sorted(result.cameras, key=lambda item: int(item.camera))
            ],
            "opencv_result": {
                "detection_counter": int(dart_index),
                "cameras": camera_votes,
                "scoring": scoring,
            },
            "timings": timings,
        }

    def reset_tracks(self) -> None:
        return None

    def commit_tracked_tips(self, _tips: list[dict[str, Any]], **_kwargs: Any) -> None:
        return None

    def reload_calibration(self) -> None:
        return None
