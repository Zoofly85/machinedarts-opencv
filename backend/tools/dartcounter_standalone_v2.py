#!/usr/bin/env python3
"""Standalone 3-camera dart counter (landing + takeout only).

This tool is intentionally independent from the API/runtime counter so it can be
A/B tested directly from terminal output.
"""

from __future__ import annotations

import argparse
import time
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple

import cv2
import numpy as np

CODE_NEW = 76
CODE_OLD = 152


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Standalone dart counter test runner")
    p.add_argument("--cams", default="0,1,2", help="Camera indices, comma separated (default: 0,1,2)")
    p.add_argument(
        "--replay-files",
        default="",
        help="Comma-separated paths to 3 replay videos (camera_0,camera_1,camera_2).",
    )
    p.add_argument(
        "--replay-no-sleep",
        action="store_true",
        help="Do not rate-limit loop while replaying videos.",
    )
    p.add_argument(
        "--priority-mode",
        choices=["normal", "high"],
        default="normal",
        help="Process priority mode to apply at startup.",
    )
    p.add_argument("--width", type=int, default=1280, help="Processing width (default: 1280)")
    p.add_argument("--height", type=int, default=720, help="Capture height (default: 720)")
    p.add_argument("--fps", type=int, default=30, help="Capture FPS target (default: 30)")
    p.add_argument("--diff-threshold", type=float, default=0.15, help="Absdiff threshold 0..1 (default: 0.15)")
    p.add_argument("--move-threshold", type=float, default=0.001, help="Movement threshold (default: 0.001)")
    p.add_argument("--single-cam-strong", type=float, default=0.001, help="Single-cam strong movement threshold (default: 0.002)")
    p.add_argument("--remove-start", type=float, default=0.03, help="Takeout start threshold (default: 0.03)")
    p.add_argument("--remove-finish", type=float, default=0.40, help="Takeout finish ratio threshold (default: 0.40)")
    p.add_argument("--cooldown-ms", type=int, default=350, help="Detection cooldown ms (default: 350)")
    p.add_argument(
        "--threshold-logs",
        action="store_true",
        default=True,
        help="Print threshold debug logs (default: on)",
    )
    p.add_argument(
        "--no-threshold-logs",
        dest="threshold_logs",
        action="store_false",
        help="Disable threshold debug logs",
    )
    return p.parse_args()


def resize_to_width(img: np.ndarray, width: int) -> np.ndarray:
    h, w = img.shape[:2]
    if w == width:
        return img
    scale = width / float(w)
    target_h = max(1, int(round(h * scale)))
    interp = cv2.INTER_AREA if width < w else cv2.INTER_LINEAR
    return cv2.resize(img, (width, target_h), interpolation=interp)


def fast_absdiff_gray(gray_a: np.ndarray, gray_b: np.ndarray, threshold_u8: int) -> Tuple[float, np.ndarray]:
    diff = cv2.absdiff(gray_a, gray_b)
    mask = diff > threshold_u8
    percent = float(np.count_nonzero(mask)) / float(mask.size)
    return percent, mask


def sum_of_2_smallest(diff_list: List[dict]) -> float:
    vals = sorted(float(d["percent"]) for d in diff_list)
    if not vals:
        return 0.0
    if len(vals) == 1:
        return vals[0]
    return vals[0] + vals[1]


def sum_of_2_largest(diff_list: List[dict]) -> float:
    vals = sorted((float(d["percent"]) for d in diff_list), reverse=True)
    if not vals:
        return 0.0
    if len(vals) == 1:
        return vals[0]
    return vals[0] + vals[1]


def second_largest(values: List[float]) -> float:
    if not values:
        return 0.0
    vals = sorted(values, reverse=True)
    if len(vals) == 1:
        return vals[0]
    return vals[1]


def set_mask_to_background(mask_u8: Optional[np.ndarray]) -> None:
    if mask_u8 is not None:
        mask_u8[mask_u8 == CODE_NEW] = CODE_OLD


