#!/usr/bin/env python3
"""Summarize OpenCV scoring accuracy and evidence quality from saved dart packs."""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DATA_ROOT = ROOT / "backend" / "data"


def _score_key(score: dict[str, Any] | None) -> tuple[int, int, str] | None:
    if not isinstance(score, dict):
        return None
    try:
        segment = int(score.get("segment") or 0)
    except Exception:
        segment = 0
    try:
        multiplier = int(score.get("multiplier") or 1)
    except Exception:
        multiplier = 1
    zone = str(score.get("zone") or "").strip().lower()
    value = int(score.get("score") or 0)
    if value <= 0 or zone == "miss":
        return (0, 0, "miss")
    if multiplier == 3:
        zone_key = "triple"
    elif multiplier == 2:
        zone_key = "double"
    elif segment == 25 and value == 50:
        zone_key = "bull"
        multiplier = 2
    elif segment == 25:
        zone_key = "outer_bull"
        multiplier = 1
    elif zone.startswith("single"):
        zone_key = "single"
        multiplier = 1
    else:
        zone_key = zone or "single"
    return (segment, multiplier, zone_key)


def _label(score: dict[str, Any] | None, fallback_value: Any = None) -> str:
    if not isinstance(score, dict):
        if fallback_value is None:
            return "UNKNOWN"
        try:
            value = int(fallback_value)
        except Exception:
            return str(fallback_value)
        return "MISS" if value <= 0 else str(value)
    try:
        value = int(score.get("score") or 0)
        segment = int(score.get("segment") or 0)
        multiplier = int(score.get("multiplier") or 1)
    except Exception:
        value = 0
        segment = 0
        multiplier = 1
    zone = str(score.get("zone") or "").lower()
    if value <= 0 or zone == "miss":
        return "MISS"
    if segment == 25 and value == 50:
        return "BULL (50)"
    if segment == 25:
        return "25"
    prefix = {1: "S", 2: "D", 3: "T"}.get(multiplier, "S")
    return f"{prefix}{segment} ({value})"


def _cluster(scoring: dict[str, Any]) -> dict[str, Any]:
    primary = scoring.get("intersection_consensus")
    ellipse = scoring.get("ellipse_radial_intersection_consensus")
    if isinstance(primary, dict):
        return primary
    if isinstance(ellipse, dict):
        return ellipse
    return {}


def _spread(scoring: dict[str, Any], cluster: dict[str, Any]) -> float:
    for value in (cluster.get("spread_px"), scoring.get("intersection_spread_px")):
        try:
            return float(value)
        except Exception:
            pass
    return 9999.0


def _candidate_score(entry: dict[str, Any]) -> int:
    try:
        return int(entry.get("score") or 0)
    except Exception:
        return 0


def _candidate_agreement(entry: dict[str, Any]) -> int:
    try:
        return int(entry.get("agreement") or 0)
    except Exception:
        return 0


def _candidate_spread(entry: dict[str, Any]) -> float:
    try:
        return float(entry.get("spread") or 9999.0)
    except Exception:
        return 9999.0


def _quality_bucket(matches: bool, source: str, agreement: int, spread: float, camera_agreement: int) -> tuple[str, int]:
    if not matches:
        return "wrong", 0
    if source.startswith("line_cluster") and agreement >= 3 and spread <= 6.0:
        return "excellent", 5
    if source.startswith("line_cluster") and agreement >= 3 and spread <= 12.0:
        return "strong", 4
    if source.startswith("line_cluster") and agreement >= 2 and spread <= 10.0:
        return "good", 3
    if camera_agreement >= 3:
        return "tip_consensus", 3
    if source.startswith("ellipse_radial_line_fallback") and agreement >= 3 and spread <= 8.0:
        return "fallback_tight", 2
    return "risky", 1


def _camera_vote_stats(candidates: list[Any]) -> tuple[int, str, dict[str, int]]:
    counts: Counter[str] = Counter()
    for item in candidates:
        if not isinstance(item, dict):
            continue
        score = item.get("score") if isinstance(item.get("score"), dict) else None
        counts[_label(score)] += 1
    if not counts:
        return 0, "", {}
    label, count = counts.most_common(1)[0]
    return int(count), label, dict(counts)


