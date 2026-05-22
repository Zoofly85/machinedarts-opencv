from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Optional

from backend.core.camera_service import CameraService
from backend.core.detection.dartcounter import main as dartcounter_main


@dataclass
class DartCounterCore:
    """Detector runtime owner for lab mode."""

    camera_service: CameraService
    thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if self.thread and self.thread.is_alive():
            return
        self.thread = threading.Thread(
            target=dartcounter_main,
            kwargs={"camera_service": self.camera_service},
            daemon=True,
            name="dartcounter-thread",
        )
        self.thread.start()
