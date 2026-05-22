#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path
from statistics import mean
from typing import Any


FPS_RE = re.compile(r"\[FPS\]\s+loop:(?P<fps>[0-9]+(?:\.[0-9]+)?)")
FPS_RE_ALT = re.compile(r"\[FPS\]\s+(?P<fps>[0-9]+(?:\.[0-9]+)?)\b")
SCORE_RE = re.compile(r"\[SCORE\].*?\bms=(?P<ms>[0-9]+(?:\.[0-9]+)?)")
EVENT_RE = re.compile(
    r"frame=(?P<frame>[0-9]+)\s+time=(?P<time>[0-9]+(?:\.[0-9]+)?)s\s+event=(?P<event>[A-Z_]+)\s+darts=(?P<darts>[0-9]+)"
)
MAX_DARTS_RE = re.compile(r"\[INFO\]\s+Max darts reached - waiting for takeout")
TAKEOUT_COMPLETE_RE = re.compile(r"\[TAKEOUT\]\s+Complete -> reset")
REMOVE_TIMEOUT_RE = re.compile(r"\bREMOVE_TIMEOUT\b|\[REMOVE_TIMEOUT\]")


def _pct(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    if len(values) == 1:
        return float(values[0])
    vals = sorted(values)
    idx = (len(vals) - 1) * pct
    lo = int(math.floor(idx))
    hi = int(math.ceil(idx))
    if lo == hi:
        return float(vals[lo])
    w = idx - lo
    return float(vals[lo] * (1.0 - w) + vals[hi] * w)


def _read_text_auto(path: Path) -> str:
    raw = path.read_bytes()
    if raw.startswith(b"\xff\xfe") or raw.startswith(b"\xfe\xff"):
        return raw.decode("utf-16")
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw.decode("utf-8-sig", errors="ignore")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        # Fallback for mixed/legacy logs.
        return raw.decode("latin-1", errors="ignore")


def summarize_log(path: Path) -> dict[str, Any]:
    fps_values: list[float] = []
    score_ms_values: list[float] = []
    takeout_latencies_s: list[float] = []
    pending_detect3_times: list[float] = []
    pending_detect3_count = 0
    takeout_complete_count = 0
    remove_timeout_count = 0

    for raw in _read_text_auto(path).splitlines():
            line = raw.strip()
            if not line:
                continue

            m_fps = FPS_RE.search(line) or FPS_RE_ALT.search(line)
            if m_fps:
                fps_values.append(float(m_fps.group("fps")))

            if MAX_DARTS_RE.search(line):
                pending_detect3_count += 1
            if TAKEOUT_COMPLETE_RE.search(line):
                takeout_complete_count += 1
            if REMOVE_TIMEOUT_RE.search(line):
                remove_timeout_count += 1

            m_score = SCORE_RE.search(line)
            if m_score:
                score_ms_values.append(float(m_score.group("ms")))

            m_event = EVENT_RE.search(line)
            if not m_event:
                continue

            event = m_event.group("event")
            darts = int(m_event.group("darts"))
            t = float(m_event.group("time"))

            if event == "DETECT" and darts >= 3:
                pending_detect3_times.append(t)
            elif event in {"REMOVE", "REMOVE_TIMEOUT"}:
                if event == "REMOVE_TIMEOUT":
                    remove_timeout_count += 1
                if pending_detect3_times:
                    t0 = pending_detect3_times.pop(0)
                    if t >= t0:
                        takeout_latencies_s.append(t - t0)

    unmatched_detect3_count = len(pending_detect3_times)
    if pending_detect3_count > 0:
        unmatched_detect3_count = max(0, pending_detect3_count - takeout_complete_count)

    return {
        "file": str(path),
        "fps": {
            "count": len(fps_values),
            "avg": round(mean(fps_values), 3) if fps_values else None,
            "min": round(min(fps_values), 3) if fps_values else None,
            "p50": round(_pct(fps_values, 0.50), 3) if fps_values else None,
            "p95": round(_pct(fps_values, 0.95), 3) if fps_values else None,
        },
        "score_ms": {
            "count": len(score_ms_values),
            "avg": round(mean(score_ms_values), 3) if score_ms_values else None,
            "min": round(min(score_ms_values), 3) if score_ms_values else None,
            "p50": round(_pct(score_ms_values, 0.50), 3) if score_ms_values else None,
            "p95": round(_pct(score_ms_values, 0.95), 3) if score_ms_values else None,
        },
        "takeout_latency_s": {
            "count": len(takeout_latencies_s),
            "avg": round(mean(takeout_latencies_s), 3) if takeout_latencies_s else None,
            "min": round(min(takeout_latencies_s), 3) if takeout_latencies_s else None,
            "p50": round(_pct(takeout_latencies_s, 0.50), 3) if takeout_latencies_s else None,
            "p95": round(_pct(takeout_latencies_s, 0.95), 3) if takeout_latencies_s else None,
        },
        "events": {
            "remove_timeout_count": remove_timeout_count,
            "unmatched_detect3_count": unmatched_detect3_count,
            "max_darts_wait_count": pending_detect3_count,
            "takeout_complete_count": takeout_complete_count,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Summarize detector logs for before/after comparisons.")
    parser.add_argument("logs", nargs="+", help="One or more log files.")
    parser.add_argument("--json", action="store_true", help="Print full JSON output.")
    args = parser.parse_args()

    paths = [Path(p).expanduser().resolve() for p in args.logs]
    summaries = []
    for p in paths:
        if not p.exists():
            raise FileNotFoundError(f"Log not found: {p}")
        summaries.append(summarize_log(p))

    if args.json:
        print(json.dumps({"runs": summaries}, indent=2))
        return

    for s in summaries:
        print(f"\n=== {s['file']} ===")
        print(
            "FPS: "
            f"count={s['fps']['count']} avg={s['fps']['avg']} min={s['fps']['min']} "
            f"p50={s['fps']['p50']} p95={s['fps']['p95']}"
        )
        print(
            "SCORE ms: "
            f"count={s['score_ms']['count']} avg={s['score_ms']['avg']} min={s['score_ms']['min']} "
            f"p50={s['score_ms']['p50']} p95={s['score_ms']['p95']}"
        )
        print(
            "Takeout latency (s): "
            f"count={s['takeout_latency_s']['count']} avg={s['takeout_latency_s']['avg']} "
            f"min={s['takeout_latency_s']['min']} p50={s['takeout_latency_s']['p50']} "
            f"p95={s['takeout_latency_s']['p95']}"
        )
        print(
            "Events: "
            f"remove_timeout_count={s['events']['remove_timeout_count']} "
            f"unmatched_detect3_count={s['events']['unmatched_detect3_count']} "
            f"max_darts_wait_count={s['events'].get('max_darts_wait_count')} "
            f"takeout_complete_count={s['events'].get('takeout_complete_count')}"
        )


if __name__ == "__main__":
    main()
