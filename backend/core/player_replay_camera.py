from __future__ import annotations

import base64
import contextlib
import os
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Any

import cv2

from backend.config.settings import DEFAULT_SCORING_CAMERA_COUNT, enumerate_camera_device_identities, settings

_PLAYER_REPLAY_BUFFER_SECONDS = int(
    max(15, min(60, int(os.getenv("MACHINE_DARTS_PLAYER_REPLAY_BUFFER_SECONDS", "30"))))
)
_PLAYER_REPLAY_TARGET_FPS = int(
    max(8, min(30, int(os.getenv("MACHINE_DARTS_PLAYER_REPLAY_FPS", "30"))))
)
_PLAYER_REPLAY_TARGET_WIDTH = int(
    max(320, min(1280, int(os.getenv("MACHINE_DARTS_PLAYER_REPLAY_WIDTH", "640"))))
)
_PLAYER_REPLAY_JPEG_QUALITY = int(
    max(50, min(95, int(os.getenv("MACHINE_DARTS_PLAYER_REPLAY_JPEG_QUALITY", "75"))))
)
_PLAYER_REPLAY_LOOKUP_TOLERANCE_MS = int(
    max(250, min(4000, int(os.getenv("MACHINE_DARTS_PLAYER_REPLAY_LOOKUP_TOLERANCE_MS", "1800"))))
)
_PLAYER_REPLAY_PREROLL_MS = int(
    max(250, min(5000, int(os.getenv("MACHINE_DARTS_PLAYER_REPLAY_PREROLL_MS", "3000"))))
)
_PLAYER_REPLAY_POSTROLL_MS = int(
    max(250, min(8000, int(os.getenv("MACHINE_DARTS_PLAYER_REPLAY_POSTROLL_MS", "6000"))))
)


@dataclass(frozen=True)
class BufferedReplayFrame:
    ts_ms: int
    jpeg_bytes: bytes


@dataclass(frozen=True)
class HumanTurnWindow:
    start_ms: int
    end_ms: int | None
    player_index: int | None


