from __future__ import annotations

import json
import os
import shutil
import sys
import threading
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any

from backend.config.settings import get_data_root


def _resolve_training_data_dir() -> Path:
    if getattr(sys, "frozen", False):
        return get_data_root() / "training"
    return Path(__file__).resolve().parents[1] / "data" / "training"


def _resolve_correction_debug_dir() -> Path:
    if getattr(sys, "frozen", False):
        return get_data_root() / "correction_debug"
    return Path(__file__).resolve().parents[1] / "data" / "correction_debug"


def _resolve_logs_dir() -> Path:
    if getattr(sys, "frozen", False):
        return get_data_root() / "logs"
    return Path(__file__).resolve().parents[1] / "data" / "logs"


class FirebaseUploader:
    def __init__(self) -> None:
        self.training_dir = _resolve_training_data_dir()
        self.training_dir.mkdir(parents=True, exist_ok=True)
        self.correction_debug_dir = _resolve_correction_debug_dir()
        self.correction_debug_dir.mkdir(parents=True, exist_ok=True)
        self.temp_dir = self.training_dir.parent / "temp_uploads"
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        self.logs_dir = _resolve_logs_dir()
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        self.log_file = self.logs_dir / "training-data.log"
        self._firebase_initialized = False
        self._bucket = None

    def _log(self, message: str) -> None:
        line = f"{datetime.now().isoformat(timespec='seconds')} [training-data] {message}"
        try:
            with self.log_file.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:
            pass
        try:
            print(f"[training-data] {message}")
        except Exception:
            pass

    def _initialize_firebase(self) -> bool:
        if self._firebase_initialized:
            return True
        try:
            import firebase_admin  # type: ignore
            from firebase_admin import credentials, storage  # type: ignore
        except Exception:
            self._log("firebase-admin not installed; auto-upload disabled")
            return False

        cred_env = os.environ.get("FIREBASE_CREDENTIALS_PATH", "").strip()
        bucket_name = os.environ.get("FIREBASE_STORAGE_BUCKET", "dart-detector-training-data.firebasestorage.app")
        candidates = []
        if cred_env:
            candidates.append(Path(cred_env))
        if getattr(sys, "frozen", False):
            exe_dir = Path(sys.executable).resolve().parent
            candidates.append(exe_dir / "firebase_credentials.json")
            candidates.append(exe_dir / "backend" / "data" / "firebase_credentials.json")
        candidates.append(self.training_dir.parent / "firebase_credentials.json")

        cred_path = next((p for p in candidates if p.exists()), None)
        if cred_path is None:
            self._log("firebase_credentials.json not found; auto-upload disabled")
            return False

        try:
            if not firebase_admin._apps:
                cred = credentials.Certificate(str(cred_path))
                firebase_admin.initialize_app(cred, {"storageBucket": bucket_name})
            self._bucket = storage.bucket()
            self._firebase_initialized = True
            self._log(f"Firebase initialized (bucket={bucket_name})")
            return True
        except Exception as exc:
            self._log(f"Firebase init failed: {exc}")
            return False

    def count_images(self) -> dict[str, int]:
        counts = {"dart_1": 0, "dart_2": 0, "dart_3": 0, "total": 0}
        for idx in range(1, 4):
            dart_dir = self.training_dir / f"dart_{idx}"
            if not dart_dir.exists():
                continue
            n = len(list(dart_dir.glob("*.jpg")))
            counts[f"dart_{idx}"] = n
            counts["total"] += n
        return counts

    def count_correction_debug_packs(self) -> dict[str, int]:
        packs = [p for p in self.correction_debug_dir.glob("dart_*") if p.is_dir()]
        files = 0
        for pack in packs:
            files += sum(1 for p in pack.rglob("*") if p.is_file())
        return {"packs": len(packs), "files": files}

    def create_zip(self) -> Path | None:
        counts = self.count_images()
        if counts["total"] <= 0:
            return None

    def create_correction_debug_zip(self) -> Path | None:
        counts = self.count_correction_debug_packs()
        if counts["packs"] <= 0:
            return None
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        zip_path = self.temp_dir / f"correction_debug_{stamp}.zip"
        try:
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                for pack_dir in sorted([p for p in self.correction_debug_dir.glob("dart_*") if p.is_dir()]):
                    for path in pack_dir.rglob("*"):
                        if path.is_file():
                            zf.write(path, str(Path(pack_dir.name) / path.relative_to(pack_dir)))
            return zip_path
        except Exception as exc:
            self._log(f"Failed creating correction debug zip: {exc}")
            return None
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        zip_path = self.temp_dir / f"training_data_{stamp}.zip"
        try:
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                classes = self.training_dir / "classes.txt"
                if classes.exists():
                    zf.write(classes, "classes.txt")
                for idx in range(1, 4):
                    dart_dir = self.training_dir / f"dart_{idx}"
                    if not dart_dir.exists():
                        continue
                    for p in dart_dir.glob("*"):
                        if p.is_file() and p.suffix.lower() in {".jpg", ".jpeg", ".png", ".json", ".txt"}:
                            zf.write(p, str(Path(f"dart_{idx}") / p.name))
            return zip_path
        except Exception as exc:
            self._log(f"Failed creating zip: {exc}")
            return None

    def upload_zip(self, zip_path: Path, folder: str = "training_data") -> bool:
        if not self._initialize_firebase():
            return False
        try:
            assert self._bucket is not None
            blob_path = f"{folder.strip('/')}/{zip_path.name}"
            blob = self._bucket.blob(blob_path)
            blob.upload_from_filename(str(zip_path))
            self._log(f"Uploaded {zip_path.name} -> {blob_path}")
            return True
        except Exception as exc:
            self._log(f"Firebase upload failed: {exc}")
            return False

    def delete_training_data(self) -> bool:
        try:
            if self.training_dir.exists():
                shutil.rmtree(self.training_dir)
            self.training_dir.mkdir(parents=True, exist_ok=True)
            return True
        except Exception as exc:
            self._log(f"Failed deleting training data: {exc}")
            return False

    def delete_correction_debug_data(self) -> bool:
        try:
            if self.correction_debug_dir.exists():
                shutil.rmtree(self.correction_debug_dir)
            self.correction_debug_dir.mkdir(parents=True, exist_ok=True)
            return True
        except Exception as exc:
            self._log(f"Failed deleting correction debug data: {exc}")
            return False

    def upload_and_clean(self) -> dict[str, Any]:
        counts = self.count_images()
        result: dict[str, Any] = {
            "success": False,
            "counts": counts,
            "images_count": int(counts["total"]),
            "file_size_mb": 0.0,
            "message": "",
        }
        if counts["total"] <= 0:
            result["success"] = True
            result["message"] = "No training data to upload"
            return result

        zip_path = self.create_zip()
        if zip_path is None:
            result["message"] = "Failed to create zip"
            return result
        try:
            result["file_size_mb"] = zip_path.stat().st_size / (1024 * 1024)
            if not self.upload_zip(zip_path):
                result["message"] = "Upload failed"
                return result
            self.delete_training_data()
            result["success"] = True
            result["message"] = "Training data uploaded"
            return result
        finally:
            try:
                if zip_path.exists():
                    zip_path.unlink()
            except Exception:
                pass

    def upload_correction_debug_and_clean(self) -> dict[str, Any]:
        counts = self.count_correction_debug_packs()
        result: dict[str, Any] = {
            "success": False,
            "counts": counts,
            "packs_count": int(counts["packs"]),
            "files_count": int(counts["files"]),
            "file_size_mb": 0.0,
            "message": "",
        }
        if counts["packs"] <= 0:
            result["success"] = True
            result["message"] = "No correction debug data to upload"
            return result

        zip_path = self.create_correction_debug_zip()
        if zip_path is None:
            result["message"] = "Failed to create correction debug zip"
            return result
        try:
            result["file_size_mb"] = zip_path.stat().st_size / (1024 * 1024)
            if not self.upload_zip(zip_path, folder="correction_debug"):
                result["message"] = "Correction debug upload failed"
                return result
            self.delete_correction_debug_data()
            result["success"] = True
            result["message"] = "Correction debug data uploaded"
            return result
        finally:
            try:
                if zip_path.exists():
                    zip_path.unlink()
            except Exception:
                pass


_UPLOAD_LOCK = threading.Lock()
_UPLOAD_IN_PROGRESS = False


def trigger_background_upload(min_images: int = 10) -> bool:
    global _UPLOAD_IN_PROGRESS
    uploader = FirebaseUploader()
    counts = uploader.count_images()
    if int(counts.get("total", 0)) < int(min_images):
        return False

    with _UPLOAD_LOCK:
        if _UPLOAD_IN_PROGRESS:
            return False
        _UPLOAD_IN_PROGRESS = True

    def _job() -> None:
        global _UPLOAD_IN_PROGRESS
        try:
            uploader.upload_and_clean()
        finally:
            with _UPLOAD_LOCK:
                _UPLOAD_IN_PROGRESS = False

    threading.Thread(target=_job, name="training-upload-worker", daemon=True).start()
    return True
