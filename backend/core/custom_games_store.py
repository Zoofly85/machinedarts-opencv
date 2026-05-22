from __future__ import annotations

import base64
import json
import re
import shutil
import time
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from backend.config.settings import get_data_root


MAX_PACKAGE_BYTES = 25 * 1024 * 1024


def custom_games_root() -> Path:
    if (get_data_root() / "backend").exists():
        return get_data_root() / "backend" / "data" / "custom_frontend_games"
    return get_data_root() / "custom_frontend_games"


def _index_path() -> Path:
    return custom_games_root() / "custom-games.json"


def _packages_root() -> Path:
    return custom_games_root() / "packages"


def _archives_root() -> Path:
    return custom_games_root() / "archives"


def _slugify(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "-", str(value or "").strip()).strip("-_.").lower()
    return cleaned[:64] or "custom-game"


def _read_index() -> list[dict[str, Any]]:
    path = _index_path()
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        games = payload.get("games", []) if isinstance(payload, dict) else []
        return [dict(item) for item in games if isinstance(item, dict)]
    except Exception:
        return []


def _write_index(games: list[dict[str, Any]]) -> None:
    root = custom_games_root()
    root.mkdir(parents=True, exist_ok=True)
    payload = {
        "games": games,
        "updatedAt": int(time.time() * 1000),
    }
    _index_path().write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _is_safe_zip_member(name: str) -> bool:
    normalized = name.replace("\\", "/")
    if not normalized or normalized.startswith("/") or normalized.startswith("../") or "/../" in normalized:
        return False
    return True


def _safe_extract(zip_path: Path, target_dir: Path) -> None:
    with zipfile.ZipFile(zip_path, "r") as archive:
        for info in archive.infolist():
            if not _is_safe_zip_member(info.filename):
                raise ValueError(f"Unsafe package path: {info.filename}")
        archive.extractall(target_dir)


def _find_package_root(extract_dir: Path) -> Path:
    direct_manifest = extract_dir / "custom-game.json"
    direct_index = extract_dir / "index.html"
    if direct_manifest.exists() and direct_index.exists():
        return extract_dir

    candidates = []
    for manifest in extract_dir.glob("*/custom-game.json"):
        package_root = manifest.parent
        if (package_root / "index.html").exists():
            candidates.append(package_root)
    if len(candidates) == 1:
        return candidates[0]
    raise ValueError("Package must include custom-game.json and index.html at the ZIP root or inside one top-level folder.")


def _load_manifest(package_root: Path) -> dict[str, Any]:
    try:
        manifest = json.loads((package_root / "custom-game.json").read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError(f"Invalid custom-game.json: {exc}") from exc
    if not isinstance(manifest, dict):
        raise ValueError("custom-game.json must contain an object.")
    name = str(manifest.get("name", "")).strip()
    if not name:
        raise ValueError("custom-game.json must include a name.")
    return manifest


def list_custom_games() -> list[dict[str, Any]]:
    games = _read_index()
    existing: list[dict[str, Any]] = []
    changed = False
    for game in games:
        game_id = str(game.get("id", "")).strip()
        if not game_id:
            changed = True
            continue
        package_dir = _packages_root() / game_id
        if not (package_dir / "index.html").exists():
            changed = True
            continue
        existing.append(
            {
                **game,
                "launchUrl": f"/custom-games-content/{game_id}/index.html",
                "downloadUrl": f"/api/custom-games/{game_id}/download",
            }
        )
    if changed:
        _write_index(existing)
    return existing


def import_custom_game(filename: str, content_base64: str) -> dict[str, Any]:
    raw = base64.b64decode(content_base64, validate=True)
    if len(raw) > MAX_PACKAGE_BYTES:
        raise ValueError("Package is too large. Maximum size is 25 MB.")

    root = custom_games_root()
    _packages_root().mkdir(parents=True, exist_ok=True)
    _archives_root().mkdir(parents=True, exist_ok=True)

    with TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        zip_path = tmp_dir / "package.zip"
        zip_path.write_bytes(raw)
        if not zipfile.is_zipfile(zip_path):
            raise ValueError("Imported file must be a ZIP package.")
        extract_dir = tmp_dir / "extract"
        extract_dir.mkdir(parents=True, exist_ok=True)
        _safe_extract(zip_path, extract_dir)
        package_root = _find_package_root(extract_dir)
        manifest = _load_manifest(package_root)

        game_id = _slugify(str(manifest.get("id") or manifest.get("name") or Path(filename).stem))
        games = [game for game in _read_index() if str(game.get("id", "")) != game_id]
        package_dir = _packages_root() / game_id
        archive_path = _archives_root() / f"{game_id}.zip"

        if package_dir.exists():
            shutil.rmtree(package_dir, ignore_errors=True)
        shutil.copytree(package_root, package_dir)
        archive_path.write_bytes(raw)

        imported_at = int(time.time() * 1000)
        game = {
            "id": game_id,
            "name": str(manifest.get("name") or game_id),
            "description": str(manifest.get("description") or ""),
            "version": str(manifest.get("version") or "1.0.0"),
            "author": str(manifest.get("author") or ""),
            "importedAt": imported_at,
            "packageBytes": len(raw),
            "entry": "index.html",
        }
        games.append(game)
        games.sort(key=lambda item: str(item.get("name", "")).lower())
        _write_index(games)

    return {
        **game,
        "launchUrl": f"/custom-games-content/{game_id}/index.html",
        "downloadUrl": f"/api/custom-games/{game_id}/download",
        "storageRoot": str(root),
    }


def delete_custom_game(game_id: str) -> bool:
    normalized = _slugify(game_id)
    games = _read_index()
    next_games = [game for game in games if str(game.get("id", "")) != normalized]
    if len(next_games) == len(games):
        return False
    shutil.rmtree(_packages_root() / normalized, ignore_errors=True)
    archive = _archives_root() / f"{normalized}.zip"
    if archive.exists():
        archive.unlink()
    _write_index(next_games)
    return True


def custom_game_archive(game_id: str) -> Path | None:
    normalized = _slugify(game_id)
    archive = _archives_root() / f"{normalized}.zip"
    if not archive.exists():
        return None
    return archive
