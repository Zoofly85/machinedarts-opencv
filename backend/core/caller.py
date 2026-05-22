from __future__ import annotations

import json
import os
import queue
import random
import shutil
import subprocess
import sys
import threading
import time
from collections import deque
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable, Optional

from backend.core.detection_events import register_detection_event_listener
from backend.core.games.bots import NEXT_TARGET_DOUBLE_OUT, NEXT_TARGET_SINGLE_OUT

try:
    from playsound import playsound  # type: ignore
except Exception:
    playsound = None


def _resolve_settings_path() -> Path:
    if getattr(__import__("sys"), "frozen", False):
        if os.name == "nt":
            appdata = os.getenv("APPDATA", "").strip()
            base = Path(appdata).resolve() / "DartDetector" if appdata else Path.home() / "AppData" / "Roaming" / "DartDetector"
        else:
            xdg_data_home = os.getenv("XDG_DATA_HOME", "").strip()
            base = Path(xdg_data_home).resolve() if xdg_data_home else Path.home() / ".local" / "share"
            base = base / "DartDetector"
        return base / "settings" / "caller.json"
    return Path(__file__).resolve().parents[1] / "data" / "settings" / "caller.json"


def _default_voice_pack_candidates() -> list[Path]:
    candidates: list[Path] = []
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        # Support both direct side-by-side resources and updater layouts
        # like ...\Machine Darts\_up_\_up_\voice_packs\sound_english.
        up1 = exe_dir.parent
        up2 = up1.parent
        up3 = up2.parent
        up4 = up3.parent
        candidates.extend(
            [
                exe_dir / "voice_packs" / "sound_english",
                exe_dir / "resources" / "voice_packs" / "sound_english",
                up1 / "voice_packs" / "sound_english",
                up2 / "voice_packs" / "sound_english",
                up3 / "voice_packs" / "sound_english",
                up4 / "voice_packs" / "sound_english",
            ]
        )
    candidates.extend(
        [
            Path.cwd() / "voice_packs" / "sound_english",
            Path(__file__).resolve().parents[2] / "voice_packs" / "sound_english",
        ]
    )
    return candidates


def _default_voice_pack_path() -> str:
    candidates = _default_voice_pack_candidates()
    for c in candidates:
        if _is_usable_voice_pack(c):
            return str(c)
    return ""


SETTINGS_PATH = _resolve_settings_path()
SUPPORTED_EXTENSIONS = (".wav", ".mp3", ".ogg")
GAME_START_EVENTS = {
    "x01_started",
    "cricket_started",
    "around_the_clock_started",
    "shanghai_started",
    "beer_race_started",
    "bermuda_started",
    "bob27_started",
    "one_two_one_started",
    "target_trainer_started",
}
GAME_STOP_EVENTS = {
    "x01_stopped",
    "cricket_stopped",
    "around_the_clock_stopped",
    "shanghai_stopped",
    "beer_race_stopped",
    "bermuda_stopped",
    "bob27_stopped",
    "one_two_one_stopped",
    "target_trainer_stopped",
}
_LOCK = threading.Lock()
_SERVICE: Optional["CallerService"] = None
_CALLER_EVENT_LOCK = threading.Lock()
_CALLER_EVENTS: deque[dict[str, Any]] = deque(maxlen=250)
_CALLER_EVENT_SEQ = 0


def publish_caller_browser_event(tokens: list[str], queue_delay_ms: int) -> None:
    global _CALLER_EVENT_SEQ
    if not tokens:
        return
    with _CALLER_EVENT_LOCK:
        _CALLER_EVENT_SEQ += 1
        _CALLER_EVENTS.append(
            {
                "seq": _CALLER_EVENT_SEQ,
                "type": "caller_tokens",
                "tokens": list(tokens),
                "queue_delay_ms": max(0, int(queue_delay_ms or 0)),
                "ts": time.time(),
            }
        )


def get_latest_caller_event_seq() -> int:
    with _CALLER_EVENT_LOCK:
        return _CALLER_EVENT_SEQ


def get_caller_events_since(seq: int) -> list[dict[str, Any]]:
    with _CALLER_EVENT_LOCK:
        return [dict(ev) for ev in _CALLER_EVENTS if int(ev.get("seq", 0) or 0) > int(seq)]


def _env_bool(name: str) -> Optional[bool]:
    value = os.getenv(name)
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return None


