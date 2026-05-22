from __future__ import annotations

import argparse
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Sequence

import cv2
import numpy as np

COLOR_GRAY_76 = 76
COLOR_GRAY_152 = 152
REMOVE_DARTS_MIN_FOREGROUND = 200


class DetectState(str, Enum):
    INIT = "INIT"
    NO_MOVEMENT = "NO_MOVEMENT"
    MOVEMENT = "MOVEMENT"
    REMOVING_DARTS = "REMOVING_DARTS"
    PARTIAL_TAKEOUT = "PARTIAL_TAKEOUT"


class DetectEventType(str, Enum):
    DETECT = "DETECT"
    REMOVE = "REMOVE"


@dataclass
class DetectorConfig:
    camera_ids: Sequence[int] = (0, 1, 2)
    width: int = 1280
    height: int = 720
    process_width: int = 640
    process_height: int = 360
    fps: int = 30
    warmup_seconds: float = 1.0
    blur_size: int = 5
    pixel_diff_threshold: int = 18
    movement_threshold: float = 0.001
    remove_darts_threshold: float = 0.1
    remove_darts_finish_threshold: float = 0.4
    direct_takeout_threshold: float = 0.8
    single_remove_overlap_threshold: float = 0.18
    single_remove_min_overlap_pixels: int = 120
    last_dart_single_remove_overlap_threshold: float = 0.09
    last_dart_single_remove_min_overlap_pixels: int = 70
    large_removal_motion_threshold: float = 0.05
    post_clear_hold_frames: int = 10
    detect_min_largest2: float = 0.006
    remove_delay_ms: int = 500
    min_blob_area: int = 40
    min_foreground_pixels: int = 80
    max_darts: int = 3
    debug_windows: bool = True
    show_masks: bool = True


@dataclass
class CameraDiff:
    mask: np.ndarray
    percent: float


@dataclass
class DetectionEvent:
    event_type: str
    dart_count: int
    state: str
    current_diff: str
    current_diff_sum: str
    last_detection_sum: str
    remove_finish: str
    movement_duration_ms: str


def parse_camera_ids(value: str) -> list[int]:
    ids = [int(part.strip()) for part in value.split(",") if part.strip()]
    if len(ids) != 3:
        raise ValueError("Exactly 3 camera ids are required, for example 0,1,2")
    return ids


def sum_of_2_smallest_diff(diff_images: list[CameraDiff]) -> float:
    percents = sorted(diff.percent for diff in diff_images)
    return percents[0] + percents[1]


def sum_of_2_largest_diff(diff_images: list[CameraDiff]) -> float:
    percents = sorted((diff.percent for diff in diff_images), reverse=True)
    return percents[0] + percents[1]


def next_biggest(values: list[float]) -> float:
    if len(values) < 2:
        return float("-inf")
    return sorted(values, reverse=True)[1]


def format_values(values: list[float]) -> str:
    return "[" + ", ".join(f"{value:.4f}" for value in values) + "]"


def is_mask_foreground(mask: np.ndarray) -> np.ndarray:
    return np.logical_or(mask == COLOR_GRAY_76, mask == COLOR_GRAY_152)


