#!/usr/bin/env python3
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.core.model_crypto import default_model_key_file


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Generate and optionally compile a native model-key helper.")
    p.add_argument("--key-file", default="", help="Model key file. Defaults to app local model_key.txt")
    p.add_argument("--out-dir", default="backend/native_key", help="Output directory for generated source/library")
    p.add_argument("--compile", action="store_true", help="Compile the generated C source when a compiler is available")
    p.add_argument("--force", action="store_true", help="Overwrite generated files")
    return p.parse_args()


def _obfuscate(text: str) -> tuple[list[int], list[int]]:
    data = text.encode("utf-8")
    key = [((i * 37) + 113) & 0xFF for i in range(len(data))]
    enc = [b ^ key[i] for i, b in enumerate(data)]
    return enc, key


def _c_array(values: list[int]) -> str:
    return ", ".join(f"0x{v:02x}" for v in values)


def write_c_source(key_text: str, out_path: Path) -> None:
    enc, key = _obfuscate(key_text.strip())
    source = f"""#include <stddef.h>

#if defined(_WIN32)
#define EXPORT __declspec(dllexport)
#else
#define EXPORT __attribute__((visibility("default")))
#endif

static const unsigned char k_enc[] = {{{_c_array(enc)}}};
static const unsigned char k_xor[] = {{{_c_array(key)}}};
static char k_out[{len(enc) + 1}];

EXPORT const char* machine_darts_model_key(void) {{
    size_t n = sizeof(k_enc) / sizeof(k_enc[0]);
    for (size_t i = 0; i < n; ++i) {{
        k_out[i] = (char)(k_enc[i] ^ k_xor[i]);
    }}
    k_out[n] = '\\0';
    return k_out;
}}
"""
    out_path.write_text(source, encoding="utf-8")


def compile_helper(source_path: Path, out_dir: Path) -> Path:
    if sys.platform.startswith("win"):
        out_path = out_dir / "model_key_helper.dll"
        for compiler in ("cl", "clang", "gcc"):
            if shutil.which(compiler):
                if compiler == "cl":
                    subprocess.check_call([compiler, "/LD", "/O2", str(source_path), f"/Fe:{out_path}"])
                elif compiler == "clang":
                    subprocess.check_call([compiler, "-shared", "-O2", "-o", str(out_path), str(source_path)])
                else:
                    subprocess.check_call([compiler, "-shared", "-O2", "-o", str(out_path), str(source_path)])
                return out_path
    else:
        out_path = out_dir / "libmodel_key_helper.so"
        for compiler in ("cc", "gcc", "clang"):
            if shutil.which(compiler):
                subprocess.check_call([compiler, "-shared", "-fPIC", "-O2", "-o", str(out_path), str(source_path)])
                return out_path
    raise RuntimeError("No C compiler found. Install Visual Studio Build Tools, clang/gcc, or build this file on your target OS.")


def main() -> None:
    args = parse_args()
    key_file = Path(args.key_file).expanduser().resolve() if args.key_file else default_model_key_file()
    if not key_file.exists():
        raise FileNotFoundError(f"Model key file not found: {key_file}")

    out_dir = Path(args.out_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    source_path = out_dir / "generated_model_key_helper.c"
    if source_path.exists() and not args.force:
        raise FileExistsError(f"Generated source already exists: {source_path}. Use --force to replace it.")

    write_c_source(key_file.read_text(encoding="utf-8"), source_path)
    print(f"Generated native key helper source: {source_path}")
    if args.compile:
        lib_path = compile_helper(source_path, out_dir)
        print(f"Compiled native key helper: {lib_path}")


if __name__ == "__main__":
    main()
