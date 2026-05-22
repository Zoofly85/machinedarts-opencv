from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any
import sys

from backend.config.settings import get_data_root

_LOCK = threading.Lock()
_SERVICE: "OwnerAnalyticsService | None" = None
_DEFAULT_PUBLIC_SUPABASE_URL = "https://vchcxcijkmicdrtcggrj.supabase.co"
_DEFAULT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_ulUjBZUytB60vEpEM0UYNA_8PLqWeWf"


def _resolve_queue_path() -> Path:
    return _settings_dir() / "owner_analytics_queue.jsonl"


def _settings_dir() -> Path:
    root = get_data_root()
    if getattr(sys, "frozen", False):
        return root / "settings"
    return root / "backend" / "data" / "settings"


def _resolve_config_path() -> Path:
    return _settings_dir() / "owner_analytics.json"


def _load_file_config() -> dict[str, str]:
    path = _resolve_config_path()
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(payload, dict):
        return {}
    resolved: dict[str, str] = {}
    url_value = payload.get("supabaseUrl")
    if isinstance(url_value, str) and url_value.strip():
        resolved["supabaseUrl"] = url_value.strip()
    admin_key = payload.get("serviceRoleKey")
    if not isinstance(admin_key, str) or not admin_key.strip():
        admin_key = payload.get("secretKey")
    if isinstance(admin_key, str) and admin_key.strip():
        resolved["adminKey"] = admin_key.strip()
    public_key = payload.get("publishableKey")
    if not isinstance(public_key, str) or not public_key.strip():
        public_key = payload.get("anonKey")
    if isinstance(public_key, str) and public_key.strip():
        resolved["publicKey"] = public_key.strip()
    return resolved


