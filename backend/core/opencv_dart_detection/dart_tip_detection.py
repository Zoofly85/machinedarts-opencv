#!/usr/bin/env python3
"""Dart mask, bounding box, and shaft-line helpers.

This module is intentionally independent from live camera capture so we can
develop the difficult vision pieces against saved frames first.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import cv2
import numpy as np


Point = Tuple[float, float]
BBox = Tuple[int, int, int, int]


@dataclass
class CameraDartDetection:
    camera_index: int
    bbox: BBox
    line_point: Point
    line_direction: Point
    endpoint_a: Point
    endpoint_b: Point
    board_end: Point
    contour_area: float
    confidence: float
    endpoint_a_width: float = 0.0
    endpoint_b_width: float = 0.0
    width_ratio: float = 0.0
    used_width_tip: bool = False
    source_priority: int = 0


def clean_mask(mask: np.ndarray, kernel_size: int = 5) -> np.ndarray:
    """Remove specks and bridge small gaps in a binary dart mask."""
    mask_u8 = (mask > 0).astype(np.uint8) * 255
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    cleaned = cv2.morphologyEx(mask_u8, cv2.MORPH_OPEN, kernel)
    cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_CLOSE, kernel)

    # A light vertical-ish close helps reconnect broken shaft pieces without
    # inflating the mask too aggressively.
    line_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, max(7, kernel_size * 2 + 1)))
    cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_CLOSE, line_kernel)
    return cleaned


def filter_small_components(mask: np.ndarray, min_pixels: int = 12) -> np.ndarray:
    """Keep solid connected components and discard speckle noise."""
    mask_u8 = (mask > 0).astype(np.uint8) * 255
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask_u8, connectivity=8)
    out = np.zeros_like(mask_u8)
    for label in range(1, n):
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area >= min_pixels:
            out[labels == label] = 255
    return out


def bridge_mask_gaps(mask: np.ndarray) -> np.ndarray:
    """Connect nearby dart fragments for grouping, without replacing raw pixels.

    This mask is used to decide which raw CODE_NEW pixels belong together. The
    final line and box still use the original pixels inside each bridged group.
    """
    mask_u8 = filter_small_components(mask, min_pixels=12)
    small = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    bridged = cv2.morphologyEx(mask_u8, cv2.MORPH_CLOSE, small)

    # Bridge modest shaft gaps. Keep these conservative: the raw diff can have
    # scattered board speckles, and aggressive kernels create giant false boxes.
    kernels = [
        cv2.getStructuringElement(cv2.MORPH_RECT, (3, 11)),
        cv2.getStructuringElement(cv2.MORPH_RECT, (9, 3)),
        np.array(
            [
                [1, 0, 0],
                [0, 1, 0],
                [0, 0, 1],
            ],
            dtype=np.uint8,
        )
        * 255,
        np.array(
            [
                [0, 0, 1],
                [0, 1, 0],
                [1, 0, 0],
            ],
            dtype=np.uint8,
        )
        * 255,
    ]
    for kernel in kernels:
        bridged = cv2.morphologyEx(bridged, cv2.MORPH_CLOSE, kernel)

    return bridged


def neon_green_mask(frame: np.ndarray) -> np.ndarray:
    """Extract Autodarts-style bright green debug dart pixels."""
    b, g, r = cv2.split(frame)
    mask = (g > 170) & (r < 110) & (b < 110) & ((g.astype(np.int16) - r.astype(np.int16)) > 80)
    return clean_mask(mask.astype(np.uint8) * 255, kernel_size=3)


def diff_mask(
    before: np.ndarray,
    after: np.ndarray,
    threshold: int = 16,
    kernel_size: int = 5,
) -> np.ndarray:
    """Build a binary mask from two BGR images."""
    diff = cv2.absdiff(before, after)
    gray = cv2.cvtColor(diff, cv2.COLOR_BGR2GRAY)
    _, mask = cv2.threshold(gray, threshold, 255, cv2.THRESH_BINARY)
    return clean_mask(mask, kernel_size=kernel_size)


def _contour_points(contour: np.ndarray) -> np.ndarray:
    pts = contour.reshape(-1, 2).astype(np.float32)
    return pts


def _fit_line(points_xy: np.ndarray) -> Optional[Tuple[Point, Point]]:
    if points_xy is None or len(points_xy) < 2:
        return None
    vx, vy, x0, y0 = cv2.fitLine(points_xy, cv2.DIST_L2, 0, 0.01, 0.01).flatten()
    norm = float(np.hypot(vx, vy))
    if norm <= 1e-6:
        return None
    return (float(x0), float(y0)), (float(vx / norm), float(vy / norm))


def _fit_hough_line(mask_u8: np.ndarray, min_length_ratio: float = 0.10) -> Optional[Tuple[Point, Point, Point, Point]]:
    """Find the longest Hough segment as a shaft candidate."""
    h, w = mask_u8.shape[:2]
    min_len = max(35, int(min(h, w) * min_length_ratio))
    lines = cv2.HoughLinesP(
        mask_u8,
        rho=1,
        theta=np.pi / 180.0,
        threshold=21,
        minLineLength=min_len,
        maxLineGap=35,
    )
    if lines is None:
        return None

    best = None
    best_score = -1.0
    for line in lines[:, 0, :]:
        x1, y1, x2, y2 = map(float, line)
        length = float(np.hypot(x2 - x1, y2 - y1))
        if length <= 1.0:
            continue
        # Prefer long lines; slightly prefer non-horizontal lines because board
        # ring fragments are often short/horizontal in these camera views.
        verticality = abs(y2 - y1) / length
        score = length * (0.75 + 0.25 * verticality)
        if score > best_score:
            best_score = score
            best = (x1, y1, x2, y2)

    if best is None:
        return None
    x1, y1, x2, y2 = best
    dx = x2 - x1
    dy = y2 - y1
    norm = float(np.hypot(dx, dy))
    if norm <= 1e-6:
        return None
    return (x1, y1), (float(dx / norm), float(dy / norm)), (x1, y1), (x2, y2)


def _line_endpoints_from_points(points_xy: np.ndarray, point: Point, direction: Point) -> Tuple[Point, Point]:
    p = np.array(point, dtype=np.float32)
    d = np.array(direction, dtype=np.float32)
    t = (points_xy - p) @ d
    a = p + d * float(np.min(t))
    b = p + d * float(np.max(t))
    return (float(a[0]), float(a[1])), (float(b[0]), float(b[1]))


def _recenter_line_point(points_xy: np.ndarray, point: Point, direction: Point) -> Point:
    """Shift a line sideways to the median center of the mask cross-sections.

    Hough/fitLine often lands on a bright edge of the shaft. We keep the
    direction but recenter the line using the median perpendicular offset of
    supporting pixels.
    """
    if points_xy is None or len(points_xy) < 4:
        return point

    p = np.array(point, dtype=np.float32)
    d = np.array(direction, dtype=np.float32)
    norm = float(np.hypot(d[0], d[1]))
    if norm <= 1e-6:
        return point
    d /= norm
    normal = np.array([-d[1], d[0]], dtype=np.float32)

    rel = points_xy - p
    projections = rel @ d
    offsets = rel @ normal
    if len(offsets) < 4:
        return point

    # Bin along the dart and average the left/right mask edge per bin. Taking
    # the median of those centers is more robust than raw median pixels when
    # one side of the shaft is brighter than the other.
    t_min = float(np.min(projections))
    t_max = float(np.max(projections))
    span = max(1.0, t_max - t_min)
    bins = max(4, min(18, int(span / 18.0)))
    centers = []
    for i in range(bins):
        lo = t_min + span * i / bins
        hi = t_min + span * (i + 1) / bins
        vals = offsets[(projections >= lo) & (projections < hi)]
        if len(vals) < 3:
            continue
        q10, q90 = np.percentile(vals, [10, 90])
        centers.append((float(q10) + float(q90)) / 2.0)

    if centers:
        shift = float(np.median(centers))
    else:
        shift = float(np.median(offsets))

    centered = p + normal * shift
    return (float(centered[0]), float(centered[1]))


def _fit_centerline_from_points(
    points_xy: np.ndarray,
    point: Point,
    direction: Point,
    min_bins: int = 4,
) -> Optional[Tuple[Point, Point, np.ndarray]]:
    """Fit a line through robust mask cross-section centers.

    Fitting every foreground pixel equally can bias toward one bright edge or
    toward a thick flight/barrel. This reduces the mask to one center point per
    slice along the dart, then fits through those centers.
    """
    if points_xy is None or len(points_xy) < 12:
        return None

    p = np.array(point, dtype=np.float32)
    d = np.array(direction, dtype=np.float32)
    norm = float(np.linalg.norm(d))
    if norm <= 1e-6:
        return None
    d /= norm
    normal = np.array([-d[1], d[0]], dtype=np.float32)

    rel = points_xy - p
    t = rel @ d
    u = rel @ normal
    t_min = float(np.min(t))
    t_max = float(np.max(t))
    span = max(1.0, t_max - t_min)
    bins = max(min_bins, min(24, int(span / 12.0)))

    centers: List[np.ndarray] = []
    for i in range(bins):
        lo = t_min + span * i / bins
        hi = t_min + span * (i + 1) / bins
        in_bin = (t >= lo) & (t < hi if i < bins - 1 else t <= hi)
        vals = u[in_bin]
        ts = t[in_bin]
        if len(vals) < 4:
            continue

        # Use robust edges of the cross-section, not the average pixel offset.
        # That keeps the fitted line centered even if one edge has more pixels.
        q10, q90 = np.percentile(vals, [10, 90])
        center_u = (float(q10) + float(q90)) / 2.0
        center_t = float(np.median(ts))
        centers.append(p + d * center_t + normal * center_u)

    if len(centers) < min_bins:
        return None

    center_points = np.array(centers, dtype=np.float32)
    vx, vy, x0, y0 = cv2.fitLine(center_points, cv2.DIST_L1, 0, 0.01, 0.01).flatten()
    line_norm = float(np.hypot(vx, vy))
    if line_norm <= 1e-6:
        return None
    return (float(x0), float(y0)), (float(vx / line_norm), float(vy / line_norm)), center_points


def _distance_to_line(points_xy: np.ndarray, point: Point, direction: Point) -> float:
    p = np.array(point, dtype=np.float32)
    d = np.array(direction, dtype=np.float32)
    rel = points_xy - p
    cross = np.abs(rel[:, 0] * d[1] - rel[:, 1] * d[0])
    return float(np.mean(cross)) if len(cross) else 9999.0


def _pixels_near_line(
    points_xy: np.ndarray,
    point: Point,
    direction: Point,
    endpoint_a: Point,
    endpoint_b: Point,
    max_distance: float = 18.0,
    projection_pad: float = 45.0,
) -> np.ndarray:
    """Return mask pixels that plausibly belong to the fitted dart line."""
    if points_xy is None or len(points_xy) == 0:
        return np.empty((0, 2), dtype=np.float32)
    p = np.array(point, dtype=np.float32)
    d = np.array(direction, dtype=np.float32)
    a = np.array(endpoint_a, dtype=np.float32)
    b = np.array(endpoint_b, dtype=np.float32)

    rel = points_xy - p
    perpendicular = np.abs(rel[:, 0] * d[1] - rel[:, 1] * d[0])
    projections = rel @ d
    ta = float((a - p) @ d)
    tb = float((b - p) @ d)
    t_min = min(ta, tb) - projection_pad
    t_max = max(ta, tb) + projection_pad
    keep = (perpendicular <= max_distance) & (projections >= t_min) & (projections <= t_max)
    return points_xy[keep]


def _endpoint_widths(
    points_xy: np.ndarray,
    point: Point,
    direction: Point,
    endpoint_a: Point,
    endpoint_b: Point,
    end_fraction: float = 0.28,
) -> Tuple[float, float]:
    """Estimate perpendicular mask width near each end of the fitted dart."""
    if points_xy is None or len(points_xy) < 4:
        return 0.0, 0.0

    p = np.array(point, dtype=np.float32)
    d = np.array(direction, dtype=np.float32)
    rel = points_xy - p
    projections = rel @ d
    perpendicular = rel[:, 0] * (-d[1]) + rel[:, 1] * d[0]

    ta = float((np.array(endpoint_a, dtype=np.float32) - p) @ d)
    tb = float((np.array(endpoint_b, dtype=np.float32) - p) @ d)
    t_min = min(ta, tb)
    t_max = max(ta, tb)
    span = max(1.0, t_max - t_min)
    band = max(10.0, span * end_fraction)

    low = perpendicular[projections <= (t_min + band)]
    high = perpendicular[projections >= (t_max - band)]

    def robust_width(values: np.ndarray) -> float:
        if len(values) < 2:
            return 0.0
        lo, hi = np.percentile(values, [10, 90])
        return float(max(0.0, hi - lo))

    width_low = robust_width(low)
    width_high = robust_width(high)

    # Map widths back to endpoint_a/endpoint_b, regardless of line direction.
    if ta <= tb:
        return width_low, width_high
    return width_high, width_low


def _choose_board_end(
    points_xy: np.ndarray,
    point: Point,
    direction: Point,
    endpoint_a: Point,
    endpoint_b: Point,
    fallback_center: np.ndarray,
) -> Tuple[Point, Dict[str, float]]:
    """Choose the likely board/tip end.

    A visible flight makes one end wide and the tip/board end narrow. When that
    signal is clear, pick the narrow end. Otherwise fall back to the previous
    center-distance heuristic.
    """
    width_a, width_b = _endpoint_widths(points_xy, point, direction, endpoint_a, endpoint_b)
    wider = max(width_a, width_b)
    narrower = min(width_a, width_b)
    width_ratio = wider / max(1.0, narrower)

    if wider >= 12.0 and width_ratio >= 1.45:
        chosen = endpoint_a if width_a < width_b else endpoint_b
        reason = 1.0
    else:
        a_np = np.array(endpoint_a, dtype=np.float32)
        b_np = np.array(endpoint_b, dtype=np.float32)
        chosen = endpoint_a if np.linalg.norm(a_np - fallback_center) < np.linalg.norm(b_np - fallback_center) else endpoint_b
        reason = 0.0

    return chosen, {
        "endpoint_a_width": float(width_a),
        "endpoint_b_width": float(width_b),
        "width_ratio": float(width_ratio),
        "used_width_tip": float(reason),
    }


def _refit_tip_side_line(
    points_xy: np.ndarray,
    line_point: Point,
    line_direction: Point,
    endpoint_a: Point,
    endpoint_b: Point,
    board_end: Point,
    min_points: int = 25,
    tip_percentile: float = 68.0,
    width_percentile: float = 72.0,
    max_width: float = 18.0,
) -> Optional[Tuple[Point, Point, Point, Point, np.ndarray]]:
    """Refit the line using the narrow shaft pixels nearest the board end.

    A full dart mask often includes flight/barrel pixels that pull the line away
    from the actual tip ray. Once we know the likely board end, keep only the
    tip-side half of pixels and reject wide perpendicular outliers.
    """
    if points_xy is None or len(points_xy) < min_points:
        return None

    p = np.array(line_point, dtype=np.float32)
    d = np.array(line_direction, dtype=np.float32)
    norm = float(np.linalg.norm(d))
    if norm <= 1e-6:
        return None
    d /= norm
    tip = np.array(board_end, dtype=np.float32)
    a = np.array(endpoint_a, dtype=np.float32)
    b = np.array(endpoint_b, dtype=np.float32)

    # Orient +d from the board tip toward the visible body/flight.
    other = b if np.linalg.norm(a - tip) < np.linalg.norm(b - tip) else a
    if float((other - tip) @ d) < 0:
        d = -d

    rel = points_xy - tip
    t = rel @ d
    perpendicular = np.abs(rel[:, 0] * d[1] - rel[:, 1] * d[0])
    positive = t >= -6.0
    if int(np.count_nonzero(positive)) < min_points:
        positive = t >= float(np.percentile(t, 20))

    t_pos = t[positive]
    if len(t_pos) < min_points:
        return None

    max_t = float(np.percentile(t_pos, tip_percentile))
    tip_side = positive & (t <= max_t)
    if int(np.count_nonzero(tip_side)) < min_points:
        max_t = float(np.percentile(t_pos, 82))
        tip_side = positive & (t <= max_t)

    if int(np.count_nonzero(tip_side)) < min_points:
        return None

    width_limit = max(7.0, float(np.percentile(perpendicular[tip_side], width_percentile)) + 2.0)
    shaft = tip_side & (perpendicular <= min(max_width, width_limit))
    if int(np.count_nonzero(shaft)) < min_points:
        shaft = tip_side & (perpendicular <= min(24.0, width_limit + 5.0))
    if int(np.count_nonzero(shaft)) < min_points:
        return None

    shaft_points = points_xy[shaft]
    fit = _fit_line(shaft_points)
    if fit is None:
        return None
    new_point, new_direction = fit

    center_fit = _fit_centerline_from_points(
        shaft_points,
        new_point,
        new_direction,
        min_bins=3,
    )
    if center_fit is not None:
        new_point, new_direction, shaft_points = center_fit

    nd = np.array(new_direction, dtype=np.float32)
    if float((other - tip) @ nd) < 0:
        nd = -nd
        new_direction = (float(nd[0]), float(nd[1]))

    new_point = _recenter_line_point(shaft_points, new_point, new_direction)
    new_a, new_b = _line_endpoints_from_points(shaft_points, new_point, new_direction)

    # Force one endpoint to be the existing board vote. This preserves scoring
    # behavior while making the final line direction come from tip-side shaft.
    projected_tip = np.array(new_point, dtype=np.float32)
    nd = np.array(new_direction, dtype=np.float32)
    projected_tip = projected_tip + nd * float((tip - projected_tip) @ nd)
    body_end = np.array(new_a, dtype=np.float32)
    if float((np.array(new_b, dtype=np.float32) - projected_tip) @ nd) > float((body_end - projected_tip) @ nd):
        body_end = np.array(new_b, dtype=np.float32)
    return (
        (float(projected_tip[0]), float(projected_tip[1])),
        (float(nd[0]), float(nd[1])),
        (float(projected_tip[0]), float(projected_tip[1])),
        (float(body_end[0]), float(body_end[1])),
        shaft_points,
    )


def detect_dart_lines(
    mask: np.ndarray,
    camera_index: int = 0,
    board_center: Optional[Point] = None,
    min_area: float = 40.0,
    min_points: int = 25,
    line_strategy: str = "full_centerline",
) -> List[CameraDartDetection]:
    """Detect plausible dart shaft lines from a binary mask.

    The function accepts broken masks: it first finds contour candidates, then
    fits a line through each candidate's pixels. Later we can add fragment
    merging across nearby aligned contours.
    """
    mask_u8 = (mask > 0).astype(np.uint8) * 255
    solid_mask = filter_small_components(mask_u8, min_pixels=12)
    grouping_mask = bridge_mask_gaps(mask_u8)
    contours, _ = cv2.findContours(grouping_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    detections: List[CameraDartDetection] = []

    h, w = mask_u8.shape[:2]
    center = board_center if board_center is not None else (w / 2.0, h / 2.0)
    center_np = np.array(center, dtype=np.float32)

    grouped_candidates: List[Tuple[np.ndarray, BBox, float, np.ndarray]] = []
    min_bbox_pixels = max(12, int(min_points * 0.45))

    for contour in contours:
        x, y, bw, bh = cv2.boundingRect(contour)
        if bw <= 1 or bh <= 1:
            continue
        group_roi = np.zeros((bh, bw), dtype=np.uint8)
        shifted = contour.copy()
        shifted[:, 0, 0] -= x
        shifted[:, 0, 1] -= y
        cv2.drawContours(group_roi, [shifted], -1, 255, -1)

        raw_roi = solid_mask[y : y + bh, x : x + bw]
        roi = cv2.bitwise_and(raw_roi, raw_roi, mask=group_roi)
        ys, xs = np.where(roi > 0)
        if len(xs) >= min_bbox_pixels:
            rx1 = int(np.min(xs) + x)
            ry1 = int(np.min(ys) + y)
            rx2 = int(np.max(xs) + x + 1)
            ry2 = int(np.max(ys) + y + 1)
            solid_bbox = (rx1, ry1, rx2 - rx1, ry2 - ry1)
        else:
            solid_bbox = (int(x), int(y), int(bw), int(bh))
        area = float(cv2.contourArea(contour))
        if area < min_area:
            continue
        if len(xs) < min_points:
            continue
        grouped_candidates.append(
            (
                np.column_stack([xs + x, ys + y]).astype(np.float32),
                solid_bbox,
                area,
                contour,
            )
        )

    for points_xy, solid_bbox, area, contour in grouped_candidates:
        x, y, bw, bh = solid_bbox

        submask = np.zeros_like(grouping_mask)
        cv2.drawContours(submask, [contour], -1, 255, -1)
        submask = cv2.bitwise_and(submask, solid_mask)
        hough = _fit_hough_line(submask)
        fit = _fit_line(points_xy)
        if hough is not None:
            line_point, line_direction, endpoint_a, endpoint_b = hough
            near_hough = _pixels_near_line(
                points_xy,
                line_point,
                line_direction,
                endpoint_a,
                endpoint_b,
                max_distance=18.0,
                projection_pad=80.0,
            )
            if len(near_hough) >= min_points:
                line_point = _recenter_line_point(near_hough, line_point, line_direction)
                endpoint_a, endpoint_b = _line_endpoints_from_points(near_hough, line_point, line_direction)
            else:
                line_point = _recenter_line_point(points_xy, line_point, line_direction)
        elif fit is not None:
            line_point, line_direction = fit
            line_point = _recenter_line_point(points_xy, line_point, line_direction)
            endpoint_a, endpoint_b = _line_endpoints_from_points(points_xy, line_point, line_direction)
        else:
            continue

        board_end, endpoint_metrics = _choose_board_end(
            points_xy,
            line_point,
            line_direction,
            endpoint_a,
            endpoint_b,
            center_np,
        )
        final_points = points_xy
        if line_strategy == "full_centerline":
            centerline_fit = _fit_centerline_from_points(points_xy, line_point, line_direction)
            if centerline_fit is not None:
                line_point, line_direction, final_points = centerline_fit
                line_point = _recenter_line_point(final_points, line_point, line_direction)
                endpoint_a, endpoint_b = _line_endpoints_from_points(final_points, line_point, line_direction)
                board_end, endpoint_metrics = _choose_board_end(
                    final_points,
                    line_point,
                    line_direction,
                    endpoint_a,
                    endpoint_b,
                    center_np,
                )
        elif line_strategy != "no_tip_refit":
            if line_strategy == "tip_refit_strict":
                tip_percentile, width_percentile, max_width = 52.0, 60.0, 13.0
            elif line_strategy == "tip_refit_balanced":
                tip_percentile, width_percentile, max_width = 60.0, 66.0, 15.0
            else:
                tip_percentile, width_percentile, max_width = 68.0, 72.0, 18.0
            tip_refit = _refit_tip_side_line(
                points_xy,
                line_point,
                line_direction,
                endpoint_a,
                endpoint_b,
                board_end,
                min_points=min_points,
                tip_percentile=tip_percentile,
                width_percentile=width_percentile,
                max_width=max_width,
            )
            if tip_refit is not None:
                line_point, line_direction, endpoint_a, endpoint_b, final_points = tip_refit
                board_end = endpoint_a

        pad = 6
        x1 = max(0, x - pad)
        y1 = max(0, y - pad)
        x2 = min(w, x + bw + pad)
        y2 = min(h, y + bh + pad)
        padded_bw = x2 - x1
        padded_bh = y2 - y1

        major = max(padded_bw, padded_bh)
        minor = max(1, min(padded_bw, padded_bh))
        elongation = float(major / minor)
        line_error = _distance_to_line(final_points, line_point, line_direction)
        area_fill = float(len(points_xy) / max(1, padded_bw * padded_bh))
        size_score = min(1.0, major / max(1.0, min(w, h) * 0.32))
        confidence = min(
            1.0,
            min(1.0, elongation / 8.0) * 0.30
            + max(0.0, 1.0 - line_error / 12.0) * 0.35
            + min(1.0, area_fill * 4.0) * 0.05
            + size_score * 0.30,
        )

        detections.append(
            CameraDartDetection(
                camera_index=camera_index,
                bbox=(int(x1), int(y1), int(padded_bw), int(padded_bh)),
                line_point=line_point,
                line_direction=line_direction,
                endpoint_a=endpoint_a,
                endpoint_b=endpoint_b,
                board_end=board_end,
                contour_area=area,
                confidence=float(confidence),
                endpoint_a_width=float(endpoint_metrics["endpoint_a_width"]),
                endpoint_b_width=float(endpoint_metrics["endpoint_b_width"]),
                width_ratio=float(endpoint_metrics["width_ratio"]),
                used_width_tip=bool(endpoint_metrics["used_width_tip"]),
                source_priority=1,
            )
        )

    detections.sort(
        key=lambda d: (
            d.source_priority,
            max(d.bbox[2], d.bbox[3]) >= max(65, int(min(h, w) * 0.08)),
            d.confidence,
            max(d.bbox[2], d.bbox[3]),
            d.contour_area,
        ),
        reverse=True,
    )
    return detections


def draw_detections(
    frame: np.ndarray,
    detections: Sequence[CameraDartDetection],
    mask: Optional[np.ndarray] = None,
) -> np.ndarray:
    """Draw Autodarts-style debug overlays."""
    out = frame.copy()
    if mask is not None:
        green = np.zeros_like(out)
        green[:, :, 1] = 255
        out = np.where((mask > 0)[:, :, None], cv2.addWeighted(out, 0.45, green, 0.55, 0), out)

    for det in detections:
        x, y, w, h = det.bbox
        cv2.rectangle(out, (x, y), (x + w, y + h), (255, 0, 0), 2, cv2.LINE_AA)

        a = (int(round(det.endpoint_a[0])), int(round(det.endpoint_a[1])))
        b = (int(round(det.endpoint_b[0])), int(round(det.endpoint_b[1])))
        cv2.line(out, a, b, (255, 255, 255), 2, cv2.LINE_AA)
        cv2.line(out, a, b, (255, 0, 0), 1, cv2.LINE_AA)

        tip = (int(round(det.board_end[0])), int(round(det.board_end[1])))
        cv2.circle(out, tip, 5, (0, 0, 255), -1, cv2.LINE_AA)
        cv2.putText(
            out,
            f"{det.confidence:.2f}",
            (x, max(18, y - 6)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            (255, 255, 255),
            2,
            cv2.LINE_AA,
        )
    return out


def pairwise_line_intersections(detections: Sequence[CameraDartDetection]) -> List[Tuple[int, int, Point]]:
    """Intersect every pair of 2D fitted lines in their shared coordinate plane."""
    intersections: List[Tuple[int, int, Point]] = []
    for i in range(len(detections)):
        for j in range(i + 1, len(detections)):
            a = detections[i]
            b = detections[j]
            p = np.array(a.line_point, dtype=np.float64)
            r = np.array(a.line_direction, dtype=np.float64)
            q = np.array(b.line_point, dtype=np.float64)
            s = np.array(b.line_direction, dtype=np.float64)
            denom = float(r[0] * s[1] - r[1] * s[0])
            if abs(denom) < 1e-9:
                continue
            t = float(((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / denom)
            x = p + t * r
            intersections.append((a.camera_index, b.camera_index, (float(x[0]), float(x[1]))))
    return intersections
