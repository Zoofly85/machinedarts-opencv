from __future__ import annotations

import sys
from queue import Queue
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.core.detection import dartcounter


def _blank_frames(num_cams: int, size: int = 100) -> tuple[list[np.ndarray], list[np.ndarray], list[np.ndarray]]:
    raw = [np.zeros((size, size, 3), dtype=np.uint8) for _ in range(num_cams)]
    gray = [np.zeros((size, size), dtype=np.uint8) for _ in range(num_cams)]
    processed = [frame.copy() for frame in raw]
    return processed, gray, raw


def _dart_frames(num_cams: int, size: int = 100) -> tuple[list[np.ndarray], list[np.ndarray], list[np.ndarray]]:
    processed, gray, raw = _blank_frames(num_cams, size=size)
    for cam_idx in (0, 1):
        raw[cam_idx][20:30, 20:30] = 255
        processed[cam_idx][20:30, 20:30] = 255
        gray[cam_idx][20:30, 20:30] = 255
    return processed, gray, raw


def main() -> None:
    num_cams = 3
    baseline_frames, baseline_gray, baseline_raw = _blank_frames(num_cams)
    dart_frames, dart_gray, dart_raw = _dart_frames(num_cams)
    raw_before = list(baseline_raw)
    raw_last = list(baseline_raw)
    tip_jobs: Queue = Queue(maxsize=4)

    st = dartcounter.DetectState(num_cams=num_cams)
    st.state = "no_movement"
    st.before_movement_imgs = baseline_frames
    st.before_movement_grays = baseline_gray
    st.last_frame_imgs = baseline_frames
    st.last_frame_grays = baseline_gray
    st.empty_imgs = baseline_frames
    st.empty_grays = baseline_gray

    threshold_u8 = int(dartcounter.DIFF_THRESHOLD * 255)
    threshold_log_last = 0.0

    threshold_log_last = dartcounter._handle_no_movement_state(
        st=st,
        frames=dart_frames,
        frames_gray=dart_gray,
        frames_raw=dart_raw,
        diff_threshold_u8=threshold_u8,
        now_loop=0.0,
        threshold_log_last=threshold_log_last,
        raw_before_movement_imgs=raw_before,
        raw_last_frame_imgs=raw_last,
    )
    assert st.state == "movement", f"expected movement state, got {st.state!r}"
    assert tip_jobs.empty(), "scoring should not queue at movement start"

    threshold_log_last = dartcounter._handle_movement_state(
        st=st,
        frames=dart_frames,
        frames_gray=dart_gray,
        frames_raw=dart_raw,
        diff_threshold_u8=threshold_u8,
        threshold_log_last=threshold_log_last,
        raw_before_movement_imgs=raw_before,
        raw_last_frame_imgs=raw_last,
        tip_jobs=tip_jobs,
        current_tip_session=lambda: 1,
    )
    assert st.stable_end_frames == 0, "first live-motion frame should not count as settled"
    assert tip_jobs.empty(), "scoring should not queue while live motion is still present"

    for stable_frame in range(1, dartcounter.STABLE_END_FRAMES_FOR_DETECT):
        threshold_log_last = dartcounter._handle_movement_state(
            st=st,
            frames=dart_frames,
            frames_gray=dart_gray,
            frames_raw=dart_raw,
            diff_threshold_u8=threshold_u8,
            threshold_log_last=threshold_log_last,
            raw_before_movement_imgs=raw_before,
            raw_last_frame_imgs=raw_last,
            tip_jobs=tip_jobs,
            current_tip_session=lambda: 1,
        )
        assert st.stable_end_frames == stable_frame, (
            f"expected {stable_frame} stable frames, got {st.stable_end_frames}"
        )
        assert tip_jobs.empty(), f"scoring queued too early at stable frame {stable_frame}"

    threshold_log_last = dartcounter._handle_movement_state(
        st=st,
        frames=dart_frames,
        frames_gray=dart_gray,
        frames_raw=dart_raw,
        diff_threshold_u8=threshold_u8,
        threshold_log_last=threshold_log_last,
        raw_before_movement_imgs=raw_before,
        raw_last_frame_imgs=raw_last,
        tip_jobs=tip_jobs,
        current_tip_session=lambda: 1,
    )
    assert st.state == "no_movement", f"expected no_movement after detection, got {st.state!r}"
    assert st.dart_count == 1, f"expected one dart counted, got {st.dart_count}"
    assert tip_jobs.qsize() == 1, f"expected one scoring job, got {tip_jobs.qsize()}"
    job = tip_jobs.get_nowait()
    assert job["dart_index"] == 1, f"expected dart_index 1, got {job['dart_index']}"
    assert len(job["frames"]) == num_cams, f"expected {num_cams} captured frames"

    print(
        "PASS: dartcounter waits for motion to settle and queues scoring only after "
        f"{dartcounter.STABLE_END_FRAMES_FOR_DETECT} stable frames."
    )


if __name__ == "__main__":
    main()