class TripleCameraDartDetector:
    def __init__(self, config: DetectorConfig):
        self.config = config
        self.state = DetectState.INIT
        self.dart_count = 0
        self.masks: list[np.ndarray | None] = [None, None, None]
        self.masks_history: list[list[np.ndarray | None]] = []
        self.before_movement_frames: list[np.ndarray | None] = [None, None, None]
        self.last_frame_frames: list[np.ndarray | None] = [None, None, None]
        self.empty_frames: list[np.ndarray | None] = [None, None, None]
        self.request_frames: list[np.ndarray | None] = [None, None, None]
        self.movement_frame_before: list[float | None] = [None, None, None]
        self.remove_delay_start: float | None = None
        self.warmup_deadline = time.time() + self.config.warmup_seconds
        self.last_debug_line = ""
        self.last_diff_images: list[CameraDiff] | None = None
        self.vis_current_diff: str | None = None
        self.vis_current_diff_sum: str | None = None
        self.vis_last_detection_sum: str | None = None
        self.vis_remove_finish: str | None = None
        self.movement_started_ms: float | None = None
        self.movement_duration_ms: float | None = None
        self.post_clear_hold_frames_left = 0

    def reset(self, frames: list[np.ndarray]) -> None:
        self._reset_images(frames)
        self.remove_delay_start = None
        self.movement_frame_before = [None, None, None]
        self.state = DetectState.NO_MOVEMENT
        self.dart_count = 0

    def process(self, frames: list[np.ndarray]) -> DetectionEvent | None:
        gray_frames = [self._preprocess(frame) for frame in frames]

        if self.state == DetectState.INIT:
            self._reset_images(gray_frames)
            if time.time() < self.warmup_deadline:
                return None
            self.state = DetectState.NO_MOVEMENT
            return None

        if self.state == DetectState.NO_MOVEMENT:
            return self._no_movement_state(gray_frames)

        if self.state == DetectState.MOVEMENT:
            return self._movement_state(gray_frames)

        if self.state == DetectState.REMOVING_DARTS:
            return self._removing_darts_state(gray_frames)

        return None

    def _reset_images(self, frames: list[np.ndarray]) -> None:
        self.masks = [None, None, None]
        self.masks_history = []
        self.empty_frames = [frame.copy() for frame in frames]
        self.before_movement_frames = [frame.copy() for frame in frames]
        self.last_frame_frames = [frame.copy() for frame in frames]
        self.request_frames = [None, None, None]
        self.last_diff_images = None
        self.last_debug_line = ""
        self.vis_current_diff = None
        self.vis_current_diff_sum = None
        self.vis_last_detection_sum = None
        self.vis_remove_finish = None
        self.movement_duration_ms = None
        self.post_clear_hold_frames_left = 0

    def _preprocess(self, frame: np.ndarray) -> np.ndarray:
        resized = cv2.resize(
            frame,
            (self.config.process_width, self.config.process_height),
            interpolation=cv2.INTER_AREA,
        )
        return cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)

    def _build_diff_images(
        self,
        current_frames: list[np.ndarray],
        reference_frames: list[np.ndarray | None],
    ) -> list[CameraDiff]:
        result: list[CameraDiff] = []
        for idx, current in enumerate(current_frames):
            reference = reference_frames[idx] if reference_frames[idx] is not None else current
            abs_diff = cv2.absdiff(current, reference)
            _, binary = cv2.threshold(
                abs_diff, self.config.pixel_diff_threshold, 255, cv2.THRESH_BINARY
            )
            kernel = np.ones((3, 3), np.uint8)
            binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)
            binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
            binary = self._keep_large_components(binary)
            percent = cv2.countNonZero(binary) / float(binary.shape[0] * binary.shape[1])
            result.append(CameraDiff(mask=binary, percent=percent))
        self.last_diff_images = result
        return result

    def _keep_large_components(self, binary: np.ndarray) -> np.ndarray:
        contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cleaned = np.zeros_like(binary)
        for contour in contours:
            if cv2.contourArea(contour) >= self.config.min_blob_area:
                cv2.drawContours(cleaned, [contour], -1, 255, thickness=cv2.FILLED)
        return cleaned

    def _is_remove_started(self, diff_images: list[CameraDiff]) -> tuple[bool, str]:
        vis_value = sum_of_2_smallest_diff(diff_images)
        return vis_value > self.config.remove_darts_threshold, f"{vis_value:.4f}"

    def _is_movement(
        self,
        diff_images: list[CameraDiff],
        movement_frame_before: list[float | None],
    ) -> tuple[bool, list[float] | None]:
        current = [diff.percent for diff in diff_images]
        before = [value or 0.0 for value in movement_frame_before]
        all_no_movement = all(
            abs(current[idx] - before[idx]) < (self.config.movement_threshold / 2.0)
            for idx in range(3)
        )
        return (not all_no_movement), (current if not all_no_movement else None)

    def _set_masks_to_background(self) -> None:
        for idx, mask in enumerate(self.masks):
            if mask is None:
                continue
            updated = mask.copy()
            updated[updated == COLOR_GRAY_76] = COLOR_GRAY_152
            self.masks[idx] = updated

    def _get_mask(self, diff_image: CameraDiff, previous_mask: np.ndarray | None) -> np.ndarray:
        current_red = diff_image.mask > 0
        out = np.zeros_like(diff_image.mask, dtype=np.uint8)
        if previous_mask is not None:
            prev_fg = is_mask_foreground(previous_mask)
            out[prev_fg] = COLOR_GRAY_152
        else:
            prev_fg = np.zeros_like(current_red, dtype=bool)
        out[np.logical_and(current_red, np.logical_not(prev_fg))] = COLOR_GRAY_76
        return out

    def _calculate_mask_ratios(self, diff_images: list[CameraDiff]) -> tuple[list[float], list[int]]:
        ratios = [0.0, 0.0, 0.0]
        foregrounds = [0, 0, 0]
        for idx in range(3):
            mask = self.masks[idx]
            if mask is None:
                continue
            mask_fg = is_mask_foreground(mask)
            foreground = int(np.count_nonzero(mask_fg))
            if foreground <= 0:
                continue
            diff_fg = diff_images[idx].mask > 0
            common = int(np.count_nonzero(np.logical_and(diff_fg, mask_fg)))
            foregrounds[idx] = foreground
            ratios[idx] = common / float(foreground)
        return ratios, foregrounds

    def _calculate_mask_overlap_pixels(self, diff_images: list[CameraDiff]) -> list[int]:
        overlaps = [0, 0, 0]
        for idx in range(3):
            mask = self.masks[idx]
            if mask is None:
                continue
            mask_fg = is_mask_foreground(mask)
            diff_fg = diff_images[idx].mask > 0
            overlaps[idx] = int(np.count_nonzero(np.logical_and(diff_fg, mask_fg)))
        return overlaps

    def _is_single_remove_candidate(self, diff_images: list[CameraDiff]) -> tuple[bool, list[float], list[int]]:
        if self.dart_count <= 0 or all(mask is None for mask in self.masks):
            return False, [0.0, 0.0, 0.0], [0, 0, 0]
        ratios, _ = self._calculate_mask_ratios(diff_images)
        overlaps = self._calculate_mask_overlap_pixels(diff_images)
        ratio_threshold = (
            self.config.last_dart_single_remove_overlap_threshold
            if self.dart_count == 1
            else self.config.single_remove_overlap_threshold
        )
        pixel_threshold = (
            self.config.last_dart_single_remove_min_overlap_pixels
            if self.dart_count == 1
            else self.config.single_remove_min_overlap_pixels
        )
        overlap_cams = sum(
            overlaps[idx] >= pixel_threshold and
            ratios[idx] >= ratio_threshold
            for idx in range(3)
        )
        return overlap_cams >= 2, ratios, overlaps

    def _apply_single_remove(self, diff_images: list[CameraDiff]) -> int:
        remaining_fg_total = 0
        for idx in range(3):
            mask = self.masks[idx]
            if mask is None:
                continue
            updated = mask.copy()
            overlap = np.logical_and(is_mask_foreground(updated), diff_images[idx].mask > 0)
            updated[overlap] = 0
            if np.count_nonzero(is_mask_foreground(updated)) <= self.config.min_foreground_pixels:
                updated[:] = 0
            remaining_fg = int(np.count_nonzero(is_mask_foreground(updated)))
            remaining_fg_total += remaining_fg
            self.masks[idx] = updated if remaining_fg > 0 else None

        if remaining_fg_total <= 0:
            self.dart_count = 0
        elif self.dart_count > 0:
            self.dart_count -= 1
        if self.dart_count == 0:
            self.masks = [None, None, None]
            self.post_clear_hold_frames_left = self.config.post_clear_hold_frames
        return remaining_fg_total

    def _is_direct_takeout(self, diff_images: list[CameraDiff]) -> tuple[bool, str]:
        if self.masks[0] is None:
            return False, ""
        ratios, foregrounds = self._calculate_mask_ratios(diff_images)
        if sum(foregrounds) < REMOVE_DARTS_MIN_FOREGROUND:
            return False, ""
        out_value = sum(ratio < self.config.direct_takeout_threshold for ratio in ratios) >= 2
        return (not out_value), f"{next_biggest(ratios):.5f}"

    def _is_partial_takeout(self, diff_images: list[CameraDiff]) -> tuple[bool, str]:
        if self.masks[0] is None:
            return False, ""
        ratios, _ = self._calculate_mask_ratios(diff_images)
        out_value = sum(ratio < self.config.remove_darts_finish_threshold for ratio in ratios) >= 2
        return out_value, f"{next_biggest(ratios):.5f}"

    def _diff_over_threshold_count(self, diff_images: list[CameraDiff], threshold: float) -> int:
        return sum(diff.percent > threshold for diff in diff_images)

    def _build_event(
        self,
        event_type: DetectEventType,
        diff_images: list[CameraDiff],
    ) -> DetectionEvent:
        return DetectionEvent(
            event_type=event_type.value,
            dart_count=self.dart_count,
            state=self.state.value,
            current_diff=self.vis_current_diff or "-",
            current_diff_sum=self.vis_current_diff_sum or "-",
            last_detection_sum=self.vis_last_detection_sum or "-",
            remove_finish=self.vis_remove_finish or "-",
            movement_duration_ms=(
                f"{self.movement_duration_ms:.0f}" if self.movement_duration_ms is not None else "-"
            ),
        )

    def _no_movement_state(self, frames: list[np.ndarray]) -> DetectionEvent | None:
        diff_images = self._build_diff_images(frames, self.before_movement_frames)
        diff_values = [diff.percent for diff in diff_images]
        current_sum = sum(diff_values)
        self.vis_current_diff = format_values(diff_values)
        self.vis_current_diff_sum = f"{current_sum:.4f}"
        self.last_debug_line = (
            f"no_move diffs={format_values(diff_values)} "
            f"sum={current_sum:.4f} move_gate={self.config.movement_threshold / 2.0:.4f}"
        )

        if self.post_clear_hold_frames_left > 0:
            self.post_clear_hold_frames_left -= 1
            self.before_movement_frames = [frame.copy() for frame in self.last_frame_frames]
            self.last_frame_frames = [frame.copy() for frame in frames]
            self.last_debug_line = (
                f"post_clear_hold diffs={format_values(diff_values)} "
                f"hold={self.post_clear_hold_frames_left}"
            )
            return None

        over = self._diff_over_threshold_count(diff_images, self.config.movement_threshold / 2.0)
        if over >= 2:
            self.movement_frame_before = [diff.percent for diff in diff_images]
            self.state = DetectState.MOVEMENT
            self.movement_started_ms = time.time() * 1000.0
            return None

        self.before_movement_frames = [frame.copy() for frame in self.last_frame_frames]
        self.last_frame_frames = [frame.copy() for frame in frames]
        return None

    def _movement_state(self, frames: list[np.ndarray]) -> DetectionEvent | None:
        diff_images = self._build_diff_images(frames, self.before_movement_frames)
        self.last_frame_frames = [frame.copy() for frame in frames]
        diff_values = [diff.percent for diff in diff_images]
        self.vis_current_diff = format_values(diff_values)
        self.vis_current_diff_sum = f"{sum(diff_values):.4f}"

        remove_started, remove_vis = self._is_remove_started(diff_images)
        if remove_started:
            smallest2 = sum_of_2_smallest_diff(diff_images)
            self.vis_last_detection_sum = f"{smallest2:.4f}"
            self.last_debug_line = (
                f"remove_started diffs={format_values(diff_values)} "
                f"smallest2={smallest2:.4f} threshold={self.config.remove_darts_threshold:.4f}"
            )
            self.state = DetectState.REMOVING_DARTS
            return None

        is_moving, updated_frame = self._is_movement(diff_images, self.movement_frame_before)
        if is_moving:
            self.movement_frame_before = updated_frame or [None, None, None]
            current_sum = sum(diff_values)
            self.last_debug_line = (
                f"moving diffs={format_values(diff_values)} "
                f"sum={current_sum:.4f} move_threshold={self.config.movement_threshold:.4f}"
            )
            return None

        self.before_movement_frames = [frame.copy() for frame in frames]
        largest2 = sum_of_2_largest_diff(diff_images)
        if largest2 < self.config.movement_threshold:
            self.state = DetectState.NO_MOVEMENT
            self.movement_duration_ms = (
                (time.time() * 1000.0) - self.movement_started_ms
                if self.movement_started_ms is not None
                else None
            )
            self.movement_started_ms = None
            self.last_debug_line = (
                f"movement_end_small diffs={format_values(diff_values)} "
                f"largest2={largest2:.4f} threshold={self.config.movement_threshold:.4f}"
            )
            return None

        direct_takeout, direct_vis = self._is_direct_takeout(diff_images)
        if direct_takeout:
            ratios, foregrounds = self._calculate_mask_ratios(diff_images)
            self.movement_duration_ms = (
                (time.time() * 1000.0) - self.movement_started_ms
                if self.movement_started_ms is not None
                else None
            )
            self.movement_started_ms = None
            self.dart_count = 0
            self._reset_images(frames)
            self.state = DetectState.NO_MOVEMENT
            self.post_clear_hold_frames_left = self.config.post_clear_hold_frames
            self.vis_last_detection_sum = f"({self.vis_last_detection_sum})" if self.vis_last_detection_sum else "-"
            self.last_debug_line = (
                f"direct_takeout diffs={format_values(diff_values)} "
                f"ratios={format_values(ratios)} fg={foregrounds} "
                f"threshold={self.config.direct_takeout_threshold:.4f}"
            )
            return self._build_event(DetectEventType.REMOVE, diff_images)

        single_remove, single_ratios, single_overlaps = self._is_single_remove_candidate(diff_images)
        if single_remove:
            remaining_fg_total = self._apply_single_remove(diff_images)
            self.state = DetectState.NO_MOVEMENT
            self.movement_duration_ms = (
                (time.time() * 1000.0) - self.movement_started_ms
                if self.movement_started_ms is not None
                else None
            )
            self.movement_started_ms = None
            self.vis_remove_finish = f"{next_biggest(single_ratios):.5f}"
            self.vis_last_detection_sum = "-"
            self.before_movement_frames = [frame.copy() for frame in frames]
            self.last_debug_line = (
                f"single_remove diffs={format_values(diff_values)} "
                f"ratios={format_values(single_ratios)} overlaps={single_overlaps} "
                f"remaining_fg={remaining_fg_total}"
            )
            return self._build_event(DetectEventType.REMOVE, diff_images)

        current_sum = sum(diff_values)
        if self.dart_count > 0 and current_sum >= self.config.large_removal_motion_threshold:
            ratios, foregrounds = self._calculate_mask_ratios(diff_images)
            overlaps = self._calculate_mask_overlap_pixels(diff_images)
            overlap_cams = sum(
                overlaps[idx] >= self.config.single_remove_min_overlap_pixels
                for idx in range(3)
            )
            if overlap_cams >= 2:
                remaining_fg_total = self._apply_single_remove(diff_images)
                self.state = DetectState.NO_MOVEMENT
                self.movement_duration_ms = (
                    (time.time() * 1000.0) - self.movement_started_ms
                    if self.movement_started_ms is not None
                    else None
                )
                self.movement_started_ms = None
                self.vis_remove_finish = f"{next_biggest(ratios):.5f}"
                self.vis_last_detection_sum = "-"
                self.before_movement_frames = [frame.copy() for frame in frames]
                self.last_debug_line = (
                    f"large_motion_remove diffs={format_values(diff_values)} "
                    f"ratios={format_values(ratios)} overlaps={overlaps} "
                    f"remaining_fg={remaining_fg_total} threshold={self.config.large_removal_motion_threshold:.4f}"
                )
                return self._build_event(DetectEventType.REMOVE, diff_images)

        if self.dart_count >= self.config.max_darts:
            self.state = DetectState.NO_MOVEMENT
            self.movement_duration_ms = (
                (time.time() * 1000.0) - self.movement_started_ms
                if self.movement_started_ms is not None
                else None
            )
            self.movement_started_ms = None
            self.before_movement_frames = [frame.copy() for frame in frames]
            self.last_debug_line = (
                f"ignore_detect_at_max diffs={format_values(diff_values)} "
                f"largest2={largest2:.4f}"
            )
            return None

        candidate_masks = [self._get_mask(diff_images[idx], self.masks[idx]) for idx in range(3)]
        new_pixels_per_camera = [
            int(np.count_nonzero(mask == COLOR_GRAY_76)) for mask in candidate_masks
        ]
        confident_new_cameras = sum(
            pixels >= self.config.min_foreground_pixels for pixels in new_pixels_per_camera
        )
        detect_ratios, detect_foregrounds = self._calculate_mask_ratios(diff_images)
        detect_overlaps = self._calculate_mask_overlap_pixels(diff_images)

        if largest2 < self.config.detect_min_largest2 or confident_new_cameras < 2:
            self.state = DetectState.NO_MOVEMENT
            self.movement_duration_ms = (
                (time.time() * 1000.0) - self.movement_started_ms
                if self.movement_started_ms is not None
                else None
            )
            self.movement_started_ms = None
            self.last_debug_line = (
                f"reject_detect diffs={format_values(diff_values)} "
                f"largest2={largest2:.4f} detect_min={self.config.detect_min_largest2:.4f} "
                f"new_pixels={new_pixels_per_camera} min_fg={self.config.min_foreground_pixels}"
            )
            return None

        self._set_masks_to_background()
        self.masks = [self._get_mask(diff_images[idx], self.masks[idx]) for idx in range(3)]
        self.masks_history.append(
            [mask.copy() if mask is not None else None for mask in self.masks]
        )
        self.request_frames = [frame.copy() for frame in frames]
        if self.dart_count < self.config.max_darts:
            self.dart_count += 1
        self.state = DetectState.NO_MOVEMENT
        self.movement_duration_ms = (
            (time.time() * 1000.0) - self.movement_started_ms
            if self.movement_started_ms is not None
            else None
        )
        self.movement_started_ms = None
        self.vis_last_detection_sum = (
            f"{sum_of_2_smallest_diff(diff_images):.4f}"
            if largest2 >= self.config.remove_darts_threshold
            else f"{largest2:.4f}"
        )
        self.last_debug_line = (
            f"detect diffs={format_values(diff_values)} "
            f"largest2={largest2:.4f} detect_min={self.config.detect_min_largest2:.4f} "
            f"new_pixels={new_pixels_per_camera} min_fg={self.config.min_foreground_pixels} "
            f"ratios={format_values(detect_ratios)} overlaps={detect_overlaps} fg={detect_foregrounds}"
        )
        return self._build_event(DetectEventType.DETECT, diff_images)

    def _removing_darts_state(self, frames: list[np.ndarray]) -> DetectionEvent | None:
        diff_images = self._build_diff_images(frames, self.before_movement_frames)
        diff_values = [diff.percent for diff in diff_images]
        self.vis_current_diff = format_values(diff_values)
        self.vis_current_diff_sum = f"{sum(diff_values):.4f}"
        is_moving, updated_frame = self._is_movement(diff_images, self.movement_frame_before)
        if is_moving:
            self.movement_frame_before = updated_frame or [None, None, None]
            self.remove_delay_start = None
            self.last_frame_frames = [frame.copy() for frame in frames]
            self.last_debug_line = (
                f"removing_progress diffs={format_values(diff_values)} "
                f"move_threshold={self.config.movement_threshold:.4f}"
            )
            return None

        now_ms = time.time() * 1000.0
        if self.remove_delay_start is None:
            self.remove_delay_start = now_ms
            return None
        if now_ms - self.remove_delay_start < self.config.remove_delay_ms:
            return None

        if self.masks[0] is None:
            self._reset_images(frames)
            self.state = DetectState.NO_MOVEMENT
            self.last_debug_line = "remove_before_first_dart"
            return None

        partial_takeout, partial_vis = self._is_partial_takeout(diff_images)
        ratios, foregrounds = self._calculate_mask_ratios(diff_images)
        self.remove_delay_start = None
        if partial_takeout:
            self.state = DetectState.PARTIAL_TAKEOUT
            self.vis_remove_finish = partial_vis
            self.movement_duration_ms = (
                (time.time() * 1000.0) - self.movement_started_ms
                if self.movement_started_ms is not None
                else None
            )
            self.movement_started_ms = None
            self.last_debug_line = (
                f"partial_takeout diffs={format_values(diff_values)} "
                f"ratios={format_values(ratios)} fg={foregrounds} "
                f"threshold={self.config.remove_darts_finish_threshold:.4f}"
            )
            return None

        self.dart_count = 0
        self._reset_images(frames)
        self.state = DetectState.NO_MOVEMENT
        self.post_clear_hold_frames_left = self.config.post_clear_hold_frames
        self.vis_remove_finish = partial_vis
        self.movement_duration_ms = (
            (time.time() * 1000.0) - self.movement_started_ms
            if self.movement_started_ms is not None
            else None
        )
        self.movement_started_ms = None
        self.last_debug_line = (
            f"takeout_complete diffs={format_values(diff_values)} "
            f"ratios={format_values(ratios)} fg={foregrounds} "
            f"threshold={self.config.remove_darts_finish_threshold:.4f}"
        )
        return self._build_event(DetectEventType.REMOVE, diff_images)


