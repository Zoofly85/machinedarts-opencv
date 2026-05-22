"""Calibration-backed hybrid scoring for detected dart lines."""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Tuple

import numpy as np

from backend.calibration.calibration import DARTBOARD_SEGMENTS, SEGMENT_ANGLE_OFFSET
from backend.calibration.ellipse_calibration import line_ellipse_intersection_float


ScoreKey = Tuple[object, object, object]


@dataclass
class DartScoringConfig:
    """Scoring options independent of camera capture and game state."""

    camera_calibration_map: Mapping[int, int] = field(default_factory=dict)
    line_cluster_max_spread_px: float = 35.0
    rescue_min_tip_confidence: float = 0.45
    ellipse_radial_fallback_max_spread_px: float = 6.0


def format_score(score: Optional[dict]) -> str:
    if not score:
        return "no score"
    segment = score.get("segment", 0)
    multiplier = score.get("multiplier", 1)
    zone = str(score.get("zone", "unknown"))
    if score.get("score") == 50:
        return "BULL 50"
    if score.get("score") == 25:
        return "OUTER BULL 25"
    if zone == "miss" or score.get("score") == 0:
        return "MISS"
    prefix = {1: "S", 2: "D", 3: "T"}.get(int(multiplier), "S")
    return f"{prefix}{segment} ({score.get('score')})"


def score_key(score: dict) -> ScoreKey:
    return (score.get("segment"), score.get("multiplier"), score.get("zone"))


def final_score_key(score: dict) -> ScoreKey:
    zone = score.get("zone")
    if isinstance(zone, str) and zone.startswith("single"):
        zone = "single"
    return (score.get("segment"), score.get("multiplier"), zone)


def rotate_model_point(point: tuple[float, float], calibrator: object, angle_degrees: float) -> tuple[float, float]:
    cx, cy = calibrator.model_center
    angle = math.radians(float(angle_degrees))
    cos_a = math.cos(angle)
    sin_a = math.sin(angle)
    dx = float(point[0]) - float(cx)
    dy = float(point[1]) - float(cy)
    return (
        float(cx) + dx * cos_a - dy * sin_a,
        float(cy) + dx * sin_a + dy * cos_a,
    )


def score_model_point(point: tuple[float, float], calibrator: object) -> dict:
    x, y = point
    cx, cy = calibrator.model_center
    dx = float(x - cx)
    dy = float(y - cy)
    distance = math.hypot(dx, dy)
    angle = math.atan2(dy, dx)
    adjusted = angle - SEGMENT_ANGLE_OFFSET
    while adjusted < 0:
        adjusted += 2.0 * math.pi
    while adjusted >= 2.0 * math.pi:
        adjusted -= 2.0 * math.pi
    segment_index = min(19, int(adjusted / (2.0 * math.pi) * 20.0))
    segment = DARTBOARD_SEGMENTS[segment_index]

    if distance <= calibrator.bull_radius_px:
        return {"score": 50, "multiplier": 1, "segment": 0, "zone": "inner_bull"}
    if distance <= calibrator.outer_bull_radius_px:
        return {"score": 25, "multiplier": 1, "segment": 0, "zone": "outer_bull"}
    if distance <= calibrator.triple_inner_radius_px:
        return {"score": segment, "multiplier": 1, "segment": segment, "zone": "single_inner"}
    if distance <= calibrator.triple_outer_radius_px:
        return {"score": segment * 3, "multiplier": 3, "segment": segment, "zone": "triple"}
    if distance <= calibrator.double_inner_radius_px:
        return {"score": segment, "multiplier": 1, "segment": segment, "zone": "single_outer"}
    if distance <= calibrator.double_outer_radius_px:
        return {"score": segment * 2, "multiplier": 2, "segment": segment, "zone": "double"}
    return {"score": 0, "multiplier": 1, "segment": 0, "zone": "miss"}


def model_score_rotation_offset(calibrator: object) -> float:
    cached = getattr(calibrator, "_model_score_rotation_offset", None)
    if cached is not None:
        return float(cached)

    cx, cy = calibrator.model_center
    radius = float(calibrator.triple_outer_radius_px + calibrator.double_inner_radius_px) / 2.0
    sample_points = []
    for i in range(20):
        angle = SEGMENT_ANGLE_OFFSET + (i + 0.5) * 2.0 * math.pi / 20.0
        sample_points.append((float(cx) + math.cos(angle) * radius, float(cy) + math.sin(angle) * radius))

    best_offset = 0.0
    best_matches = -1
    for offset in range(0, 360, 18):
        matches = 0
        for model_point in sample_points:
            camera_point = calibrator.transform_point_to_camera(model_point)
            camera_score = calibrator.get_dart_score(float(camera_point[0]), float(camera_point[1]))
            canonical_point = rotate_model_point(model_point, calibrator, float(offset))
            canonical_score = score_model_point(canonical_point, calibrator)
            if score_key(camera_score) == score_key(canonical_score):
                matches += 1
        if matches > best_matches:
            best_matches = matches
            best_offset = float(offset)

    calibrator._model_score_rotation_offset = best_offset
    return best_offset