def _apply_runtime_overrides(settings: CallerSettings) -> CallerSettings:
    browser_playback = _env_bool("MACHINE_DARTS_CALLER_BROWSER_PLAYBACK")
    local_playback = _env_bool("MACHINE_DARTS_CALLER_LOCAL_PLAYBACK")
    if browser_playback is not None:
        settings.browser_playback_enabled = browser_playback
    if local_playback is not None:
        settings.local_playback_enabled = local_playback
    return settings


def _linux_player_command(clip: Path) -> list[str] | None:
    ext = clip.suffix.lower()
    gst_play = shutil.which("gst-play-1.0")
    if gst_play:
        return [gst_play, "--no-interactive", str(clip)]

    ffplay = shutil.which("ffplay")
    if ffplay:
        return [ffplay, "-nodisp", "-autoexit", "-loglevel", "quiet", str(clip)]

    mpg123 = shutil.which("mpg123")
    if mpg123 and ext == ".mp3":
        return [mpg123, "-q", str(clip)]

    paplay = shutil.which("paplay")
    if paplay and ext == ".wav":
        return [paplay, str(clip)]

    aplay = shutil.which("aplay")
    if aplay and ext == ".wav":
        return [aplay, "-q", str(clip)]

    return None


def _play_clip(clip: Path) -> None:
    if sys.platform.startswith("linux"):
        cmd = _linux_player_command(clip)
        if cmd is not None:
            subprocess.run(
                cmd,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return

    if playsound is None:
        raise RuntimeError("no playback backend available")
    playsound(str(clip), block=True)  # type: ignore[call-arg]


def _is_usable_voice_pack(path: Optional[Path]) -> bool:
    if path is None or not path.exists() or not path.is_dir():
        return False
    stems: set[str] = set()
    has_audio = False
    try:
        for p in path.iterdir():
            if not p.is_file() or p.suffix.lower() not in SUPPORTED_EXTENSIONS:
                continue
            has_audio = True
            stems.add(p.stem.lower())
    except Exception:
        return False
    if not has_audio:
        return False
    # Minimal caller viability: at least one common score token or game-on clip.
    if any(token in stems for token in ("0", "1", "20", "180", "gameon", "game_on")):
        return True
    return False


@dataclass
class CallerSettings:
    enabled: bool = True
    voice_pack_path: str = ""
    queue_delay_ms: int = 150
    call_dart_score: bool = True
    call_turn_change: bool = True
    call_game_events: bool = True
    call_corrections: bool = True
    call_required_score: bool = True
    call_leg_win: bool = True
    call_set_win: bool = True
    call_match_win: bool = True
    score_call_mode: str = "turn_total"  # per_dart | turn_total
    browser_playback_enabled: bool = True
    local_playback_enabled: bool = True

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "CallerSettings":
        out = cls()
        for key in cls.__dataclass_fields__.keys():  # type: ignore[attr-defined]
            if key in payload:
                setattr(out, key, payload[key])
        return out

    def normalized(self) -> "CallerSettings":
        self.voice_pack_path = str(Path(self.voice_pack_path).expanduser()) if self.voice_pack_path else ""
        self.queue_delay_ms = max(0, int(self.queue_delay_ms))
        mode = str(self.score_call_mode or "per_dart").strip().lower()
        self.score_call_mode = mode if mode in {"per_dart", "turn_total"} else "per_dart"
        return self


def _load_settings() -> CallerSettings:
    if SETTINGS_PATH.exists():
        try:
            raw = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            settings = CallerSettings.from_dict(raw if isinstance(raw, dict) else {})
            settings = settings.normalized()
            current_path = Path(settings.voice_pack_path) if settings.voice_pack_path else None
            current_valid = _is_usable_voice_pack(current_path)
            if not current_valid:
                fallback = _default_voice_pack_path()
                if fallback:
                    settings.voice_pack_path = fallback
                    _save_settings(settings)
            return _apply_runtime_overrides(settings)
        except Exception:
            pass
    settings = CallerSettings(voice_pack_path=_default_voice_pack_path()).normalized()
    _save_settings(settings)
    return _apply_runtime_overrides(settings)


def _save_settings(settings: CallerSettings) -> None:
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(json.dumps(asdict(settings), indent=2), encoding="utf-8")


def _slugify(token: Any) -> str:
    if token is None:
        return ""
    s = str(token).strip().lower()
    if not s:
        return ""
    out: list[str] = []
    for ch in s:
        if ch.isalnum():
            out.append(ch)
        elif ch in {" ", "-", "_"}:
            out.append("_")
    slug = "".join(out).strip("_")
    while "__" in slug:
        slug = slug.replace("__", "_")
    return slug


class CallerService:
    def __init__(self) -> None:
        self._settings = _load_settings()
        self._catalog: dict[str, Path] = {}
        self._queue: "queue.Queue[list[str]]" = queue.Queue()
        self._worker = threading.Thread(target=self._worker_loop, name="caller-worker", daemon=True)
        self._worker.start()
        self._last_announced_turn_key: str = ""
        self._last_required_key: str = ""
        self._last_leg_win_key: str = ""
        self._last_set_win_key: str = ""
        self._last_match_win_key: str = ""
        self._last_bust_key: str = ""
        self._last_state_dart_key: str = ""
        self._refresh_catalog()
        register_detection_event_listener(self.on_event)

    def get_settings(self) -> dict[str, Any]:
        return asdict(self._settings)

    def update_settings(self, incoming: dict[str, Any]) -> dict[str, Any]:
        s = CallerSettings.from_dict({**asdict(self._settings), **(incoming or {})}).normalized()
        s = _apply_runtime_overrides(s)
        self._settings = s
        _save_settings(s)
        self._refresh_catalog()
        return asdict(s)

    def reset_to_default_voice_pack(self) -> dict[str, Any]:
        fallback = _default_voice_pack_path()
        if fallback:
            self._settings.voice_pack_path = fallback
            _save_settings(self._settings)
            self._refresh_catalog()
        return asdict(self._settings)

    def play_tokens(self, tokens: Iterable[Any]) -> None:
        if not self._settings.enabled:
            return
        slugs = [_slugify(t) for t in tokens]
        slugs = [s for s in slugs if s]
        if not slugs:
            return
        if self._settings.browser_playback_enabled:
            publish_caller_browser_event(slugs, self._settings.queue_delay_ms)
        if self._settings.local_playback_enabled:
            self._queue.put(slugs)

    def resolve_clip_path(self, token: Any) -> Optional[Path]:
        return self._resolve_clip(token)

    def play_test(self) -> None:
        for t in ("20", "180", "0", "game_on", "player_1", "miss"):
            if self._resolve_clip(t):
                self.play_tokens([t])
                return

    def on_event(self, event: dict[str, Any]) -> None:
        if not self._settings.enabled:
            return
        etype = str(event.get("type", "") or "")
        try:
            if (
                etype == "dart_score"
                and self._settings.call_dart_score
                and self._settings.score_call_mode == "per_dart"
            ):
                score_value = int(event.get("score_value", 0) or 0)
                self.play_tokens(["miss" if score_value <= 0 else score_value])
                return

            if etype == "dart_score_corrected" and self._settings.call_corrections:
                value = int(event.get("corrected_score_value", 0) or 0)
                if self._settings.call_dart_score and self._settings.score_call_mode == "turn_total":
                    # In turn-total mode, correction should announce the updated turn total.
                    return
                self.play_tokens(["corrected", value if value > 0 else "miss"])
                return

            if etype.endswith("_state_updated"):
                source = str(event.get("source", "") or "")
                state = event.get("state", {}) if isinstance(event.get("state"), dict) else {}
                mode = etype[: -len("_state_updated")] if etype.endswith("_state_updated") else ""
                if mode == "x01" and self._settings.call_dart_score:
                    bust_key = self._extract_x01_bust_key(state)
                    if bust_key and bust_key != self._last_bust_key:
                        self._last_bust_key = bust_key
                        self.play_tokens(["bust"])

                if (
                    mode == "x01"
                    and source == "bot_dart"
                    and self._settings.call_dart_score
                    and self._settings.score_call_mode == "per_dart"
                ):
                    bot_dart_score = self._extract_x01_bot_dart_score(event, state)
                    if bot_dart_score is not None:
                        self.play_tokens(["miss" if bot_dart_score <= 0 else bot_dart_score])

                if (
                    mode == "x01"
                    and source == "remote_dart"
                    and self._settings.call_dart_score
                    and self._settings.score_call_mode == "per_dart"
                ):
                    remote_dart_key, remote_dart_score = self._extract_x01_state_dart_score(state)
                    if remote_dart_key and remote_dart_score is not None and remote_dart_key != self._last_state_dart_key:
                        self._last_state_dart_key = remote_dart_key
                        self.play_tokens(["miss" if remote_dart_score <= 0 else remote_dart_score])

                if self._settings.call_dart_score and self._settings.score_call_mode == "turn_total":
                    should_call_total = False
                    prefer_current = False
                    if source == "dart_score":
                        try:
                            should_call_total = int(event.get("dart_index", -1)) >= 2
                        except Exception:
                            should_call_total = False
                        prefer_current = True
                    elif source == "dart_score_corrected":
                        should_call_total = True
                        prefer_current = True
                    elif source in {"bot_turn", "force_next_turn", "remote_turn", "remote_turn_commit"}:
                        should_call_total = True
                    if should_call_total:
                        total = self._extract_turn_total(state, prefer_current=prefer_current)
                        if total is not None:
                            self.play_tokens(["miss" if total <= 0 else total])

                if mode == "x01" and self._settings.call_required_score and source in {"takeout_complete", "bot_turn", "force_next_turn", "remote_turn", "remote_turn_commit"}:
                    required = self._extract_required_score(state)
                    out_mode = self._extract_x01_out_mode(state)
                    if required is not None and self._is_checkout_prompt_score(required, out_mode):
                        req_key = f"{mode}:{state.get('currentPlayer')}:{out_mode}:{required}"
                        if req_key != self._last_required_key:
                            self._last_required_key = req_key
                            self.play_tokens(["you_require", required])

                if mode == "x01":
                    self._maybe_announce_x01_wins(state, mode)

                if not self._settings.call_turn_change:
                    return
                if source not in {"takeout_complete", "bot_turn", "force_next_turn", "remote_turn", "remote_turn_commit"}:
                    return
                current_player = state.get("currentPlayer")
                players = state.get("players", []) if isinstance(state.get("players"), list) else []
                name = ""
                if isinstance(current_player, int) and 0 <= current_player < len(players):
                    p = players[current_player]
                    if isinstance(p, dict):
                        name = str(p.get("name", "") or "")
                turn_key = f"{etype}:{current_player}:{name}"
                if turn_key == self._last_announced_turn_key:
                    return
                self._last_announced_turn_key = turn_key
                if name:
                    self.play_tokens(["next_player", name])
                elif isinstance(current_player, int):
                    self.play_tokens(["next_player", f"player_{current_player + 1}"])
                return

            if self._settings.call_game_events and etype in GAME_START_EVENTS:
                self.play_tokens(["game_on"])
                return
            if self._settings.call_game_events and etype in GAME_STOP_EVENTS:
                self.play_tokens(["game_stopped"])
                return
        except Exception:
            return

    @staticmethod
    def _extract_x01_bust_key(state: dict[str, Any]) -> Optional[str]:
        current_turn = state.get("currentTurn")
        if not isinstance(current_turn, dict):
            return None
        if not bool(current_turn.get("bust")):
            return None
        current_player = state.get("currentPlayer")
        turn_index = current_turn.get("turnIndex")
        darts_used = current_turn.get("dartsUsed")
        score_before = current_turn.get("scoreBefore")
        return f"x01:{current_player}:{turn_index}:{darts_used}:{score_before}"

    @staticmethod
    def _extract_turn_total(state: dict[str, Any], *, prefer_current: bool = False) -> Optional[int]:
        def _sum_darts(arr: Any) -> Optional[int]:
            if not isinstance(arr, list):
                return None
            total = 0
            seen = False
            for d in arr:
                if not isinstance(d, dict):
                    continue
                try:
                    total += int(d.get("score", 0) or 0)
                    seen = True
                except Exception:
                    continue
            return total if seen else None

        def _extract_from_turn(turn: Any) -> Optional[int]:
            if isinstance(turn, dict):
                if "scored" in turn:
                    try:
                        return int(turn.get("scored", 0) or 0)
                    except Exception:
                        pass
                if "roundScore" in turn:
                    try:
                        return int(turn.get("roundScore", 0) or 0)
                    except Exception:
                        pass
                if "pendingTotal" in turn:
                    try:
                        return int(turn.get("pendingTotal", 0) or 0)
                    except Exception:
                        pass
                if "scores" in turn and isinstance(turn.get("scores"), list):
                    try:
                        return int(sum(int(x or 0) for x in turn.get("scores", [])))
                    except Exception:
                        pass
                dart_sum = _sum_darts(turn.get("darts"))
                if dart_sum is not None:
                    return int(dart_sum)
            elif isinstance(turn, list):
                dart_sum = _sum_darts(turn)
                if dart_sum is not None:
                    return int(dart_sum)
            return None

        current_turn = state.get("currentTurn")
        last_turn = state.get("lastTurn")
        last_committed_turn = state.get("lastCommittedTurn")
        order = (current_turn, last_committed_turn, last_turn) if prefer_current else (last_committed_turn, last_turn, current_turn)
        for turn in order:
            total = _extract_from_turn(turn)
            if total is not None:
                return total
        return None

    @staticmethod
    def _extract_x01_state_dart_score(state: dict[str, Any]) -> tuple[Optional[str], Optional[int]]:
        current_turn = state.get("currentTurn")
        if not isinstance(current_turn, dict):
            return None, None
        try:
            darts_used = int(current_turn.get("dartsUsed", 0) or 0)
        except Exception:
            return None, None
        if darts_used <= 0:
            return None, None

        applied = current_turn.get("appliedScores")
        if not isinstance(applied, list) or darts_used > len(applied):
            return None, None

        try:
            score = int(applied[darts_used - 1] or 0)
        except Exception:
            return None, None

        key = f"x01:{state.get('currentPlayer')}:{current_turn.get('turnIndex')}:{darts_used}:{score}"
        return key, score

    def _refresh_catalog(self) -> None:
        self._catalog.clear()
        root = Path(self._settings.voice_pack_path) if self._settings.voice_pack_path else None
        if not _is_usable_voice_pack(root):
            fallback = _default_voice_pack_path()
            root = Path(fallback) if fallback else None
            if root is not None:
                print(f"[caller] using bundled voice pack: {root}")
                if self._settings.voice_pack_path != str(root):
                    self._settings.voice_pack_path = str(root)
                    _save_settings(self._settings)
        if not _is_usable_voice_pack(root):
            return
        for p in root.iterdir():
            if p.is_file() and p.suffix.lower() in SUPPORTED_EXTENSIONS:
                self._catalog[p.stem.lower()] = p

    def _resolve_clip(self, token: str) -> Optional[Path]:
        slug = _slugify(token)
        if not slug:
            return None
        candidates: list[Path] = []
        alias_map: dict[str, list[str]] = {
            # Many packs name this token as "busted" instead of "bust".
            "bust": ["busted"],
        }
        slugs_to_try = [slug, *alias_map.get(slug, [])]
        for base_slug in slugs_to_try:
            clip = self._catalog.get(base_slug)
            if clip is not None:
                candidates.append(clip)

        # Common fallback for packs that avoid underscores (e.g. gameon vs game_on).
        compact_slugs: list[str] = []
        for base_slug in slugs_to_try:
            compact = base_slug.replace("_", "")
            if compact and compact != base_slug:
                compact_slugs.append(compact)
                clip = self._catalog.get(compact)
                if clip is not None:
                    candidates.append(clip)

        # Optional alternate takes with +1..+8 suffix.
        for suffix in ("+1", "+2", "+3", "+4", "+5", "+6", "+7", "+8"):
            for base_slug in slugs_to_try:
                alt = f"{base_slug}{suffix}"
                clip = self._catalog.get(alt)
                if clip is not None:
                    candidates.append(clip)
            for compact in compact_slugs:
                alt_compact = f"{compact}{suffix}"
                clip = self._catalog.get(alt_compact)
                if clip is not None:
                    candidates.append(clip)

        if not candidates:
            return None
        return random.choice(candidates)

    @staticmethod
    def _extract_required_score(state: dict[str, Any]) -> Optional[int]:
        current_player = state.get("currentPlayer")
        players = state.get("players")
        if not isinstance(current_player, int) or not isinstance(players, list):
            return None
        if not (0 <= current_player < len(players)):
            return None
        player = players[current_player]
        if not isinstance(player, dict):
            return None
        for key in ("score", "remaining"):
            if key in player:
                try:
                    return int(player.get(key, 0) or 0)
                except Exception:
                    return None
        return None

    @staticmethod
    def _extract_x01_out_mode(state: dict[str, Any]) -> str:
        current_player = state.get("currentPlayer")
        players = state.get("players")
        if isinstance(current_player, int) and isinstance(players, list) and 0 <= current_player < len(players):
            player = players[current_player]
            if isinstance(player, dict):
                player_mode = str(player.get("outMode", "") or "").strip().lower()
                if player_mode in {"double", "straight"}:
                    return player_mode
        mode = str(state.get("outMode", "") or "").strip().lower()
        if mode in {"double", "straight"}:
            return mode
        return "double"

    @staticmethod
    def _is_checkout_prompt_score(remaining: int, out_mode: str) -> bool:
        if remaining <= 0:
            return False
        if out_mode == "straight":
            return int(remaining) in NEXT_TARGET_SINGLE_OUT
        return int(remaining) in NEXT_TARGET_DOUBLE_OUT

    @staticmethod
    def _extract_x01_bot_dart_score(event: dict[str, Any], state: dict[str, Any]) -> Optional[int]:
        current_turn = state.get("currentTurn")
        if not isinstance(current_turn, dict):
            return None

        dart_index = event.get("dart_index")
        try:
            idx = int(dart_index)
        except Exception:
            idx = None

        applied = current_turn.get("appliedScores")
        if isinstance(applied, list) and idx is not None and 0 <= idx < len(applied):
            try:
                return int(applied[idx] or 0)
            except Exception:
                pass

        darts = current_turn.get("darts")
        if isinstance(darts, list) and idx is not None and 0 <= idx < len(darts):
            dart = darts[idx]
            if isinstance(dart, dict):
                try:
                    return int(dart.get("score", 0) or 0)
                except Exception:
                    return None
        return None

    def _maybe_announce_x01_wins(self, state: dict[str, Any], mode: str) -> None:
        leg_winner = state.get("legWinner")
        set_winner = state.get("setWinner")
        match_winner = state.get("matchWinner")
        players = state.get("players", []) if isinstance(state.get("players"), list) else []

        if self._settings.call_leg_win and isinstance(leg_winner, int):
            leg_count: Optional[int] = None
            if 0 <= leg_winner < len(players) and isinstance(players[leg_winner], dict):
                try:
                    leg_count = int(players[leg_winner].get("legsWon", 0) or 0)
                except Exception:
                    leg_count = None
            leg_key = f"{mode}:{leg_winner}:{leg_count}"
            if leg_key != self._last_leg_win_key:
                self._last_leg_win_key = leg_key
                token = f"gameshot_l{leg_count}_n" if leg_count and leg_count > 0 else ""
                if token and self._resolve_clip(token):
                    self.play_tokens([token])
                elif leg_count and self._resolve_clip(f"leg_{leg_count}"):
                    self.play_tokens(["leg", leg_count])
                else:
                    self.play_tokens(["leg"])

        if self._settings.call_set_win and isinstance(set_winner, int):
            set_count: Optional[int] = None
            if 0 <= set_winner < len(players) and isinstance(players[set_winner], dict):
                try:
                    set_count = int(players[set_winner].get("setsWon", 0) or 0)
                except Exception:
                    set_count = None
            set_key = f"{mode}:{set_winner}:{set_count}"
            if set_key != self._last_set_win_key:
                self._last_set_win_key = set_key
                if set_count and self._resolve_clip(f"set_{set_count}"):
                    self.play_tokens(["set", set_count])
                else:
                    self.play_tokens(["set"])

        if self._settings.call_match_win and isinstance(match_winner, int):
            match_key = f"{mode}:{match_winner}"
            if match_key != self._last_match_win_key:
                self._last_match_win_key = match_key
                if self._resolve_clip("matchshot"):
                    self.play_tokens(["matchshot"])

    def _worker_loop(self) -> None:
        while True:
            tokens = self._queue.get()
            try:
                for token in tokens:
                    clip = self._resolve_clip(token)
                    if clip is None:
                        print(f"[caller] missing clip: {token}")
                        continue
                    if sys.platform.startswith("linux"):
                        cmd = _linux_player_command(clip)
                        backend = Path(cmd[0]).name if cmd else ("playsound" if playsound is not None else "none")
                        print(f"[caller] token={token} backend={backend} clip={clip}")
                    elif playsound is None:
                        print(f"[caller] playsound missing; token={token}")
                    _play_clip(clip)
                    if self._settings.queue_delay_ms > 0:
                        time.sleep(self._settings.queue_delay_ms / 1000.0)
            except Exception as exc:
                print(f"[caller] playback error: {exc}")
            finally:
                self._queue.task_done()


def get_caller_service() -> CallerService:
    global _SERVICE
    with _LOCK:
        if _SERVICE is None:
            _SERVICE = CallerService()
        return _SERVICE


def get_default_voice_pack_path() -> str:
    return _default_voice_pack_path()