class PlayerReplayCameraService:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._wake_event = threading.Event()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

        self._desired_enabled = False
        self._desired_camera_index: int | None = None
        self._desired_rotation = 0
        self._desired_portrait_crop = False
        self._active_camera_index: int | None = None
        self._active_backend = "idle"
        self._last_error: str | None = None
        self._last_frame_ms: int | None = None
        self._buffer: deque[BufferedReplayFrame] = deque()
        self._active_human_turn: HumanTurnWindow | None = None
        self._recent_human_turns: deque[HumanTurnWindow] = deque(maxlen=16)

        self._cap: cv2.VideoCapture | None = None
        self._next_open_attempt_at = 0.0
        self._open_failure_count = 0
        self._capture_interval_s = 1.0 / float(max(1, _PLAYER_REPLAY_TARGET_FPS))
        self._max_buffer_frames = max(16, _PLAYER_REPLAY_BUFFER_SECONDS * _PLAYER_REPLAY_TARGET_FPS * 3)

    def configure_from_settings(self, settings_payload: dict[str, Any] | None) -> dict[str, Any]:
        payload = settings_payload or {}
        enabled = bool(payload.get("player_replay_enabled", False))
        rotation = self._normalize_rotation(payload.get("player_replay_rotation", 0))
        portrait_crop = bool(payload.get("player_replay_portrait_crop", False))
        raw_camera_index = self._default_player_camera_device_index()
        try:
            camera_index = max(0, int(raw_camera_index))
        except Exception:
            camera_index = None
        return self.configure(enabled=enabled, camera_index=camera_index, rotation=rotation, portrait_crop=portrait_crop)

    @staticmethod
    def _default_player_camera_device_index() -> int | None:
        try:
            if len(settings.camera_indices) > DEFAULT_SCORING_CAMERA_COUNT:
                return int(settings.camera_indices[DEFAULT_SCORING_CAMERA_COUNT])
        except Exception:
            return None
        return None

    @staticmethod
    def _normalize_rotation(value: Any) -> int:
        try:
            rotation = int(value)
        except Exception:
            rotation = 0
        rotation = rotation % 360
        if rotation not in {0, 90, 180, 270}:
            return 0
        return rotation

    @staticmethod
    def _apply_rotation(frame, rotation: int):
        rotation = PlayerReplayCameraService._normalize_rotation(rotation)
        if rotation == 90:
            return cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)
        if rotation == 180:
            return cv2.rotate(frame, cv2.ROTATE_180)
        if rotation == 270:
            return cv2.rotate(frame, cv2.ROTATE_90_COUNTERCLOCKWISE)
        return frame

    @staticmethod
    def _apply_portrait_crop(frame):
        try:
            height, width = frame.shape[:2]
        except Exception:
            return frame
        if width <= 0 or height <= 0:
            return frame

        def even_size(value: int) -> int:
            value = max(2, int(value))
            return value if value % 2 == 0 else value - 1

        target_aspect = 9.0 / 16.0
        current_aspect = float(width) / float(height)
        if abs(current_aspect - target_aspect) < 0.01:
            return frame
        if current_aspect > target_aspect:
            crop_width = even_size(round(float(height) * target_aspect))
            x0 = max(0, (int(width) - crop_width) // 2)
            return frame[:, x0 : x0 + crop_width]

        crop_height = even_size(round(float(width) / target_aspect))
        y0 = max(0, (int(height) - crop_height) // 2)
        return frame[y0 : y0 + crop_height, :]

    def configure(self, *, enabled: bool, camera_index: int | None, rotation: int = 0, portrait_crop: bool = False) -> dict[str, Any]:
        normalized_index = None if camera_index is None else max(0, int(camera_index))
        normalized_rotation = self._normalize_rotation(rotation)
        normalized_portrait_crop = bool(portrait_crop)
        should_run = bool(enabled) and normalized_index is not None
        with self._lock:
            changed = (
                self._desired_enabled != should_run
                or self._desired_camera_index != normalized_index
                or self._desired_rotation != normalized_rotation
                or self._desired_portrait_crop != normalized_portrait_crop
            )
            self._desired_enabled = should_run
            self._desired_camera_index = normalized_index if should_run else None
            self._desired_rotation = normalized_rotation
            self._desired_portrait_crop = normalized_portrait_crop
            if changed:
                self._buffer.clear()
                self._last_frame_ms = None
                self._last_error = None
                self._next_open_attempt_at = 0.0
                self._open_failure_count = 0
        if should_run:
            self._ensure_thread()
        self._wake_event.set()
        return self.get_status()

    def get_status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "enabled": bool(self._desired_enabled),
                "camera_index": self._desired_camera_index,
                "active_camera_index": self._active_camera_index,
                "rotation": int(self._desired_rotation),
                "portrait_crop": bool(self._desired_portrait_crop),
                "backend": self._active_backend,
                "target_fps": int(_PLAYER_REPLAY_TARGET_FPS),
                "buffered_frames": len(self._buffer),
                "last_frame_ms": self._last_frame_ms,
                "active_human_turn_start_ms": self._active_human_turn.start_ms if self._active_human_turn else None,
                "active_human_turn_player_index": self._active_human_turn.player_index if self._active_human_turn else None,
                "last_error": self._last_error,
                "next_open_attempt_ms": int(self._next_open_attempt_at * 1000) if self._next_open_attempt_at > 0 else None,
            }

    def get_latest_jpeg_bytes(self) -> bytes | None:
        with self._lock:
            if not self._buffer:
                return None
            return bytes(self._buffer[-1].jpeg_bytes)

    def mark_human_turn_started(self, player_index: int | None) -> dict[str, Any]:
        now_ms = int(time.time() * 1000)
        with self._lock:
            if (
                self._active_human_turn is not None
                and self._active_human_turn.end_ms is None
                and self._active_human_turn.player_index == (None if player_index is None else int(player_index))
                and (now_ms - int(self._active_human_turn.start_ms)) < 250
            ):
                return self.get_status()
            self._close_active_human_turn_locked(now_ms)
            self._active_human_turn = HumanTurnWindow(
                start_ms=now_ms,
                end_ms=None,
                player_index=None if player_index is None else int(player_index),
            )
        return self.get_status()

    def mark_non_human_turn_started(self) -> dict[str, Any]:
        now_ms = int(time.time() * 1000)
        with self._lock:
            self._close_active_human_turn_locked(now_ms)
            self._active_human_turn = None
        return self.get_status()

    def close(self) -> None:
        self._stop_event.set()
        self._wake_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.5)
        self._release_capture(clear_active=True)

    def build_replay_payload(
        self,
        *,
        entries: list[dict[str, Any]],
        fallback_capture_ms: int,
    ) -> dict[str, Any]:
        with self._lock:
            enabled = bool(self._desired_enabled)
            camera_index = self._desired_camera_index
            frames = list(self._buffer)
            recent_turns = list(self._recent_human_turns)
            active_turn = self._active_human_turn
            last_error = self._last_error

        if not enabled or camera_index is None:
            return {
                "enabled": False,
                "available": False,
                "camera_index": camera_index,
                "rotation": int(self._desired_rotation),
                "portrait_crop": bool(self._desired_portrait_crop),
                "frames": [],
                "reason": "disabled",
            }

        if not frames:
            return {
                "enabled": True,
                "available": False,
                "camera_index": camera_index,
                "rotation": int(self._desired_rotation),
                "portrait_crop": bool(self._desired_portrait_crop),
                "frames": [],
                "reason": last_error or "buffer_empty",
            }

        dart_entries = [entry for entry in entries if isinstance(entry, dict)]
        first_dart_ms = min((int(entry.get("ts_ms", 0) or 0) for entry in dart_entries), default=int(fallback_capture_ms))
        last_dart_ms = max((int(entry.get("ts_ms", 0) or 0) for entry in dart_entries), default=int(fallback_capture_ms))
        turn_window = self._select_human_turn_window(
            recent_turns=recent_turns,
            active_turn=active_turn,
            first_dart_ms=int(first_dart_ms),
            last_dart_ms=int(last_dart_ms),
        )
        clip_start_ms = max(0, int(first_dart_ms) - _PLAYER_REPLAY_PREROLL_MS)
        clip_end_ms = max(int(clip_start_ms), int(last_dart_ms) + _PLAYER_REPLAY_POSTROLL_MS)
        if turn_window is not None:
            clip_start_ms = max(int(turn_window.start_ms), int(clip_start_ms))
            if turn_window.end_ms is not None:
                clip_end_ms = min(int(turn_window.end_ms), int(clip_end_ms))
        replay_frames: list[dict[str, Any]] = []
        for frame in frames:
            ts_ms = int(frame.ts_ms)
            if ts_ms < clip_start_ms or ts_ms > clip_end_ms:
                continue
            replay_frames.append(
                {
                    "dart_index": self._dart_index_for_ts(dart_entries, ts_ms),
                    "score_value": self._score_value_for_ts(dart_entries, ts_ms),
                    "camera_index": int(camera_index),
                    "image": base64.b64encode(frame.jpeg_bytes).decode("ascii"),
                    "label": "Player Throw",
                    "ts_ms": ts_ms,
                }
            )

        replay_frames.sort(key=lambda item: int(item.get("ts_ms", 0) or 0))
        frame_source = "clip_window"
        if not replay_frames:
            replay_frames = self._build_recent_fallback_frames(
                frames=frames,
                dart_entries=dart_entries,
                camera_index=int(camera_index),
                preferred_end_ms=int(last_dart_ms),
            )
            frame_source = "recent_buffer_fallback" if replay_frames else "clip_window"

        return {
            "enabled": True,
            "available": bool(replay_frames),
            "camera_index": int(camera_index),
            "rotation": int(self._desired_rotation),
            "portrait_crop": bool(self._desired_portrait_crop),
            "fps": int(_PLAYER_REPLAY_TARGET_FPS),
            "turn_window_start_ms": int(turn_window.start_ms) if turn_window is not None else None,
            "turn_window_end_ms": int(turn_window.end_ms) if turn_window is not None and turn_window.end_ms is not None else None,
            "clip_start_ms": int(clip_start_ms),
            "clip_end_ms": int(clip_end_ms),
            "frames": replay_frames,
            "frame_source": frame_source,
            "reason": None if replay_frames else (last_error or "frames_unavailable"),
        }

    def _ensure_thread(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._worker_loop,
            name="player-replay-camera",
            daemon=True,
        )
        self._thread.start()

    def _backend_candidates(self) -> list[tuple[str, int | None]]:
        if sys.platform.startswith("win"):
            names = [("DSHOW", getattr(cv2, "CAP_DSHOW", None)), ("MSMF", getattr(cv2, "CAP_MSMF", None)), ("AUTO", int(cv2.CAP_ANY))]
        elif sys.platform.startswith("linux"):
            names = [("V4L2", getattr(cv2, "CAP_V4L2", None)), ("AUTO", int(cv2.CAP_ANY))]
        elif sys.platform == "darwin":
            names = [("AVFOUNDATION", getattr(cv2, "CAP_AVFOUNDATION", None)), ("AUTO", int(cv2.CAP_ANY))]
        else:
            names = [("AUTO", int(cv2.CAP_ANY))]

        seen: set[int] = set()
        candidates: list[tuple[str, int | None]] = []
        for label, value in names:
            if value is None:
                continue
            try:
                flag = int(value)
            except Exception:
                continue
            if flag in seen:
                continue
            seen.add(flag)
            candidates.append((label, flag))
        return candidates or [("AUTO", int(cv2.CAP_ANY))]

    @staticmethod
    @contextlib.contextmanager
    def _quiet_optional_opencv_probe():
        previous_level = None
        try:
            get_level = getattr(cv2, "getLogLevel", None)
            set_level = getattr(cv2, "setLogLevel", None)
            if callable(get_level) and callable(set_level):
                previous_level = int(get_level())
                set_level(0)
        except Exception:
            previous_level = None
        try:
            yield
        finally:
            if previous_level is not None:
                try:
                    cv2.setLogLevel(int(previous_level))
                except Exception:
                    pass

    def _video_capture(self, camera_index: int, backend_label: str, backend_flag: int | None):
        if (
            sys.platform.startswith("win")
            and str(backend_label).upper() == "DSHOW"
            and backend_flag is not None
        ):
            try:
                return cv2.VideoCapture(
                    int(camera_index),
                    int(backend_flag),
                    [
                        int(cv2.CAP_PROP_FOURCC),
                        int(cv2.VideoWriter_fourcc(*"MJPG")),
                        int(cv2.CAP_PROP_FRAME_WIDTH),
                        int(settings.camera_width),
                        int(cv2.CAP_PROP_FRAME_HEIGHT),
                        int(settings.camera_height),
                        int(cv2.CAP_PROP_FPS),
                        int(settings.camera_fps),
                    ],
                )
            except TypeError:
                pass
        if backend_flag is None or backend_flag == int(cv2.CAP_ANY):
            return cv2.VideoCapture(int(camera_index))
        return cv2.VideoCapture(int(camera_index), int(backend_flag))

    def _open_capture(self, camera_index: int) -> bool:
        self._release_capture(clear_active=True)
        current_devices = enumerate_camera_device_identities(max_devices=max(8, int(camera_index) + 1))
        if current_devices and int(camera_index) not in current_devices:
            self._active_backend = "unavailable"
            self._last_error = "device_not_present"
            self._open_failure_count += 1
            retry_delay_s = 60.0 if self._open_failure_count >= 3 else 10.0
            self._next_open_attempt_at = time.perf_counter() + retry_delay_s
            if self._open_failure_count in {1, 3}:
                print(
                    f"[replay] Optional Player Cam device {camera_index} not present; "
                    f"retrying in {int(retry_delay_s)}s"
                )
            return False
        for backend_label, backend_flag in self._backend_candidates():
            cap = None
            try:
                with self._quiet_optional_opencv_probe():
                    cap = self._video_capture(int(camera_index), str(backend_label), backend_flag)
                if not cap or not cap.isOpened():
                    if cap is not None:
                        cap.release()
                    continue
                configured_in_constructor = sys.platform.startswith("win") and str(backend_label).upper() == "DSHOW"
                if not configured_in_constructor:
                    cap.set(cv2.CAP_PROP_FRAME_WIDTH, float(settings.camera_width))
                    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, float(settings.camera_height))
                    cap.set(cv2.CAP_PROP_FPS, float(settings.camera_fps))
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                ok, frame = False, None
                try:
                    for _ in range(3):
                        ok, frame = cap.read()
                        if ok and frame is not None:
                            break
                        time.sleep(0.02)
                except Exception as exc:
                    cap.release()
                    self._last_error = f"read_failed:{exc}"
                    continue
                if not ok or frame is None:
                    cap.release()
                    self._last_error = "read_failed"
                    continue
                self._cap = cap
                self._active_camera_index = int(camera_index)
                self._active_backend = str(backend_label)
                self._last_error = None
                self._open_failure_count = 0
                self._next_open_attempt_at = 0.0
                return True
            except Exception as exc:
                if cap is not None:
                    try:
                        cap.release()
                    except Exception:
                        pass
                self._last_error = f"open_failed:{exc}"
        self._active_backend = "unavailable"
        self._last_error = self._last_error or "open_failed"
        self._open_failure_count += 1
        retry_delay_s = 60.0 if self._open_failure_count >= 3 else 10.0
        self._next_open_attempt_at = time.perf_counter() + retry_delay_s
        if self._open_failure_count in {1, 3}:
            print(
                f"[replay] Optional Player Cam device {camera_index} unavailable; "
                f"retrying in {int(retry_delay_s)}s"
            )
        return False

    def _release_capture(self, *, clear_active: bool) -> None:
        cap = self._cap
        self._cap = None
        if cap is not None:
            try:
                cap.release()
            except Exception:
                pass
        if clear_active:
            self._active_camera_index = None
            self._active_backend = "idle"

    def _trim_buffer_locked(self) -> None:
        cutoff_ms = int(time.time() * 1000) - (_PLAYER_REPLAY_BUFFER_SECONDS * 1000)
        while self._buffer and self._buffer[0].ts_ms < cutoff_ms:
            self._buffer.popleft()
        while len(self._buffer) > self._max_buffer_frames:
            self._buffer.popleft()

    def _close_active_human_turn_locked(self, now_ms: int) -> None:
        if self._active_human_turn is None:
            return
        self._recent_human_turns.append(
            HumanTurnWindow(
                start_ms=int(self._active_human_turn.start_ms),
                end_ms=int(now_ms),
                player_index=self._active_human_turn.player_index,
            )
        )

    def _store_frame(self, frame) -> None:
        if frame is None:
            return
        with self._lock:
            rotation = int(self._desired_rotation)
            portrait_crop = bool(self._desired_portrait_crop)
        frame = self._apply_rotation(frame, rotation)
        if portrait_crop:
            frame = self._apply_portrait_crop(frame)
        try:
            height, width = frame.shape[:2]
        except Exception:
            return
        if width > _PLAYER_REPLAY_TARGET_WIDTH:
            target_height = max(1, int(round((float(height) / float(width)) * float(_PLAYER_REPLAY_TARGET_WIDTH))))
            frame = cv2.resize(frame, (_PLAYER_REPLAY_TARGET_WIDTH, target_height), interpolation=cv2.INTER_AREA)
        ok, encoded = cv2.imencode(
            ".jpg",
            frame,
            [cv2.IMWRITE_JPEG_QUALITY, int(_PLAYER_REPLAY_JPEG_QUALITY)],
        )
        if not ok:
            return
        ts_ms = int(time.time() * 1000)
        payload = BufferedReplayFrame(ts_ms=ts_ms, jpeg_bytes=encoded.tobytes())
        with self._lock:
            self._buffer.append(payload)
            self._last_frame_ms = ts_ms
            self._last_error = None
            self._trim_buffer_locked()

    def _worker_loop(self) -> None:
        next_frame_due = 0.0
        while not self._stop_event.is_set():
            with self._lock:
                desired_enabled = bool(self._desired_enabled)
                desired_camera_index = self._desired_camera_index

            if not desired_enabled or desired_camera_index is None:
                self._release_capture(clear_active=True)
                self._wake_event.wait(0.25)
                self._wake_event.clear()
                continue

            if self._cap is None or self._active_camera_index != int(desired_camera_index):
                now = time.perf_counter()
                if self._next_open_attempt_at > now:
                    wait_s = min(1.0, max(0.1, self._next_open_attempt_at - now))
                    self._wake_event.wait(wait_s)
                    self._wake_event.clear()
                    continue
                opened = self._open_capture(int(desired_camera_index))
                if not opened:
                    with self._lock:
                        retry_at = float(self._next_open_attempt_at)
                    wait_s = max(1.0, min(10.0, retry_at - time.perf_counter()))
                    self._wake_event.wait(wait_s)
                    self._wake_event.clear()
                    continue
                next_frame_due = 0.0

            wait_s = max(0.0, next_frame_due - time.perf_counter())
            if wait_s > 0 and self._wake_event.wait(min(wait_s, 0.25)):
                self._wake_event.clear()
                continue
            self._wake_event.clear()

            cap = self._cap
            if cap is None:
                continue

            try:
                ok, frame = cap.read()
            except cv2.error as exc:
                with self._lock:
                    self._last_error = f"read_failed:{exc}"
                self._release_capture(clear_active=True)
                time.sleep(0.25)
                continue
            except Exception as exc:
                with self._lock:
                    self._last_error = f"read_failed:{exc}"
                self._release_capture(clear_active=True)
                time.sleep(0.25)
                continue
            if not ok or frame is None:
                with self._lock:
                    self._last_error = "read_failed"
                self._release_capture(clear_active=True)
                time.sleep(0.25)
                continue

            self._store_frame(frame)
            next_frame_due = time.perf_counter() + self._capture_interval_s

        self._release_capture(clear_active=True)

    def _select_buffered_frame(
        self,
        frames: list[BufferedReplayFrame],
        target_ms: int,
    ) -> BufferedReplayFrame | None:
        best_before: BufferedReplayFrame | None = None
        for frame in reversed(frames):
            if frame.ts_ms <= target_ms:
                if target_ms - frame.ts_ms <= _PLAYER_REPLAY_LOOKUP_TOLERANCE_MS:
                    best_before = frame
                break
        if best_before is not None:
            return best_before

        best_any: BufferedReplayFrame | None = None
        best_distance: int | None = None
        for frame in frames:
            distance = abs(int(frame.ts_ms) - int(target_ms))
            if distance > _PLAYER_REPLAY_LOOKUP_TOLERANCE_MS:
                continue
            if best_distance is None or distance < best_distance:
                best_any = frame
                best_distance = distance
        return best_any

    def _build_recent_fallback_frames(
        self,
        *,
        frames: list[BufferedReplayFrame],
        dart_entries: list[dict[str, Any]],
        camera_index: int,
        preferred_end_ms: int,
    ) -> list[dict[str, Any]]:
        if not frames:
            return []
        frames_sorted = sorted(frames, key=lambda item: int(item.ts_ms))
        preferred_end = int(preferred_end_ms or frames_sorted[-1].ts_ms)
        selected_end = frames_sorted[-1].ts_ms
        for frame in reversed(frames_sorted):
            if int(frame.ts_ms) <= preferred_end + _PLAYER_REPLAY_LOOKUP_TOLERANCE_MS:
                selected_end = int(frame.ts_ms)
                break
        fallback_window_ms = min(_PLAYER_REPLAY_BUFFER_SECONDS * 1000, _PLAYER_REPLAY_PREROLL_MS + _PLAYER_REPLAY_POSTROLL_MS + 6000)
        selected_start = max(0, int(selected_end) - int(fallback_window_ms))
        selected = [
            frame
            for frame in frames_sorted
            if int(frame.ts_ms) >= selected_start and int(frame.ts_ms) <= int(selected_end)
        ]
        if not selected and frames_sorted:
            selected = frames_sorted[-min(len(frames_sorted), max(1, _PLAYER_REPLAY_TARGET_FPS * 3)) :]

        replay_frames: list[dict[str, Any]] = []
        for frame in selected:
            ts_ms = int(frame.ts_ms)
            replay_frames.append(
                {
                    "dart_index": self._dart_index_for_ts(dart_entries, ts_ms),
                    "score_value": self._score_value_for_ts(dart_entries, ts_ms),
                    "camera_index": int(camera_index),
                    "image": base64.b64encode(frame.jpeg_bytes).decode("ascii"),
                    "label": "Player Throw",
                    "ts_ms": ts_ms,
                }
            )
        return replay_frames

    @staticmethod
    def _dart_index_for_ts(entries: list[dict[str, Any]], ts_ms: int) -> int:
        current = 0
        for entry in entries:
            entry_ts = int(entry.get("ts_ms", 0) or 0)
            if entry_ts <= ts_ms:
                current = int(entry.get("dart_index", 0) or 0)
            else:
                break
        return current

    @staticmethod
    def _score_value_for_ts(entries: list[dict[str, Any]], ts_ms: int) -> int:
        current = 0
        for entry in entries:
            entry_ts = int(entry.get("ts_ms", 0) or 0)
            if entry_ts <= ts_ms:
                current = int(entry.get("voted_score_value", 0) or 0)
            else:
                break
        return current

    @staticmethod
    def _select_human_turn_window(
        *,
        recent_turns: list[HumanTurnWindow],
        active_turn: HumanTurnWindow | None,
        first_dart_ms: int,
        last_dart_ms: int,
    ) -> HumanTurnWindow | None:
        candidates = list(recent_turns)
        if active_turn is not None:
            candidates.append(active_turn)
        if not candidates:
            return None
        candidates.sort(key=lambda item: int(item.start_ms))
        for item in reversed(candidates):
            end_ms = int(item.end_ms) if item.end_ms is not None else None
            if int(item.start_ms) <= int(first_dart_ms) and (end_ms is None or int(first_dart_ms) <= end_ms + 1000):
                return item
            if int(item.start_ms) <= int(last_dart_ms) and (end_ms is None or int(last_dart_ms) <= end_ms + 1000):
                return item
        return candidates[-1]


_PLAYER_REPLAY_CAMERA_SERVICE: PlayerReplayCameraService | None = None


def get_player_replay_camera_service() -> PlayerReplayCameraService:
    global _PLAYER_REPLAY_CAMERA_SERVICE
    if _PLAYER_REPLAY_CAMERA_SERVICE is None:
        _PLAYER_REPLAY_CAMERA_SERVICE = PlayerReplayCameraService()
    return _PLAYER_REPLAY_CAMERA_SERVICE
