from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np

from .geometry import BoardCalibration
from .rules import (
    RecoveredMotionCounters,
    per_camera_dart,
    per_camera_hand,
    per_camera_stable,
    per_camera_takeout,
)
from .vision import DiffParams, diff_mask


def _configured(item: dict[str, Any], key: str, default: Any) -> Any:
    value = item.get(key)
    return default if value is None else value


@dataclass(frozen=True)
class MotionObservation:
    changed: int
    occupied_before: int
    occupied_after: int
    removed_ratio: float
    dart: bool
    takeout: bool


@dataclass(frozen=True)
class CameraMotionState:
    board_pixels: int
    background_pixels: int
    dart_pixels: int
    dart_background_pixels: int
    takeout_pixels: int
    takeout_background_pixels: int
    stable: bool
    hand: bool
    dart: bool
    takeout: bool


@dataclass(frozen=True)
class MotionUpdate:
    class_id: int
    candidate_class: int
    darts: int
    waiting: bool
    camera_states: dict[int, CameraMotionState]
    before: dict[int, np.ndarray] | None = None
    after: dict[int, np.ndarray] | None = None


class MotionAnalyzer:
    def __init__(
        self,
        calibrations: dict[int, BoardCalibration],
        dynamic: list[dict[str, Any]],
        *,
        scale: int = 4,
        threshold: int = 16,
        kernel: int = 3,
    ) -> None:
        self.calibrations = calibrations
        self.dynamic = dynamic
        self.scale = max(1, int(scale))
        self.threshold = int(threshold)
        self.kernel = int(kernel)
        self._support_masks: dict[tuple[int, int, int], np.ndarray] = {}
        self._full_shapes: dict[tuple[int, int], tuple[int, int]] = {}

    def small(self, frame: np.ndarray) -> np.ndarray:
        height, width = frame.shape[:2]
        size = (max(1, width // self.scale), max(1, height // self.scale))
        self._full_shapes[(size[1], size[0])] = (height, width)
        return cv2.resize(
            frame,
            size,
            interpolation=cv2.INTER_LINEAR,
        )

    def params(self, camera: int) -> DiffParams:
        item = self.dynamic[camera] if camera < len(self.dynamic) else {}
        return DiffParams(
            threshold=self.threshold,
            kernel=self.kernel,
            min_contour_area=float(
                _configured(item, "motionMinContourArea", 8.0)
            ),
            margins=(5, 0, 5, 0),
        )

    def support(self, camera: int, shape: tuple[int, ...]) -> np.ndarray:
        key = (int(camera), int(shape[0]), int(shape[1]))
        cached = self._support_masks.get(key)
        if cached is not None:
            return cached
        calibration = self.calibrations[camera]
        small_height, small_width = int(shape[0]), int(shape[1])
        full_height, full_width = self._full_shapes.get(
            (small_height, small_width),
            (
                small_height * self.scale,
                small_width * self.scale,
            ),
        )
        full_mask = calibration.support_mask((full_height, full_width))
        mask = cv2.resize(
            full_mask,
            (small_width, small_height),
            interpolation=cv2.INTER_LINEAR,
        )
        self._support_masks[key] = mask
        return mask

    def raw_diff(
        self,
        camera: int,
        before_small: np.ndarray,
        after_small: np.ndarray,
    ) -> np.ndarray:
        return diff_mask(
            before_small,
            after_small,
            self.params(camera),
            None,
        )

    def board_background_counts(
        self,
        camera: int,
        mask: np.ndarray,
    ) -> tuple[int, int]:
        support = self.support(camera, mask.shape)
        board = int(cv2.countNonZero(cv2.bitwise_and(mask, support)))
        background = int(
            cv2.countNonZero(
                cv2.bitwise_and(mask, cv2.bitwise_not(support))
            )
        )
        return board, background

    def changed_pixels(self, camera: int, before: np.ndarray, after: np.ndarray) -> int:
        first, second = self.small(before), self.small(after)
        mask = self.raw_diff(camera, first, second)
        return int(cv2.countNonZero(mask))

    def observe(
        self,
        camera: int,
        empty: np.ndarray,
        before: np.ndarray,
        after: np.ndarray,
        darts_on_board: int,
    ) -> MotionObservation:
        empty_small = self.small(empty)
        before_small = self.small(before)
        after_small = self.small(after)
        params = self.params(camera)
        support = self.support(camera, after_small.shape)
        changed_mask = diff_mask(before_small, after_small, params, support)
        before_mask = diff_mask(empty_small, before_small, params, support)
        after_mask = diff_mask(empty_small, after_small, params, support)
        removed = cv2.bitwise_and(before_mask, cv2.bitwise_not(after_mask))
        changed = int(cv2.countNonZero(changed_mask))
        occupied_before = int(cv2.countNonZero(before_mask))
        occupied_after = int(cv2.countNonZero(after_mask))
        removed_ratio = int(cv2.countNonZero(removed)) / max(1, occupied_before)
        item = self.dynamic[camera] if camera < len(self.dynamic) else {}
        min_dart = int(item.get("motionMinDartPixels") or 40)
        takeout_coverage = float(item.get("takeoutMinCoverage") or 0.8)
        return MotionObservation(
            changed=changed,
            occupied_before=occupied_before,
            occupied_after=occupied_after,
            removed_ratio=removed_ratio,
            dart=changed >= min_dart,
            takeout=darts_on_board > 0 and occupied_before > 0 and removed_ratio >= takeout_coverage,
        )


@dataclass
class MotionLifecycle:
    analyzer: MotionAnalyzer
    dynamic: list[dict[str, Any]]
    stable_num_frames: int
    counters: RecoveredMotionCounters = field(default_factory=RecoveredMotionCounters)
    darts: int = 0
    wait_frames: int = 0
    last_stable: dict[int, np.ndarray] = field(default_factory=dict)
    last_empty: dict[int, np.ndarray] = field(default_factory=dict)
    previous_board_pixels: dict[int, int] = field(default_factory=dict)
    previous_background_pixels: dict[int, int] = field(default_factory=dict)
    complete_dart_masks: dict[int, np.ndarray] = field(default_factory=dict)
    scheduled_dart_reset: bool = False
    scheduled_full_reset: bool = False

    @classmethod
    def start(
        cls,
        analyzer: MotionAnalyzer,
        dynamic: list[dict[str, Any]],
        stable_num_frames: int,
        frames: dict[int, np.ndarray],
    ) -> "MotionLifecycle":
        copied = {camera: frame.copy() for camera, frame in frames.items()}
        return cls(
            analyzer=analyzer,
            dynamic=dynamic,
            stable_num_frames=max(1, int(stable_num_frames)),
            last_stable={
                camera: frame.copy() for camera, frame in copied.items()
            },
            last_empty={
                camera: frame.copy() for camera, frame in copied.items()
            },
            previous_board_pixels={camera: 0 for camera in copied},
            previous_background_pixels={camera: 0 for camera in copied},
        )

    def _dynamic(self, camera: int) -> dict[str, Any]:
        return self.dynamic[camera] if camera < len(self.dynamic) else {}

    @staticmethod
    def _copy_frames(
        frames: dict[int, np.ndarray],
    ) -> dict[int, np.ndarray]:
        return {camera: frame.copy() for camera, frame in frames.items()}

    def _clear_takeout_masks(self) -> None:
        self.complete_dart_masks.clear()

    def _reset_after_takeout(self, frames: dict[int, np.ndarray]) -> None:
        self.darts = 0
        self.last_stable = self._copy_frames(frames)
        self._clear_takeout_masks()
        self.scheduled_full_reset = True

    def update(self, frames: dict[int, np.ndarray]) -> MotionUpdate:
        if self.scheduled_full_reset:
            self.counters.apply_scheduled_full_reset()
            self.scheduled_full_reset = False
        elif self.scheduled_dart_reset:
            self.counters.apply_scheduled_dart_reset()
            self.scheduled_dart_reset = False

        small_current = {
            camera: self.analyzer.small(frame)
            for camera, frame in frames.items()
        }
        small_stable = {
            camera: self.analyzer.small(self.last_stable[camera])
            for camera in frames
        }
        small_empty = {
            camera: self.analyzer.small(self.last_empty[camera])
            for camera in frames
        }

        camera_states: dict[int, CameraMotionState] = {}
        all_stable: list[bool] = []
        any_hand: list[bool] = []
        any_dart: list[bool] = []
        takeout_votes: list[bool] = []

        for camera in sorted(frames):
            dynamic = self._dynamic(camera)
            motion_diff = self.analyzer.raw_diff(
                camera,
                small_stable[camera],
                small_current[camera],
            )
            board_pixels, background_pixels = (
                self.analyzer.board_background_counts(camera, motion_diff)
            )

            current_empty_diff = self.analyzer.raw_diff(
                camera,
                small_empty[camera],
                small_current[camera],
            )
            frozen = self.complete_dart_masks.get(camera)
            if frozen is None:
                frozen = np.zeros_like(current_empty_diff)
            retained = cv2.bitwise_and(current_empty_diff, frozen)
            dart_pixels, dart_background_pixels = (
                self.analyzer.board_background_counts(camera, frozen)
            )
            takeout_pixels, takeout_background_pixels = (
                self.analyzer.board_background_counts(camera, retained)
            )

            stable = per_camera_stable(
                board_pixels=board_pixels,
                previous_board_pixels=self.previous_board_pixels.get(camera, 0),
                background_pixels=background_pixels,
                previous_background_pixels=self.previous_background_pixels.get(
                    camera, 0
                ),
                min_change=int(
                    _configured(dynamic, "motionMinChange", 20)
                ),
                takeout_frames_reached=self.counters.takeout_frames_reached,
                takeout_stable_multiplier=int(
                    _configured(
                        dynamic,
                        "takeoutCompletedStableMultiplier",
                        10,
                    )
                ),
            )
            hand = per_camera_hand(
                board_pixels=board_pixels,
                background_pixels=background_pixels,
                dart_pixels=dart_pixels,
                dart_background_pixels=dart_background_pixels,
                takeout_pixels=takeout_pixels,
                takeout_background_pixels=takeout_background_pixels,
                hand_frames_reached=self.counters.hand_frames_reached,
                min_foreground_pixels=int(
                    _configured(
                        dynamic,
                        "motionMinHandForegroundPixels",
                        20,
                    )
                ),
                min_background_pixels=int(
                    _configured(
                        dynamic,
                        "motionMinHandBackgroundPixels",
                        3000,
                    )
                ),
            )
            dart = per_camera_dart(
                board_pixels=board_pixels,
                is_hand=hand,
                hand_frames_reached=self.counters.hand_frames_reached,
                darts=self.darts,
                min_dart_pixels=int(
                    _configured(dynamic, "motionMinDartPixels", 40)
                ),
            )
            takeout = per_camera_takeout(
                hand_frames_reached=self.counters.hand_frames_reached,
                dart_pixels=dart_pixels,
                takeout_pixels=takeout_pixels,
                min_coverage=float(
                    _configured(dynamic, "takeoutMinCoverage", 0.8)
                ),
            )
            self.previous_board_pixels[camera] = board_pixels
            self.previous_background_pixels[camera] = background_pixels
            camera_states[camera] = CameraMotionState(
                board_pixels=board_pixels,
                background_pixels=background_pixels,
                dart_pixels=dart_pixels,
                dart_background_pixels=dart_background_pixels,
                takeout_pixels=takeout_pixels,
                takeout_background_pixels=takeout_background_pixels,
                stable=stable,
                hand=hand,
                dart=dart,
                takeout=takeout,
            )
            all_stable.append(stable)
            any_hand.append(hand)
            any_dart.append(dart)
            takeout_votes.append(takeout)

        first_dynamic = self._dynamic(0)
        waiting = self.wait_frames > 0
        candidate_class = self.counters.update(
            darts=self.darts,
            waiting=waiting,
            all_stable=bool(all_stable) and all(all_stable),
            any_hand=any(any_hand),
            any_dart=any(any_dart),
            camera_takeout=takeout_votes,
            stable_num_frames=self.stable_num_frames,
            motion_min_dart_frames=int(
                _configured(first_dynamic, "motionMinDartFrames", 2)
            ),
            takeout_min_hand_frames=int(
                _configured(first_dynamic, "takeoutMinHandFrames", 3)
            ),
            takeout_min_completed_frames=int(
                _configured(first_dynamic, "takeoutMinCompletedFrames", 30)
            ),
        )

        if waiting:
            self.last_stable = self._copy_frames(frames)
            previous = self.wait_frames
            self.wait_frames -= 1
            return MotionUpdate(
                class_id=1 if previous == 1 else 0,
                candidate_class=candidate_class,
                darts=self.darts,
                waiting=True,
                camera_states=camera_states,
            )

        before: dict[int, np.ndarray] | None = None
        after: dict[int, np.ndarray] | None = None
        class_id = candidate_class
        if class_id == 1:
            self.last_stable = self._copy_frames(frames)
        elif class_id == 2:
            before = self._copy_frames(self.last_stable)
            after = self._copy_frames(frames)
            if self.darts == 0:
                self.last_empty = self._copy_frames(self.last_stable)
                small_empty = {
                    camera: self.analyzer.small(self.last_empty[camera])
                    for camera in frames
                }
            self.darts += 1
            self.complete_dart_masks = {
                camera: self.analyzer.raw_diff(
                    camera,
                    small_empty[camera],
                    small_current[camera],
                )
                for camera in frames
            }
            self.last_stable = self._copy_frames(frames)
            self.wait_frames = int(
                _configured(first_dynamic, "detectionWaitFrames", 6)
            )
            self.scheduled_dart_reset = True
        elif class_id == 3:
            self.scheduled_dart_reset = True
        elif class_id == 4:
            self.wait_frames = int(
                _configured(first_dynamic, "takeoutWaitFrames", 10)
            )
            self._reset_after_takeout(frames)

        return MotionUpdate(
            class_id=class_id,
            candidate_class=candidate_class,
            darts=self.darts,
            waiting=False,
            camera_states=camera_states,
            before=before,
            after=after,
        )
