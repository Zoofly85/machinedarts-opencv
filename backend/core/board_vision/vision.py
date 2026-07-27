from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np

from .models import Segmentation


RECOVERED_HOUGH_RHO = 1.0
RECOVERED_HOUGH_THETA = 0.01745329238474369
RECOVERED_DIFF_THRESHOLD_MAX = 255.0
RECOVERED_DIFF_THRESHOLD_TYPE = cv2.THRESH_BINARY
RECOVERED_CONTOUR_RETRIEVAL_MODE = cv2.RETR_LIST
RECOVERED_CONTOUR_APPROXIMATION_MODE = cv2.CHAIN_APPROX_NONE
RECOVERED_CONTOUR_REMOVAL_THICKNESS = cv2.FILLED


@dataclass(frozen=True)
class DiffParams:
    threshold: int = 16
    kernel: int = 5
    min_contour_area: float = 32.0
    margins: tuple[int, int, int, int] = (0, 0, 0, 0)


def recovered_margin_regions(
    image_shape: tuple[int, ...],
    margins: tuple[int, int, int, int],
) -> tuple[tuple[int, int, int, int], ...]:
    """Return the executable's ordered, unclamped OpenCV margin rectangles."""

    height, width = (int(image_shape[0]), int(image_shape[1]))
    top, right, bottom, left = (int(value) for value in margins)
    regions: list[tuple[int, int, int, int]] = []
    if top > 0:
        regions.append((0, 0, width, top))
    if bottom > 0:
        regions.append((0, height - bottom, width, height))
    if left > 0:
        regions.append((0, 0, left, height))
    if right > 0:
        regions.append((width - right, 0, width, height))
    return tuple(regions)


def ignore_margins(
    image: np.ndarray,
    margins: tuple[int, int, int, int],
) -> np.ndarray:
    top, right, bottom, left = (max(0, int(value)) for value in margins)
    result = image.copy()
    height, width = result.shape[:2]
    if top:
        result[: min(top, height), :] = 0
    if right:
        result[:, max(0, width - right) :] = 0
    if bottom:
        result[max(0, height - bottom) :, :] = 0
    if left:
        result[:, : min(left, width)] = 0
    return result


def remove_small_contours(mask: np.ndarray, minimum: float) -> np.ndarray:
    result = (mask > 0).astype(np.uint8) * 255
    if float(minimum) <= 0.0:
        return result
    contours, _ = cv2.findContours(
        result,
        RECOVERED_CONTOUR_RETRIEVAL_MODE,
        RECOVERED_CONTOUR_APPROXIMATION_MODE,
    )
    for contour in contours:
        if cv2.contourArea(contour) < float(minimum):
            cv2.drawContours(
                result,
                [contour],
                -1,
                0,
                RECOVERED_CONTOUR_REMOVAL_THICKNESS,
            )
    return result


def hough_call_parameters(threshold: int) -> tuple[float, float, int]:
    """Return the exact recovered basic HoughLines arguments."""

    return RECOVERED_HOUGH_RHO, RECOVERED_HOUGH_THETA, int(threshold)


def diff_mask(
    before: np.ndarray,
    after: np.ndarray,
    params: DiffParams,
    support: np.ndarray | None = None,
    *,
    support_mode: str = "clip",
) -> np.ndarray:
    diff = cv2.absdiff(before, after)
    gray = cv2.cvtColor(diff, cv2.COLOR_BGR2GRAY)
    gray = ignore_margins(gray, params.margins)
    kernel = max(1, int(params.kernel))
    if kernel > 1:
        if kernel % 2 == 0:
            kernel += 1
        gray = cv2.medianBlur(gray, kernel)
    _, mask = cv2.threshold(
        gray,
        int(params.threshold),
        RECOVERED_DIFF_THRESHOLD_MAX,
        RECOVERED_DIFF_THRESHOLD_TYPE,
    )
    if support is not None and support_mode == "clip":
        mask = cv2.bitwise_and(mask, support)
    elif support_mode not in {"clip", "count_only"}:
        raise ValueError(f"Unknown support mode: {support_mode}")
    return remove_small_contours(mask, params.min_contour_area)


