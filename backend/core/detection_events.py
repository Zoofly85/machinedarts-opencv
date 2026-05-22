from __future__ import annotations

import threading
import time
from collections import deque
from queue import Empty, Queue
from typing import Any


class DetectionEventBus:
    def __init__(self, max_events: int = 500):
        self._lock = threading.Lock()
        self._seq = 0
        self._events: deque[dict[str, Any]] = deque(maxlen=max_events)
        self._listeners: list = []
        self._dispatch_queue: Queue[tuple[dict[str, Any], list]] = Queue()
        self._dispatch_thread = threading.Thread(
            target=self._dispatch_loop,
            name="detection-event-dispatch",
            daemon=True,
        )
        self._dispatch_thread.start()

    def publish(self, event: dict[str, Any]) -> dict[str, Any]:
        payload = dict(event)
        listeners = []
        with self._lock:
            self._seq += 1
            payload["seq"] = self._seq
            payload.setdefault("ts", time.time())
            self._events.append(payload)
            listeners = list(self._listeners)
        if listeners:
            self._dispatch_queue.put((dict(payload), listeners))
        return payload

    def get_since(self, seq: int) -> list[dict[str, Any]]:
        with self._lock:
            return [e for e in self._events if int(e.get("seq", 0)) > int(seq)]

    def get_latest_seq(self) -> int:
        with self._lock:
            return int(self._seq)

    def add_listener(self, listener) -> None:
        with self._lock:
            if listener not in self._listeners:
                self._listeners.append(listener)

    def _dispatch_loop(self) -> None:
        while True:
            try:
                payload, listeners = self._dispatch_queue.get(timeout=0.5)
            except Empty:
                continue
            try:
                for listener in listeners:
                    try:
                        listener(dict(payload))
                    except Exception:
                        continue
            finally:
                self._dispatch_queue.task_done()


_BUS = DetectionEventBus()


def publish_detection_event(event: dict[str, Any]) -> dict[str, Any]:
    return _BUS.publish(event)


def get_detection_events_since(seq: int) -> list[dict[str, Any]]:
    return _BUS.get_since(seq)


def get_latest_detection_seq() -> int:
    return _BUS.get_latest_seq()


def register_detection_event_listener(listener) -> None:
    _BUS.add_listener(listener)
