#!/usr/bin/env python3
# Slim 3-dart detector: headless, no saving, minimal deps (OpenCV + NumPy)

import cv2
import numpy as np
import time
from dataclasses import dataclass
from typing import List, Optional, Tuple

# =========================
# Basic Configuration
# =========================
CAMERA_INDICES = [0, 1, 2]      # Use [0], [0,1], or [0,1,2]
RES_W, RES_H = 1080, 720        # Lower to (480,360) for weaker devices
FPS = 30                        # 20–30 is fine
PROCESS_WIDTH = 1280             # Downscale width for processing
WARMUP_MS = 800                 # allow camera auto-exposure to settle
SKIP_EVERY_OTHER_FRAME = False  # True -> halves processing load

# Thresholds (grayscale absdiff)
MOVEMENT_THRESHOLD = 0.001
DIFF_THRESHOLD = 0.25
REMOVE_DARTS_START = 0.03
REMOVE_DARTS_FINISH = 0.40
DIRECT_TAKEOUT_THRESHOLD = 0.80
REMOVE_DARTS_MIN_FOREGROUND = 200
DART_DETECTION_COOLDOWN_MS = 350

# Internal mask codes (kept in RAM only)
# 76 marks "fresh change" (new dart this cycle), then we promote to 152 so
# those pixels don't keep counting as new on subsequent frames.
CODE_NEW = 76
CODE_OLD = 152

# =========================
# Helpers
# =========================
def resize_to_width(img, width=PROCESS_WIDTH):
    h, w = img.shape[:2]
    if w == width:
        return img
    scale = width / float(w)
    return cv2.resize(img, (width, max(1, int(round(h * scale)))), interpolation=cv2.INTER_AREA)

def fast_absdiff_bgr(a: np.ndarray, b: np.ndarray, threshold=DIFF_THRESHOLD) -> Tuple[float, np.ndarray]:
    """Grayscale absdiff; returns (percent, bool_mask)."""
    gray_a = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY)
    gray_b = cv2.cvtColor(b, cv2.COLOR_BGR2GRAY)
    diff = cv2.absdiff(gray_a, gray_b)
    thr = int(threshold * 255)
    mask = (diff > thr)
    percent = float(np.count_nonzero(mask)) / mask.size
    return percent, mask

def sum_of_2_smallest(diff_list):
    vals = sorted([d["percent"] for d in diff_list])
    if not vals: return 0.0
    if len(vals) == 1: return vals[0]
    return vals[0] + vals[1]

def sum_of_2_largest(diff_list):
    vals = sorted([d["percent"] for d in diff_list], reverse=True)
    if not vals: return 0.0
    if len(vals) == 1: return vals[0]
    return vals[0] + vals[1]

def set_mask_to_background(mask_u8: Optional[np.ndarray]):
    """Promote fresh pixels (76) to old (152) so diffs 'settle' after a dart."""
    if mask_u8 is not None:
        mask_u8[mask_u8 == CODE_NEW] = CODE_OLD

def build_mask_from_diff(diff_mask_bool: np.ndarray, prev_mask_u8: Optional[np.ndarray] = None) -> np.ndarray:
    """
    Build/maintain a 0/76/152 mask from current diff:
    - keep previous foreground as 152 (old)
    - stamp current new diff pixels (not already old) as 76 (new)
    """
    h, w = diff_mask_bool.shape[:2]
    out = np.zeros((h, w), dtype=np.uint8)
    if prev_mask_u8 is not None:
        prev_fg = (prev_mask_u8 == CODE_NEW) | (prev_mask_u8 == CODE_OLD)
        out[prev_fg] = CODE_OLD
    out[diff_mask_bool & (out == 0)] = CODE_NEW
    return out

def calculate_mask_ratios_and_foregrounds(diff_list, masks):
    """Overlap ratio between current diff and existing masks, per camera."""
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
            common = (diff & mask_fg).sum()
            ratios[i] = float(common) / float(mask_foregrounds[i])
    return ratios, mask_foregrounds

def open_cam(idx, width, height, fps):
    """Try DSHOW -> MSMF -> ANY; set MJPG; single buffer to minimize latency."""
    for backend in (cv2.CAP_DSHOW, cv2.CAP_MSMF, cv2.CAP_ANY):
        cap = cv2.VideoCapture(idx, backend)
        if cap.isOpened():
            cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*'MJPG'))
            cap.set(cv2.CAP_PROP_FRAME_WIDTH,  width)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
            cap.set(cv2.CAP_PROP_FPS, fps)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            time.sleep(0.15)
            ok, _ = cap.read()
            if ok:
                print(f"✅ Opened cam {idx} (backend={backend})")
                return cap
            cap.release()
    raise RuntimeError(f"❌ Could not open camera {idx}")

def make_capture(idx):
    return open_cam(idx, RES_W, RES_H, FPS)

def read_or_reopen(idx, cap, reopen_delay=0.4):
    ok, frame = (False, None) if cap is None else cap.read()
    if ok and frame is not None:
        return cap, frame
    if cap is not None:
        cap.release()
    time.sleep(reopen_delay)
    try:
        cap = make_capture(idx)
        ok, frame = cap.read()
        if ok:
            return cap, frame
    except Exception as e:
        print(f"cam {idx} reopen failed: {e}")
    return None, None