def canonical_model_point(point: tuple[float, float], calibrator: object) -> tuple[float, float]:
    return rotate_model_point(point, calibrator, model_score_rotation_offset(calibrator))


def model_line_from_camera_line(cam: dict, calibrator: object) -> Optional[tuple[np.ndarray, np.ndarray, dict]]:
    try:
        a_cam = cam.get("endpoint_a")
        b_cam = cam.get("endpoint_b")
        if a_cam is None or b_cam is None:
            return None
        a_raw = calibrator.transform_point_to_model((float(a_cam[0]), float(a_cam[1])))
        b_raw = calibrator.transform_point_to_model((float(b_cam[0]), float(b_cam[1])))
        a_model = np.array(canonical_model_point(a_raw, calibrator), dtype=np.float64)
        b_model = np.array(canonical_model_point(b_raw, calibrator), dtype=np.float64)
        direction = b_model - a_model
        norm = float(np.linalg.norm(direction))
        if norm <= 1e-6:
            return None
        anchor = a_model
        vote = cam.get("board_end_vote")
        if vote is not None:
            vote_raw = calibrator.transform_point_to_model((float(vote[0]), float(vote[1])))
            anchor = np.array(canonical_model_point(vote_raw, calibrator), dtype=np.float64)
        info = {
            "a": [float(anchor[0]), float(anchor[1])],
            "b": [float(anchor[0] + direction[0]), float(anchor[1] + direction[1])],
            "raw_a": [float(a_model[0]), float(a_model[1])],
            "raw_b": [float(b_model[0]), float(b_model[1])],
            "anchored_to_board_end_vote": vote is not None,
            "model_score_rotation_offset": float(model_score_rotation_offset(calibrator)),
        }
        return anchor, direction / norm, info
    except Exception:
        return None