class CameraRig:
    def __init__(self, config: DetectorConfig):
        self.captures: list[cv2.VideoCapture] = []
        for camera_id in config.camera_ids:
            cap = cv2.VideoCapture(camera_id, cv2.CAP_DSHOW)
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, config.width)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, config.height)
            cap.set(cv2.CAP_PROP_FPS, config.fps)
            if not cap.isOpened():
                self.close()
                raise RuntimeError(f"Could not open camera {camera_id}")
            self.captures.append(cap)

    def read(self) -> list[np.ndarray]:
        frames = []
        for index, cap in enumerate(self.captures):
            ok, frame = cap.read()
            if not ok:
                raise RuntimeError(f"Failed to read frame from camera {index}")
            frames.append(frame)
        return frames

    def close(self) -> None:
        for cap in self.captures:
            cap.release()


def draw_status(frame: np.ndarray, label: str, detector: TripleCameraDartDetector) -> np.ndarray:
    output = frame.copy()
    cv2.putText(output, label, (18, 35), cv2.FONT_HERSHEY_SIMPLEX, 0.95, (0, 255, 255), 2, cv2.LINE_AA)
    cv2.putText(
        output,
        f"state={detector.state.value} darts={detector.dart_count}",
        (18, 70),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.70,
        (0, 255, 0),
        2,
        cv2.LINE_AA,
    )
    if detector.last_diff_images:
        text = " ".join(f"c{i}:{diff.percent:.4f}" for i, diff in enumerate(detector.last_diff_images))
        cv2.putText(
            output,
            text,
            (18, 102),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            (255, 200, 0),
            2,
            cv2.LINE_AA,
        )
    if detector.last_debug_line:
        cv2.putText(
            output,
            detector.last_debug_line[:70],
            (18, 132),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.50,
            (255, 255, 255),
            1,
            cv2.LINE_AA,
        )
    return output


