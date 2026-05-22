#!/usr/bin/env python3
"""
Ellipse-based dartboard calibration helpers.

Builds ring ellipses + radial segment boundary angles from YOLO calibration points and (optionally)
auto-detects segment orientation using a YOLO "20" class.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np


Point3 = Tuple[float, float, float]  # (x, y, conf)
Point2 = Tuple[float, float]
Ellipse = Tuple[Tuple[float, float], Tuple[float, float], float]  # ((cx,cy),(w,h),angle_deg)
BBox = Tuple[float, float, float, float, float]  # (x1,y1,x2,y2,conf)


def _as_points_xy(points: Sequence[Point3]) -> List[Point2]:
    return [(float(x), float(y)) for x, y, _ in points]


def fit_ellipse_from_points(points: Sequence[Point3], remove_outliers: bool = True) -> Optional[Ellipse]:
    if points is None or len(points) < 5:
        return None
    pts = np.array(_as_points_xy(points), dtype=np.float32)
    if remove_outliers and len(pts) >= 10:
        center = np.mean(pts, axis=0)
        dists = np.sqrt(np.sum((pts - center) ** 2, axis=1))
        median = np.median(dists)
        std = np.std(dists)
        if std > 1e-6:
            mask = np.abs(dists - median) < (2.0 * std)
            if int(mask.sum()) >= 5:
                pts = pts[mask]
    try:
        return cv2.fitEllipse(pts)
    except Exception:
        return None


def point_in_ellipse(point: Point2, ellipse: Optional[Ellipse]) -> bool:
    if ellipse is None:
        return False
    (cx, cy), (w, h), angle = ellipse
    x, y = point
    dx = x - cx
    dy = y - cy
    angle_rad = np.radians(-angle)
    cos_a = float(np.cos(angle_rad))
    sin_a = float(np.sin(angle_rad))
    x_rot = dx * cos_a - dy * sin_a
    y_rot = dx * sin_a + dy * cos_a
    a = w / 2.0
    b = h / 2.0
    if a <= 1e-6 or b <= 1e-6:
        return False
    return (x_rot / a) ** 2 + (y_rot / b) ** 2 <= 1.0


def line_ellipse_intersection(center: Point2, direction: Point2, ellipse: Ellipse) -> Tuple[int, int]:
    x_int, y_int = line_ellipse_intersection_float(center, direction, ellipse)
    return (int(round(x_int)), int(round(y_int)))


def line_ellipse_intersection_float(center: Point2, direction: Point2, ellipse: Ellipse) -> Point2:
    (cx, cy), (w, h), angle = ellipse
    dx, dy = direction

    angle_rad = np.radians(-angle)
    cos_a = float(np.cos(angle_rad))
    sin_a = float(np.sin(angle_rad))

    x0 = center[0] - cx
    y0 = center[1] - cy
    x0_rot = x0 * cos_a - y0 * sin_a
    y0_rot = x0 * sin_a + y0 * cos_a

    dx_rot = dx * cos_a - dy * sin_a
    dy_rot = dx * sin_a + dy * cos_a

    a = w / 2.0
    b = h / 2.0
    if a <= 1e-6 or b <= 1e-6:
        return (int(center[0] + dx * 1000), int(center[1] + dy * 1000))

    A = (dx_rot / a) ** 2 + (dy_rot / b) ** 2
    B = 2 * ((x0_rot * dx_rot) / (a ** 2) + (y0_rot * dy_rot) / (b ** 2))
    C = (x0_rot / a) ** 2 + (y0_rot / b) ** 2 - 1
    disc = B ** 2 - 4 * A * C
    if disc < 0 or abs(A) < 1e-12:
        return (int(center[0] + dx * 1000), int(center[1] + dy * 1000))

    t1 = (-B + np.sqrt(disc)) / (2 * A)
    t2 = (-B - np.sqrt(disc)) / (2 * A)
    t = float(max(t1, t2))

    x_int_rot = x0_rot + t * dx_rot
    y_int_rot = y0_rot + t * dy_rot

    angle_rad = np.radians(angle)
    cos_a = float(np.cos(angle_rad))
    sin_a = float(np.sin(angle_rad))
    x_int = x_int_rot * cos_a - y_int_rot * sin_a
    y_int = x_int_rot * sin_a + y_int_rot * cos_a
    return (float(x_int + cx), float(y_int + cy))


def _fit_line(points: Sequence[Point2]) -> Optional[Tuple[np.ndarray, np.ndarray]]:
    pts = np.array(points, dtype=np.float64)
    if len(pts) < 2:
        return None
    centroid = np.mean(pts, axis=0)
    centered = pts - centroid
    if len(pts) == 2:
        direction = centered[1] - centered[0]
    else:
        try:
            _, _, vt = np.linalg.svd(centered, full_matrices=False)
            direction = vt[0]
        except Exception:
            direction = centered[-1] - centered[0]
    norm = float(np.linalg.norm(direction))
    if norm < 1e-10:
        return None
    direction = direction / norm
    return centroid, direction


def _intersect_lines(line1: Tuple[np.ndarray, np.ndarray], line2: Tuple[np.ndarray, np.ndarray]) -> Optional[np.ndarray]:
    p1, d1 = line1
    p2, d2 = line2
    denom = float(d1[0] * d2[1] - d1[1] * d2[0])
    if abs(denom) < 1e-10:
        return None
    delta = p2 - p1
    t = float((delta[0] * d2[1] - delta[1] * d2[0]) / denom)
    inter = p1 + t * d1
    if not np.all(np.isfinite(inter)):
        return None
    return inter


def calculate_center_from_radial_lines(radial_point_groups: Sequence[Sequence[Point2]]) -> Optional[Point2]:
    if not radial_point_groups or len(radial_point_groups) < 3:
        return None

    lines = []
    for group in radial_point_groups:
        line = _fit_line(group)
        if line is not None:
            lines.append(line)

    if len(lines) < 3:
        return None

    intersections = []
    for i in range(len(lines)):
        for j in range(i + 1, len(lines)):
            inter = _intersect_lines(lines[i], lines[j])
            if inter is not None:
                intersections.append(inter)

    if not intersections:
        return None

    inter = np.array(intersections, dtype=np.float64)
    return (float(np.median(inter[:, 0])), float(np.median(inter[:, 1])))


def group_points_by_radial_angle(
    points_by_class: Dict[str, Sequence[Point3]],
    center: Point2,
    angle_tolerance_deg: float = 5.0,
) -> Tuple[List[float], List[List[Point2]]]:
    all_angle_points: List[Tuple[float, float, float]] = []
    for cls_name in ("cal", "cal1", "cal2", "cal3"):
        for x, y, _ in points_by_class.get(cls_name, []) or []:
            dx = float(x) - center[0]
            dy = float(y) - center[1]
            ang = float(np.degrees(np.arctan2(dy, dx)))
            if ang < 0:
                ang += 360.0
            all_angle_points.append((ang, float(x), float(y)))

    all_angle_points.sort(key=lambda t: t[0])
    used = set()
    radial_angles: List[float] = []
    radial_point_groups: List[List[Point2]] = []
    for i, (ref_ang, ref_x, ref_y) in enumerate(all_angle_points):
        if i in used:
            continue
        group = [(ref_x, ref_y)]
        used.add(i)
        for j, (ang, x, y) in enumerate(all_angle_points):
            if j in used:
                continue
            diff = abs(ang - ref_ang)
            if diff > 180.0:
                diff = 360.0 - diff
            if diff < angle_tolerance_deg:
                group.append((x, y))
                used.add(j)
        if len(group) >= 2:
            radial_angles.append(float(ref_ang))
            radial_point_groups.append(group)

    return radial_angles, radial_point_groups


def get_segment_number_from_boundaries(
    point: Point2,
    center: Point2,
    segment_angles: Sequence[float],
    rotation_offset_deg: float = 0.0,
) -> int:
    segments = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5]

    dx = float(point[0] - center[0])
    dy = float(point[1] - center[1])
    angle = float(np.degrees(np.arctan2(dy, dx)))
    if angle < 0:
        angle += 360.0

    if not segment_angles:
        adjusted_angle = (angle - rotation_offset_deg) % 360.0
        segment_angle = (adjusted_angle + 9.0) % 360.0
        segment_index = int(segment_angle / 18.0) % 20
        return segments[segment_index]

    point_angle = angle
    angles = list(map(float, segment_angles))
    num_boundaries = len(angles)
    segment_index = None
    for i in range(num_boundaries):
        start = angles[i]
        end = angles[(i + 1) % num_boundaries]
        if end < start:
            if point_angle >= start or point_angle < end:
                segment_index = i
                break
        else:
            if start <= point_angle < end:
                segment_index = i
                break
    if segment_index is None:
        segment_index = 0

    rotation_steps = int(round(rotation_offset_deg / 18.0)) % 20
    adjusted_index = (segment_index - rotation_steps) % 20
    return segments[adjusted_index]


def segment_at_top(center: Point2, segment_angles: Sequence[float], rotation_offset_deg: float) -> int:
    # In image coordinates: up is -Y, which is 270 degrees with atan2(dy,dx).
    test_point = (center[0], center[1] - 100.0)
    return get_segment_number_from_boundaries(test_point, center, segment_angles, rotation_offset_deg=rotation_offset_deg)


def _distance_point_to_radial_line(point: Point2, center: Point2, angle_deg: float) -> float:
    angle_rad = np.radians(float(angle_deg))
    dir_x = float(np.cos(angle_rad))
    dir_y = float(np.sin(angle_rad))
    rel_x = float(point[0] - center[0])
    rel_y = float(point[1] - center[1])
    # Direction vector is unit length, so the cross-product magnitude is the perpendicular distance.
    return abs(rel_x * dir_y - rel_y * dir_x)


def _distance_point_to_ellipse_boundary(point: Point2, center: Point2, ellipse: Ellipse) -> Optional[float]:
    vec_x = float(point[0] - center[0])
    vec_y = float(point[1] - center[1])
    norm = float(np.hypot(vec_x, vec_y))
    if norm < 1e-6:
        return None
    dir_x = vec_x / norm
    dir_y = vec_y / norm
    ex, ey = line_ellipse_intersection_float(center, (dir_x, dir_y), ellipse)
    return float(np.hypot(point[0] - ex, point[1] - ey))


@dataclass
class EllipseCalibration:
    center: Point2
    bullseye_ellipse: Optional[Ellipse]
    bull_ellipse: Optional[Ellipse]
    outer_double_ellipse: Optional[Ellipse]
    inner_double_ellipse: Optional[Ellipse]
    outer_triple_ellipse: Optional[Ellipse]
    inner_triple_ellipse: Optional[Ellipse]
    segment_angles: List[float]
    boundary_point_groups: List[List[Point2]]
    auto_rotation_offset_deg: Optional[float] = None
    twenty_point: Optional[Point3] = None

    def to_json(self) -> Dict[str, Any]:
        def ellipse_to_dict(e: Optional[Ellipse]):
            if e is None:
                return None
            (cx, cy), (w, h), angle = e
            return {
                "center": {"x": float(cx), "y": float(cy)},
                "axes": {"width": float(w), "height": float(h)},
                "angle": float(angle),
            }

        return {
            "center": {"x": float(self.center[0]), "y": float(self.center[1])},
            "bullseye_ellipse": ellipse_to_dict(self.bullseye_ellipse),
            "bull_ellipse": ellipse_to_dict(self.bull_ellipse),
            "outer_double_ellipse": ellipse_to_dict(self.outer_double_ellipse),
            "inner_double_ellipse": ellipse_to_dict(self.inner_double_ellipse),
            "outer_triple_ellipse": ellipse_to_dict(self.outer_triple_ellipse),
            "inner_triple_ellipse": ellipse_to_dict(self.inner_triple_ellipse),
            "segment_angles": [float(a) for a in self.segment_angles],
            "boundary_points": [
                [{"x": float(p[0]), "y": float(p[1])} for p in group] for group in self.boundary_point_groups
            ],
            "auto_rotation_offset": float(self.auto_rotation_offset_deg) if self.auto_rotation_offset_deg is not None else None,
            "twenty_point": (
                {"x": float(self.twenty_point[0]), "y": float(self.twenty_point[1]), "conf": float(self.twenty_point[2])}
                if self.twenty_point is not None
                else None
            ),
        }

    @staticmethod
    def from_json(data: Dict[str, Any]) -> "EllipseCalibration":
        def dict_to_ellipse(e: Optional[Dict[str, Any]]) -> Optional[Ellipse]:
            if not e:
                return None
            return (
                (float(e["center"]["x"]), float(e["center"]["y"])),
                (float(e["axes"]["width"]), float(e["axes"]["height"])),
                float(e["angle"]),
            )

        center = (float(data["center"]["x"]), float(data["center"]["y"]))
        boundary_groups = []
        for group in data.get("boundary_points", []) or []:
            boundary_groups.append([(float(p["x"]), float(p["y"])) for p in group])
        twenty = data.get("twenty_point")
        twenty_point = None
        if twenty and "x" in twenty and "y" in twenty:
            twenty_point = (float(twenty["x"]), float(twenty["y"]), float(twenty.get("conf", 1.0)))
        return EllipseCalibration(
            center=center,
            bullseye_ellipse=dict_to_ellipse(data.get("bullseye_ellipse")),
            bull_ellipse=dict_to_ellipse(data.get("bull_ellipse")),
            outer_double_ellipse=dict_to_ellipse(data.get("outer_double_ellipse")),
            inner_double_ellipse=dict_to_ellipse(data.get("inner_double_ellipse")),
            outer_triple_ellipse=dict_to_ellipse(data.get("outer_triple_ellipse")),
            inner_triple_ellipse=dict_to_ellipse(data.get("inner_triple_ellipse")),
            segment_angles=[float(a) for a in (data.get("segment_angles") or [])],
            boundary_point_groups=boundary_groups,
            auto_rotation_offset_deg=data.get("auto_rotation_offset"),
            twenty_point=twenty_point,
        )


def build_ellipse_calibration(
    cal_points: Sequence[Point3],
    cal1_points: Sequence[Point3],
    cal2_points: Optional[Sequence[Point3]] = None,
    cal3_points: Optional[Sequence[Point3]] = None,
    twenty_points: Optional[Sequence[Point3]] = None,
    bull_boxes: Optional[Sequence[BBox]] = None,
    bullseye_boxes: Optional[Sequence[BBox]] = None,
) -> Optional[EllipseCalibration]:
    cal2_points = cal2_points or []
    cal3_points = cal3_points or []
    twenty_points = twenty_points or []
    # Currently unused; kept for API compatibility and future improvements.
    bull_boxes = bull_boxes or []
    bullseye_boxes = bullseye_boxes or []

    points_by_class = {
        "cal": cal_points or [],
        "cal1": cal1_points or [],
        "cal2": cal2_points,
        "cal3": cal3_points,
    }

    outer_double = fit_ellipse_from_points(cal_points)
    outer_triple = fit_ellipse_from_points(cal1_points)
    # IMPORTANT: match `calibration_point_detection.py` mapping:
    # - cal2 -> inner double ring
    # - cal3 -> inner triple ring
    inner_double = fit_ellipse_from_points(cal2_points) if cal2_points else None
    inner_triple = fit_ellipse_from_points(cal3_points) if cal3_points else None

    all_pts = _as_points_xy(cal_points) + _as_points_xy(cal1_points) + _as_points_xy(cal2_points) + _as_points_xy(cal3_points)
    if len(all_pts) < 3:
        return None
    arr = np.array(all_pts, dtype=np.float64)
    center_guess = (float(np.mean(arr[:, 0])), float(np.mean(arr[:, 1])))

    _, radial_groups = group_points_by_radial_angle(points_by_class, center_guess)
    refined_center = calculate_center_from_radial_lines(radial_groups) or center_guess

    # Match calibration_point_detection.py behavior:
    # - compute center from radial lines / ring geometry
    # - fit ring ellipses in camera space (do not forcibly re-center them)
    center_final = refined_center
    radial_angles, radial_groups = group_points_by_radial_angle(points_by_class, center_final)

    angle_group_pairs: List[Tuple[float, List[Point2]]] = []
    for group in radial_groups:
        vecs = np.array([[p[0] - center_final[0], p[1] - center_final[1]] for p in group], dtype=np.float32)
        mean_vec = np.mean(vecs, axis=0)
        dx, dy = float(mean_vec[0]), float(mean_vec[1])
        if dx == 0.0 and dy == 0.0:
            far = max(group, key=lambda p: (p[0] - center_final[0]) ** 2 + (p[1] - center_final[1]) ** 2)
            dx = float(far[0] - center_final[0])
            dy = float(far[1] - center_final[1])
        ang = float(np.degrees(np.arctan2(dy, dx)))
        if ang < 0:
            ang += 360.0
        angle_group_pairs.append((ang, list(group)))

    angle_group_pairs.sort(key=lambda ag: ag[0])
    segment_angles = [ag[0] for ag in angle_group_pairs]
    boundary_groups_sorted = [ag[1] for ag in angle_group_pairs]

    # Normalize angles to a stable, near-20 boundary set.
    # If we keep near-duplicate boundaries, scoring can flip "early" near a line.
    def _normalize_boundaries(angles: List[float], groups: List[List[Point2]]):
        if not angles:
            return angles, groups
        pairs = list(zip(angles, groups))
        pairs.sort(key=lambda p: p[0])

        # Merge near-duplicates (within ~3 degrees) by averaging angle and concatenating points.
        merged: List[Tuple[float, List[Point2]]] = []
        for ang, grp in pairs:
            if not merged:
                merged.append((float(ang), list(grp)))
                continue
            prev_ang, prev_grp = merged[-1]
            diff = float(ang - prev_ang)
            if diff < 3.0:
                # Average the angles; keep combined points.
                merged[-1] = ((prev_ang + float(ang)) / 2.0, prev_grp + list(grp))
            else:
                merged.append((float(ang), list(grp)))

        # If we still have >20, drop the smallest-gap boundaries until <=20.
        while len(merged) > 20:
            angles_only = [m[0] for m in merged]
            gaps = []
            for i in range(len(angles_only)):
                a0 = angles_only[i]
                a1 = angles_only[(i + 1) % len(angles_only)]
                gap = (a1 - a0) % 360.0
                gaps.append((gap, i))
            gaps.sort(key=lambda g: g[0])
            # Remove the second boundary of the tightest gap (more likely a duplicate).
            _, idx = gaps[0]
            remove_idx = (idx + 1) % len(merged)
            merged.pop(remove_idx)

        # If we have 18–19 boundaries, fill missing by splitting the largest gaps.
        while 18 <= len(merged) < 20:
            angles_only = [m[0] for m in merged]
            max_gap = -1.0
            max_idx = 0
            for i in range(len(angles_only)):
                a0 = angles_only[i]
                a1 = angles_only[(i + 1) % len(angles_only)]
                gap = (a1 - a0) % 360.0
                if gap > max_gap:
                    max_gap = gap
                    max_idx = i
            a0 = angles_only[max_idx]
            insert_angle = (a0 + max_gap / 2.0) % 360.0
            merged.insert(max_idx + 1, (insert_angle, []))

        merged.sort(key=lambda p: p[0])
        return [m[0] for m in merged], [m[1] for m in merged]

    segment_angles, boundary_groups_sorted = _normalize_boundaries(segment_angles, boundary_groups_sorted)

    auto_rotation_offset = None
    best_twenty = None
    if twenty_points and center_final and len(segment_angles) >= 18:
        best_20 = max(twenty_points, key=lambda p: float(p[2]))
        best_twenty = (float(best_20[0]), float(best_20[1]), float(best_20[2]))
        x20, y20, _ = best_20
        dx = float(x20) - center_final[0]
        dy = float(y20) - center_final[1]
        angle_to_20 = float(np.degrees(np.arctan2(dy, dx)))
        if angle_to_20 < 0:
            angle_to_20 += 360.0
        angles_sorted = segment_angles
        prev_index = 0
        prev_angle = angles_sorted[0]
        for idx, a in enumerate(angles_sorted):
            if a <= angle_to_20:
                prev_angle = a
                prev_index = idx
        next_angle = angles_sorted[(prev_index + 1) % len(angles_sorted)]
        gap = (next_angle - prev_angle) % 360.0
        if gap <= 60.0:
            auto_rotation_offset = float((prev_index % 20) * 18.0)

    # Bull/bullseye: derive from ring scale (matches calibration_point_detection.py behavior).
    bull: Optional[Ellipse] = None
    bullseye: Optional[Ellipse] = None
    ring_refs = [
        (inner_triple, 99.0),
        (outer_triple, 107.0),
        (inner_double, 162.0),
        (outer_double, 170.0),
    ]
    ref = next(((e, r) for e, r in ring_refs if e is not None), None)
    if ref is not None:
        (rx, ry), (rw, rh), rangle = ref[0]
        ref_radius_mm = float(ref[1])
        bull_radius_mm = 15.9
        bullseye_radius_mm = 6.35
        bull_axes = (float(rw) * (bull_radius_mm / ref_radius_mm), float(rh) * (bull_radius_mm / ref_radius_mm))
        bullseye_axes = (
            float(rw) * (bullseye_radius_mm / ref_radius_mm),
            float(rh) * (bullseye_radius_mm / ref_radius_mm),
        )
        bull = (center_final, bull_axes, float(rangle))
        bullseye = (center_final, bullseye_axes, float(rangle))
    else:
        # Fallback to calibration_point_detection.py's estimation order.
        estimate = estimate_bull_from_rings(
            outer_double,
            inner_double,
            outer_triple,
            inner_triple,
            fallback_center=center_final,
        )
        if estimate is not None:
            bull, bullseye, estimated_center = estimate
            center_final = (float(estimated_center[0]), float(estimated_center[1]))

    # Enforce sane bull/bullseye ratio (calibration_point_detection.py behavior).
    canonical_ratio = 15.9 / 6.35  # ≈ 2.5039
    if bullseye is not None:
        (bxc, byc), (bw, bh), bang = bullseye
        if bull is None:
            bull = ((bxc, byc), (bw * canonical_ratio, bh * canonical_ratio), bang)
        else:
            (_, _), (w, h), ang = bull
            ratio_major = max(w, h) / max(bw, bh) if max(bw, bh) > 0 else canonical_ratio
            ratio_minor = min(w, h) / min(bw, bh) if min(bw, bh) > 0 else canonical_ratio
            if ratio_major < 2.0 or ratio_major > 3.2 or ratio_minor < 2.0 or ratio_minor > 3.2:
                bull = ((bxc, byc), (bw * canonical_ratio, bh * canonical_ratio), bang)
    elif bull is not None:
        (bxc, byc), (bw, bh), bang = bull
        bullseye = ((bxc, byc), (bw / canonical_ratio, bh / canonical_ratio), bang)

    return EllipseCalibration(
        center=center_final,
        bullseye_ellipse=bullseye,
        bull_ellipse=bull,
        outer_double_ellipse=outer_double,
        inner_double_ellipse=inner_double,
        outer_triple_ellipse=outer_triple,
        inner_triple_ellipse=inner_triple,
        segment_angles=segment_angles,
        boundary_point_groups=boundary_groups_sorted,
        auto_rotation_offset_deg=auto_rotation_offset,
        twenty_point=best_twenty,
    )


def calculate_ellipse_calibration_quality(
    calib: EllipseCalibration,
    cal_points: Sequence[Point3],
    cal1_points: Sequence[Point3],
    cal2_points: Optional[Sequence[Point3]] = None,
    cal3_points: Optional[Sequence[Point3]] = None,
) -> Dict[str, Any]:
    cal2_points = cal2_points or []
    cal3_points = cal3_points or []

    ring_specs: List[Tuple[str, Sequence[Point3], Optional[Ellipse]]] = [
        ("outer_double", cal_points, calib.outer_double_ellipse),
        ("outer_triple", cal1_points, calib.outer_triple_ellipse),
        # Match the ellipse-based scorer's ring mapping.
        ("inner_double", cal2_points, calib.inner_double_ellipse),
        ("inner_triple", cal3_points, calib.inner_triple_ellipse),
    ]

    ring_errors: List[float] = []
    ring_breakdown: Dict[str, Dict[str, float]] = {}
    for label, points, ellipse in ring_specs:
        if not points or ellipse is None:
            continue
        point_errors: List[float] = []
        for x, y, _ in points:
            err = _distance_point_to_ellipse_boundary((float(x), float(y)), calib.center, ellipse)
            if err is not None and np.isfinite(err):
                point_errors.append(float(err))
                ring_errors.append(float(err))
        if point_errors:
            ring_breakdown[label] = {
                "count": float(len(point_errors)),
                "mean_error_px": float(np.mean(point_errors)),
            }

    radial_errors: List[float] = []
    if calib.segment_angles and calib.boundary_point_groups:
        for angle_deg, group in zip(calib.segment_angles, calib.boundary_point_groups):
            for point in group:
                err = _distance_point_to_radial_line((float(point[0]), float(point[1])), calib.center, float(angle_deg))
                if np.isfinite(err):
                    radial_errors.append(float(err))

    ring_mean = float(np.mean(ring_errors)) if ring_errors else None
    radial_mean = float(np.mean(radial_errors)) if radial_errors else None

    weighted_sum = 0.0
    weight_total = 0.0
    if ring_mean is not None:
        weighted_sum += ring_mean * 0.75
        weight_total += 0.75
    if radial_mean is not None:
        weighted_sum += radial_mean * 0.25
        weight_total += 0.25
    combined_error = float(weighted_sum / weight_total) if weight_total > 0 else None

    ref_radius_px = 0.0
    if calib.outer_double_ellipse is not None:
        _, (w, h), _ = calib.outer_double_ellipse
        ref_radius_px = max(float(w), float(h)) / 2.0
    tol_px = max(10.0, 0.035 * ref_radius_px) if ref_radius_px > 0 else 10.0

    quality = 0.0
    if combined_error is not None:
        scaled = float(combined_error / tol_px)
        quality = 1.0 / (1.0 + scaled * scaled)

    return {
        "metric": "ellipse_radial_fit",
        "quality": float(max(0.0, min(1.0, quality))),
        "combined_error_px": combined_error,
        "ring_error_px": ring_mean,
        "radial_error_px": radial_mean,
        "ring_breakdown": ring_breakdown,
        "ring_points_used": int(len(ring_errors)),
        "radial_points_used": int(len(radial_errors)),
        "tolerance_px": float(tol_px),
    }


def estimate_bull_from_rings(
    outer_double: Optional[Ellipse],
    inner_double: Optional[Ellipse],
    outer_triple: Optional[Ellipse],
    inner_triple: Optional[Ellipse],
    fallback_center: Optional[Point2] = None,
) -> Optional[Tuple[Ellipse, Ellipse, Point2]]:
    """
    Ported from `calibration_point_detection.py`.
    Estimate bull and bullseye ellipses from ring geometry when direct detection is unavailable.
    """
    candidates: List[Tuple[str, Ellipse, float, float]] = []
    if inner_triple:
        candidates.append(("inner_triple", inner_triple, 15.9 / 99.0, 6.35 / 99.0))
    if outer_triple:
        candidates.append(("outer_triple", outer_triple, 15.9 / 107.0, 6.35 / 107.0))
    if inner_double:
        candidates.append(("inner_double", inner_double, 15.9 / 162.0, 6.35 / 162.0))
    if outer_double:
        candidates.append(("outer_double", outer_double, 15.9 / 170.0, 6.35 / 170.0))

    if not candidates:
        return None

    _, base_ellipse, bull_ratio, bullseye_ratio = candidates[0]
    (cx, cy), (w, h), angle = base_ellipse

    if fallback_center:
        cx = (cx + float(fallback_center[0])) / 2.0
        cy = (cy + float(fallback_center[1])) / 2.0

    bull_axes = (float(w) * float(bull_ratio), float(h) * float(bull_ratio))
    bullseye_axes = (float(w) * float(bullseye_ratio), float(h) * float(bullseye_ratio))

    bull_ellipse = ((float(cx), float(cy)), bull_axes, float(angle))
    bullseye_ellipse = ((float(cx), float(cy)), bullseye_axes, float(angle))
    return bull_ellipse, bullseye_ellipse, (float(cx), float(cy))


def score_from_ellipse_calibration(
    point: Point2,
    calib: EllipseCalibration,
    rotation_offset_deg: float,
) -> Dict[str, Any]:
    cx, cy = calib.center
    if not np.isfinite(cx) or not np.isfinite(cy):
        return {"score": 0, "multiplier": 1, "segment": 0, "zone": "miss", "is_bullseye": False, "is_outer_bull": False}

    if point_in_ellipse(point, calib.bullseye_ellipse):
        return {"score": 50, "multiplier": 1, "segment": 0, "zone": "inner_bull", "is_bullseye": True, "is_outer_bull": False}
    if point_in_ellipse(point, calib.bull_ellipse):
        return {"score": 25, "multiplier": 1, "segment": 0, "zone": "outer_bull", "is_bullseye": False, "is_outer_bull": True}

    segment = get_segment_number_from_boundaries(point, calib.center, calib.segment_angles, rotation_offset_deg=rotation_offset_deg)

    in_outer_double = point_in_ellipse(point, calib.outer_double_ellipse)
    in_inner_double = point_in_ellipse(point, calib.inner_double_ellipse) if calib.inner_double_ellipse else False
    in_outer_triple = point_in_ellipse(point, calib.outer_triple_ellipse)
    in_inner_triple = point_in_ellipse(point, calib.inner_triple_ellipse) if calib.inner_triple_ellipse else False

    if calib.outer_double_ellipse and not in_outer_double:
        return {"score": 0, "multiplier": 1, "segment": 0, "zone": "miss", "is_bullseye": False, "is_outer_bull": False}

    if calib.outer_triple_ellipse and calib.inner_triple_ellipse and in_outer_triple and not in_inner_triple:
        return {"score": segment * 3, "multiplier": 3, "segment": segment, "zone": "triple", "is_bullseye": False, "is_outer_bull": False}
    if calib.outer_double_ellipse and calib.inner_double_ellipse and in_outer_double and not in_inner_double:
        return {"score": segment * 2, "multiplier": 2, "segment": segment, "zone": "double", "is_bullseye": False, "is_outer_bull": False}

    if calib.inner_triple_ellipse and in_inner_triple:
        return {"score": segment, "multiplier": 1, "segment": segment, "zone": "single_inner", "is_bullseye": False, "is_outer_bull": False}
    if calib.inner_double_ellipse and in_inner_double:
        return {"score": segment, "multiplier": 1, "segment": segment, "zone": "single_outer", "is_bullseye": False, "is_outer_bull": False}

    # If we don't have inner rings, fall back to single if within outer double.
    if in_outer_double:
        return {"score": segment, "multiplier": 1, "segment": segment, "zone": "single", "is_bullseye": False, "is_outer_bull": False}

    return {"score": 0, "multiplier": 1, "segment": 0, "zone": "miss", "is_bullseye": False, "is_outer_bull": False}


def draw_ellipse_overlay(frame: np.ndarray, calib: EllipseCalibration, rotation_offset_deg: float) -> np.ndarray:
    result = frame.copy()
    center = (int(round(calib.center[0])), int(round(calib.center[1])))
    width = int(result.shape[1]) if result is not None and result.ndim >= 2 else 1280
    ui_scale = max(0.55, min(1.25, width / 1280.0))

    # Rings
    if calib.outer_double_ellipse is not None:
        cv2.ellipse(result, calib.outer_double_ellipse, (255, 0, 255), max(1, int(round(3 * ui_scale))), cv2.LINE_AA)
    if calib.inner_double_ellipse is not None:
        cv2.ellipse(result, calib.inner_double_ellipse, (255, 0, 255), max(1, int(round(3 * ui_scale))), cv2.LINE_AA)
    if calib.outer_triple_ellipse is not None:
        cv2.ellipse(result, calib.outer_triple_ellipse, (0, 255, 0), max(1, int(round(3 * ui_scale))), cv2.LINE_AA)
    if calib.inner_triple_ellipse is not None:
        cv2.ellipse(result, calib.inner_triple_ellipse, (0, 255, 0), max(1, int(round(3 * ui_scale))), cv2.LINE_AA)
    if calib.bull_ellipse is not None:
        cv2.ellipse(result, calib.bull_ellipse, (255, 0, 0), max(1, int(round(3 * ui_scale))), cv2.LINE_AA)
    if calib.bullseye_ellipse is not None:
        cv2.ellipse(result, calib.bullseye_ellipse, (0, 255, 255), max(1, int(round(3 * ui_scale))), cv2.LINE_AA)

    # Helper line to YOLO "20" point (orange), if available.
    if calib.twenty_point is not None:
        x20, y20, _ = calib.twenty_point
        cv2.line(
            result,
            center,
            (int(round(x20)), int(round(y20))),
            (0, 165, 255),
            max(1, int(round(2 * ui_scale))),
            cv2.LINE_AA,
        )
        cv2.circle(result, (int(round(x20)), int(round(y20))), max(2, int(round(4 * ui_scale))), (0, 165, 255), -1, cv2.LINE_AA)

    # Radial lines
    if calib.segment_angles and calib.outer_double_ellipse and calib.bull_ellipse:
        for ang in calib.segment_angles:
            rad = np.radians(float(ang))
            dx = float(np.cos(rad))
            dy = float(np.sin(rad))
            start = line_ellipse_intersection(calib.center, (dx, dy), calib.bull_ellipse)
            end = line_ellipse_intersection(calib.center, (dx, dy), calib.outer_double_ellipse)
            cv2.line(result, start, end, (255, 255, 255), max(1, int(round(2 * ui_scale))), cv2.LINE_AA)

    # Highlight segment 20 boundaries in red (like calibration tool), respecting rotation offset.
    if calib.segment_angles and calib.outer_double_ellipse and calib.bull_ellipse:
        segments = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5]
        rotation_steps = int(round(rotation_offset_deg / 18.0)) % 20
        n = len(calib.segment_angles)
        for idx, ang in enumerate(calib.segment_angles):
            seg_idx = (idx - rotation_steps) % 20
            if segments[seg_idx] != 20:
                continue
            for a in (float(ang), float(calib.segment_angles[(idx + 1) % n])):
                rad = np.radians(a)
                dx = float(np.cos(rad))
                dy = float(np.sin(rad))
                start = line_ellipse_intersection(calib.center, (dx, dy), calib.bull_ellipse)
                end = line_ellipse_intersection(calib.center, (dx, dy), calib.outer_double_ellipse)
                cv2.line(result, start, end, (0, 0, 255), max(1, int(round(2 * ui_scale))), cv2.LINE_AA)
            break

    # Numbers in outer single band
    if calib.segment_angles and calib.outer_double_ellipse:
        segments = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5]
        rotation_steps = int(round(rotation_offset_deg / 18.0)) % 20
        n = len(calib.segment_angles)

        inner_ref = calib.inner_double_ellipse or calib.outer_triple_ellipse or calib.bull_ellipse
        for i in range(n):
            seg_idx = (i - rotation_steps) % 20
            seg_value = segments[seg_idx]
            a0 = float(calib.segment_angles[i])
            a1 = float(calib.segment_angles[(i + 1) % n])
            if a1 < a0:
                a1 += 360.0
            mid = (a0 + a1) / 2.0
            rad = np.radians(mid)
            dx = float(np.cos(rad))
            dy = float(np.sin(rad))
            if inner_ref is None:
                continue
            p_in = line_ellipse_intersection(calib.center, (dx, dy), inner_ref)
            p_out = line_ellipse_intersection(calib.center, (dx, dy), calib.outer_double_ellipse)
            lx = int((p_in[0] + p_out[0]) / 2)
            ly = int((p_in[1] + p_out[1]) / 2)

            label = str(seg_value)
            font = cv2.FONT_HERSHEY_SIMPLEX
            # Scale text with the output frame so labels don't spill across wedge boundaries at lower resolutions.
            font_scale = 0.8 * ui_scale
            thickness = max(1, int(round(2 * ui_scale)))
            (tw, th), _ = cv2.getTextSize(label, font, font_scale, thickness)
            org = (lx - tw // 2, ly + th // 2)
            color = (0, 0, 255) if seg_value == 20 else (255, 255, 255)
            cv2.putText(result, label, org, font, font_scale, (0, 0, 0), thickness + 2, cv2.LINE_AA)
            cv2.putText(result, label, org, font, font_scale, color, thickness, cv2.LINE_AA)

    cv2.circle(result, center, max(2, int(round(3 * ui_scale))), (255, 255, 255), -1, cv2.LINE_AA)
    cv2.circle(result, center, max(3, int(round(6 * ui_scale))), (255, 255, 255), max(1, int(round(2 * ui_scale))), cv2.LINE_AA)
    return result
