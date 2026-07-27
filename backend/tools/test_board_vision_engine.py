from __future__ import annotations

import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.core.board_vision.calibration_adapter import dynamic_config
from backend.core.board_vision.geometry import score_point
from backend.core.board_vision.models import CameraVote, IntersectionVote, Segment
from backend.core.board_vision.pipeline import BoardVisionDetector
from backend.core.board_vision.rules import RecoveredMotionCounters


def _motion_update(
    counters: RecoveredMotionCounters,
    *,
    darts: int,
    stable: bool = False,
    hand: bool = False,
    dart: bool = False,
    takeout: tuple[bool, bool, bool] = (False, False, False),
) -> int:
    return counters.update(
        darts=darts,
        waiting=False,
        all_stable=stable,
        any_hand=hand,
        any_dart=dart,
        camera_takeout=takeout,
        stable_num_frames=3,
        motion_min_dart_frames=2,
        takeout_min_hand_frames=3,
        takeout_min_completed_frames=30,
    )


def main() -> None:
    dynamic = dynamic_config(400)
    assert dynamic["motionMinDartFrames"] == 2
    assert dynamic["takeoutMinCoverage"] == 0.8
    assert dynamic["takeoutMinHandFrames"] == 3
    assert dynamic["takeoutMinCompletedFrames"] == 30

    assert score_point((0.0, 0.0)) == Segment(25, 2, "Bull")
    assert score_point((0.0, 2.0)).multiplier == 0

    single_14 = Segment(14, 1, "Single")
    double_14 = Segment(14, 2, "Double")
    cameras = [
        CameraVote(camera, False, single_14, board_tip=(-0.90, 0.25), error=0.01)
        for camera in range(3)
    ]
    intersections = [
        IntersectionVote(0, 1, False, double_14, (-0.92, 0.25), 0.01, 0.01),
        IntersectionVote(0, 2, False, double_14, (-0.93, 0.24), 0.01, 0.01),
        IntersectionVote(1, 2, False, single_14, (-0.89, 0.25), 0.01, 0.01),
    ]
    segment, method, _coords = BoardVisionDetector._elect(cameras, intersections)
    assert segment == single_14
    assert method == "CameraConsensus"

    counters = RecoveredMotionCounters()
    assert _motion_update(counters, darts=0, dart=True) == 0
    assert _motion_update(counters, darts=0, dart=True) == 0
    assert _motion_update(counters, darts=0, stable=True) == 0
    assert _motion_update(counters, darts=0, stable=True) == 0
    assert _motion_update(counters, darts=0, stable=True) == 2

    counters.apply_scheduled_dart_reset()
    assert _motion_update(counters, darts=1, hand=True) == 0
    assert _motion_update(counters, darts=1, hand=True) == 0
    assert _motion_update(counters, darts=1, hand=True) == 3
    assert _motion_update(counters, darts=1, takeout=(True, True, True)) == 4

    print(
        "PASS: Board Vision scoring election and dart/takeout lifecycle "
        "remain deterministic without loading runtime data."
    )


if __name__ == "__main__":
    main()
