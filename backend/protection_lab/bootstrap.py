from __future__ import annotations

from dataclasses import dataclass

from backend.core.camera_service import CameraService
from backend.protection_lab.camera_core import CameraCore
from backend.protection_lab.dartcounter_core import DartCounterCore


@dataclass
class ProtectionLabRuntime:
    camera_core: CameraCore
    dartcounter_core: DartCounterCore


_runtime: ProtectionLabRuntime | None = None


def start_runtime(camera_service: CameraService) -> ProtectionLabRuntime:
    global _runtime
    if _runtime is not None:
        return _runtime

    camera_core = CameraCore(camera_service=camera_service)
    dartcounter_core = DartCounterCore(camera_service=camera_service)

    camera_core.start()
    dartcounter_core.start()

    _runtime = ProtectionLabRuntime(
        camera_core=camera_core,
        dartcounter_core=dartcounter_core,
    )
    print("[protection_lab] runtime started: CameraCore + DartCounterCore")
    return _runtime

