from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence


def per_camera_hand(
    *,
    board_pixels: int,
    background_pixels: int,
    dart_pixels: int,
    dart_background_pixels: int,
    takeout_pixels: int,
    takeout_background_pixels: int,
    hand_frames_reached: bool,
    min_foreground_pixels: int,
    min_background_pixels: int,
) -> bool:
    board = int(board_pixels)
    background = int(background_pixels)
    if bool(hand_frames_reached):
        board -= int(dart_pixels) - int(takeout_pixels)
        background -= int(dart_background_pixels) - int(takeout_background_pixels)
    return board >= int(min_foreground_pixels) and background >= int(min_background_pixels)


def per_camera_dart(
    *,
    board_pixels: int,
    is_hand: bool,
    hand_frames_reached: bool,
    darts: int,
    min_dart_pixels: int,
) -> bool:
    return (
        not bool(is_hand)
        and not bool(hand_frames_reached)
        and int(darts) != 3
        and int(board_pixels) >= int(min_dart_pixels)
    )


def per_camera_stable(
    *,
    board_pixels: int,
    previous_board_pixels: int,
    background_pixels: int,
    previous_background_pixels: int,
    min_change: int,
    takeout_frames_reached: bool,
    takeout_stable_multiplier: int,
) -> bool:
    threshold = int(min_change)
    if bool(takeout_frames_reached):
        threshold *= int(takeout_stable_multiplier)
    return (
        abs(int(board_pixels) - int(previous_board_pixels)) < threshold
        and abs(int(background_pixels) - int(previous_background_pixels)) < threshold * 2
    )


def per_camera_takeout(
    *,
    hand_frames_reached: bool,
    dart_pixels: int,
    takeout_pixels: int,
    min_coverage: float,
) -> bool:
    if not bool(hand_frames_reached):
        return False
    if int(dart_pixels) == 0:
        return True
    removed_fraction = 1.0 - float(takeout_pixels) / float(dart_pixels)
    return removed_fraction >= float(min_coverage)


def is_bouncer(*, new_pixels: int, moved_pixels: int, min_new_pixels: int, min_new_ratio: float) -> bool:
    changed_pixels = int(new_pixels) + int(moved_pixels)
    if changed_pixels < int(min_new_pixels):
        return True
    return float(new_pixels) / float(changed_pixels) < float(min_new_ratio)


def classify_motion(
    *,
    darts: int,
    is_dart: bool,
    is_hand: bool,
    is_takeout_full: bool,
    stable_frames: int,
    hand_frames: int,
    dart_frames_reached: bool,
    hand_frames_reached: bool,
    takeout_frames_reached: bool,
    stable_num_frames: int,
    takeout_min_hand_frames: int,
) -> int:
    class_hand = not hand_frames_reached and (
        (int(darts) == 3 and int(hand_frames) == 1)
        or int(hand_frames) == int(takeout_min_hand_frames)
    )
    if class_hand:
        return 3
    class_takeout = int(darts) != 0 and (
        (bool(is_takeout_full) and bool(hand_frames_reached) and not bool(is_hand))
        or (bool(takeout_frames_reached) and int(stable_frames) >= int(stable_num_frames))
    )
    if class_takeout:
        return 4
    class_dart = (
        not bool(hand_frames_reached)
        and bool(dart_frames_reached)
        and int(stable_frames) >= int(stable_num_frames)
    )
    if class_dart:
        return 2
    class_stable = (
        int(stable_frames) >= int(stable_num_frames)
        and not bool(hand_frames_reached)
        and not bool(is_dart)
        and not bool(is_hand)
    )
    return 1 if class_stable else 0


@dataclass
class RecoveredMotionCounters:
    stable_frames: int = 0
    dart_frames: int = 0
    hand_frames: int = 0
    takeout_frames: int = 0
    dart_frames_reached: bool = False
    hand_frames_reached: bool = False
    takeout_frames_reached: bool = False

    def apply_scheduled_dart_reset(self) -> None:
        self.dart_frames = 0
        self.dart_frames_reached = False

    def apply_scheduled_full_reset(self) -> None:
        self.dart_frames = 0
        self.hand_frames = 0
        self.takeout_frames = 0
        self.dart_frames_reached = False
        self.hand_frames_reached = False
        self.takeout_frames_reached = False

    def update(
        self,
        *,
        darts: int,
        waiting: bool,
        all_stable: bool,
        any_hand: bool,
        any_dart: bool,
        camera_takeout: Sequence[bool],
        stable_num_frames: int,
        motion_min_dart_frames: int,
        takeout_min_hand_frames: int,
        takeout_min_completed_frames: int,
    ) -> int:
        stable_limit = int(stable_num_frames)
        if bool(all_stable):
            self.stable_frames = min(self.stable_frames + 1, stable_limit)
        else:
            self.stable_frames = 0
        is_hand = False
        is_dart = False
        is_takeout_partial = False
        is_takeout_full = False
        votes = [bool(value) for value in camera_takeout]
        if not bool(waiting):
            is_hand = bool(any_hand)
            is_dart = not is_hand and bool(any_dart)
            is_takeout_partial = sum(votes) >= 2
            is_takeout_full = bool(votes) and all(votes)
            self.hand_frames = self.hand_frames + 1 if is_hand else 0
            self.dart_frames = self.dart_frames + 1 if is_dart else 0
            self.takeout_frames = self.takeout_frames + 1 if is_takeout_partial else 0
        class_id = classify_motion(
            darts=int(darts),
            is_dart=is_dart,
            is_hand=is_hand,
            is_takeout_full=is_takeout_full,
            stable_frames=self.stable_frames,
            hand_frames=self.hand_frames,
            dart_frames_reached=self.dart_frames_reached,
            hand_frames_reached=self.hand_frames_reached,
            takeout_frames_reached=self.takeout_frames_reached,
            stable_num_frames=stable_limit,
            takeout_min_hand_frames=int(takeout_min_hand_frames),
        )
        if not bool(waiting):
            if int(darts) < 3 and self.dart_frames == int(motion_min_dart_frames):
                self.dart_frames_reached = True
            if (int(darts) == 3 and self.hand_frames == 1) or self.hand_frames == int(takeout_min_hand_frames):
                self.hand_frames_reached = True
            if self.takeout_frames == int(takeout_min_completed_frames):
                self.takeout_frames_reached = True
        return class_id
