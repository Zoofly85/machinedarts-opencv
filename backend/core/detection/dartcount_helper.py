from __future__ import annotations

import time
from queue import Empty, Full, Queue
from typing import Any, Callable, Optional

import numpy as np

from backend.core.detection_events import publish_detection_event


def handle_dart_detected_side_effects(
    *,
    st: Any,
    diffs: list,
    frames_raw: list,
    background_frames_raw: list,
    burst_frames_raw: list | None,
    movement_started_at: Optional[float],
    detect_capture_ms: float,
    tip_jobs: Queue,
    current_tip_session: Callable[[], int],
    sum_of_2_largest: Callable[[list], float],
    update_detection_insights: Callable[..., None],
    freeze_detection_frames: Callable[..., None],
) -> None:
    """Apply non-state-machine side effects when a dart is detected."""
    top2 = sum_of_2_largest(diffs)
    st.detection_counter += 1
    st.dart_count += 1
    st.last_dart_detection_time = time.perf_counter() * 1000.0
    event_t0 = time.perf_counter()
    event_wall_ts_ms = int(time.time() * 1000)
    movement_to_detect_ms = (
        (event_t0 - float(movement_started_at)) * 1000.0
        if movement_started_at is not None
        else None
    )
    # Freeze the scoring/replay snapshot before notifying other listeners so
    # downstream event work cannot delay the captured frame.
    snapshot_frames = [f.copy() if isinstance(f, np.ndarray) else None for f in frames_raw]
    background_frames = list(background_frames_raw or [])
    burst_frames = [
        [f.copy() if isinstance(f, np.ndarray) else None for f in burst]
        for burst in (burst_frames_raw or [])
        if isinstance(burst, (list, tuple))
    ]
    snapshot_masks = [m.copy() if isinstance(m, np.ndarray) else None for m in getattr(st, "masks", [])]
    freeze_detection_frames(snapshot_frames, frames_are_copied=True)
    update_detection_insights(
        result_of_last_detection="dart_detected",
        start_detect_dart_value=round(top2, 6),
        darts_on_board=st.dart_count,
        detection_counter=st.detection_counter,
    )
    job = {
        "frames": snapshot_frames,
        "background_frames": background_frames,
        "burst_frames": burst_frames,
        "masks": snapshot_masks,
        "event_t0": event_t0,
        "movement_started_at": movement_started_at,
        "movement_to_detect_ms": movement_to_detect_ms,
        "detect_capture_ms": float(detect_capture_ms or 0.0),
        "event_wall_ts_ms": event_wall_ts_ms,
        "session": current_tip_session(),
        "dart_index": st.dart_count,
    }
    try:
        tip_jobs.put_nowait(job)
    except Full:
        try:
            tip_jobs.get_nowait()
            tip_jobs.task_done()
        except Empty:
            pass
        try:
            tip_jobs.put_nowait(job)
        except Full:
            print("[WARN] OpenCV scoring queue full; dropping scoring job")

    print(f"[DART] #{st.detection_counter} detected; darts on board: {st.dart_count}/3")
    publish_detection_event(
        {
            "type": "dart_detected",
            "detection_counter": st.detection_counter,
            "darts_on_board": st.dart_count,
            "ts_ms": event_wall_ts_ms,
            "movement_to_detect_ms": round(movement_to_detect_ms, 2) if movement_to_detect_ms is not None else None,
            "detect_capture_ms": round(float(detect_capture_ms or 0.0), 2),
        }
    )

    if st.dart_count >= 3:
        print("[DART] Max darts reached - wait for takeout")


