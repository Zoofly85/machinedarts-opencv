from __future__ import annotations

import json
import math
import sqlite3
import sys
import threading
from collections import defaultdict
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import median
from typing import Any, Iterator, Optional
from uuid import uuid4


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _resolve_db_path() -> Path:
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        return exe_dir / "backend" / "data" / "training" / "training.sqlite"
    return Path(__file__).resolve().parents[1] / "data" / "training" / "training.sqlite"


def _safe_json_loads(raw: Any, default: Any) -> Any:
    if raw is None:
        return default
    try:
        return json.loads(str(raw))
    except Exception:
        return default


def _to_dt(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:
        return None


def _distance(a: tuple[float, float], b: tuple[float, float]) -> float:
    dx = float(a[0]) - float(b[0])
    dy = float(a[1]) - float(b[1])
    return math.sqrt(dx * dx + dy * dy)


class TrainingStore:
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
                CREATE TABLE IF NOT EXISTS training_programs (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    created_by TEXT NOT NULL DEFAULT '',
                    is_archived INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS training_blocks (
                    id TEXT PRIMARY KEY,
                    program_id TEXT NOT NULL,
                    sort_order INTEGER NOT NULL,
                    block_type TEXT NOT NULL,
                    config_json TEXT NOT NULL DEFAULT '{}',
                    FOREIGN KEY(program_id) REFERENCES training_programs(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_training_blocks_program_order
                    ON training_blocks(program_id, sort_order);

                CREATE TABLE IF NOT EXISTS training_sessions (
                    id TEXT PRIMARY KEY,
                    program_id TEXT NOT NULL,
                    player_id TEXT NOT NULL DEFAULT '',
                    player_name TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    completed_at TEXT,
                    active_block_index INTEGER NOT NULL DEFAULT 0,
                    summary_json TEXT NOT NULL DEFAULT '{}',
                    metrics_json TEXT NOT NULL DEFAULT '{}',
                    FOREIGN KEY(program_id) REFERENCES training_programs(id)
                );
                CREATE INDEX IF NOT EXISTS idx_training_sessions_program
                    ON training_sessions(program_id, started_at DESC);
                CREATE INDEX IF NOT EXISTS idx_training_sessions_player
                    ON training_sessions(player_id, started_at DESC);

                CREATE TABLE IF NOT EXISTS training_session_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    ts TEXT NOT NULL,
                    block_index INTEGER NOT NULL,
                    target_key TEXT NOT NULL DEFAULT '',
                    scored INTEGER NOT NULL DEFAULT 0,
                    multiplier INTEGER NOT NULL DEFAULT 1,
                    segment TEXT NOT NULL DEFAULT '',
                    zone TEXT NOT NULL DEFAULT '',
                    board_x REAL,
                    board_y REAL,
                    event_json TEXT NOT NULL DEFAULT '{}',
                    FOREIGN KEY(session_id) REFERENCES training_sessions(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_training_events_session
                    ON training_session_events(session_id, id);
                """
            )

    def _fetch_program_blocks(self, conn: sqlite3.Connection, program_id: str) -> list[dict[str, Any]]:
        rows = conn.execute(
            """
            SELECT id, sort_order, block_type, config_json
            FROM training_blocks
            WHERE program_id = ?
            ORDER BY sort_order ASC, id ASC
            """,
            (program_id,),
        ).fetchall()
        blocks: list[dict[str, Any]] = []
        for row in rows:
            blocks.append(
                {
                    "id": str(row["id"]),
                    "order": int(row["sort_order"] or 0),
                    "type": str(row["block_type"] or ""),
                    "config": _safe_json_loads(row["config_json"], {}),
                }
            )
        return blocks

    def list_programs(self, *, include_archived: bool = False) -> list[dict[str, Any]]:
        with self._lock, self._conn() as conn:
            if include_archived:
                rows = conn.execute(
                    """
                    SELECT id, name, description, created_by, is_archived, created_at, updated_at
                    FROM training_programs
                    ORDER BY updated_at DESC
                    """
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT id, name, description, created_by, is_archived, created_at, updated_at
                    FROM training_programs
                    WHERE is_archived = 0
                    ORDER BY updated_at DESC
                    """
                ).fetchall()
            out: list[dict[str, Any]] = []
            for row in rows:
                pid = str(row["id"])
                blocks = self._fetch_program_blocks(conn, pid)
                out.append(
                    {
                        "id": pid,
                        "name": str(row["name"] or ""),
                        "description": str(row["description"] or ""),
                        "createdBy": str(row["created_by"] or ""),
                        "isArchived": bool(int(row["is_archived"] or 0)),
                        "createdAt": str(row["created_at"] or ""),
                        "updatedAt": str(row["updated_at"] or ""),
                        "blocks": blocks,
                    }
                )
            return out

    def get_program(self, program_id: str) -> Optional[dict[str, Any]]:
        with self._lock, self._conn() as conn:
            row = conn.execute(
                """
                SELECT id, name, description, created_by, is_archived, created_at, updated_at
                FROM training_programs
                WHERE id = ?
                """,
                (program_id,),
            ).fetchone()
            if row is None:
                return None
            blocks = self._fetch_program_blocks(conn, str(row["id"]))
            return {
                "id": str(row["id"]),
                "name": str(row["name"] or ""),
                "description": str(row["description"] or ""),
                "createdBy": str(row["created_by"] or ""),
                "isArchived": bool(int(row["is_archived"] or 0)),
                "createdAt": str(row["created_at"] or ""),
                "updatedAt": str(row["updated_at"] or ""),
                "blocks": blocks,
            }

    def upsert_program(
        self,
        *,
        program_id: Optional[str],
        name: str,
        description: str,
        created_by: str,
        is_archived: bool,
        blocks: list[dict[str, Any]],
    ) -> dict[str, Any]:
        now = _utc_now()
        pid = str(program_id or uuid4().hex)
        with self._lock, self._conn() as conn:
            existing = conn.execute("SELECT id, created_at FROM training_programs WHERE id = ?", (pid,)).fetchone()
            created_at = str(existing["created_at"]) if existing is not None else now
            conn.execute(
                """
                INSERT INTO training_programs(id, name, description, created_by, is_archived, created_at, updated_at)
                VALUES(?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  name=excluded.name,
                  description=excluded.description,
                  created_by=excluded.created_by,
                  is_archived=excluded.is_archived,
                  updated_at=excluded.updated_at
                """,
                (pid, name, description, created_by, 1 if is_archived else 0, created_at, now),
            )
            conn.execute("DELETE FROM training_blocks WHERE program_id = ?", (pid,))
            for idx, block in enumerate(blocks):
                bid = str(block.get("id") or uuid4().hex)
                btype = str(block.get("type") or "").strip().lower()
                bcfg = block.get("config") or {}
                conn.execute(
                    """
                    INSERT INTO training_blocks(id, program_id, sort_order, block_type, config_json)
                    VALUES(?, ?, ?, ?, ?)
                    """,
                    (bid, pid, idx, btype, json.dumps(bcfg)),
                )
        program = self.get_program(pid)
        if program is None:
            raise RuntimeError("Failed to save training program")
        return program

    def delete_program(self, program_id: str) -> bool:
        with self._lock, self._conn() as conn:
            conn.execute("DELETE FROM training_blocks WHERE program_id = ?", (program_id,))
            cur = conn.execute("DELETE FROM training_programs WHERE id = ?", (program_id,))
            return int(cur.rowcount or 0) > 0

    def set_program_archived(self, program_id: str, archived: bool) -> Optional[dict[str, Any]]:
        now = _utc_now()
        with self._lock, self._conn() as conn:
            cur = conn.execute(
                "UPDATE training_programs SET is_archived=?, updated_at=? WHERE id=?",
                (1 if archived else 0, now, program_id),
            )
            if int(cur.rowcount or 0) <= 0:
                return None
        return self.get_program(program_id)

    def create_session(
        self,
        *,
        program_id: str,
        player_id: str,
        player_name: str,
    ) -> dict[str, Any]:
        now = _utc_now()
        sid = uuid4().hex
        program_snapshot = self.get_program(program_id) or {}
        with self._lock, self._conn() as conn:
            conn.execute(
                """
                INSERT INTO training_sessions(
                  id, program_id, player_id, player_name, status, started_at, completed_at, active_block_index, summary_json, metrics_json
                )
                VALUES(?, ?, ?, ?, 'active', ?, NULL, 0, ?, '{}')
                """,
                (sid, program_id, player_id, player_name, now, json.dumps({"programSnapshot": program_snapshot})),
            )
        session = self.get_session(sid)
        if session is None:
            raise RuntimeError("Failed to create training session")
        return session

    def get_session(self, session_id: str) -> Optional[dict[str, Any]]:
        with self._lock, self._conn() as conn:
            row = conn.execute(
                """
                SELECT id, program_id, player_id, player_name, status, started_at, completed_at,
                       active_block_index, summary_json, metrics_json
                FROM training_sessions
                WHERE id = ?
                """,
                (session_id,),
            ).fetchone()
            if row is None:
                return None
            events = conn.execute(
                """
                SELECT id, ts, block_index, target_key, scored, multiplier, segment, zone, board_x, board_y, event_json
                FROM training_session_events
                WHERE session_id = ?
                ORDER BY id ASC
                """,
                (session_id,),
            ).fetchall()
            return {
                "id": str(row["id"]),
                "programId": str(row["program_id"] or ""),
                "playerId": str(row["player_id"] or ""),
                "playerName": str(row["player_name"] or ""),
                "status": str(row["status"] or "active"),
                "startedAt": str(row["started_at"] or ""),
                "completedAt": str(row["completed_at"] or "") or None,
                "activeBlockIndex": int(row["active_block_index"] or 0),
                "summary": _safe_json_loads(row["summary_json"], {}),
                "metrics": _safe_json_loads(row["metrics_json"], {}),
                "events": [
                    {
                        "id": int(ev["id"] or 0),
                        "ts": str(ev["ts"] or ""),
                        "blockIndex": int(ev["block_index"] or 0),
                        "targetKey": str(ev["target_key"] or ""),
                        "scored": int(ev["scored"] or 0),
                        "multiplier": int(ev["multiplier"] or 1),
                        "segment": str(ev["segment"] or ""),
                        "zone": str(ev["zone"] or ""),
                        "boardX": float(ev["board_x"]) if ev["board_x"] is not None else None,
                        "boardY": float(ev["board_y"]) if ev["board_y"] is not None else None,
                        "meta": _safe_json_loads(ev["event_json"], {}),
                    }
                    for ev in events
                ],
            }

    def append_session_event(
        self,
        *,
        session_id: str,
        block_index: int,
        target_key: str,
        scored: int,
        multiplier: int,
        segment: str,
        zone: str,
        board_x: Optional[float],
        board_y: Optional[float],
        meta: dict[str, Any],
    ) -> Optional[dict[str, Any]]:
        now = _utc_now()
        with self._lock, self._conn() as conn:
            row = conn.execute(
                "SELECT id, status FROM training_sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
            if row is None or str(row["status"] or "") != "active":
                return None
            conn.execute(
                """
                INSERT INTO training_session_events(
                  session_id, ts, block_index, target_key, scored, multiplier, segment, zone, board_x, board_y, event_json
                )
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    now,
                    int(block_index),
                    target_key,
                    int(scored),
                    int(multiplier),
                    segment,
                    zone,
                    board_x,
                    board_y,
                    json.dumps(meta or {}),
                ),
            )
        return self.get_session(session_id)

    def update_session_event(
        self,
        *,
        session_id: str,
        event_id: int,
        scored: int,
        multiplier: int,
        segment: str,
        zone: str,
        board_x: Optional[float],
        board_y: Optional[float],
        meta: dict[str, Any],
    ) -> Optional[dict[str, Any]]:
        with self._lock, self._conn() as conn:
            session_row = conn.execute(
                "SELECT id, status FROM training_sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
            if session_row is None or str(session_row["status"] or "") != "active":
                return None

            existing = conn.execute(
                "SELECT id, event_json FROM training_session_events WHERE id = ? AND session_id = ?",
                (int(event_id), session_id),
            ).fetchone()
            if existing is None:
                return None

            prev_meta = _safe_json_loads(existing["event_json"], {})
            merged_meta = dict(prev_meta or {})
            merged_meta.update(meta or {})

            cur = conn.execute(
                """
                UPDATE training_session_events
                SET scored=?, multiplier=?, segment=?, zone=?, board_x=?, board_y=?, event_json=?
                WHERE id=? AND session_id=?
                """,
                (
                    int(scored),
                    int(multiplier),
                    segment,
                    zone,
                    board_x,
                    board_y,
                    json.dumps(merged_meta),
                    int(event_id),
                    session_id,
                ),
            )
            if int(cur.rowcount or 0) <= 0:
                return None
        return self.get_session(session_id)

    def complete_session(
        self,
        *,
        session_id: str,
        summary: dict[str, Any],
        metrics: dict[str, Any],
    ) -> Optional[dict[str, Any]]:
        now = _utc_now()
        with self._lock, self._conn() as conn:
            cur = conn.execute(
                """
                UPDATE training_sessions
                SET status='completed',
                    completed_at=?,
                    summary_json=?,
                    metrics_json=?
                WHERE id=? AND status='active'
                """,
                (now, json.dumps(summary or {}), json.dumps(metrics or {}), session_id),
            )
            if int(cur.rowcount or 0) <= 0:
                return None
        return self.get_session(session_id)

    def report_overview(self, *, player_id: str) -> dict[str, Any]:
        with self._lock, self._conn() as conn:
            where = ""
            params: list[Any] = []
            if player_id:
                where = "WHERE player_id = ?"
                params.append(player_id)

            rows = conn.execute(
                f"""
                SELECT id, player_id, player_name, started_at, completed_at, status, summary_json, metrics_json
                FROM training_sessions
                {where}
                ORDER BY started_at DESC
                LIMIT 2000
                """,
                tuple(params),
            ).fetchall()

        now = datetime.now(timezone.utc)
        windows = {
            "day": now - timedelta(days=1),
            "week": now - timedelta(days=7),
            "month": now - timedelta(days=30),
            "all": None,
        }
        aggregates: dict[str, dict[str, Any]] = {
            "day": {"sessions": 0, "completed": 0, "darts": 0},
            "week": {"sessions": 0, "completed": 0, "darts": 0},
            "month": {"sessions": 0, "completed": 0, "darts": 0},
            "all": {"sessions": 0, "completed": 0, "darts": 0},
        }

        timeline: list[dict[str, Any]] = []
        for row in rows:
            started_at = _to_dt(str(row["started_at"] or ""))
            summary = _safe_json_loads(row["summary_json"], {})
            metrics = _safe_json_loads(row["metrics_json"], {})
            darts = int(summary.get("totalDarts", 0) or 0)
            score = int(summary.get("totalScore", 0) or 0)
            hit_rate = float(metrics.get("hitRate", 0.0) or 0.0)
            status = str(row["status"] or "")
            entry = {
                "sessionId": str(row["id"]),
                "playerId": str(row["player_id"] or ""),
                "playerName": str(row["player_name"] or ""),
                "status": status,
                "startedAt": str(row["started_at"] or ""),
                "completedAt": str(row["completed_at"] or "") or None,
                "darts": darts,
                "score": score,
                "hitRate": hit_rate,
            }
            timeline.append(entry)

            for key, start in windows.items():
                if started_at is None:
                    continue
                if start is not None and started_at < start:
                    continue
                aggregates[key]["sessions"] += 1
                aggregates[key]["darts"] += darts
                aggregates[key]["score"] = int(aggregates[key].get("score", 0) or 0) + score
                if status == "completed":
                    aggregates[key]["completed"] += 1
                prev_hit_sum = float(aggregates[key].get("_hitRateSum", 0.0) or 0.0)
                prev_hit_count = int(aggregates[key].get("_hitRateCount", 0) or 0)
                aggregates[key]["_hitRateSum"] = prev_hit_sum + hit_rate
                aggregates[key]["_hitRateCount"] = prev_hit_count + 1

        for key in aggregates.keys():
            hit_count = int(aggregates[key].pop("_hitRateCount", 0) or 0)
            hit_sum = float(aggregates[key].pop("_hitRateSum", 0.0) or 0.0)
            aggregates[key]["avgHitRate"] = (hit_sum / hit_count) if hit_count > 0 else 0.0

        timeline_by_day: dict[str, dict[str, Any]] = {}
        for item in timeline:
            dt = _to_dt(str(item.get("startedAt") or ""))
            if dt is None:
                continue
            day_key = dt.astimezone(timezone.utc).strftime("%Y-%m-%d")
            row = timeline_by_day.setdefault(day_key, {"date": day_key, "sessions": 0, "darts": 0, "score": 0})
            row["sessions"] += 1
            row["darts"] += int(item.get("darts", 0) or 0)
            row["score"] += int(item.get("score", 0) or 0)

        return {
            "playerId": player_id,
            "windows": aggregates,
            "timeline": timeline[:300],
            "timelineByDay": sorted(timeline_by_day.values(), key=lambda x: str(x["date"]))[-60:],
        }

    def _session_events(self, session_id: str) -> list[dict[str, Any]]:
        with self._lock, self._conn() as conn:
            rows = conn.execute(
                """
                SELECT id, ts, block_index, target_key, scored, multiplier, segment, zone, board_x, board_y, event_json
                FROM training_session_events
                WHERE session_id = ?
                ORDER BY id ASC
                """,
                (session_id,),
            ).fetchall()
        out: list[dict[str, Any]] = []
        for row in rows:
            out.append(
                {
                    "id": int(row["id"] or 0),
                    "ts": str(row["ts"] or ""),
                    "blockIndex": int(row["block_index"] or 0),
                    "targetKey": str(row["target_key"] or ""),
                    "scored": int(row["scored"] or 0),
                    "multiplier": int(row["multiplier"] or 1),
                    "segment": str(row["segment"] or ""),
                    "zone": str(row["zone"] or ""),
                    "boardX": float(row["board_x"]) if row["board_x"] is not None else None,
                    "boardY": float(row["board_y"]) if row["board_y"] is not None else None,
                    "meta": _safe_json_loads(row["event_json"], {}),
                }
            )
        return out

    def _compute_analytics(self, events: list[dict[str, Any]]) -> dict[str, Any]:
        per_target: dict[str, dict[str, Any]] = {}
        target_points: dict[str, list[tuple[float, float]]] = defaultdict(list)
        total_score = 0
        total_darts = 0
        total_hits = 0

        for event in events:
            target_key = str(event.get("targetKey") or "").upper() or "UNKNOWN"
            scored = int(event.get("scored", 0) or 0)
            meta = event.get("meta") or {}
            is_hit = bool(meta.get("isHit", False))

            row = per_target.setdefault(
                target_key,
                {"target": target_key, "darts": 0, "score": 0, "hits": 0, "misses": 0, "avgScorePerDart": 0.0, "hitRate": 0.0},
            )
            row["darts"] += 1
            row["score"] += scored
            if is_hit:
                row["hits"] += 1
            else:
                row["misses"] += 1

            bx = event.get("boardX")
            by = event.get("boardY")
            if bx is not None and by is not None:
                target_points[target_key].append((float(bx), float(by)))

            total_score += scored
            total_darts += 1
            total_hits += 1 if is_hit else 0

        for target, row in per_target.items():
            darts = max(1, int(row["darts"]))
            row["avgScorePerDart"] = float(row["score"]) / float(darts)
            row["hitRate"] = float(row["hits"]) / float(darts)

            pts = target_points.get(target, [])
            grouping: dict[str, Any] = {
                "count": len(pts),
                "centerX": None,
                "centerY": None,
                "meanDistance": None,
                "medianDistance": None,
                "maxSpread": None,
                "firstThirdRadius": None,
                "middleThirdRadius": None,
                "lastThirdRadius": None,
                "fatigueTrend": None,
            }
            if len(pts) >= 2:
                cx = sum(p[0] for p in pts) / len(pts)
                cy = sum(p[1] for p in pts) / len(pts)
                dists = [_distance(p, (cx, cy)) for p in pts]
                max_spread = 0.0
                for i in range(len(pts)):
                    for j in range(i + 1, len(pts)):
                        max_spread = max(max_spread, _distance(pts[i], pts[j]))
                third = max(1, len(pts) // 3)
                first = pts[:third]
                middle = pts[third : third * 2] or pts[:third]
                last = pts[-third:]

                def _radius(chunk: list[tuple[float, float]]) -> float:
                    if not chunk:
                        return 0.0
                    ccx = sum(p[0] for p in chunk) / len(chunk)
                    ccy = sum(p[1] for p in chunk) / len(chunk)
                    return sum(_distance(p, (ccx, ccy)) for p in chunk) / len(chunk)

                first_r = _radius(first)
                middle_r = _radius(middle)
                last_r = _radius(last)
                fatigue = "worsening" if last_r > (first_r * 1.2) else "steady_or_improving"

                grouping.update(
                    {
                        "centerX": cx,
                        "centerY": cy,
                        "meanDistance": sum(dists) / len(dists),
                        "medianDistance": float(median(dists)),
                        "maxSpread": max_spread,
                        "firstThirdRadius": first_r,
                        "middleThirdRadius": middle_r,
                        "lastThirdRadius": last_r,
                        "fatigueTrend": fatigue,
                    }
                )
            row["grouping"] = grouping

        overall_hit_rate = (float(total_hits) / float(total_darts)) if total_darts > 0 else 0.0
        overall_avg_score = (float(total_score) / float(total_darts)) if total_darts > 0 else 0.0

        sorted_targets = sorted(
            per_target.values(),
            key=lambda item: (float(item.get("hitRate", 0.0)), float(item.get("avgScorePerDart", 0.0))),
            reverse=True,
        )
        best_target = sorted_targets[0]["target"] if sorted_targets else None
        worst_target = sorted_targets[-1]["target"] if sorted_targets else None

        return {
            "overall": {
                "totalDarts": total_darts,
                "totalScore": total_score,
                "totalHits": total_hits,
                "hitRate": overall_hit_rate,
                "avgScorePerDart": overall_avg_score,
                "bestTarget": best_target,
                "worstTarget": worst_target,
            },
            "perTarget": sorted(per_target.values(), key=lambda x: str(x.get("target", ""))),
        }

    def report_session(self, *, session_id: str) -> Optional[dict[str, Any]]:
        session = self.get_session(session_id)
        if session is None:
            return None
        events = self._session_events(session_id)
        analytics = self._compute_analytics(events)
        return {"session": session, "analytics": analytics}

    def report_program(self, *, program_id: str, player_id: str) -> dict[str, Any]:
        with self._lock, self._conn() as conn:
            where_parts = ["program_id = ?"]
            params: list[Any] = [program_id]
            if player_id:
                where_parts.append("player_id = ?")
                params.append(player_id)
            where_sql = " AND ".join(where_parts)
            rows = conn.execute(
                f"""
                SELECT id, status, started_at
                FROM training_sessions
                WHERE {where_sql}
                ORDER BY started_at DESC
                LIMIT 300
                """,
                tuple(params),
            ).fetchall()

        completed_session_ids = [str(r["id"]) for r in rows if str(r["status"] or "") == "completed"]
        all_events: list[dict[str, Any]] = []
        for sid in completed_session_ids:
            all_events.extend(self._session_events(sid))

        analytics = self._compute_analytics(all_events)
        return {
            "programId": program_id,
            "playerId": player_id,
            "sessions": len(rows),
            "completedSessions": len(completed_session_ids),
            "analytics": analytics,
        }


_training_store: Optional[TrainingStore] = None


def get_training_store() -> TrainingStore:
    global _training_store
    if _training_store is None:
        _training_store = TrainingStore()
    return _training_store
