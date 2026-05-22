#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.core.model_crypto import default_model_key_file, encrypt_file, generate_model_key, load_model_key


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Encrypt an OpenVINO model folder for Machine Darts.")
    p.add_argument("--model-dir", required=True, help="Source OpenVINO model folder containing .xml and .bin")
    p.add_argument("--output-dir", default="", help="Encrypted output folder. Defaults to <model-dir>_encrypted")
    p.add_argument("--generate-key", action="store_true", help="Generate a new local key file before encrypting")
    p.add_argument("--key-file", default="", help="Optional key file path. Defaults to the app local model key file")
    p.add_argument("--force", action="store_true", help="Overwrite an existing output folder")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    src = Path(args.model_dir).expanduser().resolve()
    if not src.exists():
        raise FileNotFoundError(f"Model directory not found: {src}")

    xml_files = sorted(src.glob("*.xml"))
    bin_files = sorted(src.glob("*.bin"))
    if not xml_files or not bin_files:
        raise FileNotFoundError(f"Expected .xml and .bin files in {src}")
    xml_path = xml_files[0]
    bin_path = bin_files[0]

    key_file = Path(args.key_file).expanduser().resolve() if args.key_file else default_model_key_file()
    if args.generate_key:
        if key_file.exists() and not args.force:
            raise FileExistsError(f"Key file already exists: {key_file}. Use --force to replace it.")
        key_file.parent.mkdir(parents=True, exist_ok=True)
        key_file.write_text(generate_model_key() + "\n", encoding="utf-8")
        print(f"Generated model key: {key_file}")

    if args.key_file:
        import os

        os.environ["MACHINE_DARTS_MODEL_KEY_FILE"] = str(key_file)
    key = load_model_key()

    out = Path(args.output_dir).expanduser().resolve() if args.output_dir else src.with_name(f"{src.name}_encrypted")
    if out.exists():
        if not args.force:
            raise FileExistsError(f"Output directory exists: {out}. Use --force to replace it.")
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)

    encrypt_file(xml_path, out / f"{xml_path.name}.enc", key)
    encrypt_file(bin_path, out / f"{bin_path.name}.enc", key)

    for plain_file in src.iterdir():
        if not plain_file.is_file() or plain_file.suffix.lower() in {".xml", ".bin"}:
            continue
        shutil.copy2(plain_file, out / plain_file.name)

    manifest = {
        "format": "machine-darts-openvino-encrypted-v1",
        "xml": xml_path.name,
        "bin": bin_path.name,
        "source_model_dir": src.name,
    }
    (out / "encrypted_model.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Encrypted model written: {out}")
    print(f"Keep this key safe and private: {key_file}")


if __name__ == "__main__":
    main()