def segment(
    empty: np.ndarray,
    before: np.ndarray,
    after: np.ndarray,
    params: DiffParams,
    support: np.ndarray,
    mode: str = "state",
    support_mode: str = "clip",
    lowest_point_band: int = 3,
) -> Segmentation:
    throw_diff = diff_mask(
        before,
        after,
        params,
        support,
        support_mode=support_mode,
    )
    darts_before = diff_mask(
        empty,
        before,
        params,
        support,
        support_mode=support_mode,
    )
    darts_after = diff_mask(
        empty,
        after,
        params,
        support,
        support_mode=support_mode,
    )
    stationary = cv2.bitwise_and(darts_before, darts_after)
    moved = cv2.bitwise_and(darts_before, cv2.bitwise_not(darts_after))
    new_state = cv2.bitwise_and(darts_after, cv2.bitwise_not(darts_before))
    new_throw = cv2.bitwise_and(throw_diff, cv2.bitwise_not(darts_before))
    new = cv2.bitwise_or(new_state, new_throw)
    old = stationary
    if mode == "throw":
        new = throw_diff
        selected = throw_diff
    elif mode == "recovered":
        new = cv2.bitwise_and(throw_diff, cv2.bitwise_not(stationary))
        new = cv2.bitwise_and(new, cv2.bitwise_not(moved))
        old = cv2.bitwise_and(throw_diff, stationary)
        stationary = cv2.bitwise_and(stationary, cv2.bitwise_not(old))
        new_tip = lowest_point(new, lowest_point_band)
        old_tip = lowest_point(old, lowest_point_band)
        if (
            new_tip is not None
            and old_tip is not None
            and old_tip[1] <= new_tip[1]
        ):
            selected = cv2.bitwise_or(new, old)
        else:
            selected = new.copy()
    elif mode == "state_new":
        selected = new
    elif mode == "state":
        selected = new
        new_tip = lowest_point(new, lowest_point_band)
        old_tip = lowest_point(old, lowest_point_band)
        if new_tip is not None and old_tip is not None and old_tip[1] >= new_tip[1]:
            selected = cv2.bitwise_or(new, old)
    else:
        raise ValueError(f"Unknown segmentation mode: {mode}")
    return Segmentation(selected, throw_diff, darts_before, darts_after, stationary, moved, new, old)


def lowest_point(mask: np.ndarray, band: int = 3) -> tuple[float, float] | None:
    ys, xs = np.where(mask > 0)
    if len(xs) == 0:
        return None
    max_y = int(np.max(ys))
    chosen = ys >= max(0, max_y - max(1, int(band)) + 1)
    if not np.any(chosen):
        return None
    return float(np.mean(xs[chosen])), float(max_y)


def skeletonize(mask: np.ndarray) -> np.ndarray:
    # Detection masks are already binary uint8 mats; the executable clones the
    # mat directly before the erosion loop.
    source = mask.copy()
    skeleton = np.zeros_like(source)
    element = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    while cv2.countNonZero(source):
        eroded = cv2.erode(source, element)
        opened = cv2.dilate(eroded, element)
        skeleton = cv2.bitwise_or(skeleton, cv2.subtract(source, opened))
        source = eroded
    return skeleton


def line_from_hough(
    rho: float,
    theta: float,
    width: int,
    height: int,
) -> tuple[tuple[float, float], tuple[float, float]] | None:
    """Recover geometry.LnFromHough plus Line.FitTo for the normal path."""

    rho = float(rho)
    theta = float(theta)
    width = int(width)
    height = int(height)
    cosine = math.cos(theta)
    sine = math.sin(theta)
    points: list[tuple[float, float]] = []

    # FitTo checks rectangle edges in top, right, bottom, left order.
    if abs(cosine) > 1e-15:
        top_x = rho / cosine
        if 0.0 <= top_x <= width:
            points.append((top_x, 0.0))

    if abs(sine) > 1e-15:
        right_y = (rho - cosine * width) / sine
        if 0.0 <= right_y <= height:
            points.append((float(width), right_y))

    if abs(cosine) > 1e-15:
        bottom_x = (rho - sine * height) / cosine
        if 0.0 <= bottom_x <= width:
            points.append((bottom_x, float(height)))

    if abs(sine) > 1e-15:
        left_y = rho / sine
        if 0.0 <= left_y <= height:
            points.append((0.0, left_y))

    if len(points) != 2:
        return None
    first, second = points
    if first[1] > second[1]:
        first, second = second, first
    return first, second


def _distance(point: tuple[float, float], line: tuple[tuple[float, float], tuple[float, float]]) -> float:
    p = np.asarray(point, np.float64)
    a = np.asarray(line[0], np.float64)
    b = np.asarray(line[1], np.float64)
    direction = b - a
    norm = float(np.linalg.norm(direction))
    if norm <= 1e-9:
        return float("inf")
    rel = p - a
    return abs(float(rel[0] * direction[1] - rel[1] * direction[0])) / norm


def best_line(
    mask: np.ndarray,
    tip: tuple[float, float],
    threshold: int,
    *,
    selection: str = "closest",
) -> tuple[tuple[tuple[float, float], tuple[float, float]] | None, float | None, np.ndarray]:
    skeleton = skeletonize(mask)
    rho, theta, votes = hough_call_parameters(threshold)
    raw = cv2.HoughLines(skeleton, rho, theta, votes)
    candidates: list[tuple[float, tuple[tuple[float, float], tuple[float, float]]]] = []
    if raw is not None:
        for item in raw[:128]:
            line = line_from_hough(
                float(item[0][0]),
                float(item[0][1]),
                mask.shape[1],
                mask.shape[0],
            )
            if line is not None:
                error = _distance(tip, line)
                if selection == "first":
                    return line, float(error), skeleton
                candidates.append((error, line))
    if not candidates:
        return None, None, skeleton
    if selection == "closest":
        error, line = min(candidates, key=lambda item: item[0])
    else:
        raise ValueError(f"Unknown Hough selection: {selection}")
    return line, float(error), skeleton