class OwnerAnalyticsService:
    def __init__(self) -> None:
        file_config = _load_file_config()
        self._base_url = str(
            os.getenv("MACHINE_DARTS_SUPABASE_URL", "").strip()
            or os.getenv("SUPABASE_URL", "").strip()
            or os.getenv("VITE_SUPABASE_URL", "").strip()
            or file_config.get("supabaseUrl", "")
            or _DEFAULT_PUBLIC_SUPABASE_URL
        ).rstrip("/")
        self._service_role_key = str(
            os.getenv("MACHINE_DARTS_SUPABASE_SERVICE_ROLE_KEY", "").strip()
            or os.getenv("MACHINE_DARTS_SUPABASE_SECRET_KEY", "").strip()
            or os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
            or os.getenv("SUPABASE_SECRET_KEY", "").strip()
            or file_config.get("adminKey", "")
        )
        self._public_key = str(
            os.getenv("MACHINE_DARTS_SUPABASE_PUBLISHABLE_KEY", "").strip()
            or os.getenv("MACHINE_DARTS_SUPABASE_ANON_KEY", "").strip()
            or os.getenv("SUPABASE_PUBLISHABLE_KEY", "").strip()
            or os.getenv("SUPABASE_ANON_KEY", "").strip()
            or os.getenv("VITE_SUPABASE_ANON_KEY", "").strip()
            or file_config.get("publicKey", "")
            or _DEFAULT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
        )
        self._queue_path = _resolve_queue_path()
        self._config_path = _resolve_config_path()
        self._current_session: dict[str, Any] = {}
        self._state_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._wake_event = threading.Event()
        self._worker: threading.Thread | None = None
        self._warned_disabled = False
        self._last_error: str | None = None
        self._last_success_at: str | None = None
        self._last_queued_at: str | None = None
        self._last_queued_table: str | None = None

    @property
    def enabled(self) -> bool:
        return bool(self._base_url and (self._service_role_key or self._public_key))

    @property
    def ingest_mode(self) -> str:
        if self._base_url and self._service_role_key:
            return "direct"
        if self._base_url and self._public_key:
            return "edge"
        return "disabled"

    def start(self) -> None:
        with self._state_lock:
            if self._worker is not None:
                return
            worker = threading.Thread(target=self._worker_loop, name="owner-analytics", daemon=True)
            worker.start()
            self._worker = worker

    def shutdown(self) -> None:
        self._stop_event.set()
        self._wake_event.set()
        worker = self._worker
        if worker is not None:
            worker.join(timeout=2.0)

    def status(self) -> dict[str, Any]:
        with self._state_lock:
            session = dict(self._current_session)
        return {
            "enabled": self.enabled,
            "baseUrlConfigured": bool(self._base_url),
            "serviceRoleConfigured": bool(self._service_role_key),
            "publicKeyConfigured": bool(self._public_key),
            "ingestMode": self.ingest_mode,
            "configPath": str(self._config_path),
            "queuePath": str(self._queue_path),
            "pendingEvents": self._pending_count(),
            "currentSession": session,
            "lastError": self._last_error,
            "lastSuccessAt": self._last_success_at,
            "lastQueuedAt": self._last_queued_at,
            "lastQueuedTable": self._last_queued_table,
        }

    def record_app_open(self, payload: dict[str, Any]) -> None:
        session_payload = {
            "install_id": str(payload.get("install_id", "")).strip(),
            "session_id": str(payload.get("session_id", "")).strip(),
            "app_version": str(payload.get("app_version", "")).strip() or None,
            "product_flavor": str(payload.get("product_flavor", "")).strip() or None,
            "ui_shell": str(payload.get("ui_shell", "")).strip() or None,
            "platform": str(payload.get("platform", "")).strip() or None,
            "is_tauri": bool(payload.get("is_tauri", False)),
        }
        with self._state_lock:
            self._current_session = dict(session_payload)
        self._enqueue(
            "owner_app_events",
            {
                **session_payload,
                "event_name": "app_open",
                "occurred_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "details": {
                    "user_agent": str(payload.get("user_agent", "")).strip() or None,
                    "language": str(payload.get("language", "")).strip() or None,
                    "timezone": str(payload.get("timezone", "")).strip() or None,
                },
            },
        )

    def record_x01_match_summary(self, payload: dict[str, Any]) -> None:
        with self._state_lock:
            session = dict(self._current_session)
        print(
            "[owner-analytics] record_x01_match_summary "
            f"winner={payload.get('match_winner')} "
            f"players={payload.get('players_count')} "
            f"source={payload.get('analytics_source')}"
        )
        self._enqueue("owner_match_summaries", {**session, **payload})

    def fetch_dashboard(self) -> dict[str, Any]:
        if not self.enabled:
            raise RuntimeError("Owner analytics is not configured")

        daily_app_opens = self._fetch_rows(
            "owner_daily_app_opens",
            {
                "select": "*",
                "order": "day.desc",
                "limit": "30",
            },
        )
        monthly_active_installs = self._fetch_rows(
            "owner_monthly_active_installs",
            {
                "select": "*",
                "order": "month.desc",
                "limit": "12",
            },
        )
        matches_per_day = self._fetch_rows(
            "owner_matches_per_day",
            {
                "select": "*",
                "order": "day.desc",
                "limit": "30",
            },
        )
        darts_per_month = self._fetch_rows(
            "owner_darts_per_month",
            {
                "select": "*",
                "order": "month.desc",
                "limit": "12",
            },
        )
        x01_quality_per_month = self._fetch_rows(
            "owner_x01_quality_per_month",
            {
                "select": "*",
                "order": "month.desc",
                "limit": "12",
            },
        )

        overview = {
            "last30AppOpens": sum(int(row.get("app_opens", 0) or 0) for row in daily_app_opens),
            "last30Matches": sum(int(row.get("matches_played", 0) or 0) for row in matches_per_day),
            "last12MonthsDarts": sum(int(row.get("total_darts", 0) or 0) for row in darts_per_month),
            "currentMonthActiveInstalls": int(monthly_active_installs[0].get("active_installs", 0) or 0)
            if monthly_active_installs
            else 0,
            "latestEstimatedAccuracy": float(x01_quality_per_month[0].get("avg_estimated_accuracy", 0.0) or 0.0)
            if x01_quality_per_month
            else 0.0,
            "latestAvgCorrectionsPerMatch": float(x01_quality_per_month[0].get("avg_corrections_per_match", 0.0) or 0.0)
            if x01_quality_per_month
            else 0.0,
        }

        return {
            "overview": overview,
            "dailyAppOpens": list(reversed(daily_app_opens)),
            "monthlyActiveInstalls": list(reversed(monthly_active_installs)),
            "matchesPerDay": list(reversed(matches_per_day)),
            "dartsPerMonth": list(reversed(darts_per_month)),
            "x01QualityPerMonth": list(reversed(x01_quality_per_month)),
        }

    def _enqueue(self, table: str, payload: dict[str, Any]) -> None:
        if not self.enabled:
            if not self._warned_disabled:
                self._warned_disabled = True
                print(
                    "[owner-analytics] disabled "
                    "(configure a service role/secret key for direct mode, "
                    "or a publishable key for edge mode, "
                    f"or create {self._config_path})"
                )
            return
        self._queue_path.parent.mkdir(parents=True, exist_ok=True)
        with self._state_lock:
            with self._queue_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({"table": table, "payload": payload}, separators=(",", ":")) + "\n")
            self._last_queued_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            self._last_queued_table = table
            self._last_error = None
        print(f"[owner-analytics] queued table={table} pending={self._pending_count()}")
        self._wake_event.set()

    def _pending_count(self) -> int:
        if not self._queue_path.exists():
            return 0
        try:
            with self._queue_path.open("r", encoding="utf-8") as handle:
                return sum(1 for line in handle if line.strip())
        except Exception:
            return 0

    def _worker_loop(self) -> None:
        while not self._stop_event.is_set():
            self._wake_event.wait(timeout=20.0)
            self._wake_event.clear()
            if self._stop_event.is_set():
                break
            self._flush_pending(max_events=25)

    def _flush_pending(self, *, max_events: int) -> None:
        if not self.enabled or not self._queue_path.exists():
            return
        for _ in range(max_events):
            record = self._peek_first_record()
            if record is None:
                return
            try:
                self._insert_record(record["table"], record["payload"])
            except Exception as exc:
                self._last_error = str(exc)
                print(f"[owner-analytics] flush paused: {exc}")
                return
            self._drop_first_record()
            self._last_success_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            self._last_error = None
            print(f"[owner-analytics] flushed table={record['table']} pending={self._pending_count()}")

    def _peek_first_record(self) -> dict[str, Any] | None:
        try:
            with self._queue_path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    raw = line.strip()
                    if not raw:
                        continue
                    parsed = json.loads(raw)
                    if isinstance(parsed, dict) and isinstance(parsed.get("table"), str) and isinstance(parsed.get("payload"), dict):
                        return {"table": parsed["table"], "payload": parsed["payload"]}
                    return None
        except Exception:
            return None
        return None

    def _drop_first_record(self) -> None:
        try:
            with self._state_lock:
                if not self._queue_path.exists():
                    return
                lines = self._queue_path.read_text(encoding="utf-8").splitlines()
                remaining: list[str] = []
                dropped = False
                for line in lines:
                    if not line.strip():
                        continue
                    if not dropped:
                        dropped = True
                        continue
                    remaining.append(line)
                if remaining:
                    self._queue_path.write_text("\n".join(remaining) + "\n", encoding="utf-8")
                else:
                    self._queue_path.unlink(missing_ok=True)
        except Exception:
            pass

    def _insert_record(self, table: str, payload: dict[str, Any]) -> None:
        if self.ingest_mode == "direct":
            self._insert_record_direct(table, payload)
            return
        if self.ingest_mode == "edge":
            self._insert_record_via_edge_function(table, payload)
            return
        raise RuntimeError("Owner analytics is not configured for inserts")

    def _insert_record_direct(self, table: str, payload: dict[str, Any]) -> None:
        url = f"{self._base_url}/rest/v1/{table}"
        body = json.dumps([payload], separators=(",", ":")).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "apikey": self._service_role_key,
            "Prefer": "return=minimal",
        }
        if not self._service_role_key.startswith("sb_secret_"):
            headers["Authorization"] = f"Bearer {self._service_role_key}"
        request = urllib.request.Request(
            url,
            data=body,
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=4.0) as response:
                status = int(getattr(response, "status", 200) or 200)
                if status >= 300:
                    raise RuntimeError(f"Supabase insert failed for {table}: HTTP {status}")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            raise RuntimeError(f"Supabase insert failed for {table}: HTTP {exc.code} {detail}".strip()) from exc

    def _insert_record_via_edge_function(self, table: str, payload: dict[str, Any]) -> None:
        url = f"{self._base_url}/functions/v1/owner-analytics-ingest"
        body = json.dumps({"table": table, "payload": payload}, separators=(",", ":")).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "apikey": self._public_key,
            "Authorization": f"Bearer {self._public_key}",
            "x-machine-darts-analytics": "1",
        }
        request = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=6.0) as response:
                status = int(getattr(response, "status", 200) or 200)
                if status >= 300:
                    raise RuntimeError(f"Supabase edge ingest failed for {table}: HTTP {status}")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            raise RuntimeError(f"Supabase edge ingest failed for {table}: HTTP {exc.code} {detail}".strip()) from exc

    def _fetch_rows(self, relation: str, params: dict[str, str]) -> list[dict[str, Any]]:
        if not self._service_role_key:
            raise RuntimeError("Owner analytics dashboard queries require a local secret/service role config")
        query = urllib.parse.urlencode(params)
        url = f"{self._base_url}/rest/v1/{relation}"
        if query:
            url = f"{url}?{query}"
        headers = {
            "apikey": self._service_role_key,
        }
        if not self._service_role_key.startswith("sb_secret_"):
            headers["Authorization"] = f"Bearer {self._service_role_key}"
        request = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(request, timeout=6.0) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            raise RuntimeError(f"Supabase fetch failed for {relation}: HTTP {exc.code} {detail}".strip()) from exc
        if not isinstance(payload, list):
            raise RuntimeError(f"Supabase fetch failed for {relation}: expected a list response")
        return [row for row in payload if isinstance(row, dict)]


def get_owner_analytics_service() -> OwnerAnalyticsService:
    global _SERVICE
    with _LOCK:
        if _SERVICE is None:
            _SERVICE = OwnerAnalyticsService()
        return _SERVICE
