#!/usr/bin/env python3
from __future__ import annotations

import argparse
import shutil
from pathlib import Path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Stage only encrypted model folders for secure release packaging.")
    p.add_argument("--models-root", default="models", help="Source models root")
    p.add_argument("--output-root", default="build/secure-models/models", help="Destination models root")
    p.add_argument("--force", action="store_true", help="Replace destination folder")
    return p.parse_args()


def copy_encrypted_models(src_root: Path, dst_root: Path) -> int:
    count = 0
    for family_dir in sorted([p for p in src_root.iterdir() if p.is_dir()], key=lambda p: p.name):
        for model_dir in sorted([p for p in family_dir.iterdir() if p.is_dir()], key=lambda p: p.name):
            if not list(model_dir.glob("*.xml.enc")) or not list(model_dir.glob("*.bin.enc")):
                continue
            rel = model_dir.relative_to(src_root)
            dst = dst_root / rel
            dst.mkdir(parents=True, exist_ok=True)
            for item in model_dir.iterdir():
                if item.is_file() and (item.suffix.lower() in {".yaml", ".json"} or item.name.endswith(".enc")):
                    shutil.copy2(item, dst / item.name)
            count += 1
    return count


def main() -> None:
    args = parse_args()
    src_root = Path(args.models_root).expanduser().resolve()
    dst_root = Path(args.output_root).expanduser().resolve()
    if not src_root.exists():
        raise FileNotFoundError(f"Models root not found: {src_root}")
    if dst_root.exists():
        if not args.force:
            raise FileExistsError(f"Output root exists: {dst_root}. Use --force to replace it.")
        shutil.rmtree(dst_root)
    dst_root.mkdir(parents=True, exist_ok=True)
    count = copy_encrypted_models(src_root, dst_root)
    if count <= 0:
        raise RuntimeError(f"No encrypted model folders found under {src_root}")
    print(f"Staged {count} encrypted model folder(s): {dst_root}")


if __name__ == "__main__":
    main()
