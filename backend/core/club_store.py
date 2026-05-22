from __future__ import annotations

import json
import os
import sqlite3
import sys
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _resolve_db_path() -> Path:
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        return exe_dir / "backend" / "data" / "club" / "club.sqlite"
    return Path(__file__).resolve().parents[1] / "data" / "club" / "club.sqlite"


def _to_dt(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:
        return None


class ClubStore:
    def __init__(self) -> None:
        self._db_path = _resolve_db_path()
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._init_schema()

    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(str(self._db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def _init_schema(self) -> None:
        with self._lock, self._conn() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS boards (
                    board_id TEXT PRIMARY KEY,
                    venue_id TEXT NOT NULL,
                    machine_id TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'idle',
                    shell TEXT NOT NULL DEFAULT '',
                    active_game TEXT NOT NULL DEFAULT '',
                    fps REAL,
                    last_seen_at TEXT NOT NULL,
                    heartbeat_payload TEXT NOT NULL DEFAULT '{}'
                );

                CREATE TABLE IF NOT EXISTS sessions (
                    session_id TEXT PRIMARY KEY,
                    board_id TEXT NOT NULL,
                    venue_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    operator TEXT NOT NULL,
                    notes TEXT NOT NULL DEFAULT '',
                    started_at TEXT NOT NULL,
                    stopped_at TEXT,
                    status TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_sessions_board_started ON sessions(board_id, started_at);

                CREATE TABLE IF NOT EXISTS board_policies (
                    board_id TEXT PRIMARY KEY,
                    policy_id TEXT NOT NULL,
                    policy_name TEXT NOT NULL,
                    lock_detection_settings INTEGER NOT NULL,
                    lock_runtime_settings INTEGER NOT NULL,
                    lock_calibration INTEGER NOT NULL,
                    lock_game_presets INTEGER NOT NULL,
                    applied_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS social_nights (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    starts_at TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    status TEXT NOT NULL,
                    board_ids_json TEXT NOT NULL DEFAULT '[]',
                    leaderboard_json TEXT NOT NULL DEFAULT '[]',
                    plan_json TEXT NOT NULL DEFAULT '{}',
                    results_json TEXT NOT NULL DEFAULT '{}',
                    playoffs_json TEXT NOT NULL DEFAULT '{}'
                );

                CREATE TABLE IF NOT EXISTS tournaments (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    starts_at TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    status TEXT NOT NULL,
                    board_ids_json TEXT NOT NULL DEFAULT '[]',
                    notes TEXT NOT NULL DEFAULT ''
                );

                CREATE TABLE IF NOT EXISTS sync_events (
                    event_id TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    received_at TEXT NOT NULL
                );
                """
            )
            cols = conn.execute("PRAGMA table_info(boards)").fetchall()
            names = {str(r["name"]) for r in cols}
            if "machine_id" not in names:
                conn.execute("ALTER TABLE boards ADD COLUMN machine_id TEXT NOT NULL DEFAULT ''")
            social_cols = conn.execute("PRAGMA table_info(social_nights)").fetchall()
            social_names = {str(r["name"]) for r in social_cols}
            if "plan_json" not in social_names:
                conn.execute("ALTER TABLE social_nights ADD COLUMN plan_json TEXT NOT NULL DEFAULT '{}'")
            if "results_json" not in social_names:
                conn.execute("ALTER TABLE social_nights ADD COLUMN results_json TEXT NOT NULL DEFAULT '{}'")
            if "playoffs_json" not in social_names:
                conn.execute("ALTER TABLE social_nights ADD COLUMN playoffs_json TEXT NOT NULL DEFAULT '{}'")

    def upsert_board_heartbeat(
        self,
        *,
        board_id: str,
        venue_id: str,
        machine_id: str,
        status: str,
        shell: str,
        active_game: str,
        fps: Optional[float],
        payload: dict[str, Any],
    ) -> dict[str, Any] | None:
        now = _utc_now()
        with self._lock, self._conn() as conn:
            existing = conn.execute(
                "SELECT machine_id FROM boards WHERE board_id=?",
                (board_id,),
            ).fetchone()
            if existing is not None:
                existing_machine = str(existing["machine_id"] or "")
                if existing_machine and machine_id and existing_machine != machine_id:
                    return None
            conn.execute(
                """
                INSERT INTO boards(board_id, venue_id, machine_id, status, shell, active_game, fps, last_seen_at, heartbeat_payload)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(board_id) DO UPDATE SET
                  venue_id=excluded.venue_id,
                  machine_id=excluded.machine_id,
                  status=excluded.status,
                  shell=excluded.shell,
                  active_game=excluded.active_game,
                  fps=excluded.fps,
                  last_seen_at=excluded.last_seen_at,
                  heartbeat_payload=excluded.heartbeat_payload
                """,
                (
                    board_id,
                    venue_id,
                    machine_id,
                    status,
                    shell,
                    active_game,
                    fps,
                    now,
                    json.dumps(payload or {}),
                ),
            )
        return {
            "board_id": board_id,
            "venue_id": venue_id,
            "machine_id": machine_id,
            "status": status,
            "shell": shell,
            "active_game": active_game,
            "fps": fps,
            "last_seen_at": now,
        }

    def register_board(self, *, board_id: str, venue_id: str, machine_id: str, shell: str) -> tuple[bool, dict[str, Any]]:
        now = _utc_now()
        with self._lock, self._conn() as conn:
            existing = conn.execute(
                "SELECT board_id, venue_id, machine_id, shell, last_seen_at FROM boards WHERE board_id=?",
                (board_id,),
            ).fetchone()
            if existing is not None:
                existing_machine = str(existing["machine_id"] or "")
                if existing_machine and machine_id and existing_machine != machine_id:
                    return False, {
                        "board_id": board_id,
                        "venue_id": str(existing["venue_id"]),
                        "machine_id": existing_machine,
                        "shell": str(existing["shell"] or ""),
                        "last_seen_at": str(existing["last_seen_at"] or ""),
                    }
            conn.execute(
                """
                INSERT INTO boards(board_id, venue_id, machine_id, status, shell, active_game, fps, last_seen_at, heartbeat_payload)
                VALUES(?, ?, ?, 'idle', ?, '', NULL, ?, '{}')
                ON CONFLICT(board_id) DO UPDATE SET
                  venue_id=excluded.venue_id,
                  machine_id=excluded.machine_id,
                  shell=excluded.shell,
                  last_seen_at=excluded.last_seen_at
                """,
                (board_id, venue_id, machine_id, shell, now),
            )
        return True, {
            "board_id": board_id,
            "venue_id": venue_id,
            "machine_id": machine_id,
            "shell": shell,
            "last_seen_at": now,
        }

    def list_boards(self, *, venue_id: str, seed_board_ids: list[str]) -> list[dict[str, Any]]:
        with self._lock, self._conn() as conn:
            rows = conn.execute(
                """
                SELECT b.board_id, b.venue_id, b.machine_id, b.status, b.shell, b.active_game, b.fps, b.last_seen_at, b.heartbeat_payload
                FROM boards b
                WHERE b.venue_id = ?
                ORDER BY b.board_id
                """,
                (venue_id,),
            ).fetchall()
            sessions = conn.execute(
                """
                SELECT session_id, board_id, title, operator, notes, started_at, stopped_at, status
                FROM sessions
                WHERE venue_id = ? AND status = 'active'
                """,
                (venue_id,),
            ).fetchall()
            policies = conn.execute(
                """
                SELECT board_id, policy_id, policy_name, lock_detection_settings, lock_runtime_settings,
                       lock_calibration, lock_game_presets, applied_at
                FROM board_policies
                """,
            ).fetchall()

        sessions_by_board = {str(r["board_id"]): dict(r) for r in sessions}
        policies_by_board = {str(r["board_id"]): dict(r) for r in policies}
        result: dict[str, dict[str, Any]] = {}
        for row in rows:
            bid = str(row["board_id"])
            result[bid] = {
                "board_id": bid,
                "venue_id": str(row["venue_id"]),
                "machine_id": str(row["machine_id"] or ""),
                "status": str(row["status"] or "idle"),
                "shell": str(row["shell"] or ""),
                "active_game": str(row["active_game"] or ""),
                "fps": row["fps"],
                "last_seen_at": str(row["last_seen_at"] or ""),
                "active_session": sessions_by_board.get(bid),
                "policy": policies_by_board.get(bid),
            }

        for bid in seed_board_ids:
            if bid not in result:
                result[bid] = {
                    "board_id": bid,
                    "venue_id": venue_id,
                    "machine_id": "",
                    "status": "idle",
                    "shell": "",
                    "active_game": "",
                    "fps": None,
                    "last_seen_at": "",
                    "active_session": sessions_by_board.get(bid),
                    "policy": policies_by_board.get(bid),
                }
        return [result[k] for k in sorted(result.keys())]

    def start_session(
        self,
        *,
        session_id: str,
        board_id: str,
        venue_id: str,
        title: str,
        operator: str,
        notes: str,
    ) -> dict[str, Any]:
        now = _utc_now()
        with self._lock, self._conn() as conn:
            conn.execute(
                "UPDATE sessions SET status='closed', stopped_at=? WHERE board_id=? AND status='active'",
                (now, board_id),
            )
            conn.execute(
                """
                INSERT INTO sessions(session_id, board_id, venue_id, title, operator, notes, started_at, stopped_at, status)
                VALUES(?, ?, ?, ?, ?, ?, ?, NULL, 'active')
                """,
                (session_id, board_id, venue_id, title, operator, notes, now),
            )
        return {
            "session_id": session_id,
            "board_id": board_id,
            "title": title,
            "operator": operator,
            "notes": notes,
            "started_at": now,
            "stopped_at": None,
            "status": "active",
        }

    def stop_session(self, *, board_id: str) -> Optional[dict[str, Any]]:
        now = _utc_now()
        with self._lock, self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM sessions WHERE board_id=? AND status='active' ORDER BY started_at DESC LIMIT 1",
                (board_id,),
            ).fetchone()
            if row is None:
                return None
            conn.execute(
                "UPDATE sessions SET status='closed', stopped_at=? WHERE session_id=?",
                (now, str(row["session_id"])),
            )
        out = dict(row)
        out["status"] = "closed"
        out["stopped_at"] = now
        return out

    def apply_policy(
        self,
        *,
        board_id: str,
        policy_id: str,
        policy_name: str,
        lock_detection_settings: bool,
        lock_runtime_settings: bool,
        lock_calibration: bool,
        lock_game_presets: bool,
    ) -> dict[str, Any]:
        now = _utc_now()
        with self._lock, self._conn() as conn:
            conn.execute(
                """
                INSERT INTO board_policies(board_id, policy_id, policy_name, lock_detection_settings,
                                          lock_runtime_settings, lock_calibration, lock_game_presets, applied_at)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(board_id) DO UPDATE SET
                  policy_id=excluded.policy_id,
                  policy_name=excluded.policy_name,
                  lock_detection_settings=excluded.lock_detection_settings,
                  lock_runtime_settings=excluded.lock_runtime_settings,
                  lock_calibration=excluded.lock_calibration,
                  lock_game_presets=excluded.lock_game_presets,
                  applied_at=excluded.applied_at
                """,
                (
                    board_id,
                    policy_id,
                    policy_name,
                    int(lock_detection_settings),
                    int(lock_runtime_settings),
                    int(lock_calibration),
                    int(lock_game_presets),
                    now,
                ),
            )
        return {
            "board_id": board_id,
            "policy_id": policy_id,
            "policy_name": policy_name,
            "lock_detection_settings": lock_detection_settings,
            "lock_runtime_settings": lock_runtime_settings,
            "lock_calibration": lock_calibration,
            "lock_game_presets": lock_game_presets,
            "applied_at": now,
        }

    def create_social_night(
        self,
        *,
        social_id: str,
        name: str,
        starts_at: str,
        board_ids: list[str],
        plan: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = _utc_now()
        with self._lock, self._conn() as conn:
            conn.execute(
                """
                INSERT INTO social_nights(id, name, starts_at, created_at, status, board_ids_json, leaderboard_json, plan_json, results_json, playoffs_json)
                VALUES(?, ?, ?, ?, 'active', ?, '[]', ?, '{}', '{}')
                """,
                (social_id, name, starts_at, now, json.dumps(board_ids), json.dumps(plan or {})),
            )
        return {
            "id": social_id,
            "name": name,
            "starts_at": starts_at,
            "board_ids": list(board_ids),
            "created_at": now,
            "status": "active",
            "leaderboard": [],
            "plan": dict(plan or {}),
            "results": {},
            "playoffs": {},
        }

    def create_tournament(
        self,
        *,
        tournament_id: str,
        name: str,
        starts_at: str,
        board_ids: list[str],
        notes: str,
    ) -> dict[str, Any]:
        now = _utc_now()
        with self._lock, self._conn() as conn:
            conn.execute(
                """
                INSERT INTO tournaments(id, name, starts_at, created_at, status, board_ids_json, notes)
                VALUES(?, ?, ?, ?, 'active', ?, ?)
                """,
                (tournament_id, name, starts_at, now, json.dumps(board_ids), notes),
            )
        return {
            "id": tournament_id,
            "name": name,
            "starts_at": starts_at,
            "created_at": now,
            "status": "active",
            "board_ids": list(board_ids),
            "notes": notes,
        }

    def get_social_night(self, social_id: str) -> Optional[dict[str, Any]]:
        with self._lock, self._conn() as conn:
            row = conn.execute("SELECT * FROM social_nights WHERE id=?", (social_id,)).fetchone()
        if row is None:
            return None
        return {
            "id": str(row["id"]),
            "name": str(row["name"]),
            "starts_at": str(row["starts_at"]),
            "created_at": str(row["created_at"]),
            "status": str(row["status"]),
            "board_ids": json.loads(str(row["board_ids_json"] or "[]")),
            "leaderboard": json.loads(str(row["leaderboard_json"] or "[]")),
            "plan": json.loads(str(row["plan_json"] or "{}")),
            "results": json.loads(str(row["results_json"] or "{}")),
            "playoffs": json.loads(str(row["playoffs_json"] or "{}")),
        }

    def list_active_social_nights(self) -> list[dict[str, Any]]:
        with self._lock, self._conn() as conn:
            rows = conn.execute(
                """
                SELECT * FROM social_nights
                WHERE status='active'
                ORDER BY starts_at ASC, created_at ASC
                """
            ).fetchall()
        out: list[dict[str, Any]] = []
        for row in rows:
            out.append(
                {
                    "id": str(row["id"]),
                    "name": str(row["name"]),
                    "starts_at": str(row["starts_at"]),
                    "created_at": str(row["created_at"]),
                    "status": str(row["status"]),
                    "board_ids": json.loads(str(row["board_ids_json"] or "[]")),
                    "leaderboard": json.loads(str(row["leaderboard_json"] or "[]")),
                    "plan": json.loads(str(row["plan_json"] or "{}")),
                    "results": json.loads(str(row["results_json"] or "{}")),
                    "playoffs": json.loads(str(row["playoffs_json"] or "{}")),
                }
            )
        return out

    def upsert_social_night_result(
        self,
        *,
        social_id: str,
        match_id: str,
        winner: str,
        score_a: Optional[int],
        score_b: Optional[int],
    ) -> dict[str, Any] | None:
        with self._lock, self._conn() as conn:
            row = conn.execute("SELECT results_json FROM social_nights WHERE id=?", (social_id,)).fetchone()
            if row is None:
                return None
            try:
                current = json.loads(str(row["results_json"] or "{}"))
                if not isinstance(current, dict):
                    current = {}
            except Exception:
                current = {}
            current[str(match_id)] = {
                "winner": str(winner),
                "score_a": int(score_a) if score_a is not None else None,
                "score_b": int(score_b) if score_b is not None else None,
                "updated_at": _utc_now(),
            }
            conn.execute(
                "UPDATE social_nights SET results_json=? WHERE id=?",
                (json.dumps(current), social_id),
            )
        return current.get(str(match_id))

    def set_social_night_playoffs(self, *, social_id: str, playoffs: dict[str, Any]) -> dict[str, Any] | None:
        with self._lock, self._conn() as conn:
            row = conn.execute("SELECT id FROM social_nights WHERE id=?", (social_id,)).fetchone()
            if row is None:
                return None
            conn.execute(
                "UPDATE social_nights SET playoffs_json=? WHERE id=?",
                (json.dumps(playoffs or {}), social_id),
            )
        return playoffs

    def upsert_sync_event(self, *, event_id: str, event_type: str, payload: dict[str, Any], received_at: str) -> None:
        with self._lock, self._conn() as conn:
            conn.execute(
                """
                INSERT INTO sync_events(event_id, type, payload_json, received_at)
                VALUES(?, ?, ?, ?)
                ON CONFLICT(event_id) DO UPDATE SET
                  type=excluded.type,
                  payload_json=excluded.payload_json,
                  received_at=excluded.received_at
                """,
                (event_id, event_type, json.dumps(payload), received_at),
            )

    def playtime_metrics(self, *, from_value: Optional[str], to_value: Optional[str], board_id: Optional[str]) -> dict[str, Any]:
        from_dt = _to_dt(from_value)
        to_dt = _to_dt(to_value)
        where = ["status='closed' OR status='active'"]
        params: list[Any] = []
        if board_id:
            where.append("board_id=?")
            params.append(board_id)
        query = f"SELECT board_id, started_at, stopped_at, status FROM sessions WHERE {' AND '.join(where)}"
        with self._lock, self._conn() as conn:
            rows = conn.execute(query, tuple(params)).fetchall()

        board_totals: dict[str, float] = {}
        session_count = 0
        now = datetime.now(timezone.utc)
        for row in rows:
            started = _to_dt(str(row["started_at"] or ""))
            if started is None:
                continue
            stopped = _to_dt(str(row["stopped_at"] or "")) if row["stopped_at"] else (now if str(row["status"]) == "active" else None)
            if stopped is None:
                continue
            if from_dt and stopped < from_dt:
                continue
            if to_dt and started > to_dt:
                continue
            clipped_start = max(started, from_dt) if from_dt else started
            clipped_stop = min(stopped, to_dt) if to_dt else stopped
            duration = max(0.0, (clipped_stop - clipped_start).total_seconds())
            if duration <= 0:
                continue
            bid = str(row["board_id"])
            board_totals[bid] = board_totals.get(bid, 0.0) + duration
            session_count += 1

        occupancy = float(sum(board_totals.values()))
        # Sprint 2 assumption: active play ~= occupancy until full game-event splitter is added.
        active = occupancy
        avg_session = (occupancy / float(session_count)) if session_count > 0 else 0.0
        board_metrics = [
            {
                "board_id": bid,
                "occupancy_seconds": round(total, 2),
                "active_play_seconds": round(total, 2),
            }
            for bid, total in sorted(board_totals.items())
        ]
        return {
            "metrics": {
                "occupancy_seconds": round(occupancy, 2),
                "active_play_seconds": round(active, 2),
                "average_session_seconds": round(avg_session, 2),
            },
            "boards": board_metrics,
        }


_STORE: Optional[ClubStore] = None
_STORE_LOCK = threading.RLock()


def get_club_store() -> ClubStore:
    global _STORE
    with _STORE_LOCK:
        if _STORE is None:
            _STORE = ClubStore()
        return _STORE