def _load_pack(pack: Path, dataset: str) -> dict[str, Any] | None:
    meta_path = pack / "metadata.json"
    if not meta_path.exists():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return None

    original_score = meta.get("original_score") if isinstance(meta.get("original_score"), dict) else None
    corrected_score = meta.get("corrected_score") if isinstance(meta.get("corrected_score"), dict) else None
    expected_score = corrected_score if corrected_score is not None else original_score
    expected_key = _score_key(expected_score)
    original_key = _score_key(original_score)
    matches = original_key == expected_key if expected_key is not None else None

    opencv = meta.get("opencv_result") if isinstance(meta.get("opencv_result"), dict) else {}
    scoring = opencv.get("scoring") if isinstance(opencv.get("scoring"), dict) else {}
    cluster = _cluster(scoring)
    agreement = int(cluster.get("agreement") or meta.get("votes") or 0)
    spread = _spread(scoring, cluster)
    source = str(scoring.get("source") or (original_score or {}).get("board", {}).get("opencv_source") or "")
    mask_mode = str(scoring.get("mask_mode") or "")
    camera_agreement, camera_majority, camera_votes = _camera_vote_stats(meta.get("candidates") or [])
    quality, quality_score = _quality_bucket(bool(matches), source, agreement, spread, camera_agreement)

    mode_candidates = scoring.get("mask_mode_candidates") if isinstance(scoring.get("mask_mode_candidates"), dict) else {}
    mode_rows = []
    selected_mode = str(mode_candidates.get("selected") or mask_mode)
    for name, item in mode_candidates.items():
        if name == "selected" or not isinstance(item, dict):
            continue
        mode_rows.append(
            {
                "mode": name,
                "rank": int(item.get("rank") or 0),
                "score": _candidate_score(item),
                "label": str(item.get("label") or ""),
                "source": str(item.get("source") or ""),
                "agreement": _candidate_agreement(item),
                "spread": _candidate_spread(item),
                "selected": name == selected_mode,
            }
        )
    selected_score_value = int(meta.get("original_score_value") or 0)
    same_score_modes = [m for m in mode_rows if _candidate_score(m) == selected_score_value]
    different_score_modes = [m for m in mode_rows if _candidate_score(m) != selected_score_value]
    best_same = max(same_score_modes, key=lambda m: (m["agreement"], -m["spread"], m["rank"]), default=None)
    best_different = max(different_score_modes, key=lambda m: (m["agreement"], -m["spread"], m["rank"]), default=None)

    timings = meta.get("scoring_timings") if isinstance(meta.get("scoring_timings"), dict) else {}
    return {
        "pack": pack.name,
        "path": str(pack),
        "dataset": dataset,
        "kind": str(meta.get("kind") or ""),
        "round_session_id": int(meta.get("round_session_id") or 0),
        "dart_index": int(meta.get("dart_index") or 0),
        "saved_at_ms": int(meta.get("saved_at_ms") or 0),
        "predicted": _label(original_score, meta.get("original_score_value")),
        "expected": _label(expected_score),
        "matches": bool(matches),
        "quality": quality,
        "quality_score": quality_score,
        "source": source,
        "mask_mode": mask_mode,
        "selected_mode": selected_mode,
        "line_agreement": agreement,
        "line_spread_px": round(float(spread), 3),
        "camera_vote_agreement": camera_agreement,
        "camera_vote_majority": camera_majority,
        "camera_votes": json.dumps(camera_votes, sort_keys=True),
        "mode_candidates": json.dumps(mode_rows, sort_keys=True),
        "best_same_score_mode": json.dumps(best_same, sort_keys=True) if best_same else "",
        "best_different_score_mode": json.dumps(best_different, sort_keys=True) if best_different else "",
        "processing_ms": round(float(meta.get("processing_ms") or 0.0), 2),
        "total_ms": round(float(meta.get("total_ms") or 0.0), 2),
        "timings": json.dumps(timings, sort_keys=True),
    }


