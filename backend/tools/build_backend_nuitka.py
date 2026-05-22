#!/usr/bin/env python3
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Build the Machine Darts backend with Nuitka.")
    p.add_argument("--backend-dir", default="backend")
    p.add_argument("--output-dir", default="backend/dist/darts-backend")
    p.add_argument("--work-dir", default="backend/build/nuitka_work")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    backend_dir = Path(args.backend_dir).resolve()
    repo_root = backend_dir.parent
    output_dir = Path(args.output_dir).resolve()
    work_dir = Path(args.work_dir).resolve()
    entry = backend_dir / "run_api.py"
    if not entry.exists():
        raise FileNotFoundError(entry)

    if shutil.which("nuitka") is None:
        try:
            import nuitka  # noqa: F401
        except Exception as exc:
            raise RuntimeError("Nuitka is not installed. Run: python -m pip install nuitka ordered-set zstandard") from exc

    if output_dir.exists():
        shutil.rmtree(output_dir)
    if work_dir.exists():
        shutil.rmtree(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)

    build_root = work_dir / "out"
    cmd = [
        sys.executable,
        "-m",
        "nuitka",
        "--standalone",
        "--assume-yes-for-downloads",
        f"--output-dir={build_root}",
        "--output-filename=darts-backend",
        "--include-package=backend.app",
        "--include-package=backend.calibration",
        "--include-package=backend.config",
        "--include-package=backend.core",
        "--include-package=backend.models",
        "--include-package=openvino",
        "--include-package=uvicorn",
        "--include-package=fastapi",
        "--include-package=cv2",
        "--include-package=cryptography",
        "--enable-plugin=no-qt",
        "--nofollow-import-to=torch",
        "--nofollow-import-to=torchvision",
        "--nofollow-import-to=torchaudio",
        "--nofollow-import-to=ultralytics",
        "--nofollow-import-to=ultralytics_thop",
        "--nofollow-import-to=nncf",
        "--nofollow-import-to=sympy",
        "--nofollow-import-to=matplotlib",
        "--nofollow-import-to=pandas",
        "--nofollow-import-to=scipy",
        "--nofollow-import-to=sklearn",
        "--nofollow-import-to=onnxruntime",
        "--nofollow-import-to=PIL.ImageQt",
        str(entry),
    ]
    subprocess.check_call(cmd, cwd=str(repo_root))

    exe_name = "darts-backend.exe" if sys.platform.startswith("win") else "darts-backend"
    matches = list(build_root.rglob(exe_name))
    if not matches:
        raise FileNotFoundError(f"Nuitka output executable not found: {exe_name}")
    dist_dir = matches[0].parent
    shutil.copytree(dist_dir, output_dir)
    print(f"Nuitka backend staged: {output_dir}")


if __name__ == "__main__":
    main()