def intersect_model_lines(line_a: tuple[np.ndarray, np.ndarray], line_b: tuple[np.ndarray, np.ndarray]) -> Optional[tuple[float, float]]:
    p, r = line_a
    q, s = line_b
    denom = float(r[0] * s[1] - r[1] * s[0])
    if abs(denom) < 1e-9:
        return None
    t = float(((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / denom)
    x = p + t * r
    return float(x[0]), float(x[1])


def _angle_deg(point: tuple[float, float], center: tuple[float, float]) -> float:
    return float(math.degrees(math.atan2(float(point[1]) - center[1], float(point[0]) - center[0])) % 360.0)


def _ellipse_radius_on_ray(center: tuple[float, float], angle_deg: float, ellipse: Any) -> Optional[float]:
    if ellipse is None:
        return None
    rad = math.radians(float(angle_deg))
    hit = line_ellipse_intersection_float(center, (math.cos(rad), math.sin(rad)), ellipse)
    return float(math.hypot(float(hit[0]) - center[0], float(hit[1]) - center[1]))


def ellipse_radial_point_to_model(point: tuple[float, float], calibrator: object) -> Optional[tuple[float, float]]:
    """Approximate camera point -> canonical model point without homography.

    Angle is interpolated between detected radial boundaries; radius is
    interpolated between fitted ring ellipses. This is intentionally used as a
    tight-spread fallback only, because the mapping is approximate.
    """
    calib = getattr(calibrator, "ellipse_calibration", None)
    if calib is None or not getattr(calib, "segment_angles", None) or getattr(calib, "outer_double_ellipse", None) is None:
        return None

    center = (float(calib.center[0]), float(calib.center[1]))
    cam_angle = _angle_deg(point, center)
    boundaries = [float(a) % 360.0 for a in calib.segment_angles]
    if len(boundaries) < 20:
        return None

    interval_i = 0
    frac = 0.0
    for i, start in enumerate(boundaries):
        end = boundaries[(i + 1) % len(boundaries)]
        span = (end - start) % 360.0
        delta = (cam_angle - start) % 360.0
        if delta < span or abs(delta - span) < 1e-6:
            interval_i = i
            frac = max(0.0, min(1.0, delta / max(span, 1e-6)))
            break

    rotation_steps = int(round(float(getattr(calibrator, "rotation_angle", 0.0) or 0.0) / 18.0)) % 20
    canonical_interval = (interval_i - rotation_steps) % 20
    canonical_angle = math.degrees(SEGMENT_ANGLE_OFFSET) + (canonical_interval + frac) * 18.0
    canonical_rad = math.radians(canonical_angle)

    cam_radius = float(math.hypot(float(point[0]) - center[0], float(point[1]) - center[1]))
    ring_pairs: list[tuple[float, float]] = []
    for ellipse, model_radius in (
        (getattr(calib, "bullseye_ellipse", None), getattr(calibrator, "bull_radius_px", 0.0)),
        (getattr(calib, "bull_ellipse", None), getattr(calibrator, "outer_bull_radius_px", 0.0)),
        (getattr(calib, "inner_triple_ellipse", None), getattr(calibrator, "triple_inner_radius_px", 0.0)),
        (getattr(calib, "outer_triple_ellipse", None), getattr(calibrator, "triple_outer_radius_px", 0.0)),
        (getattr(calib, "inner_double_ellipse", None), getattr(calibrator, "double_inner_radius_px", 0.0)),
        (getattr(calib, "outer_double_ellipse", None), getattr(calibrator, "double_outer_radius_px", 0.0)),
    ):
        cam_boundary_radius = _ellipse_radius_on_ray(center, cam_angle, ellipse)
        if cam_boundary_radius is not None and math.isfinite(cam_boundary_radius):
            ring_pairs.append((cam_boundary_radius, float(model_radius)))
    ring_pairs.sort(key=lambda p: p[0])
    if not ring_pairs:
        return None

    if cam_radius <= ring_pairs[0][0]:
        model_radius = cam_radius / max(ring_pairs[0][0], 1e-6) * ring_pairs[0][1]
    elif cam_radius >= ring_pairs[-1][0]:
        model_radius = cam_radius / max(ring_pairs[-1][0], 1e-6) * ring_pairs[-1][1]
    else:
        model_radius = ring_pairs[-1][1]
        for (r0, m0), (r1, m1) in zip(ring_pairs, ring_pairs[1:]):
            if r0 <= cam_radius <= r1:
                frac_r = (cam_radius - r0) / max(r1 - r0, 1e-6)
                model_radius = m0 + frac_r * (m1 - m0)
                break

    cx, cy = calibrator.model_center
    return (
        float(cx) + math.cos(canonical_rad) * model_radius,
        float(cy) + math.sin(canonical_rad) * model_radius,
    )


def ellipse_radial_line_from_camera_line(cam: dict, calibrator: object) -> Optional[tuple[np.ndarray, np.ndarray]]:
    try:
        a_cam = cam.get("endpoint_a")
        b_cam = cam.get("endpoint_b")
        if a_cam is None or b_cam is None:
            return None
        a = np.array([float(a_cam[0]), float(a_cam[1])], dtype=np.float64)
        b = np.array([float(b_cam[0]), float(b_cam[1])], dtype=np.float64)
        direction = b - a
        if float(np.linalg.norm(direction)) <= 1e-6:
            return None

        samples = []
        for t in np.linspace(-0.25, 1.25, 11):
            p = a + direction * float(t)
            mapped = ellipse_radial_point_to_model((float(p[0]), float(p[1])), calibrator)
            if mapped is not None and all(math.isfinite(v) for v in mapped):
                samples.append(mapped)
        if len(samples) < 2:
            return None

        pts = np.array(samples, dtype=np.float64)
        mean = pts.mean(axis=0)
        _, _, vh = np.linalg.svd(pts - mean, full_matrices=False)
        line_dir = vh[0]
        norm = float(np.linalg.norm(line_dir))
        if norm <= 1e-6:
            return None

        anchor = mean
        vote = cam.get("board_end_vote")
        if vote is not None:
            mapped_vote = ellipse_radial_point_to_model((float(vote[0]), float(vote[1])), calibrator)
            if mapped_vote is not None:
                anchor = np.array(mapped_vote, dtype=np.float64)
        return anchor, line_dir / norm
    except Exception:
        return None


def _score_from_key(scores: list[dict], key: ScoreKey) -> Optional[dict]:
    return next((score for score in scores if final_score_key(score) == key), None)


def _intersection_cluster(intersections: list[dict]) -> Optional[dict]:
    candidates = []
    keys = Counter(final_score_key(item["score"]) for item in intersections if item.get("score") is not None)
    for key, count in keys.items():
        if count < 2:
            continue
        group = [item for item in intersections if final_score_key(item["score"]) == key]
        points = np.array([item["point"] for item in group], dtype=np.float64)
        median_point = np.median(points, axis=0)
        spread = float(np.max(np.linalg.norm(points - median_point, axis=1))) if len(points) else float("inf")
        candidates.append(
            {
                "key": key,
                "agreement": int(count),
                "intersections": int(len(intersections)),
                "pair_points": int(len(group)),
                "spread_px": spread,
                "median_point": [float(median_point[0]), float(median_point[1])],
                "pairs": [item.get("pair") for item in group],
                "score": group[0]["score"],
                "label": format_score(group[0]["score"]),
            }
        )
    if not candidates:
        return None
    candidates.sort(key=lambda item: (-item["agreement"], item["spread_px"]))
    return candidates[0]


def _is_miss_key(key: Optional[ScoreKey]) -> bool:
    return key == (0, 1, "miss")


def _camera_mask_quality(cam: dict, vote: dict, *, image_width: int = 1280, image_height: int = 720) -> tuple[float, dict]:
    bbox = cam.get("bbox") or vote.get("bbox") or [0, 0, 0, 0]
    try:
        x, y, w, h = [float(v) for v in bbox]
    except Exception:
        x = y = w = h = 0.0
    confidence = float(cam.get("confidence") or vote.get("confidence") or 0.0)
    pixels = float(cam.get("new_mask_pixels") or 0.0)
    area = float(cam.get("contour_area") or 0.0)
    width_ratio = float(cam.get("width_ratio") or 0.0)
    clipped = x <= 2 or y <= 2 or (x + w) >= (image_width - 2) or (y + h) >= (image_height - 2)
    score = vote.get("score") or {}
    miss = _is_miss_key(final_score_key(score)) if score else False

    quality = confidence
    quality += min(pixels / 5000.0, 1.0) * 0.45
    quality += min(area / 2500.0, 1.0) * 0.25
    if clipped:
        quality -= 0.75
    if miss:
        quality -= 1.0
    if width_ratio > 4.0:
        quality -= 0.20

    return quality, {
        "quality": float(quality),
        "clipped": bool(clipped),
        "miss": bool(miss),
        "new_mask_pixels": int(pixels),
        "contour_area": float(area),
        "width_ratio": float(width_ratio),
    }


def _quality_weighted_tip_fallback(scoring: dict, throw_summary: dict) -> Optional[dict]:
    cameras = {int(cam.get("camera_index", -1)): cam for cam in throw_summary.get("cameras", [])}
    weighted: dict[ScoreKey, float] = {}
    best_vote_for_key: dict[ScoreKey, tuple[float, dict]] = {}
    diagnostics = []

    for vote in scoring.get("camera_votes", []):
        cam_i = int(vote.get("camera_index", -1))
        score = vote.get("score")
        if not score:
            continue
        key = final_score_key(score)
        quality, info = _camera_mask_quality(cameras.get(cam_i, {}), vote)
        info["camera_index"] = cam_i
        info["label"] = vote.get("label")
        diagnostics.append(info)
        if _is_miss_key(key) or quality <= 0:
            continue
        weighted[key] = weighted.get(key, 0.0) + quality
        if key not in best_vote_for_key or quality > best_vote_for_key[key][0]:
            best_vote_for_key[key] = (quality, vote)

    if not weighted:
        scoring["quality_weighted_tip_votes"] = diagnostics
        return None

    best_key = max(weighted, key=lambda item: weighted[item])
    best_quality, best_vote = best_vote_for_key[best_key]
    final_score = (scoring.get("final") or {}).get("score")
    final_key = final_score_key(final_score) if final_score else None
    tip_confirmations = int((scoring.get("final") or {}).get("tip_confirmations", 0) or 0)
    intersection_consensus = scoring.get("intersection_consensus") or {}
    cluster_pairs = set(intersection_consensus.get("pairs") or [])

    # A tight line cluster is stronger evidence than any single camera vote.
    # The quality fallback exists for broken/clipped line cases, not for
    # overruling unanimous or near-unanimous line intersections.
    if (
        intersection_consensus
        and int(intersection_consensus.get("agreement") or 0) >= 2
        and float(intersection_consensus.get("spread_px") or 999.0) <= 12.0
    ):
        scoring["quality_weighted_tip_votes"] = diagnostics
        scoring["quality_weighted_fallback"] = {
            "score": best_vote.get("score"),
            "label": format_score(best_vote.get("score")),
            "camera_index": best_vote.get("camera_index"),
            "quality": float(best_quality),
            "weight": float(weighted[best_key]),
            "overrides": False,
            "previous_label": scoring.get("predicted_label"),
            "reason": {"tight_line_cluster": True},
        }
        return None

    intersection_keys = Counter(
        final_score_key(item.get("score"))
        for item in scoring.get("intersections", [])
        if item.get("score") is not None
    )
    best_has_line_support = intersection_keys.get(best_key, 0) > 0
    bad_pair_camera = False
    for item in diagnostics:
        cam_i = int(item.get("camera_index", -1))
        if not item.get("clipped") and not item.get("miss") and float(item.get("quality", 0.0)) >= 0.45:
            continue
        if any(str(cam_i) in str(pair).split("-") for pair in cluster_pairs):
            bad_pair_camera = True
            break

    strong_disagreement = final_key is not None and best_key != final_key and best_quality >= 0.70
    should_override = strong_disagreement and best_has_line_support and (
        bad_pair_camera
        or tip_confirmations <= 1
        or float((scoring.get("intersection_consensus") or {}).get("spread_px", 999.0)) > 8.0
    )

    fallback = {
        "score": best_vote.get("score"),
        "label": format_score(best_vote.get("score")),
        "camera_index": best_vote.get("camera_index"),
        "quality": float(best_quality),
        "weight": float(weighted[best_key]),
        "overrides": bool(should_override),
        "previous_label": scoring.get("predicted_label"),
        "reason": {
            "bad_pair_camera": bool(bad_pair_camera),
            "tip_confirmations": int(tip_confirmations),
            "strong_disagreement": bool(strong_disagreement),
            "best_has_line_support": bool(best_has_line_support),
        },
    }
    scoring["quality_weighted_tip_votes"] = diagnostics
    scoring["quality_weighted_fallback"] = fallback
    return fallback if should_override else None


def _triple_boundary_upgrade(scoring: dict, throw_summary: dict) -> Optional[dict]:
    final_score = (scoring.get("final") or {}).get("score")
    if not final_score:
        return None
    final_segment = int(final_score.get("segment") or 0)
    final_multiplier = int(final_score.get("multiplier") or 1)
    final_zone = str(final_score.get("zone") or "")

    vote_segments = []
    same_segment_single_votes = 0
    for vote in scoring.get("camera_votes", []):
        score = vote.get("score") or {}
        segment = int(score.get("segment") or 0)
        multiplier = int(score.get("multiplier") or 1)
        zone = str(score.get("zone") or "")
        value = int(score.get("score") or 0)
        if segment > 0 and value > 0:
            vote_segments.append(segment)
        if segment == final_segment and multiplier == 1 and zone.startswith("single"):
            same_segment_single_votes += 1

    vote_counts = Counter(vote_segments)
    majority_segment = 0
    majority_count = 0
    if vote_counts:
        majority_segment, majority_count = vote_counts.most_common(1)[0]

    segment = 0
    if final_segment > 0 and final_multiplier == 1 and final_zone.startswith("single"):
        segment = final_segment
    if majority_count >= 2:
        segment = int(majority_segment)
    if segment <= 0:
        return None
    if same_segment_single_votes >= 2:
        return None

    triple_key = (segment, 3, "triple")
    same_segment_intersections = []
    triple_pairs = []
    for item in scoring.get("intersections", []):
        score = item.get("score") or {}
        if int(score.get("segment") or 0) != segment:
            continue
        if int(score.get("score") or 0) > 0:
            same_segment_intersections.append(item)
        if final_score_key(score) == triple_key:
            triple_pairs.append(item)
    if not triple_pairs:
        return None

    cluster = scoring.get("intersection_consensus") or {}
    if cluster:
        key = cluster.get("key") or []
        cluster_segment = int(key[0]) if len(key) > 0 and key[0] is not None else 0
        cluster_multiplier = int(key[1]) if len(key) > 1 and key[1] is not None else 1
        if cluster_segment not in (0, segment):
            return None
        if (
            cluster_segment == segment
            and cluster_multiplier == 1
            and int(cluster.get("agreement") or 0) >= 2
            and float(cluster.get("spread_px") or 999.0) <= 14.0
        ):
            return None

    support = 0
    if final_segment == segment:
        support += 1
    if majority_count >= 2:
        support += 2
    support += len(same_segment_intersections)
    if support < 3:
        return None

    triple_pair = triple_pairs[0]
    return {
        "score": triple_pair.get("score"),
        "label": format_score(triple_pair.get("score")),
        "pair": triple_pair.get("pair"),
        "pair_point": triple_pair.get("point"),
        "segment": int(segment),
        "support": int(support),
        "majority_count": int(majority_count),
        "same_segment_intersections": int(len(same_segment_intersections)),
    }


def _single_pair_tip_rescue(scoring: dict, camera_counts: Counter, min_tip_confidence: float) -> Optional[dict]:
    cluster = scoring.get("intersection_consensus") or {}
    if (
        cluster
        and not _is_miss_key(tuple(cluster.get("key") or ()))
        and int(cluster.get("agreement") or 0) >= 2
        and float(cluster.get("spread_px") or 999.0) <= 12.0
    ):
        scoring["rescue_rejected"] = {
            "reason": "tight_nonmiss_line_cluster",
            "cluster": cluster,
        }
        return None

    final_score = (scoring.get("final") or {}).get("score")
    final_key = final_score_key(final_score) if final_score is not None else None
    if final_key is not None and not _is_miss_key(final_key) and not scoring.get("uncertain"):
        return None

    nonmiss_tip_consensus = max(
        [count for key, count in camera_counts.items() if key is not None and not _is_miss_key(key)],
        default=0,
    )
    if nonmiss_tip_consensus >= 2:
        return None

    pair_counts = Counter(
        final_score_key(item["score"])
        for item in scoring.get("intersections", [])
        if item.get("score") is not None
    )
    exact_candidates = []
    segment_candidates = []
    for key, pair_count in pair_counts.items():
        if key is None or _is_miss_key(key):
            continue
        pair_item = next(item for item in scoring.get("intersections", []) if final_score_key(item.get("score")) == key)
        tip_item = next(
            (
                item for item in scoring.get("camera_votes", [])
                if item.get("score") is not None and final_score_key(item["score"]) == key
            ),
            None,
        )
        if pair_count == 1 and camera_counts.get(key, 0) == 1 and tip_item is not None:
            confidence = float(tip_item.get("confidence") or 0.0)
            if confidence >= min_tip_confidence:
                exact_candidates.append(
                    {
                        "score": pair_item["score"],
                        "label": format_score(pair_item["score"]),
                        "pair": pair_item.get("pair"),
                        "pair_point": pair_item.get("point"),
                        "tip_camera": tip_item.get("camera_index"),
                        "tip_confidence": confidence,
                        "rescue_mode": "exact_pair_tip",
                    }
                )
            continue

        tip_item = next(
            (
                item for item in scoring.get("camera_votes", [])
                if item.get("score") is not None
                and item["score"].get("segment") not in (None, 0)
                and item["score"].get("segment") == pair_item["score"].get("segment")
            ),
            None,
        )
        if tip_item is None:
            continue
        confidence = float(tip_item.get("confidence") or 0.0)
        if confidence < min_tip_confidence:
            continue
        if int(pair_item["score"].get("multiplier") or 1) > int(tip_item["score"].get("multiplier") or 1):
            continue
        segment_candidates.append(
            {
                "score": pair_item["score"],
                "label": format_score(pair_item["score"]),
                "pair": pair_item.get("pair"),
                "pair_point": pair_item.get("point"),
                "tip_camera": tip_item.get("camera_index"),
                "tip_confidence": confidence,
                "rescue_mode": "same_segment_pair_tip",
            }
        )

    if len(exact_candidates) == 1:
        return exact_candidates[0]
    if len(exact_candidates) > 1:
        return None
    if len(segment_candidates) == 1:
        return segment_candidates[0]
    return None


def score_throw_summary(
    throw_summary: dict,
    calibrators: Mapping[int, object],
    *,
    config: Optional[DartScoringConfig] = None,
) -> dict:
    """Score a throw summary using app-provided calibrators.

    Calibrators must provide the same API as `DartboardCalibrator`:
    `get_dart_score`, `transform_point_to_model`, `transform_point_to_camera`,
    `is_calibrated`, `model_center`, and the ring radius properties.
    """
    config = config or DartScoringConfig()
    scoring = {
        "camera_calibration_map": {str(k): int(config.camera_calibration_map.get(k, k)) for k in calibrators},
        "camera_votes": [],
        "intersections": [],
        "final": None,
        "predicted_label": "UNCERTAIN",
        "uncertain": True,
        "source": "none",
    }

    valid_scores = []
    model_lines = {}
    ellipse_radial_lines = {}
    for cam in throw_summary.get("cameras", []):
        cam_i = int(cam.get("camera_index", -1))
        vote = cam.get("board_end_vote")
        calibrator = calibrators.get(cam_i)
        if vote is None or calibrator is None or not getattr(calibrator, "is_calibrated", False):
            scoring["camera_votes"].append(
                {
                    "camera_index": cam_i,
                    "calibration_camera": int(config.camera_calibration_map.get(cam_i, cam_i)),
                    "score": None,
                    "reason": "missing vote or calibration",
                }
            )
            continue

        score = calibrator.get_dart_score(float(vote[0]), float(vote[1]))
        raw_model_vote = calibrator.transform_point_to_model((float(vote[0]), float(vote[1])))
        model_vote = canonical_model_point(raw_model_vote, calibrator)
        model_line = model_line_from_camera_line(cam, calibrator)
        item = {
            "camera_index": cam_i,
            "calibration_camera": int(config.camera_calibration_map.get(cam_i, cam_i)),
            "vote": [float(vote[0]), float(vote[1])],
            "model_vote": [float(model_vote[0]), float(model_vote[1])],
            "raw_model_vote": [float(raw_model_vote[0]), float(raw_model_vote[1])],
            "model_score_rotation_offset": float(model_score_rotation_offset(calibrator)),
            "score": score,
            "label": format_score(score),
            "confidence": cam.get("confidence"),
            "bbox": cam.get("bbox"),
        }
        if model_line is not None:
            line_point, line_direction, line_info = model_line
            model_lines[cam_i] = (line_point, line_direction)
            item["model_line"] = line_info
        ellipse_radial_line = ellipse_radial_line_from_camera_line(cam, calibrator)
        if ellipse_radial_line is not None:
            ellipse_radial_lines[cam_i] = ellipse_radial_line
        scoring["camera_votes"].append(item)
        valid_scores.append(score)

    reference_calibrator = next((c for c in calibrators.values() if getattr(c, "is_calibrated", False)), None)
    if reference_calibrator is not None:
        sorted_line_ids = sorted(model_lines)
        for i, cam_a in enumerate(sorted_line_ids):
            for cam_b in sorted_line_ids[i + 1:]:
                point = intersect_model_lines(model_lines[cam_a], model_lines[cam_b])
                if point is None:
                    continue
                score = score_model_point(point, reference_calibrator)
                scoring["intersections"].append(
                    {
                        "pair": f"{cam_a}-{cam_b}",
                        "point": [float(point[0]), float(point[1])],
                        "score": score,
                        "label": format_score(score),
                    }
                )

        sorted_ellipse_ids = sorted(ellipse_radial_lines)
        for i, cam_a in enumerate(sorted_ellipse_ids):
            for cam_b in sorted_ellipse_ids[i + 1:]:
                point = intersect_model_lines(ellipse_radial_lines[cam_a], ellipse_radial_lines[cam_b])
                if point is None:
                    continue
                score = score_model_point(point, reference_calibrator)
                scoring.setdefault("ellipse_radial_intersections", []).append(
                    {
                        "pair": f"{cam_a}-{cam_b}",
                        "point": [float(point[0]), float(point[1])],
                        "score": score,
                        "label": format_score(score),
                    }
                )

    use_intersections = False
    camera_consensus_key = None
    camera_consensus_count = 0
    camera_counts = Counter()
    if valid_scores:
        camera_counts = Counter(final_score_key(score) for score in valid_scores)
        camera_consensus_key, camera_consensus_count = camera_counts.most_common(1)[0]

    if len(scoring["intersections"]) >= 2:
        points = np.array([item["point"] for item in scoring["intersections"]], dtype=np.float64)
        median_point = np.median(points, axis=0)
        spread = float(np.max(np.linalg.norm(points - median_point, axis=1)))
        scoring["intersection_spread_px"] = spread
        cluster = _intersection_cluster(scoring["intersections"])
        if cluster is not None:
            scoring["intersection_consensus"] = {
                "key": list(cluster["key"]),
                "agreement": int(cluster["agreement"]),
                "intersections": int(cluster["intersections"]),
                "pair_points": int(cluster["pair_points"]),
                "spread_px": float(cluster["spread_px"]),
                "pairs": list(cluster["pairs"]),
                "label": cluster["label"],
            }

        tight_nonmiss_cluster = (
            cluster is not None
            and cluster["agreement"] >= 2
            and cluster["spread_px"] <= 2.0
            and not _is_miss_key(cluster["key"])
        )

        if (
            cluster is not None
            and cluster["agreement"] >= 2
            and cluster["spread_px"] <= config.line_cluster_max_spread_px
            and reference_calibrator is not None
            and (
                camera_counts.get(cluster["key"], 0) >= 1
                or not _is_miss_key(cluster["key"])
                or (cluster["agreement"] >= 3 and not _is_miss_key(cluster["key"]))
            )
            and (
                tight_nonmiss_cluster
                or
                camera_consensus_count < 2
                or camera_consensus_key == cluster["key"]
                or cluster["agreement"] >= 3
            )
        ):
            cluster_point = cluster["median_point"]
            chosen_score = score_model_point((float(cluster_point[0]), float(cluster_point[1])), reference_calibrator)
            if final_score_key(chosen_score) != cluster["key"]:
                chosen_score = cluster["score"]
            scoring["final"] = {
                "score": chosen_score,
                "label": format_score(chosen_score),
                "agreement": int(cluster["agreement"]),
                "cameras": int(len(scoring["intersections"])),
                "model_point": [float(cluster_point[0]), float(cluster_point[1])],
                "tip_confirmations": int(camera_counts.get(cluster["key"], 0)),
            }
            scoring["predicted_label"] = format_score(chosen_score)
            scoring["uncertain"] = False
            scoring["source"] = f"line_cluster_confirmed_by_tip_{cluster['agreement']}_of_{len(scoring['intersections'])}"
            use_intersections = True

    if valid_scores and not use_intersections:
        best_key, best_count = camera_counts.most_common(1)[0]
        best_score = _score_from_key(valid_scores, best_key)
        if best_count >= 2:
            scoring["final"] = {
                "score": best_score,
                "label": format_score(best_score),
                "agreement": int(best_count),
                "cameras": int(len(valid_scores)),
            }
            scoring["predicted_label"] = format_score(best_score)
            scoring["uncertain"] = False
            scoring["source"] = f"camera_score_consensus_{best_count}_of_{len(valid_scores)}"
        else:
            scoring["source"] = f"no_camera_score_consensus_1_of_{len(valid_scores)}"

    rescue = _single_pair_tip_rescue(scoring, camera_counts, config.rescue_min_tip_confidence)
    if rescue is not None:
        scoring["final"] = {
            "score": rescue["score"],
            "label": rescue["label"],
            "agreement": 1,
            "cameras": int(len(valid_scores)),
            "model_point": rescue.get("pair_point"),
            "tip_confirmations": 1,
        }
        scoring["predicted_label"] = rescue["label"]
        scoring["uncertain"] = False
        scoring["source"] = "single_pair_tip_rescue"
        scoring["rescue"] = rescue

    quality_fallback = _quality_weighted_tip_fallback(scoring, throw_summary)
    if quality_fallback is not None:
        scoring["final"] = {
            "score": quality_fallback["score"],
            "label": quality_fallback["label"],
            "agreement": 1,
            "cameras": int(len(valid_scores)),
            "model_point": None,
            "tip_confirmations": 1,
        }
        scoring["predicted_label"] = quality_fallback["label"]
        scoring["uncertain"] = False
        scoring["source"] = "quality_weighted_tip_fallback"

    triple_upgrade = _triple_boundary_upgrade(scoring, throw_summary)
    if triple_upgrade is not None:
        scoring["final"] = {
            "score": triple_upgrade["score"],
            "label": triple_upgrade["label"],
            "agreement": 1,
            "cameras": int(len(valid_scores)),
            "model_point": triple_upgrade.get("pair_point"),
            "tip_confirmations": 1,
        }
        scoring["predicted_label"] = triple_upgrade["label"]
        scoring["uncertain"] = False
        scoring["source"] = "triple_boundary_upgrade"
        scoring["triple_boundary_upgrade"] = triple_upgrade

    ellipse_items = scoring.get("ellipse_radial_intersections") or []
    if len(ellipse_items) >= 2 and reference_calibrator is not None:
        ellipse_cluster = _intersection_cluster(ellipse_items)
        if ellipse_cluster is not None:
            scoring["ellipse_radial_intersection_consensus"] = {
                "key": list(ellipse_cluster["key"]),
                "agreement": int(ellipse_cluster["agreement"]),
                "intersections": int(ellipse_cluster["intersections"]),
                "pair_points": int(ellipse_cluster["pair_points"]),
                "spread_px": float(ellipse_cluster["spread_px"]),
                "pairs": list(ellipse_cluster["pairs"]),
                "label": ellipse_cluster["label"],
            }
            if (
                ellipse_cluster["agreement"] >= 2
                and ellipse_cluster["spread_px"] <= float(config.ellipse_radial_fallback_max_spread_px)
                and not _is_miss_key(ellipse_cluster["key"])
            ):
                cluster_point = ellipse_cluster["median_point"]
                chosen_score = score_model_point((float(cluster_point[0]), float(cluster_point[1])), reference_calibrator)
                if final_score_key(chosen_score) != ellipse_cluster["key"]:
                    chosen_score = ellipse_cluster["score"]
                previous_final = scoring.get("final") if isinstance(scoring.get("final"), dict) else None
                previous_score = previous_final.get("score") if isinstance(previous_final, dict) else None
                previous_key = final_score_key(previous_score) if isinstance(previous_score, dict) else None
                previous_segment = int(previous_key[0]) if previous_key and previous_key[0] is not None else 0
                ellipse_segment = int(ellipse_cluster["key"][0]) if ellipse_cluster["key"][0] is not None else 0
                previous_value = int(previous_score.get("score") or 0) if isinstance(previous_score, dict) else 0
                same_segment_or_missing = previous_value <= 0 or previous_segment == ellipse_segment
                if not same_segment_or_missing:
                    scoring["ellipse_radial_fallback_blocked"] = {
                        "reason": "segment_change_not_allowed",
                        "previous_label": scoring.get("predicted_label"),
                        "ellipse_label": ellipse_cluster["label"],
                        "spread_px": float(ellipse_cluster["spread_px"]),
                    }
                    throw_summary["scoring"] = scoring
                    return throw_summary
                if previous_key != ellipse_cluster["key"]:
                    scoring["ellipse_radial_fallback_previous"] = {
                        "source": scoring.get("source"),
                        "label": scoring.get("predicted_label"),
                    }
                scoring["final"] = {
                    "score": chosen_score,
                    "label": format_score(chosen_score),
                    "agreement": int(ellipse_cluster["agreement"]),
                    "cameras": int(len(ellipse_items)),
                    "model_point": [float(cluster_point[0]), float(cluster_point[1])],
                    "tip_confirmations": int(camera_counts.get(ellipse_cluster["key"], 0)),
                }
                scoring["predicted_label"] = format_score(chosen_score)
                scoring["uncertain"] = False
                scoring["source"] = f"ellipse_radial_line_fallback_{ellipse_cluster['agreement']}_of_{len(ellipse_items)}"

    throw_summary["scoring"] = scoring
    return throw_summary