def build_mask_from_diff(diff_mask_bool: np.ndarray, prev_mask_u8: Optional[np.ndarray]) -> np.ndarray:
    h, w = diff_mask_bool.shape[:2]
    out = np.zeros((h, w), dtype=np.uint8)
    if prev_mask_u8 is not None:
        prev_fg = (prev_mask_u8 == CODE_NEW) | (prev_mask_u8 == CODE_OLD)
        out[prev_fg] = CODE_OLD
    out[diff_mask_bool & (out == 0)] = CODE_NEW
    return out


def calculate_mask_ratios_and_foregrounds(diff_list: List[dict], masks: List[Optional[np.ndarray]]) -> Tuple[List[float], List[int]]:
    ratios = [0.0] * len(masks)
    mask_foregrounds = [0] * len(masks)
    for i in range(len(masks)):
        diff = diff_list[i]["mask"]
        mask = masks[i]
        if mask is None:
            continue
        mask_fg = (mask == CODE_NEW) | (mask == CODE_OLD)
        mask_foregrounds[i] = int(mask_fg.sum())
        if mask_foregrounds[i] > 0:
            common = int((diff & mask_fg).sum())
            ratios[i] = float(common) / float(mask_foregrounds[i])
    return ratios, mask_foregrounds


@dataclass
class CounterState:
    num_cams: int
    state: str = "init"
    dart_count: int = 0
    detection_counter: int = 0
    movement_frame_before: Optional[List[float]] = None
    before_grays: Optional[List[np.ndarray]] = None
    last_grays: Optional[List[np.ndarray]] = None
    masks: Optional[List[Optional[np.ndarray]]] = None
    last_dart_detection_time_ms: Optional[float] = None
    remove_delay_start_ms: Optional[float] = None
    remove_started_value: Optional[float] = None
    takeout_armed: bool = False

    def __post_init__(self) -> None:
        self.movement_frame_before = [0.0] * self.num_cams
        self.masks = [None] * self.num_cams

    def is_movement(self, diffs: List[dict], move_threshold: float) -> bool:
        moves = [float(d["percent"]) for d in diffs]
        no_move = [
            abs(moves[i] - self.movement_frame_before[i]) < (move_threshold / 2.0)
            for i in range(self.num_cams)
        ]
        if all(no_move):
            return False
        self.movement_frame_before = moves
        return True

    def reset_all(self, grays: List[np.ndarray]) -> None:
        self.masks = [None] * self.num_cams
        self.dart_count = 0
        # Grayscale frames are immutable snapshots for this loop; keep references
        # to avoid extra per-frame memcpy churn during reset.
        self.before_grays = grays
        self.last_grays = grays
        self.remove_delay_start_ms = None
        self.remove_started_value = None
        self.takeout_armed = False
        print("[RESET] masks cleared; dart_count=0")


