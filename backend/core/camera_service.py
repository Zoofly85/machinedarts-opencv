from __future__ import annotations

import os
import sys
import threading
import time
from dataclasses import dataclass
from typing import Literal

import cv2
import numpy as np

from backend.config.settings import DEFAULT_SCORING_CAMERA_COUNT, is_scoring_camera_slot, settings


@dataclass
class CameraInfo:
    index: int
    slot: int
    opened: bool
    last_frame_ms: int | None
    frame_mean: float | None
    error: str | None
    backend: str | None
    codec: str | None
    width: int | None
    height: int | None
    fps: float | None


class CameraService:
    """Shared camera owner for all pipelines (calibration/detection/streaming)."""

    def __init__(self, indices: list[int] | None = None):
        self.indices = indices or settings.camera_indices
        self._slot_to_index: dict[int, int] = {slot: cam_idx for slot, cam_idx in enumerate(self.indices)}
        self._caps: dict[int, cv2.VideoCapture] = {}
        self._latest_frames: dict[int, np.ndarray | None] = {idx: None for idx in self.indices}
        self._latest_frame_ms: dict[int, int | None] = {idx: None for idx in self.indices}
        self._latest_lock = threading.Lock()
        self._cap_lock = threading.Lock()
        self._switch_lock = threading.RLock()
        self._switching = threading.Event()
        self._running = threading.Event()
        self._threads: dict[int, threading.Thread] = {}
        self._optional_missing_slots: set[int] = set()
        self._slot_errors: dict[int, str] = {}

        # Simple global mode lock so detection and calibration can coordinate.
        self._mode_lock = threading.Lock()
        self._active_mode: Literal["idle", "calibration", "detection"] = "idle"
        self._active_mode_owner: str | None = None

    @staticmethod
    def _platform_name() -> str:
        if sys.platform.startswith("win"):
            return "windows"
        if sys.platform.startswith("linux"):
            return "linux"
        if sys.platform == "darwin":
            return "macos"
        return "other"

    @staticmethod
    def _backend_flag(name: str) -> int | None:
        val = getattr(cv2, name, None)
        if val is None:
            return None
        try:
            return int(val)
        except Exception:
            return None

    def _backend_candidates(self) -> list[int]:
        platform_name = self._platform_name()
        names: list[str]
        if platform_name == "windows":
            names = ["CAP_DSHOW"]
        elif platform_name == "linux":
            names = ["CAP_V4L2", "CAP_ANY"]
        elif platform_name == "macos":
            names = ["CAP_AVFOUNDATION", "CAP_ANY"]
        else:
            names = ["CAP_ANY"]

        out: list[int] = []
        for name in names:
            flag = self._backend_flag(name)
            if flag is not None and flag not in out:
                out.append(flag)
        if not out:
            out.append(int(cv2.CAP_ANY))
        return out

    def _codec_candidates(self) -> list[str | None]:
        platform_name = self._platform_name()
        if platform_name == "windows":
            return ["MJPG"]
        if platform_name == "linux":
            # Linux cams typically expose MJPG/YUYV via V4L2; fallback to driver default.
            return ["MJPG", "YUYV", "UYVY", None]
        if platform_name == "macos":
            return ["MJPG", None]
        return [None]

    def _strict_scoring_camera_open(self, *, required: bool) -> bool:
        if not required:
            return False
        raw = str(
            os.getenv("MACHINE_DARTS_STRICT_CAMERA_OPEN", "")
            or getattr(settings, "strict_camera_open", "")
            or ""
        ).strip().lower()
        if raw in {"1", "true", "yes", "on"}:
            return True
        if self._platform_name() == "windows" and required:
            return True
        return False

    def backend_hint_label(self) -> str:
        platform_name = self._platform_name()
        if platform_name == "windows":
            if self._strict_scoring_camera_open(required=True):
                return "STRICT DSHOW/MJPG"
            return "DSHOW/MSMF/AUTO"
        if platform_name == "linux":
            return "V4L2/AUTO"
        if platform_name == "macos":
            return "AVFOUNDATION/AUTO"
        return "AUTO"

    @staticmethod
    def _backend_name(backend: int) -> str:
        names = {
            int(cv2.CAP_DSHOW): "DSHOW",
            int(cv2.CAP_MSMF): "MSMF",
            int(cv2.CAP_ANY): "AUTO",
            int(getattr(cv2, "CAP_V4L2", -1)): "V4L2",
            int(getattr(cv2, "CAP_AVFOUNDATION", -1)): "AVFOUNDATION",
            int(getattr(cv2, "CAP_FFMPEG", -1)): "FFMPEG",
        }
        return names.get(int(backend), str(int(backend)))

    @staticmethod
    def _fourcc_to_str(value: float | int) -> str:
        try:
            fourcc = int(value)
            chars = [chr((fourcc >> (8 * i)) & 0xFF) for i in range(4)]
            text = "".join(chars).strip("\x00 ").strip()
            return text or "-"
        except Exception:
            return "-"

    def _camera_runtime_info(self, cap: cv2.VideoCapture | None) -> dict[str, int | float | str | None]:
        if cap is None or not cap.isOpened():
            return {
                "backend": None,
                "codec": None,
                "width": None,
                "height": None,
                "fps": None,
            }
        try:
            backend = self._backend_name(int(cap.get(cv2.CAP_PROP_BACKEND)))
        except Exception:
            backend = None
        try:
            codec = self._fourcc_to_str(cap.get(cv2.CAP_PROP_FOURCC))
        except Exception:
            codec = None
        try:
            width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or None
        except Exception:
            width = None
        try:
            height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or None
        except Exception:
            height = None
        try:
            fps = float(cap.get(cv2.CAP_PROP_FPS))
            fps = round(fps, 2) if fps > 0 else None
        except Exception:
            fps = None
        return {
            "backend": backend,
            "codec": codec,
            "width": width,
            "height": height,
            "fps": fps,
        }

    @staticmethod
    def _frame_matches_requested_resolution(frame: np.ndarray | None) -> bool:
        if frame is None:
            return False
        try:
            height, width = frame.shape[:2]
            return int(width) == int(settings.camera_width) and int(height) == int(settings.camera_height)
        except Exception:
            return False

    def _video_capture(self, cam_idx: int, backend: int, codec: str | None) -> cv2.VideoCapture:
        use_constructor_params = (
            self._platform_name() == "windows"
            and self._backend_name(backend) == "DSHOW"
            and bool(codec)
        )
        if use_constructor_params:
            params = [
                int(cv2.CAP_PROP_FOURCC),
                int(cv2.VideoWriter_fourcc(*str(codec))),
                int(cv2.CAP_PROP_FRAME_WIDTH),
                int(settings.camera_width),
                int(cv2.CAP_PROP_FRAME_HEIGHT),
                int(settings.camera_height),
                int(cv2.CAP_PROP_FPS),
                int(settings.camera_fps),
            ]
            try:
                return cv2.VideoCapture(int(cam_idx), int(backend), params)
            except TypeError:
                pass
        return cv2.VideoCapture(int(cam_idx), int(backend))

    def _open_camera(self, cam_idx: int, *, required: bool = True, quiet: bool = False) -> cv2.VideoCapture | None:
        strict_open = self._strict_scoring_camera_open(required=required)
        backend_candidates = self._backend_candidates()
        codec_candidates = self._codec_candidates()
        if strict_open and self._platform_name() == "windows":
            dshow = self._backend_flag("CAP_DSHOW")
            backend_candidates = [dshow] if dshow is not None else []
            codec_candidates = ["MJPG"]

        for backend in backend_candidates:
            for codec in codec_candidates:
                try:
                    cap = self._video_capture(cam_idx, backend, codec)
                except cv2.error as exc:
                    if required and not quiet:
                        print(f"[WARN] Camera {cam_idx} constructor failed with {self._backend_name(backend)}: {exc}")
                    continue
                except Exception as exc:
                    if required and not quiet:
                        print(f"[WARN] Camera {cam_idx} constructor exception with {self._backend_name(backend)}: {exc}")
                    continue
                try:
                    if not cap.isOpened():
                        cap.release()
                        continue

                    configured_in_constructor = (
                        self._platform_name() == "windows"
                        and self._backend_name(backend) == "DSHOW"
                        and bool(codec)
                    )
                    if codec and not configured_in_constructor:
                        try:
                            cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*codec))
                        except Exception:
                            pass
                    if not configured_in_constructor:
                        cap.set(cv2.CAP_PROP_FRAME_WIDTH, settings.camera_width)
                        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, settings.camera_height)
                        cap.set(cv2.CAP_PROP_FPS, settings.camera_fps)
                    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

                    # Allow backend/driver to settle, then probe a few frames.
                    time.sleep(0.06)
                    ok = False
                    frame: np.ndarray | None = None
                    for _ in range(3):
                        ok, frame = cap.read()
                        if ok:
                            break
                        time.sleep(0.02)
                except cv2.error as exc:
                    req_backend = self._backend_name(backend)
                    if required and not quiet:
                        print(f"[WARN] Camera {cam_idx} open failed with {req_backend}/{codec or 'DEFAULT'}: {exc}")
                    try:
                        cap.release()
                    except Exception:
                        pass
                    continue
                except Exception as exc:
                    req_backend = self._backend_name(backend)
                    if required and not quiet:
                        print(f"[WARN] Camera {cam_idx} open exception with {req_backend}/{codec or 'DEFAULT'}: {exc}")
                    try:
                        cap.release()
                    except Exception:
                        pass
                    continue

                info = self._camera_runtime_info(cap)
                req_backend = self._backend_name(backend)
                req_codec = codec or "DEFAULT"
                actual_backend = str(info.get("backend") or "-").upper()
                actual_codec = str(info.get("codec") or "-").upper()
                codec_matches = (not codec) or actual_codec == str(codec).upper()
                backend_matches = actual_backend == req_backend.upper()
                if ok and strict_open and (not backend_matches or not codec_matches):
                    if not quiet:
                        print(
                            f"[WARN] Camera {cam_idx} rejected "
                            f"(strict scoring camera requires {req_backend}/{req_codec}, "
                            f"actual={actual_backend}/{actual_codec})"
                        )
                    cap.release()
                    continue
                if ok and self._frame_matches_requested_resolution(frame):
                    if not quiet:
                        print(
                            f"Opened camera {cam_idx} "
                            f"(requested={req_backend}/{req_codec}, "
                            f"backend={info.get('backend') or '-'}, codec={info.get('codec') or '-'}, "
                            f"res={info.get('width') or '-'}x{info.get('height') or '-'}@{info.get('fps') or '-'})"
                        )
                    return cap
                if ok and not quiet:
                    actual_w = info.get("width") or (int(frame.shape[1]) if isinstance(frame, np.ndarray) else "-")
                    actual_h = info.get("height") or (int(frame.shape[0]) if isinstance(frame, np.ndarray) else "-")
                    print(
                        f"[WARN] Camera {cam_idx} rejected "
                        f"(requested={req_backend}/{req_codec}, "
                        f"actual={actual_w}x{actual_h}, "
                        f"required={settings.camera_width}x{settings.camera_height})"
                    )
                cap.release()
        if required and not quiet:
            strict_suffix = " with strict DSHOW/MJPG" if strict_open and self._platform_name() == "windows" else ""
            print(
                f"[ERROR] Camera {cam_idx} could not open at required "
                f"{settings.camera_width}x{settings.camera_height}{strict_suffix}"
            )
        elif not required and not quiet:
            print(f"[INFO] Optional camera {cam_idx} is not available")
        return None

    def _probe_camera_index(self, cam_idx: int) -> bool:
        cap = self._open_camera(cam_idx, required=False, quiet=True)
        if cap is None:
            return False
        try:
            cap.release()
        except Exception:
            pass
        return True

    def _apply_repaired_camera_mapping_locked(self, *, slot: int, failed_idx: int, replacement: int) -> list[int]:
        repaired = [int(idx) for idx in self.indices]
        repaired[int(slot)] = int(replacement)

        # Optional slots are allowed to be missing, but the saved mapping must
        # remain unique. If the replacement was previously the Player Cam slot,
        # move that optional slot to the old failed index or the next free index.
        used: set[int] = set()
        for idx, value in enumerate(repaired):
            if value not in used:
                used.add(value)
                continue
            fallback = int(failed_idx) if int(failed_idx) not in used else 0
            while fallback in used:
                fallback += 1
            repaired[idx] = fallback
            used.add(fallback)

        self.indices = repaired
        self._slot_to_index = {slot_idx: cam_idx for slot_idx, cam_idx in enumerate(self.indices)}
        with self._latest_lock:
            self._latest_frames = {idx: self._latest_frames.get(idx) for idx in self.indices}
            self._latest_frame_ms = {idx: self._latest_frame_ms.get(idx) for idx in self.indices}
        try:
            from backend.config.settings import set_camera_indices

            set_camera_indices(repaired, persist=True)
        except Exception as exc:
            print(f"[WARN] Could not persist repaired camera mapping {repaired}: {exc}")
        return repaired

    def _repair_scoring_slot_index_locked(self, slot: int, failed_idx: int) -> int | None:
        scoring_count = min(DEFAULT_SCORING_CAMERA_COUNT, len(self.indices))
        if slot < 0 or slot >= scoring_count:
            return None
        if self._strict_scoring_camera_open(required=True):
            print(
                f"[camera] Strict scoring camera open failed for slot {slot} device {failed_idx}; "
                "automatic repair disabled. Use Camera Selection to assign a DSHOW/MJPG device."
            )
            return None

        used_scoring = {
            int(self._slot_to_index.get(other_slot, self.indices[other_slot]))
            for other_slot in range(scoring_count)
            if other_slot != slot
        }
        scan_max = max(8, max([int(idx) for idx in self.indices] + [0]) + 5)
        replacement: int | None = None
        for candidate in range(scan_max):
            if candidate in used_scoring:
                continue
            if self._probe_camera_index(candidate):
                replacement = candidate
                break
        if replacement is None or replacement == int(failed_idx):
            return None

        repaired = self._apply_repaired_camera_mapping_locked(
            slot=slot,
            failed_idx=failed_idx,
            replacement=replacement,
        )
        print(
            f"[camera] Repaired scoring slot {slot}: device {failed_idx} was unavailable, "
            f"using device {replacement}. New mapping: {repaired}"
        )
        return replacement

    def start(self) -> None:
        with self._switch_lock:
            self._start_capture_threads_locked()

    def _stop_capture_threads_locked(self) -> None:
        self._switching.set()
        self._running.clear()
        threads = list(self._threads.values())
        for thread in threads:
            thread.join(timeout=0.75)
        self._threads.clear()
        with self._cap_lock:
            for cap in self._caps.values():
                if cap is not None:
                    cap.release()
            self._caps.clear()

    def _start_capture_threads_locked(self) -> None:
        if self._running.is_set():
            return
        self._running.set()
        with self._cap_lock:
            self._slot_errors.clear()
            for slot, idx in list(enumerate(self.indices)):
                if not is_scoring_camera_slot(slot):
                    self._caps[idx] = None
                    continue
                self._start_slot_capture_thread_locked(slot, idx, required=True)

    def _start_slot_capture_thread_locked(self, slot: int, cam_idx: int, *, required: bool) -> None:
        if cam_idx in self._threads:
            return
        if slot in self._optional_missing_slots:
            return
        self._caps[cam_idx] = self._open_camera(cam_idx, required=required)
        if self._caps[cam_idx] is None and required:
            replacement = self._repair_scoring_slot_index_locked(slot, cam_idx)
            if replacement is not None:
                cam_idx = replacement
                if cam_idx in self._threads:
                    return
                self._caps[cam_idx] = self._open_camera(cam_idx, required=required)
        if self._caps[cam_idx] is None and required and self._strict_scoring_camera_open(required=True):
            self._slot_errors[int(slot)] = (
                f"Device {int(cam_idx)} failed strict DSHOW/MJPG open. "
                "Open Camera Selection and assign a valid scoring camera."
            )
            return
        if self._caps[cam_idx] is None and not required:
            self._optional_missing_slots.add(slot)
            return
        thread = threading.Thread(target=self._capture_loop, args=(slot, cam_idx, required), daemon=True)
        self._threads[cam_idx] = thread
        thread.start()

    def _capture_loop(self, slot: int, cam_idx: int, required: bool) -> None:
        last_read_error_log_ms = 0
        while self._running.is_set():
            cap = None
            with self._cap_lock:
                cap = self._caps.get(cam_idx)
                if cap is None:
                    cap = self._open_camera(cam_idx, required=required)
                    self._caps[cam_idx] = cap

            if cap is None:
                if not required:
                    self._optional_missing_slots.add(slot)
                    with self._cap_lock:
                        self._threads.pop(cam_idx, None)
                    return
                if self._strict_scoring_camera_open(required=True):
                    with self._cap_lock:
                        self._slot_errors[int(slot)] = (
                            f"Device {int(cam_idx)} failed strict DSHOW/MJPG open. "
                            "Open Camera Selection and assign a valid scoring camera."
                        )
                        self._threads.pop(cam_idx, None)
                    return
                time.sleep(0.2)
                continue

            try:
                ok, frame = cap.read()
            except cv2.error as exc:
                # Keep capture threads alive on transient OpenCV failures
                # (including occasional OutOfMemory errors from backend drivers).
                now_ms = int(time.time() * 1000)
                if now_ms - last_read_error_log_ms > 2000:
                    print(f"[WARN] Camera {cam_idx} read failed ({exc}); reopening camera")
                    last_read_error_log_ms = now_ms
                ok, frame = False, None
            except Exception as exc:
                now_ms = int(time.time() * 1000)
                if now_ms - last_read_error_log_ms > 2000:
                    print(f"[WARN] Camera {cam_idx} read exception ({exc}); reopening camera")
                    last_read_error_log_ms = now_ms
                ok, frame = False, None
            if ok and frame is not None:
                with self._latest_lock:
                    self._latest_frames[cam_idx] = frame
                    self._latest_frame_ms[cam_idx] = int(time.time() * 1000)
                continue

            with self._cap_lock:
                bad_cap = self._caps.get(cam_idx)
                if bad_cap is not None:
                    bad_cap.release()
                self._caps[cam_idx] = None
            time.sleep(0.1)

    def list_cameras(self) -> list[CameraInfo]:
        self.start()
        with self._cap_lock, self._latest_lock:
            out: list[CameraInfo] = []
            for slot, cam_idx in self._slot_to_index.items():
                cap = self._caps.get(cam_idx)
                opened = cap is not None and cap.isOpened()
                runtime = self._camera_runtime_info(cap)
                frame = self._latest_frames.get(cam_idx)
                frame_mean = None
                if isinstance(frame, np.ndarray) and frame.size > 0:
                    try:
                        frame_mean = round(float(np.mean(frame)), 2)
                    except Exception:
                        frame_mean = None
                out.append(
                    CameraInfo(
                        index=cam_idx,
                        slot=slot,
                        opened=opened,
                        last_frame_ms=self._latest_frame_ms.get(cam_idx),
                        frame_mean=frame_mean,
                        error=self._slot_errors.get(int(slot)),
                        backend=runtime["backend"],
                        codec=runtime["codec"],
                        width=runtime["width"],
                        height=runtime["height"],
                        fps=runtime["fps"],
                    )
                )
            return out

    def get_latest_frame(self, camera_slot: int, copy: bool = True) -> np.ndarray | None:
        if self._switching.is_set():
            return None
        self.start()
        if camera_slot < 0 or camera_slot >= len(self.indices):
            return None
        cam_idx = self._slot_to_index[camera_slot]
        self._ensure_optional_slot_started(camera_slot, cam_idx)
        with self._latest_lock:
            frame = self._latest_frames.get(cam_idx)
            if frame is None:
                return None
            return frame.copy() if copy else frame

    def get_latest_frame_info(self, camera_slot: int, copy: bool = True) -> tuple[np.ndarray | None, int | None]:
        if self._switching.is_set():
            return None, None
        self.start()
        if camera_slot < 0 or camera_slot >= len(self.indices):
            return None, None
        cam_idx = self._slot_to_index[camera_slot]
        self._ensure_optional_slot_started(camera_slot, cam_idx)
        with self._latest_lock:
            frame = self._latest_frames.get(cam_idx)
            ts_ms = self._latest_frame_ms.get(cam_idx)
            if frame is None:
                return None, ts_ms
            return (frame.copy() if copy else frame), ts_ms

    def _ensure_optional_slot_started(self, camera_slot: int, cam_idx: int) -> None:
        if is_scoring_camera_slot(camera_slot):
            return
        with self._cap_lock:
            self._start_slot_capture_thread_locked(camera_slot, cam_idx, required=False)

    def wait_for_frame(self, camera_slot: int, timeout_s: float = 1.0) -> np.ndarray | None:
        deadline = time.perf_counter() + max(0.0, timeout_s)
        while time.perf_counter() < deadline:
            frame = self.get_latest_frame(camera_slot, copy=True)
            if frame is not None:
                return frame
            time.sleep(0.01)
        return None

    def read_frame(self, camera_slot: int) -> np.ndarray | None:
        """Compatibility shim for existing callers."""
        return self.get_latest_frame(camera_slot, copy=True)

    def acquire_mode(self, mode: Literal["calibration", "detection"], owner: str) -> bool:
        with self._mode_lock:
            if self._active_mode in ("idle", mode):
                self._active_mode = mode
                self._active_mode_owner = owner
                return True
            return False

    def release_mode(self, owner: str) -> None:
        with self._mode_lock:
            if self._active_mode_owner == owner:
                self._active_mode = "idle"
                self._active_mode_owner = None

    def mode_status(self) -> dict[str, str | None]:
        with self._mode_lock:
            mode = "switching" if self._switching.is_set() else self._active_mode
            return {"mode": mode, "owner": self._active_mode_owner}

    def close(self) -> None:
        with self._switch_lock:
            try:
                self._stop_capture_threads_locked()
            finally:
                self._switching.clear()

    def reconfigure_indices(self, indices: list[int]) -> None:
        normalized = [int(idx) for idx in indices]
        if not normalized:
            raise ValueError("indices cannot be empty")
        if len(set(normalized)) != len(normalized):
            raise ValueError("indices must be unique")

        with self._switch_lock:
            was_running = self._running.is_set()
            try:
                self._stop_capture_threads_locked()
                self.indices = normalized
                self._slot_to_index = {slot: cam_idx for slot, cam_idx in enumerate(self.indices)}
                self._optional_missing_slots.clear()
                with self._latest_lock:
                    self._latest_frames = {idx: None for idx in self.indices}
                    self._latest_frame_ms = {idx: None for idx in self.indices}
            finally:
                self._switching.clear()

            if was_running:
                self._start_capture_threads_locked()