# =========================
# State
# =========================
@dataclass
class DetectState:
    num_cams: int
    state: str = "init"
    warmup_done_at: Optional[float] = None

    masks: Optional[List[Optional[np.ndarray]]] = None
    detection_counter: int = 0
    dart_count: int = 0

    before_movement_imgs: Optional[List[Optional[np.ndarray]]] = None
    last_frame_imgs: Optional[List[Optional[np.ndarray]]] = None
    empty_imgs: Optional[List[Optional[np.ndarray]]] = None
    movement_frame_before: Optional[List[float]] = None

    movement_started_at: Optional[float] = None
    remove_delay_start: Optional[float] = None
    last_dart_detection_time: Optional[float] = None

    def __post_init__(self):
        self.masks = [None] * self.num_cams
        self.before_movement_imgs = [None] * self.num_cams
        self.last_frame_imgs = [None] * self.num_cams
        self.empty_imgs = [None] * self.num_cams
        self.movement_frame_before = [0.0] * self.num_cams

    def warmed_up(self):
        now = time.perf_counter() * 1000.0
        if self.warmup_done_at is None:
            self.warmup_done_at = now + WARMUP_MS
            return False
        return now >= self.warmup_done_at

    def is_movement(self, diff_images):
        moves = [float(r["percent"]) for r in diff_images]
        no_move = [
            abs(moves[i] - self.movement_frame_before[i]) < (MOVEMENT_THRESHOLD / 2.0)
            for i in range(self.num_cams)
        ]
        if all(no_move):
            return False
        self.movement_frame_before = moves
        return True

    def is_remove_started(self, diff_images):
        return sum_of_2_smallest(diff_images) > REMOVE_DARTS_START

    def is_direct_takeout(self, diff_images):
        if all(m is None for m in self.masks):
            return False
        ratios, mask_fgs = calculate_mask_ratios_and_foregrounds(diff_images, self.masks)
        if sum(mask_fgs) < REMOVE_DARTS_MIN_FOREGROUND:
            return False
        return sum(1 for r in ratios if r >= DIRECT_TAKEOUT_THRESHOLD) >= 2

    def is_partial_takeout(self, diff_images):
        if all(m is None for m in self.masks):
            return False
        ratios, _ = calculate_mask_ratios_and_foregrounds(diff_images, self.masks)
        return sum(1 for r in ratios if r < REMOVE_DARTS_FINISH) >= 2

    def reset_all(self, imgs):
        self.masks = [None] * self.num_cams
        self.dart_count = 0
        self.empty_imgs = imgs
        self.before_movement_imgs = imgs
        self.last_frame_imgs = imgs
        self.movement_started_at = None
        self.remove_delay_start = None
        self.last_dart_detection_time = None
        print("🔄 Reset: masks cleared; dart count=0")