def show_masks(detector: TripleCameraDartDetector) -> None:
    if not detector.last_diff_images:
        return
    for idx, diff in enumerate(detector.last_diff_images):
        cv2.imshow(f"diff-mask-{idx}", diff.mask)
        stored = detector.masks[idx]
        if stored is not None:
            vis = np.zeros((stored.shape[0], stored.shape[1], 3), dtype=np.uint8)
            vis[stored == COLOR_GRAY_76] = (0, 255, 255)
            vis[stored == COLOR_GRAY_152] = (160, 160, 160)
            cv2.imshow(f"stored-mask-{idx}", vis)


def main() -> None:
    parser = argparse.ArgumentParser(description="3-camera diff-based dart detection without scoring.")
    parser.add_argument("--camera-ids", default="0,1,2", help="Comma-separated camera ids, for example 0,1,2")
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--process-width", type=int, default=640)
    parser.add_argument("--process-height", type=int, default=360)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--pixel-diff-threshold", type=int, default=18)
    parser.add_argument("--movement-threshold", type=float, default=0.001)
    parser.add_argument("--remove-darts-threshold", type=float, default=0.15)
    parser.add_argument("--remove-darts-finish-threshold", type=float, default=0.4)
    parser.add_argument("--detect-min-largest2", type=float, default=0.006)
    parser.add_argument("--min-blob-area", type=int, default=40)
    parser.add_argument("--min-foreground-pixels", type=int, default=80)
    parser.add_argument("--no-debug-windows", action="store_true")
    parser.add_argument("--hide-masks", action="store_true")
    args = parser.parse_args()

    config = DetectorConfig(
        camera_ids=parse_camera_ids(args.camera_ids),
        width=args.width,
        height=args.height,
        process_width=args.process_width,
        process_height=args.process_height,
        fps=args.fps,
        pixel_diff_threshold=args.pixel_diff_threshold,
        movement_threshold=args.movement_threshold,
        remove_darts_threshold=args.remove_darts_threshold,
        remove_darts_finish_threshold=args.remove_darts_finish_threshold,
        detect_min_largest2=args.detect_min_largest2,
        min_blob_area=args.min_blob_area,
        min_foreground_pixels=args.min_foreground_pixels,
        debug_windows=not args.no_debug_windows,
        show_masks=not args.hide_masks,
    )

    rig = CameraRig(config)
    detector = TripleCameraDartDetector(config)

    print("Starting Dartit-style diff detector.")
    print("Controls: q=quit, r=manual reset")
    print(
        f"Capture resolution: {config.width}x{config.height} | "
        f"Processing resolution: {config.process_width}x{config.process_height}"
    )

    try:
        while True:
            frames = rig.read()
            event = detector.process(frames)

            if event is not None:
                print(
                    f"event={event.event_type} darts={event.dart_count} state={event.state} "
                    f"currentDiff={event.current_diff} currentDiffSum={event.current_diff_sum} "
                    f"lastDetectSum={event.last_detection_sum} "
                    f"removeFinish={event.remove_finish} movementMs={event.movement_duration_ms}"
                )

            if config.debug_windows:
                for idx, frame in enumerate(frames):
                    cv2.imshow(f"dart-camera-{idx}", draw_status(frame, f"Camera {idx}", detector))
                if config.show_masks:
                    show_masks(detector)

            key = cv2.waitKey(1) & 0xFF
            if key == ord("q"):
                break
            if key == ord("r"):
                detector.reset([detector._preprocess(frame) for frame in frames])
                print("MANUAL_RESET: darts=0")
    finally:
        rig.close()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
