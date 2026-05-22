#!/usr/bin/env python3
"""Single entrypoint to run the backend API (and optional detector loop)."""

from __future__ import annotations

import argparse
import os
import re
import shutil
import socket
import sys
import threading
from pathlib import Path

import uvicorn


def _is_packaged_runtime() -> bool:
    exe_name = Path(sys.executable).name.lower()
    return bool(
        getattr(sys, "frozen", False)
        or "__compiled__" in globals()
        or exe_name in {"darts-backend.exe", "darts-backend"}
    )


# Force line-buffered stdout so all print() calls appear immediately in logs,
# even when running as a frozen PyInstaller exe (where PYTHONUNBUFFERED env
# var has no effect because Python is pre-initialized before env vars are read).
try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass

# ---------------------------------------------------------------------------
# Path setup — must work both when run as a plain Python script AND when
# frozen by PyInstaller into a single-file executable.
#
# Frozen:  sys.frozen=True, sys.executable = path to the .exe
#          The .exe lives next to the Tauri app; data files (calibration,
#          models, settings) are resolved relative to the .exe's directory.
#
# Script:  __file__ = backend/run_api.py
#          PROJECT_ROOT = the repo root (parent of backend/)
# ---------------------------------------------------------------------------
if _is_packaged_runtime():
    # Running as a PyInstaller bundle.
    # sys.executable is the .exe path; its directory is the install dir.
    _EXE_DIR = Path(sys.executable).resolve().parent
    # The bundled code is already importable via sys._MEIPASS; no extra
    # sys.path manipulation needed for imports.
    # Set PROJECT_ROOT to the exe directory so data paths resolve correctly.
    PROJECT_ROOT = _EXE_DIR
else:
    # Running as a plain Python script: backend/run_api.py
    # PROJECT_ROOT = repo root (one level above backend/)
    PROJECT_ROOT = Path(__file__).resolve().parents[1]
    if str(PROJECT_ROOT) not in sys.path:
        sys.path.insert(0, str(PROJECT_ROOT))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Machine Darts backend API.")
    parser.add_argument("--host", default="0.0.0.0", help="Bind host (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8000, help="Bind port (default: 8000)")
    parser.add_argument("--reload", action="store_true", help="Enable auto-reload (API-only mode)")
    parser.add_argument(
        "--with-detector",
        action="store_true",
        help="Legacy flag. Detector starts by default; this flag is kept for compatibility.",
    )
    parser.add_argument(
        "--api-only",
        action="store_true",
        help="Start API without dartcounter (debug mode).",
    )
    return parser.parse_args()


def _parse_semver_from_dist_info(name: str) -> tuple[int, int, int] | None:
    match = re.match(r"^openvino-(\d+)\.(\d+)\.(\d+)\.dist-info$", name)
    if not match:
        return None
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)))


def _cleanup_stale_openvino_dist_info() -> None:
    """Keep only the newest openvino-*.dist-info in frozen onedir installs.

    Tauri updater/over-installs can leave stale dist-info directories from old
    backend versions. They are harmless but confusing for diagnostics.
    """
    if not _is_packaged_runtime():
        return
    internal_dir = Path(sys.executable).resolve().parent / "_internal"
    if not internal_dir.exists():
        return

    candidates = [p for p in internal_dir.iterdir() if p.is_dir() and p.name.startswith("openvino-") and p.name.endswith(".dist-info")]
    if len(candidates) <= 1:
        return

    parsed = []
    unknown = []
    for path in candidates:
        ver = _parse_semver_from_dist_info(path.name)
        if ver is None:
            unknown.append(path)
        else:
            parsed.append((ver, path))

    keep: Path | None = None
    if parsed:
        parsed.sort(key=lambda item: item[0], reverse=True)
        keep = parsed[0][1]
    elif candidates:
        keep = sorted(candidates, key=lambda p: p.name, reverse=True)[0]

    for path in candidates:
        if keep is not None and path == keep:
            continue
        try:
            shutil.rmtree(path, ignore_errors=True)
        except Exception:
            pass


_ALLOWED_TIP_MODEL_DIRS = {
    "1280-11n-p-13052026_encrypted",
    "1280-11n-p-30042026_openvino_model",
    "1280-11n-p-30042026_openvino_model_encrypted",
    "y11-p-n-1280-rect-10-2-2026_openvino_model",
    "y11-p-1280-720-26032026_openvino_model",
}