def _write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def _write_markdown(path: Path, rows: list[dict[str, Any]], summary: dict[str, Any]) -> None:
    lines = [
        "# OpenCV Scoring Quality Audit",
        "",
        f"Generated: {datetime.now().isoformat(timespec='seconds')}",
        "",
        "## Summary",
        "",
        f"- Packs evaluated: {summary['packs']}",
        f"- Correct final scores: {summary['correct']} / {summary['packs']} ({summary['accuracy_percent']:.2f}%)",
        f"- Average processing: {summary['avg_processing_ms']:.1f} ms",
        f"- Average total: {summary['avg_total_ms']:.1f} ms",
        "",
        "## Quality Buckets",
        "",
        "| Bucket | Count |",
        "|---|---:|",
    ]
    for bucket, count in summary["quality_counts"].items():
        lines.append(f"| {bucket} | {count} |")
    lines.extend(["", "## Mask Modes", "", "| Mode | Count |", "|---|---:|"])
    for mode, count in summary["mask_mode_counts"].items():
        lines.append(f"| {mode or 'unknown'} | {count} |")
    risky = [r for r in rows if r["matches"] and r["quality_score"] <= 2]
    wrong = [r for r in rows if not r["matches"]]
    lines.extend(["", "## Wrong Scores", "", "| Pack | Predicted | Expected | Source | Mode | Agreement | Spread |", "|---|---|---|---|---|---:|---:|"])
    for r in wrong[:80]:
        lines.append(
            f"| {r['pack']} | {r['predicted']} | {r['expected']} | {r['source']} | {r['selected_mode']} | {r['line_agreement']} | {r['line_spread_px']} |"
        )
    lines.extend(["", "## Risky Correct Scores", "", "| Pack | Score | Quality | Source | Mode | Agreement | Spread | Camera vote |", "|---|---|---|---|---|---:|---:|---|"])
    for r in risky[:120]:
        lines.append(
            f"| {r['pack']} | {r['predicted']} | {r['quality']} | {r['source']} | {r['selected_mode']} | {r['line_agreement']} | {r['line_spread_px']} | {r['camera_vote_majority']} {r['camera_vote_agreement']}/3 |"
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corrections", default=str(DATA_ROOT / "correction_debug"))
    parser.add_argument("--correct", default=str(DATA_ROOT / "regression_debug" / "correct"))
    parser.add_argument("--output-dir", default=str(DATA_ROOT / "calibration_audit" / "scoring_quality"))
    parser.add_argument("--since-ms", type=int, default=0)
    args = parser.parse_args()

    rows: list[dict[str, Any]] = []
    for dataset, root_raw in (("correction", args.corrections), ("correct", args.correct)):
        root = Path(root_raw)
        if not root.exists():
            continue
        for pack in sorted(p for p in root.iterdir() if p.is_dir()):
            row = _load_pack(pack, dataset)
            if row is None:
                continue
            if args.since_ms and int(row["saved_at_ms"] or 0) < int(args.since_ms):
                continue
            rows.append(row)

    quality_counts = dict(Counter(r["quality"] for r in rows))
    mask_mode_counts = dict(Counter(r["selected_mode"] or r["mask_mode"] for r in rows))
    correct = sum(1 for r in rows if r["matches"])
    avg_processing = sum(float(r["processing_ms"]) for r in rows) / len(rows) if rows else 0.0
    avg_total = sum(float(r["total_ms"]) for r in rows) / len(rows) if rows else 0.0
    summary = {
        "packs": len(rows),
        "correct": correct,
        "accuracy_percent": (correct / len(rows) * 100.0) if rows else 0.0,
        "avg_processing_ms": avg_processing,
        "avg_total_ms": avg_total,
        "quality_counts": quality_counts,
        "mask_mode_counts": mask_mode_counts,
        "by_dataset": {
            dataset: {
                "packs": len(group),
                "correct": sum(1 for r in group if r["matches"]),
                "quality_counts": dict(Counter(r["quality"] for r in group)),
            }
            for dataset, group in _groups(rows, "dataset").items()
        },
    }

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    _write_csv(out_dir / "scoring_quality_rows.csv", rows)
    (out_dir / "scoring_quality_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    (out_dir / "scoring_quality_rows.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
    _write_markdown(out_dir / "scoring_quality_report.md", rows, summary)

    print(f"packs={summary['packs']} correct={summary['correct']}/{summary['packs']} accuracy={summary['accuracy_percent']:.2f}%")
    print(f"quality={summary['quality_counts']}")
    print(f"mask_modes={summary['mask_mode_counts']}")
    print(f"report={out_dir / 'scoring_quality_report.md'}")
    return 0


def _groups(rows: list[dict[str, Any]], key: str) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[str(row.get(key) or "")].append(row)
    return grouped


if __name__ == "__main__":
    raise SystemExit(main())
