from __future__ import annotations

import base64
import ctypes
import hashlib
import os
import secrets
import sys
from pathlib import Path

from backend.config.settings import get_data_root

MAGIC = b"MDMODEL1\n"
KEY_PREFIX = "mdk1:"
NONCE_SIZE = 12


def is_packaged_runtime() -> bool:
    exe_name = Path(sys.executable).name.lower()
    return bool(
        getattr(sys, "frozen", False)
        or "__compiled__" in globals()
        or exe_name in {"darts-backend.exe", "darts-backend"}
    )


def generate_model_key() -> str:
    return KEY_PREFIX + base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii")


def default_model_key_file() -> Path:
    data_root = get_data_root()
    if (data_root / "backend").exists():
        return data_root / "backend" / "data" / "settings" / "model_key.txt"
    return data_root / "settings" / "model_key.txt"


def _key_from_text(raw: str) -> bytes:
    value = str(raw or "").strip()
    if not value:
        raise ValueError("Model encryption key is empty")
    encoded = value[len(KEY_PREFIX) :] if value.startswith(KEY_PREFIX) else value
    try:
        decoded = base64.urlsafe_b64decode(encoded.encode("ascii"))
        if len(decoded) == 32:
            return decoded
    except Exception:
        pass
    return hashlib.sha256(value.encode("utf-8")).digest()


def _native_key_candidates() -> list[Path]:
    env_path = os.getenv("MACHINE_DARTS_MODEL_KEY_NATIVE", "").strip()
    if env_path:
        return [Path(env_path).expanduser().resolve()]

    names = ["model_key_helper.dll"] if os.name == "nt" else ["libmodel_key_helper.so", "model_key_helper.so"]
    if sys.platform == "darwin":
        names = ["libmodel_key_helper.dylib", "model_key_helper.dylib", *names]

    bases: list[Path] = []
    if is_packaged_runtime():
        exe_dir = Path(sys.executable).resolve().parent
        bases.extend([exe_dir, exe_dir / "_internal", exe_dir / "native_key", exe_dir / "_internal" / "native_key"])
        for i in range(1, 5):
            try:
                parent = exe_dir.parents[i - 1]
            except Exception:
                break
            bases.extend([parent / "native_key", parent / "resources" / "native_key"])
    else:
        root = Path(__file__).resolve().parents[2]
        bases.extend([root / "backend" / "native_key", root / "build" / "native_key"])

    return [base / name for base in bases for name in names]


def load_native_model_key_text() -> str | None:
    for candidate in _native_key_candidates():
        if not candidate.exists():
            continue
        try:
            lib = ctypes.CDLL(str(candidate))
            fn = lib.machine_darts_model_key
            fn.restype = ctypes.c_char_p
            raw = fn()
            if raw:
                text = raw.decode("utf-8").strip()
                if text:
                    print(f"[model-key] loaded native model key helper: {candidate}")
                    return text
        except Exception as exc:
            print(f"[WARN] failed to load native model key helper {candidate}: {exc}")
    return None


def load_model_key() -> bytes:
    env_key = os.getenv("MACHINE_DARTS_MODEL_KEY", "").strip()
    if env_key:
        return _key_from_text(env_key)

    native_key = load_native_model_key_text()
    if native_key:
        return _key_from_text(native_key)

    key_file = Path(os.getenv("MACHINE_DARTS_MODEL_KEY_FILE", "").strip()).expanduser() if os.getenv("MACHINE_DARTS_MODEL_KEY_FILE", "").strip() else default_model_key_file()
    if key_file.exists():
        return _key_from_text(key_file.read_text(encoding="utf-8"))

    raise FileNotFoundError(
        "Encrypted model key not found. Set MACHINE_DARTS_MODEL_KEY, "
        f"or put the key in {key_file}."
    )


def encrypt_bytes(data: bytes, key: bytes) -> bytes:
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except Exception as exc:
        raise RuntimeError("cryptography is required for encrypted model support") from exc
    nonce = secrets.token_bytes(NONCE_SIZE)
    return MAGIC + nonce + AESGCM(key).encrypt(nonce, data, None)


def decrypt_bytes(data: bytes, key: bytes) -> bytes:
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except Exception as exc:
        raise RuntimeError("cryptography is required for encrypted model support") from exc
    if not data.startswith(MAGIC):
        raise ValueError("Encrypted model file has an unknown format")
    offset = len(MAGIC)
    nonce = data[offset : offset + NONCE_SIZE]
    ciphertext = data[offset + NONCE_SIZE :]
    return AESGCM(key).decrypt(nonce, ciphertext, None)


def encrypt_file(src: Path, dst: Path, key: bytes) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(encrypt_bytes(src.read_bytes(), key))


def decrypt_file(src: Path, dst: Path, key: bytes) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(decrypt_bytes(src.read_bytes(), key))
