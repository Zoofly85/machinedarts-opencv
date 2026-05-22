from __future__ import annotations

from dataclasses import dataclass

from backend.core.camera_service import CameraService


@dataclass
class CameraCore:
    """Single camera runtime owner for lab mode.

    This wraps the existing CameraService so we can migrate incrementally
    without breaking current routes.
    """

    camera_service: CameraService
    started: bool = False

    def start(self) -> None:
        if self.started:
            return
        self.camera_service.start()
        self.started = True

    def stop(self) -> None:
        if not self.started:
            return
        self.camera_service.close()
        self.started = False