def process_tip_score_job(
    *,
    job: dict,
    current_tip_session: Callable[[], int],
    tip_scorer: Any,
    update_detection_insights: Callable[..., None],
    record_round_dart_result: Callable[..., None],
) -> None:
    """Process one queued OpenCV scoring job and publish corresponding events."""
    job_session = int(job.get("session", -1))
    if job_session != current_tip_session():
        return

    proc_t0 = time.perf_counter()
    tip_result = tip_scorer.score_masks(
        job.get("masks") or [],
        dart_index=int(job.get("dart_index", 0)),
        frames=job.get("frames") or [],
        background_frames=job.get("background_frames") or [],
    )
    proc_ms = (time.perf_counter() - proc_t0) * 1000.0
    total_ms = (time.perf_counter() - float(job["event_t0"])) * 1000.0
    queue_wait_ms = (proc_t0 - float(job["event_t0"])) * 1000.0
    movement_started_at = job.get("movement_started_at")
    hit_to_score_ms = (
        (time.perf_counter() - float(movement_started_at)) * 1000.0
        if movement_started_at is not None
        else None
    )

    if job_session != current_tip_session():
        return

    timings = tip_result.get("timings", {}) if isinstance(tip_result.get("timings"), dict) else {}
    timing_bits = []
    for key, label in (
        ("extract_masks_ms", "extract"),
        ("bridge_mask_ms", "bridge"),
        ("bridged_score_ms", "bridged"),
        ("raw_score_ms", "raw"),
        ("pure_lab_mask_ms", "labmask"),
        ("pure_lab_score_ms", "labscore"),
        ("selection_ms", "select"),
        ("result_build_ms", "build"),
    ):
        if key in timings:
            try:
                timing_bits.append(f"{label}={float(timings.get(key) or 0.0):.1f}")
            except Exception:
                pass
    timing_suffix = f", {' '.join(timing_bits)}" if timing_bits else ""
    detect_suffix = (
        f", detect={float(job.get('movement_to_detect_ms') or 0.0):.1f}"
        f" capture={float(job.get('detect_capture_ms') or 0.0):.1f}"
        f" queue={queue_wait_ms:.1f}"
        + (f" hit_to_score={hit_to_score_ms:.1f}" if hit_to_score_ms is not None else "")
    )

    if bool(tip_result.get("ok")):
        selected_new_tips = tip_result.get("selected_new_tips", [])
        if selected_new_tips:
            tip_scorer.commit_tracked_tips(selected_new_tips)
        active_model_id = str(tip_result.get("active_model_id", "") or "unknown")
        voted_score = tip_result.get("voted_score", {})
        voted_value = int(tip_result.get("voted_score_value", 0))
        votes = int(tip_result.get("votes", 0))
        miss_reason = str(tip_result.get("miss_reason") or "").strip() or None
        candidates = tip_result.get("candidates", [])
        dart_index = int(job.get("dart_index", 0))
        miss_suffix = f", miss_reason={miss_reason}" if miss_reason else ""
        print(
            f"[OPENCV] score -> {voted_value} "
            f"(votes={votes}, zone={voted_score.get('zone', '-')}, "
            f"proc={proc_ms:.2f} ms, total={total_ms:.2f} ms{detect_suffix}{timing_suffix}{miss_suffix})"
        )

        if dart_index > 0:
            record_round_dart_result(
                dart_index=dart_index,
                active_model_id=active_model_id,
                voted_score_value=voted_value,
                voted_score=voted_score,
                votes=votes,
                candidates=candidates if isinstance(candidates, list) else [],
                frames=job.get("frames", []),
                background_frames=job.get("background_frames", []),
                burst_frames=job.get("burst_frames", []),
                masks=job.get("masks", []),
                opencv_result=tip_result.get("opencv_result"),
                scoring_timings=timings,
                processing_ms=proc_ms,
                total_ms=total_ms,
                miss_reason=miss_reason,
                frames_are_owned=True,
                background_frames_are_owned=True,
                ts_ms=int(job.get("event_wall_ts_ms", int(time.time() * 1000)) or int(time.time() * 1000)),
            )

        update_detection_insights(
            last_voted_score=voted_value,
            last_votes=votes,
            last_tip_scoring_ms=round(proc_ms, 2),
            last_tip_preprocess_ms=timings.get("preprocess_ms"),
            last_tip_inference_ms=timings.get("inference_ms"),
            last_tip_decode_ms=timings.get("decode_ms"),
            last_tip_selection_ms=timings.get("selection_ms"),
            last_tip_calibration_ms=timings.get("calibration_ms"),
            last_tip_vote_ms=timings.get("vote_ms"),
            last_tip_total_ms=timings.get("total_ms"),
            last_miss_reason=miss_reason,
        )
        publish_detection_event(
            {
                "type": "dart_score",
                "dart_index": dart_index,
                "score_value": voted_value,
                "score": voted_score,
                "votes": votes,
                "miss_reason": miss_reason,
                "active_model_id": active_model_id,
                "processing_ms": round(proc_ms, 2),
                "total_ms": round(total_ms, 2),
                "timings": timings,
            }
        )
        return

    reason = str(tip_result.get("reason", "unknown"))
    print(
        f"[OPENCV] score unavailable "
        f"({reason}, proc={proc_ms:.2f} ms, total={total_ms:.2f} ms{detect_suffix}{timing_suffix})"
    )
    update_detection_insights(
        last_tip_scoring_ms=round(proc_ms, 2),
        last_tip_preprocess_ms=timings.get("preprocess_ms"),
        last_tip_inference_ms=timings.get("inference_ms"),
        last_tip_decode_ms=timings.get("decode_ms"),
        last_tip_selection_ms=timings.get("selection_ms"),
        last_tip_calibration_ms=timings.get("calibration_ms"),
        last_tip_vote_ms=timings.get("vote_ms"),
        last_tip_total_ms=timings.get("total_ms"),
    )
    publish_detection_event(
        {
            "type": "dart_score_unavailable",
            "reason": reason,
            "processing_ms": round(proc_ms, 2),
            "total_ms": round(total_ms, 2),
            "timings": timings,
        }
    )


def perform_takeout_reset_side_effects(
    *,
    st: Any,
    frames: list,
    frames_gray: list,
    frames_raw: list,
    raw_last_frame_imgs: list,
    raw_before_movement_imgs: list,
    raw_empty_imgs: list,
    tip_scorer: Any,
    bump_tip_session: Callable[[], int],
    clear_tip_jobs: Callable[[], None],
    publish_event: bool,
    clear_frozen_detection_frames: Callable[[], None],
    clear_round_dart_history: Callable[[], None],
) -> None:
    """Apply non-state-machine side effects when takeout reset completes."""
    st.reset_all(frames, frames_gray)
    raw_last_frame_imgs[:] = list(frames_raw)
    raw_before_movement_imgs[:] = list(frames_raw)
    raw_empty_imgs[:] = list(frames_raw)
    clear_frozen_detection_frames()
    clear_round_dart_history()
    tip_scorer.reset_tracks()
    bump_tip_session()
    clear_tip_jobs()
    if publish_event:
        publish_detection_event({"type": "takeout_complete"})