class StandaloneDartCounter:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.cam_indices = [int(x.strip()) for x in args.cams.split(",") if x.strip()]
        self.replay_files = [x.strip() for x in str(args.replay_files).split(",") if x.strip()]
        if self.replay_files and len(self.replay_files) != 3:
            raise ValueError("Please provide exactly 3 replay files in --replay-files.")
        if not self.replay_files and len(self.cam_indices) != 3:
            raise ValueError("Please provide exactly 3 camera indices, e.g. --cams 0,1,2")
        self.caps: List[cv2.VideoCapture] = []
        self.is_replay = bool(self.replay_files)

    def _apply_priority(self) -> None:
        try:
            from backend.core.process_priority import apply_process_priority

            res = apply_process_priority(self.args.priority_mode)
            print(
                f"[runtime] process_priority requested={res.get('requested')} "
                f"applied={res.get('applied')} ok={res.get('ok')}"
            )
        except Exception as exc:
            print(f"[runtime] process_priority apply skipped: {exc}")

    def _open_cameras(self) -> None:
        if self.is_replay:
            for p in self.replay_files:
                rp = str(Path(p).expanduser().resolve())
                cap = cv2.VideoCapture(rp)
                if not cap.isOpened():
                    raise RuntimeError(f"Failed to open replay file: {rp}")
                print(f"Opened replay: {rp}")
                self.caps.append(cap)
            print("[REPLAY] enabled")
            return

        for idx in self.cam_indices:
            cap = cv2.VideoCapture(idx, cv2.CAP_DSHOW)
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, float(self.args.width))
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, float(self.args.height))
            cap.set(cv2.CAP_PROP_FPS, float(self.args.fps))
            cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
            if not cap.isOpened():
                raise RuntimeError(f"Failed to open camera {idx}")
            print(f"Opened camera {idx} (DSHOW MJPG {self.args.width}x{self.args.height}@{self.args.fps})")
            self.caps.append(cap)

    def _read_frames(self) -> Optional[List[np.ndarray]]:
        frames: List[np.ndarray] = []
        for cap in self.caps:
            ok, frame = cap.read()
            if not ok or frame is None:
                return None
            frames.append(frame)
        return frames

    def run(self) -> None:
        self._apply_priority()
        self._open_cameras()
        st = CounterState(num_cams=len(self.caps))

        print("\nStandalone Dart Counter")
        print(f"  cams={self.cam_indices} process_width={self.args.width}")
        print(
            "  thresholds: "
            f"move={self.args.move_threshold:.6f} "
            f"single_cam_strong={self.args.single_cam_strong:.4f} "
            f"remove_start={self.args.remove_start:.4f} "
            f"remove_finish={self.args.remove_finish:.3f} "
            f"diff={self.args.diff_threshold:.3f}"
        )
        print("  Ctrl+C to stop\n")

        diff_threshold_u8 = int(max(1, min(255, round(self.args.diff_threshold * 255.0))))
        frames_counted = 0
        t_fps = time.perf_counter()
        threshold_log_last = 0.0

        try:
            while True:
                loop_start = time.perf_counter()
                frames_raw = self._read_frames()
                if frames_raw is None:
                    if self.is_replay:
                        print("[REPLAY] complete")
                        break
                    print("[WARN] Frame read failed; retrying...")
                    time.sleep(0.01)
                    continue

                frames = [resize_to_width(f, self.args.width) for f in frames_raw]
                grays = [cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in frames]

                if st.state == "init":
                    st.before_grays = grays
                    st.last_grays = grays
                    st.state = "no_movement"

                state_before = st.state

                if st.state == "no_movement":
                    diffs = []
                    for i in range(st.num_cams):
                        p, m = fast_absdiff_gray(grays[i], st.before_grays[i], diff_threshold_u8)
                        diffs.append({"percent": p, "mask": m})

                    now = time.perf_counter()
                    if self.args.threshold_logs and (now - threshold_log_last) >= 2.0:
                        perc = [float(d["percent"]) for d in diffs]
                        print(
                            f"[thr] state=no_movement max={max(perc):.4f} top2={sum_of_2_largest(diffs):.4f} "
                            f"move_thr={self.args.move_threshold:.6f} single_cam_strong={self.args.single_cam_strong:.4f} "
                            f"remove_start={self.args.remove_start:.4f} remove_finish={self.args.remove_finish:.3f}"
                        )
                        threshold_log_last = now

                    cond = [float(d["percent"]) > (self.args.move_threshold / 2.0) for d in diffs]
                    at_least_two = sum(cond) >= 2
                    one_cam_strong = max((float(d["percent"]) for d in diffs), default=0.0) >= self.args.single_cam_strong

                    if at_least_two or one_cam_strong:
                        st.movement_frame_before = [float(d["percent"]) for d in diffs]
                        st.state = "movement"
                    else:
                        st.before_grays = st.last_grays
                        st.last_grays = grays

                elif st.state == "movement":
                    diffs = []
                    for i in range(st.num_cams):
                        p, m = fast_absdiff_gray(grays[i], st.before_grays[i], diff_threshold_u8)
                        diffs.append({"percent": p, "mask": m})

                    remove_start_value = sum_of_2_smallest(diffs)
                    remove_started = remove_start_value > self.args.remove_start

                    if remove_started:
                        st.remove_started_value = remove_start_value
                        st.takeout_armed = True
                        st.state = "removing_darts"
                    else:
                        largest2 = sum_of_2_largest(diffs)
                        movement_ended = not st.is_movement(diffs, self.args.move_threshold)
                        if movement_ended:
                            st.before_grays = grays
                            st.last_grays = grays
                            now_ms = time.perf_counter() * 1000.0
                            cooldown_ok = (
                                st.last_dart_detection_time_ms is None
                                or (now_ms - st.last_dart_detection_time_ms) >= float(self.args.cooldown_ms)
                            )
                            if largest2 < self.args.move_threshold or not cooldown_ok:
                                st.state = "no_movement"
                            else:
                                for i in range(st.num_cams):
                                    if st.masks[i] is not None:
                                        set_mask_to_background(st.masks[i])
                                for i in range(st.num_cams):
                                    st.masks[i] = build_mask_from_diff(diffs[i]["mask"], st.masks[i])

                                st.detection_counter += 1
                                st.dart_count = min(3, st.dart_count + 1)
                                st.last_dart_detection_time_ms = now_ms
                                print(f"[DART] #{st.detection_counter} landed; darts_on_board={st.dart_count}/3")
                                if st.dart_count >= 3:
                                    print("[INFO] Max darts reached - waiting for takeout")
                                st.state = "no_movement"

                elif st.state == "removing_darts":
                    diffs = []
                    for i in range(st.num_cams):
                        p, m = fast_absdiff_gray(grays[i], st.before_grays[i], diff_threshold_u8)
                        diffs.append({"percent": p, "mask": m})

                    if st.is_movement(diffs, self.args.move_threshold):
                        pass
                    else:
                        now_ms = time.perf_counter() * 1000.0
                        if st.remove_delay_start_ms is None:
                            st.remove_delay_start_ms = now_ms
                        elif now_ms - st.remove_delay_start_ms < 450:
                            pass
                        else:
                            if st.dart_count <= 0 or all(m is None for m in st.masks):
                                print("[INFO] Takeout ignored (no darts yet)")
                                st.reset_all(grays)
                                st.state = "no_movement"
                            else:
                                ratios, _ = calculate_mask_ratios_and_foregrounds(diffs, st.masks)
                                is_partial = sum(1 for r in ratios if float(r) < self.args.remove_finish) >= 2
                                finish_metric = second_largest([float(r) for r in ratios])
                                if is_partial and st.takeout_armed:
                                    print(f"[TAKEOUT] Partial takeout waiting (finish_metric={finish_metric:.4f})")
                                    st.state = "partial_takeout"
                                else:
                                    print(f"[TAKEOUT] Complete -> reset (finish_metric={finish_metric:.4f})")
                                    st.reset_all(grays)
                                    st.state = "no_movement"
                            st.remove_delay_start_ms = None

                elif st.state == "partial_takeout":
                    if not st.takeout_armed:
                        st.state = "no_movement"
                    else:
                        diffs = []
                        for i in range(st.num_cams):
                            p, m = fast_absdiff_gray(grays[i], st.before_grays[i], diff_threshold_u8)
                            diffs.append({"percent": p, "mask": m})
                        ratios, _ = calculate_mask_ratios_and_foregrounds(diffs, st.masks)
                        is_partial = sum(1 for r in ratios if float(r) < self.args.remove_finish) >= 2
                        if not is_partial:
                            print("[TAKEOUT] Partial finished -> reset")
                            st.reset_all(grays)
                            st.state = "no_movement"

                frames_counted += 1
                if (time.perf_counter() - t_fps) > 2.0:
                    fps_now = frames_counted / (time.perf_counter() - t_fps)
                    print(f"[FPS] {fps_now:.1f} | state={st.state} | darts={st.dart_count}/3")
                    t_fps = time.perf_counter()
                    frames_counted = 0

                if st.state != state_before:
                    print(f"[STATE] {state_before} -> {st.state}")

                if not (self.is_replay and self.args.replay_no_sleep):
                    elapsed = time.perf_counter() - loop_start
                    target_dt = 1.0 / float(max(1, self.args.fps))
                    if elapsed < target_dt:
                        time.sleep(target_dt - elapsed)

        except KeyboardInterrupt:
            print("\nStopping standalone dart counter...")
        finally:
            for cap in self.caps:
                try:
                    cap.release()
                except Exception:
                    pass
            cv2.destroyAllWindows()


def main() -> None:
    args = parse_args()
    runner = StandaloneDartCounter(args)
    runner.run()


if __name__ == "__main__":
    main()
