from __future__ import annotations

import os
import sys
from typing import Literal

PriorityMode = Literal["normal", "high"]


def normalize_priority_mode(value: object) -> PriorityMode:
    mode = str(value or "normal").strip().lower()
    if mode == "high":
        return "high"
    return "normal"


def apply_process_priority(mode: object) -> dict[str, object]:
    normalized = normalize_priority_mode(mode)
    if os.name != "nt":
        return {
            "requested": normalized,
            "applied": "normal",
            "ok": normalized == "normal",
            "message": "Process priority control is only implemented on Windows.",
        }

    try:
        import ctypes  # noqa: WPS433

        NORMAL_PRIORITY_CLASS = 0x00000020
        HIGH_PRIORITY_CLASS = 0x00000080
        target = HIGH_PRIORITY_CLASS if normalized == "high" else NORMAL_PRIORITY_CLASS

        kernel32 = ctypes.windll.kernel32
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        kernel32.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        kernel32.SetPriorityClass.restype = ctypes.c_int
        handle = kernel32.GetCurrentProcess()
        ok = bool(kernel32.SetPriorityClass(ctypes.c_void_p(handle), ctypes.c_uint32(target)))
        if not ok:
            err = ctypes.GetLastError()
            return {
                "requested": normalized,
                "applied": get_current_process_priority_mode(),
                "ok": False,
                "message": f"SetPriorityClass failed (WinError {err}).",
            }
        return {
            "requested": normalized,
            "applied": get_current_process_priority_mode(),
            "ok": True,
            "message": "Process priority applied.",
        }
    except Exception as exc:
        return {
            "requested": normalized,
            "applied": "normal",
            "ok": False,
            "message": f"Failed to apply process priority: {exc}",
        }


def get_current_process_priority_mode() -> PriorityMode:
    if os.name != "nt":
        return "normal"
    try:
        import ctypes  # noqa: WPS433

        NORMAL_PRIORITY_CLASS = 0x00000020
        HIGH_PRIORITY_CLASS = 0x00000080

        kernel32 = ctypes.windll.kernel32
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        kernel32.GetPriorityClass.argtypes = [ctypes.c_void_p]
        kernel32.GetPriorityClass.restype = ctypes.c_uint32
        handle = kernel32.GetCurrentProcess()
        priority = int(kernel32.GetPriorityClass(ctypes.c_void_p(handle)))
        if priority == HIGH_PRIORITY_CLASS:
            return "high"
        if priority == NORMAL_PRIORITY_CLASS:
            return "normal"
    except Exception:
        pass
    return "normal"
