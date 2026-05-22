from __future__ import annotations

import base64
import json
import os
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


def _resolve_settings_path() -> Path:
    if getattr(sys, "frozen", False):
        if os.name == "nt":
            appdata = os.getenv("APPDATA", "").strip()
            base = Path(appdata).resolve() / "DartDetector" if appdata else Path.home() / "AppData" / "Roaming" / "DartDetector"
        else:
            xdg_data_home = os.getenv("XDG_DATA_HOME", "").strip()
            base = Path(xdg_data_home).resolve() if xdg_data_home else Path.home() / ".local" / "share"
            base = base / "DartDetector"
        return base / "settings" / "gif_reactions.json"
    return Path(__file__).resolve().parents[1] / "data" / "settings" / "gif_reactions.json"


SETTINGS_PATH = _resolve_settings_path()
UPLOAD_DIR = SETTINGS_PATH.parent.parent / "gif_reactions"
SUPPORTED_EXTENSIONS = {".gif", ".webp", ".png", ".jpg", ".jpeg", ".mp4", ".webm"}
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
TARGETS_WITH_RULES = {"score", "checkout"}
TARGETS_WITHOUT_RULES = {"set_won", "match_won"}
MATCH_TYPES = {"exact_score", "min_score", "any_checkout", "exact_checkout", "min_checkout"}


@dataclass
class GifReactionRule:
    id: str
    label: str
    match_type: str
    score: int | None = None
    gifs: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "GifReactionRule":
        return cls(
            id=str(payload.get("id") or ""),
            label=str(payload.get("label") or ""),
            match_type=str(payload.get("match_type") or ""),
            score=payload.get("score") if payload.get("score") is None else int(payload.get("score") or 0),
            gifs=[str(item) for item in payload.get("gifs", []) if str(item).strip()] if isinstance(payload.get("gifs"), list) else [],
        )

    def normalized(self, fallback_prefix: str, index: int) -> "GifReactionRule":
        self.id = _slugify(self.id or f"{fallback_prefix}-{index}")
        self.label = self.label.strip() or self.id.replace("-", " ").title()
        self.match_type = self.match_type if self.match_type in MATCH_TYPES else "min_score"
        if self.match_type in {"exact_score", "min_score", "exact_checkout", "min_checkout"}:
            self.score = max(0, min(180, int(self.score or 0)))
        else:
            self.score = None
        self.gifs = [str(item) for item in self.gifs if str(item).strip()]
        return self


@dataclass
class GifReactionSettings:
    enabled: bool = True
    duration_ms: int = 1800
    score_rules: list[GifReactionRule] = field(default_factory=list)
    checkout_rules: list[GifReactionRule] = field(default_factory=list)
    set_won_gifs: list[str] = field(default_factory=list)
    match_won_gifs: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "GifReactionSettings":
        score_rules = payload.get("score_rules", [])
        checkout_rules = payload.get("checkout_rules", [])
        return cls(
            enabled=bool(payload.get("enabled", True)),
            duration_ms=int(payload.get("duration_ms", 1800) or 1800),
            score_rules=[
                GifReactionRule.from_dict(item) for item in score_rules if isinstance(item, dict)
            ]
            if isinstance(score_rules, list)
            else [],
            checkout_rules=[
                GifReactionRule.from_dict(item) for item in checkout_rules if isinstance(item, dict)
            ]
            if isinstance(checkout_rules, list)
            else [],
            set_won_gifs=[str(item) for item in payload.get("set_won_gifs", []) if str(item).strip()]
            if isinstance(payload.get("set_won_gifs"), list)
            else [],
            match_won_gifs=[str(item) for item in payload.get("match_won_gifs", []) if str(item).strip()]
            if isinstance(payload.get("match_won_gifs"), list)
            else [],
        )

    def normalized(self) -> "GifReactionSettings":
        self.enabled = bool(self.enabled)
        self.duration_ms = max(500, min(10000, int(self.duration_ms or 1800)))
        self.score_rules = [rule.normalized("score", idx) for idx, rule in enumerate(self.score_rules)]
        self.checkout_rules = [rule.normalized("checkout", idx) for idx, rule in enumerate(self.checkout_rules)]
        self.set_won_gifs = [str(item) for item in self.set_won_gifs if str(item).strip()]
        self.match_won_gifs = [str(item) for item in self.match_won_gifs if str(item).strip()]
        return self


def _slugify(value: str) -> str:
    out = re.sub(r"[^a-z0-9_-]+", "-", str(value or "").strip().lower()).strip("-")
    return (out or "reaction")[:64]


def _save_settings(settings: GifReactionSettings) -> None:
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(json.dumps(asdict(settings), indent=2), encoding="utf-8")