def _cleanup_stale_tip_models() -> None:
    """Keep only allowed tip models in frozen installs.

    Updater installs may leave deleted model folders/files behind. This can make
    old models show in the UI even though they were removed from source.
    """
    if not _is_packaged_runtime():
        return
    exe_dir = Path(sys.executable).resolve().parent
    bases: list[Path] = [exe_dir]
    for i in range(1, 7):
        try:
            bases.append(exe_dir.parents[i - 1])
        except Exception:
            break

    candidate_roots: list[Path] = []
    seen: set[str] = set()
    for base in bases:
        for root in (
            base / "models" / "tip",
            base / "resources" / "models" / "tip",
            base / "_up_" / "_up_" / "models" / "tip",
        ):
            key = str(root).lower()
            if key not in seen:
                seen.add(key)
                candidate_roots.append(root)
    for tip_root in candidate_roots:
        if not tip_root.exists():
            continue
        removed: list[str] = []
        for entry in tip_root.iterdir():
            try:
                if entry.is_dir():
                    if entry.name not in _ALLOWED_TIP_MODEL_DIRS:
                        shutil.rmtree(entry, ignore_errors=True)
                        removed.append(entry.name)
                elif entry.is_file() and entry.suffix.lower() in {".pt", ".onnx"}:
                    entry.unlink(missing_ok=True)
                    removed.append(entry.name)
            except Exception:
                pass
        if removed:
            print(f"[cleanup] Removed stale tip models/files from {tip_root}: {', '.join(sorted(removed))}")


def _cleanup_raw_model_resources_when_secure_models_exist() -> None:
    """Remove raw model resources left by older installer/updater layouts."""
    if not _is_packaged_runtime():
        return
    exe_dir = Path(sys.executable).resolve().parent
    bases: list[Path] = [exe_dir]
    for i in range(1, 7):
        try:
            bases.append(exe_dir.parents[i - 1])
        except Exception:
            break

    raw_roots: list[Path] = []
    secure_roots: list[Path] = []
    seen: set[str] = set()
    for base in bases:
        for root in (
            base / "models",
            base / "resources" / "models",
            base / "_up_" / "_up_" / "models",
        ):
            key = str(root).lower()
            if key not in seen:
                seen.add(key)
                raw_roots.append(root)
        for root in (
            base / "build" / "secure-models" / "models",
            base / "resources" / "build" / "secure-models" / "models",
            base / "_up_" / "_up_" / "build" / "secure-models" / "models",
        ):
            key = str(root).lower()
            if key not in seen:
                seen.add(key)
                secure_roots.append(root)

    secure_available = any(
        root.exists() and any(root.rglob("*.enc"))
        for root in secure_roots
    )
    if not secure_available:
        return

    for raw_root in raw_roots:
        if not raw_root.exists():
            continue
        try:
            shutil.rmtree(raw_root, ignore_errors=True)
            print(f"[cleanup] Removed stale raw model resource folder: {raw_root}")
        except Exception:
            pass


def main() -> None:
    _cleanup_stale_openvino_dist_info()
    _cleanup_raw_model_resources_when_secure_models_exist()
    _cleanup_stale_tip_models()
    args = parse_args()
    run_detector = not args.api_only
    protection_lab_mode = str(os.getenv("MACHINE_DARTS_PROTECTION_LAB", "")).strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }

    # Apply persisted process priority mode early in startup.
    try:
        from backend.core.detection import dartcounter as _dartcounter_settings
        from backend.core.process_priority import apply_process_priority

        loaded = _dartcounter_settings.load_detection_settings()
        priority_mode = str(loaded.get("process_priority_mode", "normal"))
        result = apply_process_priority(priority_mode)
        print(
            f"[runtime] process_priority requested={result.get('requested')} "
            f"applied={result.get('applied')} ok={result.get('ok')}"
        )
    except Exception as exc:
        print(f"[runtime] process_priority apply skipped: {exc}")

    # Prevent multiple backend instances. A second launch should exit fast
    # instead of racing for cameras/port and confusing the frontend.
    lock_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        lock_socket.bind(("127.0.0.1", 18765))
        lock_socket.listen(1)
    except OSError:
        print("Another darts-backend instance is already running; exiting.")
        return

    if run_detector:
        if args.reload:
            print("`--reload` is disabled when dartcounter is enabled. Use `--api-only --reload` for API dev mode.")
        from backend.app.main import app
        from backend.app.routers import calibration as calibration_router

        if protection_lab_mode:
            from backend.protection_lab.bootstrap import start_runtime as start_protection_lab_runtime

            start_protection_lab_runtime(calibration_router.camera_service)
            print("dartcounter started via protection_lab. Use --api-only to disable.")
        else:
            from backend.core.detection.dartcounter import main as detector_main

            def _run_detector_runtime() -> None:
                try:
                    calibration_router.camera_service.start()
                    detector_main(camera_service=calibration_router.camera_service)
                except Exception as exc:
                    print(f"[runtime] dartcounter startup failed: {exc}")

            detector_thread = threading.Thread(
                target=_run_detector_runtime,
                daemon=True,
                name="dartcounter-bootstrap-thread",
            )
            detector_thread.start()
            print("dartcounter startup requested. Use --api-only to disable.")

        uvicorn.run(app, host=args.host, port=args.port, reload=False)
        return

    if args.reload:
        uvicorn.run("backend.app.main:app", host=args.host, port=args.port, reload=True)
    else:
        from backend.app.main import app

        uvicorn.run(app, host=args.host, port=args.port, reload=False)


if __name__ == "__main__":
    main()