# =========================
# Main
# =========================
def main():
    print("🚀 Slim Dart Detector (headless)")
    print(f"   Cameras: {CAMERA_INDICES} | Res: {RES_W}x{RES_H}@{FPS} | Process width: {PROCESS_WIDTH}")
    print(f"   Frame skip: {SKIP_EVERY_OTHER_FRAME}")

    caps = [None] * len(CAMERA_INDICES)
    for i, idx in enumerate(CAMERA_INDICES):
        try:
            caps[i] = make_capture(idx)
        except Exception as e:
            print(f"cam {idx} init failed:", e)

    st = DetectState(num_cams=len(CAMERA_INDICES))

    frame_i = 0
    t_fps = time.perf_counter()
    frames_counted = 0

    try:
        while True:
            frame_i += 1
            if SKIP_EVERY_OTHER_FRAME and (frame_i % 2 == 1):
                time.sleep(0.001)

            # Read frames
            frames_raw = []
            failed = []
            for j, idx in enumerate(CAMERA_INDICES):
                caps[j], f = read_or_reopen(idx, caps[j])
                frames_raw.append(f)
                if f is None:
                    failed.append(idx)

            if len(failed) == len(CAMERA_INDICES):
                print("❌ All cameras failed — retrying in 2s...")
                time.sleep(2)
                continue
            elif failed:
                # pad failed cams with black frames (keep array lengths)
                h, w = RES_H, RES_W
                for f in frames_raw:
                    if f is not None:
                        h, w = f.shape[:2]
                        break
                print(f"⚠️ Cameras {failed} failed — padding")
                for j in range(len(CAMERA_INDICES)):
                    if frames_raw[j] is None:
                        frames_raw[j] = np.zeros((h, w, 3), dtype=np.uint8)

            # Normalize to processing width
            frames = [resize_to_width(f, PROCESS_WIDTH) for f in frames_raw]

            # ===== State machine =====
            if st.state == "init":
                st.last_frame_imgs = frames
                st.before_movement_imgs = frames
                st.empty_imgs = frames
                if st.warmed_up():
                    st.state = "no_movement"

            elif st.state == "no_movement":
                diffs = []
                for j in range(st.num_cams):
                    p, m = fast_absdiff_bgr(frames[j], st.before_movement_imgs[j], DIFF_THRESHOLD)
                    diffs.append({"percent": p, "mask": m})

                cond = [d["percent"] > (MOVEMENT_THRESHOLD / 2.0) for d in diffs]
                at_least_two = sum(cond) >= 2

                if at_least_two:
                    if st.dart_count >= 3:
                        large = any(d["percent"] > REMOVE_DARTS_START for d in diffs)
                        if large:
                            st.movement_frame_before = [d["percent"] for d in diffs]
                            st.state = "movement"
                            st.movement_started_at = time.perf_counter()
                        else:
                            st.before_movement_imgs = st.last_frame_imgs
                            st.last_frame_imgs = frames
                    else:
                        st.movement_frame_before = [d["percent"] for d in diffs]
                        st.state = "movement"
                        st.movement_started_at = time.perf_counter()
                else:
                    st.before_movement_imgs = st.last_frame_imgs
                    st.last_frame_imgs = frames

            elif st.state == "movement":
                diffs = []
                for j in range(st.num_cams):
                    p, m = fast_absdiff_bgr(frames[j], st.before_movement_imgs[j], DIFF_THRESHOLD)
                    diffs.append({"percent": p, "mask": m})
                st.last_frame_imgs = frames

                if st.is_remove_started(diffs):
                    st.state = "removing_darts"
                else:
                    largest2 = sum_of_2_largest(diffs)
                    movement_ended = not st.is_movement(diffs)
                    if movement_ended:
                        st.before_movement_imgs = frames
                        if largest2 < MOVEMENT_THRESHOLD:
                            st.state = "no_movement"
                            st.movement_started_at = None
                        else:
                            now_ms = time.perf_counter() * 1000.0
                            # Debounce "settling"
                            if st.last_dart_detection_time is not None and (now_ms - st.last_dart_detection_time < DART_DETECTION_COOLDOWN_MS):
                                st.state = "no_movement"
                                st.movement_started_at = None
                            else:
                                # direct takeout?
                                if st.is_direct_takeout(diffs):
                                    print("🧹 Direct takeout -> reset")
                                    st.reset_all(frames)
                                    st.state = "no_movement"
                                else:
                                    if st.dart_count >= 3:
                                        print("🚫 3 darts already — waiting for removal")
                                        st.state = "no_movement"
                                        st.movement_started_at = None
                                    else:
                                        # Promote last cycle's new(76) -> old(152),
                                        # then stamp current diff as new(76).
                                        for j in range(st.num_cams):
                                            if st.masks[j] is not None:
                                                set_mask_to_background(st.masks[j])
                                        for j in range(st.num_cams):
                                            st.masks[j] = build_mask_from_diff(diffs[j]["mask"], st.masks[j])

                                        st.detection_counter += 1
                                        st.dart_count += 1
                                        st.last_dart_detection_time = now_ms
                                        print(f"🎯 Dart #{st.detection_counter} detected; darts on board: {st.dart_count}/3")
                                        if st.dart_count >= 3:
                                            print("🎯 Max darts reached — wait for takeout")
                                        st.state = "no_movement"

            elif st.state == "removing_darts":
                diffs = []
                for j in range(st.num_cams):
                    p, m = fast_absdiff_bgr(frames[j], st.before_movement_imgs[j], DIFF_THRESHOLD)
                    diffs.append({"percent": p, "mask": m})

                if st.is_movement(diffs):
                    st.last_frame_imgs = frames
                else:
                    now_ms = time.perf_counter() * 1000.0
                    if st.remove_delay_start is None:
                        st.remove_delay_start = now_ms
                    elif now_ms - st.remove_delay_start < 450:
                        pass
                    else:
                        if all(m is None for m in st.masks):
                            print("ℹ️ Takeout ignored (no darts yet)")
                            st.reset_all(frames)
                            st.state = "no_movement"
                        else:
                            if st.is_partial_takeout(diffs):
                                print("🟨 Partial takeout — waiting…")
                                st.state = "partial_takeout"
                            else:
                                print("✅ Takeout complete -> reset")
                                st.reset_all(frames)
                                st.state = "no_movement"
                        st.remove_delay_start = None

            elif st.state == "partial_takeout":
                diffs = []
                for j in range(st.num_cams):
                    p, m = fast_absdiff_bgr(frames[j], st.before_movement_imgs[j], DIFF_THRESHOLD)
                    diffs.append({"percent": p, "mask": m})
                if not st.is_partial_takeout(diffs):
                    print("✅ Partial takeout finished -> reset")
                    st.reset_all(frames)
                    st.state = "no_movement"

            # Headless: periodic heartbeat
            frames_counted += 1
            if (time.perf_counter() - t_fps) > 2.0:
                fps_now = frames_counted / (time.perf_counter() - t_fps)
                print(f"⏱️  {fps_now:.1f} FPS | state={st.state} | darts={st.dart_count}/3")
                t_fps = time.perf_counter()
                frames_counted = 0

    finally:
        for cap in caps:
            if cap:
                cap.release()

if __name__ == "__main__":
    main()