def _default_settings() -> GifReactionSettings:
    return GifReactionSettings(
        score_rules=[
            GifReactionRule("score-180", "180", "exact_score", 180),
            GifReactionRule("score-140-plus", "140+", "min_score", 140),
            GifReactionRule("score-ton-plus", "100+", "min_score", 100),
        ],
        checkout_rules=[
            GifReactionRule("checkout-any", "Any checkout", "any_checkout"),
            GifReactionRule("checkout-100-plus", "100+ checkout", "min_checkout", 100),
            GifReactionRule("checkout-150-plus", "150+ checkout", "min_checkout", 150),
            GifReactionRule("checkout-170", "170 checkout", "exact_checkout", 170),
        ],
    ).normalized()


def get_gif_reaction_settings() -> dict[str, Any]:
    if SETTINGS_PATH.exists():
        try:
            raw = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            return asdict(GifReactionSettings.from_dict(raw if isinstance(raw, dict) else {}).normalized())
        except Exception:
            pass
    settings = _default_settings()
    _save_settings(settings)
    return asdict(settings)


def update_gif_reaction_settings(incoming: dict[str, Any]) -> dict[str, Any]:
    settings = GifReactionSettings.from_dict({**get_gif_reaction_settings(), **(incoming or {})}).normalized()
    _save_settings(settings)
    return asdict(settings)


def reset_gif_reaction_settings() -> dict[str, Any]:
    try:
        if UPLOAD_DIR.exists():
            for path in UPLOAD_DIR.rglob("*"):
                if path.is_file():
                    path.unlink()
    except Exception:
        pass
    settings = _default_settings()
    _save_settings(settings)
    return asdict(settings)


def _decode_upload(filename: str, content_base64: str) -> tuple[str, bytes]:
    suffix = Path(filename or "").suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        raise ValueError("unsupported GIF reaction file type")
    try:
        raw = base64.b64decode(str(content_base64 or ""), validate=True)
    except Exception as exc:
        raise ValueError("invalid GIF reaction file data") from exc
    if not raw:
        raise ValueError("GIF reaction file is empty")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise ValueError("GIF reaction file is too large")
    return suffix, raw


def upload_gif_reaction_file(target_type: str, rule_id: str | None, filename: str, content_base64: str) -> dict[str, Any]:
    target_type = str(target_type or "").strip().lower()
    rule_id = _slugify(rule_id or "")
    if target_type not in TARGETS_WITH_RULES | TARGETS_WITHOUT_RULES:
        raise ValueError("unknown GIF reaction target")
    if target_type in TARGETS_WITH_RULES and not rule_id:
        raise ValueError("rule id is required")
    suffix, raw = _decode_upload(filename, content_base64)

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    base_name = _slugify(Path(filename).stem)
    folder = UPLOAD_DIR / target_type / (rule_id if target_type in TARGETS_WITH_RULES else "default")
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{base_name}{suffix}"
    counter = 2
    while target.exists():
        target = folder / f"{base_name}-{counter}{suffix}"
        counter += 1
    target.write_bytes(raw)

    settings = GifReactionSettings.from_dict(get_gif_reaction_settings()).normalized()
    _append_file(settings, target_type, rule_id, str(target))
    _save_settings(settings)
    return asdict(settings)


def delete_gif_reaction_file(target_type: str, rule_id: str | None, file_path: str) -> dict[str, Any]:
    target_type = str(target_type or "").strip().lower()
    rule_id = _slugify(rule_id or "")
    if target_type not in TARGETS_WITH_RULES | TARGETS_WITHOUT_RULES:
        raise ValueError("unknown GIF reaction target")
    settings = GifReactionSettings.from_dict(get_gif_reaction_settings()).normalized()
    _remove_file(settings, target_type, rule_id, file_path)
    _save_settings(settings)
    try:
        path = Path(file_path)
        if path.is_file() and path.resolve().is_relative_to(UPLOAD_DIR.resolve()):
            path.unlink()
    except Exception:
        pass
    return asdict(settings)


def _append_file(settings: GifReactionSettings, target_type: str, rule_id: str, file_path: str) -> None:
    if target_type == "score":
        for rule in settings.score_rules:
            if rule.id == rule_id:
                rule.gifs.append(file_path)
                return
    if target_type == "checkout":
        for rule in settings.checkout_rules:
            if rule.id == rule_id:
                rule.gifs.append(file_path)
                return
    if target_type == "set_won":
        settings.set_won_gifs.append(file_path)
        return
    if target_type == "match_won":
        settings.match_won_gifs.append(file_path)
        return
    raise ValueError("GIF reaction rule was not found")


def _remove_file(settings: GifReactionSettings, target_type: str, rule_id: str, file_path: str) -> None:
    if target_type == "score":
        for rule in settings.score_rules:
            if rule.id == rule_id:
                rule.gifs = [item for item in rule.gifs if item != file_path]
                return
    if target_type == "checkout":
        for rule in settings.checkout_rules:
            if rule.id == rule_id:
                rule.gifs = [item for item in rule.gifs if item != file_path]
                return
    if target_type == "set_won":
        settings.set_won_gifs = [item for item in settings.set_won_gifs if item != file_path]
        return
    if target_type == "match_won":
        settings.match_won_gifs = [item for item in settings.match_won_gifs if item != file_path]
