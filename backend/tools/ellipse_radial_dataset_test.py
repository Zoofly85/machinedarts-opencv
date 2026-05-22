#!/usr/bin/env python3
"""Replay correction packs with an ellipse/radial line-plane experiment.

The live scorer already uses ellipse/radial calibration for each camera's
single tip vote. The homography-sensitive part is the pairwise line
intersection in the shared model plane. This script builds an alternate
model-plane point from ellipse/radial calibration and compares it with the
saved corrected score.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.calibration.calibration import DartboardCalibrator, SEGMENT_ANGLE_OFFSET
from backend.calibration.ellipse_calibration import line_ellipse_intersection_float
from backend.core.opencv_dart_detection.scoring import (
    final_score_key,
    format_score,
    intersect_model_lines,
    score_model_point,
)


IGNORE_BY_DEFAULT = {
    # User later identified this as a duplicate/wrong correction.
    "dart_3_1779417338399",
}


def _score_key_from_value(value: int | None, score: dict[str, Any] | None = None) -> tuple[Any, Any, Any] | None:
    if score:
        return _normalized_key(score)
    if value is None:
        return None
    if int(value) == 0:
        return (0, 1, "miss")
    # Value-only fallback cannot distinguish S20 from D10 or T?; avoid using it
    # for pass/fail if metadata has the full corrected score object.
    return None


def _normalized_key(score: dict[str, Any]) -> tuple[Any, Any, Any]:
    segment, multiplier, zone = final_score_key(score)
    try:
        segment = int(segment)
    except Exception:
        pass
    try:
        multiplier = int(multiplier)
    except Exception:
        pass
    return segment, multiplier, zone


def _load_calibrators(calibration_dir: Path, camera_count: int = 3) -> dict[int, DartboardCalibrator]:
    calibrators: dict[int, DartboardCalibrator] = {}
    for cam_i in range(camera_count):
        cam_dir = calibration_dir / f"camera_{cam_i}"
        if not cam_dir.exists():
            continue
        cal = DartboardCalibrator(calibration_dir=str(cam_dir))
        if getattr(cal, "is_calibrated", False) and getattr(cal, "ellipse_calibration", None) is not None:
            calibrators[cam_i] = cal
    return calibrators


def _angle_deg(point: tuple[float, float], center: tuple[float, float]) -> float:
    return float(math.degrees(math.atan2(float(point[1]) - center[1], float(point[0]) - center[0])) % 360.0)


def _angle_between_ccw(angle: float, start: float, end: float) -> float:
    span = (end - start) % 360.0
    delta = (angle - start) % 360.0
    if span <= 1e-6:
        return 0.0
    return max(0.0, min(1.0, delta / span))


def _ellipse_radius_on_ray(center: tuple[float, float], angle_deg: float, ellipse: Any) -> float | None:
    if ellipse is None:
        return None
    rad = math.radians(angle_deg)
    hit = line_ellipse_intersection_float(center, (math.cos(rad), math.sin(rad)), ellipse)
    return float(math.hypot(float(hit[0]) - center[0], float(hit[1]) - center[1]))


def ellipse_point_to_canonical_model(point: tuple[float, float], calibrator: DartboardCalibrator) -> tuple[float, float] | None:
    """Approximate camera point -> canonical model point using ellipse/radial calibration.

    This avoids the homography matrix. Angle is interpolated between detected
    radial boundaries; radius is interpolated between fitted ring ellipses.
    """
    calib = getattr(calibrator, "ellipse_calibration", None)
    if calib is None or not calib.segment_angles or calib.outer_double_ellipse is None:
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
            frac = _angle_between_ccw(cam_angle, start, end)
            break

    rotation_steps = int(round(float(getattr(calibrator, "rotation_angle", 0.0)) / 18.0)) % 20
    canonical_interval = (interval_i - rotation_steps) % 20
    canonical_angle = math.degrees(SEGMENT_ANGLE_OFFSET) + (canonical_interval + frac) * 18.0
    canonical_rad = math.radians(canonical_angle)

    cam_radius = float(math.hypot(float(point[0]) - center[0], float(point[1]) - center[1]))
    ring_pairs: list[tuple[float, float]] = []
    for ellipse, model_radius in (
        (calib.bullseye_ellipse, calibrator.bull_radius_px),
        (calib.bull_ellipse, calibrator.outer_bull_radius_px),
        (calib.inner_triple_ellipse, calibrator.triple_inner_radius_px),
        (calib.outer_triple_ellipse, calibrator.triple_outer_radius_px),
        (calib.inner_double_ellipse, calibrator.double_inner_radius_px),
        (calib.outer_double_ellipse, calibrator.double_outer_radius_px),
    ):
        cam_boundary_radius = _ellipse_radius_on_ray(center, cam_angle, ellipse)
        if cam_boundary_radius is not None and math.isfinite(cam_boundary_radius):
            ring_pairs.append((cam_boundary_radius, float(model_radius)))
    ring_pairs.sort(key=lambda p: p[0])
    if not ring_pairs:
        return None

    if cam_radius <= ring_pairs[0][0]:
        denom = max(ring_pairs[0][0], 1e-6)
        model_radius = cam_radius / denom * ring_pairs[0][1]
    elif cam_radius >= ring_pairs[-1][0]:
        denom = max(ring_pairs[-1][0], 1e-6)
        model_radius = cam_radius / denom * ring_pairs[-1][1]
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


def _fit_ellipse_model_line(cam: dict[str, Any], calibrator: DartboardCalibrator) -> tuple[np.ndarray, np.ndarray] | None:
    a = cam.get("endpoint_a")
    b = cam.get("endpoint_b")
    if not a or not b:
        return None
    a_np = np.array([float(a[0]), float(a[1])], dtype=np.float64)
    b_np = np.array([float(b[0]), float(b[1])], dtype=np.float64)
    direction = b_np - a_np
    if float(np.linalg.norm(direction)) <= 1e-6:
        return None

    # The ellipse/radial mapping is non-linear, so sample along the fitted dart
    # line and fit a new straight line in canonical board coordinates.
    samples = []
    for t in np.linspace(-0.25, 1.25, 11):
        p = a_np + direction * float(t)
        mapped = ellipse_point_to_canonical_model((float(p[0]), float(p[1])), calibrator)
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

    vote = cam.get("board_end_vote")
    anchor = mean
    if vote:
        mapped_vote = ellipse_point_to_canonical_model((float(vote[0]), float(vote[1])), calibrator)
        if mapped_vote is not None:
            anchor = np.array(mapped_vote, dtype=np.float64)
    return anchor, line_dir / norm


def _majority_score(scores: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not scores:
        return None
    counts = Counter(_normalized_key(s) for s in scores)
    key, _ = counts.most_common(1)[0]
    return next((s for s in scores if _normalized_key(s) == key), None)


def evaluate_pack(pack_dir: Path) -> dict[str, Any]:
    meta = json.loads((pack_dir / "metadata.json").read_text(encoding="utf-8"))
    calibration_dir = pack_dir / "calibration"
    if not calibration_dir.exists():
        calibration_dir = ROOT / "backend" / "data" / "calibration"
    calibrators = _load_calibrators(calibration_dir)

    corrected_score = meta.get("corrected_score")
    corrected_key = _score_key_from_value(meta.get("corrected_score_value"), corrected_score)
    original_score = meta.get("original_score")
    original_key = _score_key_from_value(meta.get("original_score_value"), original_score)

    cameras = (meta.get("opencv_result") or {}).get("cameras") or []
    ellipse_tip_scores: list[dict[str, Any]] = []
    ellipse_lines: dict[int, tuple[np.ndarray, np.ndarray]] = {}
    for cam in cameras:
        cam_i = int(cam.get("camera_index", -1))
        calibrator = calibrators.get(cam_i)
        vote = cam.get("board_end_vote")
        if calibrator is None or vote is None:
            continue
        ellipse_tip_scores.append(calibrator.get_dart_score(float(vote[0]), float(vote[1])))
        line = _fit_ellipse_model_line(cam, calibrator)
        if line is not None:
            ellipse_lines[cam_i] = line

    tip_majority = _majority_score(ellipse_tip_scores)
    reference = next(iter(calibrators.values()), None)
    intersections: list[dict[str, Any]] = []
    if reference is not None:
        ids = sorted(ellipse_lines)
        for i, a_id in enumerate(ids):
            for b_id in ids[i + 1 :]:
                point = intersect_model_lines(ellipse_lines[a_id], ellipse_lines[b_id])
                if point is None:
                    continue
                score = score_model_point(point, reference)
                intersections.append(
                    {
                        "pair": f"{a_id}-{b_id}",
                        "point": [float(point[0]), float(point[1])],
                        "score": score,
                        "label": format_score(score),
                    }
                )
    intersection_majority = _majority_score([i["score"] for i in intersections])
    spread = None
    if len(intersections) >= 2:
        pts = np.array([i["point"] for i in intersections], dtype=np.float64)
        median = np.median(pts, axis=0)
        spread = float(np.max(np.linalg.norm(pts - median, axis=1)))

    return {
        "pack": pack_dir.name,
        "original": format_score(original_score),
        "corrected": format_score(corrected_score),
        "original_matches": bool(original_key is not None and corrected_key is not None and original_key == corrected_key),
        "ellipse_tip_majority": format_score(tip_majority),
        "ellipse_tip_matches": bool(tip_majority and corrected_key is not None and _normalized_key(tip_majority) == corrected_key),
        "ellipse_line_majority": format_score(intersection_majority),
        "ellipse_line_matches": bool(intersection_majority and corrected_key is not None and _normalized_key(intersection_majority) == corrected_key),
        "ellipse_line_spread_px": spread,
        "ellipse_line_intersections": intersections,
        "camera_tip_scores": [format_score(s) for s in ellipse_tip_scores],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--packs", default=str(ROOT / "backend" / "data" / "correction_debug"))
    parser.add_argument("--include-known-bad-labels", action="store_true")
    parser.add_argument("--output", default=str(ROOT / "backend" / "data" / "calibration_audit" / "ellipse_radial_dataset_test.json"))
    args = parser.parse_args()

    pack_root = Path(args.packs)
    rows = []
    for pack_dir in sorted(p for p in pack_root.iterdir() if p.is_dir() and (p / "metadata.json").exists()):
        if not args.include_known_bad_labels and pack_dir.name in IGNORE_BY_DEFAULT:
            continue
        rows.append(evaluate_pack(pack_dir))

    summary = {
        "packs_evaluated": len(rows),
        "original_matches": sum(1 for r in rows if r["original_matches"]),
        "ellipse_tip_matches": sum(1 for r in rows if r["ellipse_tip_matches"]),
        "ellipse_line_matches": sum(1 for r in rows if r["ellipse_line_matches"]),
        "rows": rows,
    }

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print(f"packs evaluated: {summary['packs_evaluated']}")
    print(f"saved original matches corrected: {summary['original_matches']}/{summary['packs_evaluated']}")
    print(f"ellipse/radial tip majority matches corrected: {summary['ellipse_tip_matches']}/{summary['packs_evaluated']}")
    print(f"ellipse/radial line intersections match corrected: {summary['ellipse_line_matches']}/{summary['packs_evaluated']}")
    print()
    for row in rows:
        print(
            f"{row['pack']}: corrected={row['corrected']} original={row['original']} "
            f"ellipse_tip={row['ellipse_tip_majority']} "
            f"ellipse_line={row['ellipse_line_majority']} spread={row['ellipse_line_spread_px']}"
        )
    print(f"\nreport: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
