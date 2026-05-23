from __future__ import annotations

import time
from collections import defaultdict
from typing import Any, Optional

import numpy as np

from backend.config.settings import settings
from backend.core.calibration_manager import get_shared_calibration_manager
from backend.core.opencv_dart_detection import DartScoringConfig, detect_and_score_from_masks
from backend.core.opencv_dart_detection.dart_tip_detection import bridge_mask_gaps
from backend.core.opencv_dart_detection.scoring import final_score_key, format_score


CODE_NEW = 76


class OpenCvDartScoringService:
    """Score confirmed darts from the detector's CODE_NEW masks.

    This service intentionally does not own dart detection or takeout. It uses
    the app's existing detector state machine, then replaces the AI tip model
    with OpenCV mask line fitting plus calibration-backed line/tip voting.
    """

    def __init__(self) -> None:
        self._cal_manager = get_shared_calibration_manager(
            num_cameras=len(settings.camera_indices),
            calibration_dir=settings.calibration_data_dir,
        )
        self._calibrators_cache: dict[int, object] = {}
        self._board_centers_cache: dict[int, tuple[float, float]] = {}
        self._config_cache = DartScoringConfig(camera_calibration_map={})
        self._refresh_calibration_cache()

    def reload_calibration(self) -> None:
        self._cal_manager = get_shared_calibration_manager(
            num_cameras=len(settings.camera_indices),
            calibration_dir=settings.calibration_data_dir,
        )
        self._refresh_calibration_cache()

    def reset_tracks(self) -> None:
        # Kept for compatibility with the existing takeout reset path.
        return None

    def commit_tracked_tips(self, tips: list[tuple[int, float, float]]) -> None:
        # OpenCV scoring does not need duplicate AI-tip tracking.
        return None

    def get_runtime_info(self) -> dict[str, Any]:
        return {"active_model_id": "opencv-line-fit", "runtime": "opencv"}

    def _calibrators(self) -> dict[int, object]:
        if not self._calibrators_cache:
            self._refresh_calibration_cache()
        return dict(self._calibrators_cache)

    def _refresh_calibration_cache(self) -> None:
        self._calibrators_cache = {
            cam_i: item.calibrator
            for cam_i, item in enumerate(getattr(self._cal_manager, "_items", []))
        }
        self._board_centers_cache = self._board_centers(self._calibrators_cache)
        self._config_cache = DartScoringConfig(
            camera_calibration_map={i: i for i in self._calibrators_cache}
        )

    @staticmethod
    def _board_centers(calibrators: dict[int, object]) -> dict[int, tuple[float, float]]:
        centers: dict[int, tuple[float, float]] = {}
        for cam_i, calibrator in calibrators.items():
            if not getattr(calibrator, "is_calibrated", False):
                continue
            try:
                center = calibrator.transform_point_to_camera(calibrator.model_center)
                centers[int(cam_i)] = (float(center[0]), float(center[1]))
            except Exception:
                continue
        return centers

    @staticmethod
    def _extract_new_masks(masks: list[Optional[np.ndarray]]) -> dict[int, np.ndarray]:
        out: dict[int, np.ndarray] = {}
        for cam_i, mask in enumerate(masks or []):
            if not isinstance(mask, np.ndarray):
                continue
            new_mask = (mask == CODE_NEW).astype(np.uint8) * 255
            if int(np.count_nonzero(new_mask)) > 0:
                out[int(cam_i)] = new_mask
        return out

    @staticmethod
    def _bridge_mask_cropped(mask: np.ndarray, padding: int = 48) -> np.ndarray:
        coords = np.argwhere(mask > 0)
        if coords.size == 0:
            return np.zeros_like(mask, dtype=np.uint8)

        y0, x0 = coords.min(axis=0)
        y1, x1 = coords.max(axis=0) + 1
        h, w = mask.shape[:2]
        x0 = max(0, int(x0) - int(padding))
        y0 = max(0, int(y0) - int(padding))
        x1 = min(w, int(x1) + int(padding))
        y1 = min(h, int(y1) + int(padding))

        out = np.zeros_like(mask, dtype=np.uint8)
        out[y0:y1, x0:x1] = bridge_mask_gaps(mask[y0:y1, x0:x1])
        return out

    @staticmethod
    def _score_value(score: dict[str, Any]) -> int:
        try:
            return int(score.get("score", 0) or 0)
        except Exception:
            return 0

    @classmethod
    def _result_score_value(cls, result: dict[str, Any]) -> int:
        scoring = result.get("scoring", {}) if isinstance(result.get("scoring"), dict) else {}
        final = scoring.get("final") if isinstance(scoring.get("final"), dict) else None
        final_score = final.get("score") if isinstance(final, dict) and isinstance(final.get("score"), dict) else {}
        return cls._score_value(final_score)

    @classmethod
    def _score_candidate_rank(cls, result: dict[str, Any]) -> int:
        scoring = result.get("scoring", {}) if isinstance(result.get("scoring"), dict) else {}
        source = str(scoring.get("source") or "")
        final_value = cls._result_score_value(result)
        cluster = scoring.get("intersection_consensus") if isinstance(scoring.get("intersection_consensus"), dict) else {}
        agreement = int(cluster.get("agreement") or 0)
        try:
            spread = float(cluster.get("spread_px") or scoring.get("intersection_spread_px") or 9999.0)
        except Exception:
            spread = 9999.0

        rank = 0
        if final_value > 0:
            rank += 20
        if source.startswith("line_cluster"):
            rank += 25
        if agreement >= 3:
            rank += 20
        elif agreement >= 2:
            rank += 12
        if spread <= 12.0:
            rank += 10
        elif spread <= 35.0:
            rank += 5
        if source in {"single_pair_tip_rescue", "triple_boundary_upgrade"}:
            rank += 8
        if source.startswith("camera_score_consensus") and final_value <= 0:
            rank -= 15
        return rank

    @classmethod
    def _is_strong_mask_result(cls, result: dict[str, Any]) -> bool:
        scoring = result.get("scoring", {}) if isinstance(result.get("scoring"), dict) else {}
        source = str(scoring.get("source") or "")
        if cls._result_score_value(result) <= 0:
            return False
        if not (
            source.startswith("line_cluster")
            or source.startswith("ellipse_radial_line_fallback")
        ):
            return False

        cluster = scoring.get("intersection_consensus")
        if not isinstance(cluster, dict):
            cluster = scoring.get("ellipse_radial_intersection_consensus")
        if not isinstance(cluster, dict):
            return False

        agreement = int(cluster.get("agreement") or 0)
        try:
            spread = float(cluster.get("spread_px") or scoring.get("intersection_spread_px") or 9999.0)
        except Exception:
            spread = 9999.0
        return (agreement >= 3 and spread <= 12.0) or (agreement >= 2 and spread <= 6.0)

    @classmethod
    def _single_mask_mode_candidates(
        cls,
        result: dict[str, Any],
        *,
        selected_mode: str,
        skipped_mode: str,
        reason: str,
    ) -> dict[str, Any]:
        scoring = result.get("scoring", {}) if isinstance(result.get("scoring"), dict) else {}
        rank = cls._score_candidate_rank(result)
        return {
            selected_mode: {
                "rank": int(rank),
                "score": int(cls._result_score_value(result)),
                "source": scoring.get("source"),
                "label": scoring.get("predicted_label"),
            },
            skipped_mode: {"skipped": True, "reason": reason},
            "selected": selected_mode,
        }

    @classmethod
    def _select_mask_mode_result(cls, raw_result: dict[str, Any], bridged_result: dict[str, Any]) -> dict[str, Any]:
        raw_rank = cls._score_candidate_rank(raw_result)
        bridged_rank = cls._score_candidate_rank(bridged_result)
        selected = bridged_result if bridged_rank > raw_rank else raw_result
        selected = cls._apply_cross_mode_triple_rescue(selected, raw_result, bridged_result)
        scoring = selected.setdefault("scoring", {})
        scoring["mask_mode_candidates"] = {
            "raw": {
                "rank": int(raw_rank),
                "score": int(cls._result_score_value(raw_result)),
                "source": (raw_result.get("scoring") or {}).get("source"),
                "label": (raw_result.get("scoring") or {}).get("predicted_label"),
            },
            "bridged": {
                "rank": int(bridged_rank),
                "score": int(cls._result_score_value(bridged_result)),
                "source": (bridged_result.get("scoring") or {}).get("source"),
                "label": (bridged_result.get("scoring") or {}).get("predicted_label"),
            },
            "selected": "bridged" if selected is bridged_result else "raw",
        }
        return selected

    @classmethod
    def _apply_cross_mode_triple_rescue(
        cls,
        selected: dict[str, Any],
        raw_result: dict[str, Any],
        bridged_result: dict[str, Any],
    ) -> dict[str, Any]:
        scoring = selected.get("scoring", {}) if isinstance(selected.get("scoring"), dict) else {}
        final = scoring.get("final") if isinstance(scoring.get("final"), dict) else None
        final_score = final.get("score") if isinstance(final, dict) and isinstance(final.get("score"), dict) else None
        if not final_score:
            return selected
        segment = int(final_score.get("segment") or 0)
        multiplier = int(final_score.get("multiplier") or 1)
        zone = str(final_score.get("zone") or "")
        if segment <= 0 or multiplier != 1 or not zone.startswith("single"):
            return selected

        same_segment_single_clusters = []
        same_segment_camera_votes = 0
        same_segment_single_camera_votes = 0
        same_segment_triples: list[tuple[str, dict[str, Any]]] = []

        for result in (raw_result, bridged_result):
            result_scoring = result.get("scoring", {}) if isinstance(result.get("scoring"), dict) else {}
            mode = str(result_scoring.get("mask_mode") or "unknown")
            cluster = result_scoring.get("intersection_consensus")
            if isinstance(cluster, dict):
                key = cluster.get("key") or []
                cluster_segment = int(key[0]) if len(key) > 0 and key[0] is not None else 0
                cluster_multiplier = int(key[1]) if len(key) > 1 and key[1] is not None else 1
                agreement = int(cluster.get("agreement") or 0)
                try:
                    spread = float(cluster.get("spread_px") or 9999.0)
                except Exception:
                    spread = 9999.0
                if cluster_segment == segment and cluster_multiplier == 1 and agreement >= 2 and spread <= 35.0:
                    same_segment_single_clusters.append(
                        {
                            "mode": mode,
                            "agreement": agreement,
                            "spread_px": spread,
                            "pairs": cluster.get("pairs") or [],
                            "label": cluster.get("label"),
                        }
                    )
                    if agreement >= 2 and spread <= 14.0:
                        return selected

            for vote in result_scoring.get("camera_votes", []) or []:
                score = vote.get("score") if isinstance(vote, dict) else None
                if isinstance(score, dict) and int(score.get("segment") or 0) == segment and cls._score_value(score) > 0:
                    same_segment_camera_votes += 1
                    if int(score.get("multiplier") or 1) == 1 and str(score.get("zone") or "").startswith("single"):
                        same_segment_single_camera_votes += 1

            for item in result_scoring.get("intersections", []) or []:
                if not isinstance(item, dict):
                    continue
                score = item.get("score")
                if not isinstance(score, dict):
                    continue
                if final_score_key(score) == (segment, 3, "triple"):
                    same_segment_triples.append((mode, item))

        if not same_segment_triples:
            return selected
        if same_segment_single_camera_votes >= 2:
            return selected
        if not same_segment_single_clusters and same_segment_camera_votes < 2:
            return selected

        mode, triple_item = same_segment_triples[0]
        triple_score = triple_item.get("score")
        if not isinstance(triple_score, dict):
            return selected

        upgraded = dict(selected)
        upgraded_scoring = dict(scoring)
        upgraded_final = dict(final or {})
        upgraded_final["score"] = triple_score
        upgraded_final["label"] = format_score(triple_score)
        upgraded_final["agreement"] = max(int(upgraded_final.get("agreement") or 1), 1)
        upgraded_final["model_point"] = triple_item.get("point")
        upgraded_scoring["final"] = upgraded_final
        upgraded_scoring["predicted_label"] = upgraded_final["label"]
        upgraded_scoring["uncertain"] = False
        upgraded_scoring["source"] = "cross_mode_same_segment_triple"
        upgraded_scoring["cross_mode_same_segment_triple"] = {
            "segment": int(segment),
            "triple_mode": mode,
            "triple_pair": triple_item.get("pair"),
            "triple_point": triple_item.get("point"),
            "single_clusters": same_segment_single_clusters,
            "same_segment_camera_votes": int(same_segment_camera_votes),
            "same_segment_single_camera_votes": int(same_segment_single_camera_votes),
        }
        upgraded["scoring"] = upgraded_scoring
        return upgraded

    def score_masks(self, masks: list[Optional[np.ndarray]], *, dart_index: int = 0) -> dict[str, Any]:
        total_t0 = time.perf_counter()
        timings: dict[str, Any] = {}
        t0 = time.perf_counter()
        new_masks = self._extract_new_masks(masks)
        timings["extract_masks_ms"] = round((time.perf_counter() - t0) * 1000.0, 2)
        if not new_masks:
            timings["total_ms"] = round((time.perf_counter() - total_t0) * 1000.0, 2)
            return {"ok": False, "reason": "no_new_dart_mask", "timings": timings}

        t0 = time.perf_counter()
        calibrators = self._calibrators_cache
        if not calibrators:
            self._refresh_calibration_cache()
            calibrators = self._calibrators_cache
        config = self._config_cache
        board_centers = self._board_centers_cache
        timings["calibration_cache_ms"] = round((time.perf_counter() - t0) * 1000.0, 2)
        if not calibrators:
            timings["total_ms"] = round((time.perf_counter() - total_t0) * 1000.0, 2)
            return {"ok": False, "reason": "no_calibration", "timings": timings}

        line_strategy = "tip_refit"
        t0 = time.perf_counter()
        bridged_masks = {cam_i: self._bridge_mask_cropped(mask) for cam_i, mask in new_masks.items()}
        timings["bridge_mask_ms"] = round((time.perf_counter() - t0) * 1000.0, 2)

        t0 = time.perf_counter()
        bridged_result = detect_and_score_from_masks(
            bridged_masks,
            calibrators,
            detection_counter=int(dart_index or 0),
            config=config,
            board_centers=board_centers,
            line_strategy=line_strategy,
        )
        bridged_result.setdefault("scoring", {})["mask_mode"] = "bridged"
        timings["bridged_score_ms"] = round((time.perf_counter() - t0) * 1000.0, 2)

        raw_result: Optional[dict[str, Any]] = None
        if self._is_strong_mask_result(bridged_result):
            result = bridged_result
            scoring_for_mode = result.setdefault("scoring", {})
            scoring_for_mode["mask_mode_candidates"] = self._single_mask_mode_candidates(
                result,
                selected_mode="bridged",
                skipped_mode="raw",
                reason="strong_bridged_result",
            )
            scoring_for_mode["adaptive_mask_mode"] = {
                "raw_skipped": True,
                "reason": "strong_bridged_result",
            }
            timings["raw_score_ms"] = 0.0
            timings["selection_ms"] = 0.0
        else:
            t0 = time.perf_counter()
            raw_result = detect_and_score_from_masks(
                new_masks,
                calibrators,
                detection_counter=int(dart_index or 0),
                config=config,
                board_centers=board_centers,
                line_strategy=line_strategy,
            )
            raw_result.setdefault("scoring", {})["mask_mode"] = "raw"
            timings["raw_score_ms"] = round((time.perf_counter() - t0) * 1000.0, 2)
            t0 = time.perf_counter()
            result = self._select_mask_mode_result(raw_result, bridged_result)
            result.setdefault("scoring", {})["adaptive_mask_mode"] = {
                "raw_skipped": False,
                "reason": "bridged_not_strong",
            }
            timings["selection_ms"] = round((time.perf_counter() - t0) * 1000.0, 2)

        scoring = result.get("scoring", {}) if isinstance(result.get("scoring"), dict) else {}
        final = scoring.get("final") if isinstance(scoring.get("final"), dict) else None
        final_score = final.get("score") if isinstance(final, dict) and isinstance(final.get("score"), dict) else None
        if not isinstance(final_score, dict):
            timings["total_ms"] = round((time.perf_counter() - total_t0) * 1000.0, 2)
            return {
                "ok": False,
                "reason": "opencv_score_uncertain",
                "opencv_result": result,
                "timings": timings,
            }

        t0 = time.perf_counter()
        candidates = []
        selected_new_tips = []
        for item in scoring.get("camera_votes", []):
            if not isinstance(item, dict):
                continue
            vote = item.get("vote")
            score = item.get("score") if isinstance(item.get("score"), dict) else {}
            score_value = self._score_value(score)
            cam_i = int(item.get("camera_index", -1))
            candidate = {
                "camera_index": cam_i,
                "tip": {"x": float(vote[0]), "y": float(vote[1])} if vote else None,
                "confidence": float(item.get("confidence") or 0.0),
                "score": score,
                "board": {
                    "x": None,
                    "y": None,
                    "display_x": None,
                    "display_y": None,
                    "camera_count": 1,
                    "camera_indices": [cam_i],
                    "model_x": (item.get("model_vote") or [None, None])[0],
                    "model_y": (item.get("model_vote") or [None, None])[1],
                },
                "score_value": score_value,
                "is_miss": score_value <= 0,
                "line": item.get("model_line"),
                "label": item.get("label"),
            }
            candidates.append(candidate)
            if vote:
                selected_new_tips.append((cam_i, float(vote[0]), float(vote[1])))

        groups: dict[int, list[dict[str, Any]]] = defaultdict(list)
        for candidate in candidates:
            groups[int(candidate.get("score_value", 0) or 0)].append(candidate)
        winner_value = self._score_value(final_score)
        winner_group = groups.get(winner_value) or candidates
        voted_score = dict(final_score)
        voted_score["board"] = {
            "opencv_source": scoring.get("source"),
            "model_point": (final or {}).get("model_point"),
            "intersection_spread_px": scoring.get("intersection_spread_px"),
            "intersection_consensus": scoring.get("intersection_consensus"),
            "ellipse_radial_intersection_consensus": scoring.get("ellipse_radial_intersection_consensus"),
            "ellipse_radial_fallback_previous": scoring.get("ellipse_radial_fallback_previous"),
        }

        elapsed = round((time.perf_counter() - total_t0) * 1000.0, 2)
        timings["result_build_ms"] = round((time.perf_counter() - t0) * 1000.0, 2)
        timings["total_ms"] = elapsed
        timings["preprocess_ms"] = round(
            float(timings.get("extract_masks_ms") or 0.0) + float(timings.get("bridge_mask_ms") or 0.0),
            2,
        )
        timings["inference_ms"] = 0.0
        timings["decode_ms"] = 0.0
        timings["calibration_ms"] = timings.get("calibration_cache_ms", 0.0)
        timings["vote_ms"] = round(
            float(timings.get("bridged_score_ms") or 0.0)
            + float(timings.get("raw_score_ms") or 0.0)
            + float(timings.get("selection_ms") or 0.0),
            2,
        )
        return {
            "ok": True,
            "active_model_id": "opencv-line-fit",
            "voted_score_value": int(winner_value),
            "voted_score": voted_score,
            "votes": int((final or {}).get("agreement") or len(winner_group) or 1),
            "miss_reason": None if winner_value > 0 else "miss",
            "diagnostics": {
                "camera_count": len(candidates),
                "opencv_source": scoring.get("source"),
                "mask_mode": scoring.get("mask_mode"),
                "adaptive_mask_mode": scoring.get("adaptive_mask_mode"),
            },
            "candidates": candidates,
            "selected_new_tips": selected_new_tips,
            "opencv_result": result,
            "timings": timings,
        }
