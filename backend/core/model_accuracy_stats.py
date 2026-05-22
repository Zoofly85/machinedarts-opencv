from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any

from backend.core.tip_scoring import is_model_stats_enabled


def _resolve_stats_path() -> Path:
    if getattr(sys, "frozen", False):
        if os.name == "nt":
            appdata = os.getenv("APPDATA", "").strip()
            base = Path(appdata).resolve() / "DartDetector" if appdata else Path.home() / "AppData" / "Roaming" / "DartDetector"
        else:
            xdg_data_home = os.getenv("XDG_DATA_HOME", "").strip()
            base = Path(xdg_data_home).resolve() if xdg_data_home else Path.home() / ".local" / "share"
            base = base / "DartDetector"
        return base / "settings" / "model_accuracy_stats.json"
    return Path(__file__).resolve().parents[1] / "data" / "settings" / "model_accuracy_stats.json"


_STATS_PATH = _resolve_stats_path()
_LOCK = threading.Lock()


def _default_payload() -> dict[str, Any]:
    return {
        "version": 1,
        "models": {},
        "totals": {
            "total_darts": 0,
            "detected_darts": 0,
            "no_detection": 0,
            "corrected_darts": 0,
            "three_cam_total": 0,
            "three_cam_all_match": 0,
            "three_cam_two_match": 0,
            "three_cam_all_diff": 0,
            "two_cam_total": 0,
            "two_cam_match": 0,
            "two_cam_disagree": 0,
            "single_cam_total": 0,
            "score_events": 0,
            "sum_detection_to_score_ms": 0.0,
            "sum_inference_ms": 0.0,
            "sum_score_total_ms": 0.0,
            "sum_queue_wait_ms": 0.0,
            "sum_preprocess_ms": 0.0,
            "sum_decode_ms": 0.0,
            "sum_selection_ms": 0.0,
            "sum_calibration_ms": 0.0,
            "sum_vote_ms": 0.0,
        },
        "updated_at_ms": int(time.time() * 1000),
    }


def _load_payload() -> dict[str, Any]:
    payload = _default_payload()
    try:
        if _STATS_PATH.exists():
            incoming = json.loads(_STATS_PATH.read_text(encoding="utf-8"))
            if isinstance(incoming, dict):
                payload.update({k: incoming[k] for k in payload.keys() if k in incoming})
    except Exception:
        pass
    if not isinstance(payload.get("models"), dict):
        payload["models"] = {}
    if not isinstance(payload.get("totals"), dict):
        payload["totals"] = {}
    payload["totals"].setdefault("total_darts", 0)
    payload["totals"].setdefault("detected_darts", 0)
    payload["totals"].setdefault("no_detection", 0)
    payload["totals"].setdefault("corrected_darts", 0)
    payload["totals"].setdefault("three_cam_total", 0)
    payload["totals"].setdefault("three_cam_all_match", 0)
    payload["totals"].setdefault("three_cam_two_match", 0)
    payload["totals"].setdefault("three_cam_all_diff", 0)
    payload["totals"].setdefault("two_cam_total", 0)
    payload["totals"].setdefault("two_cam_match", 0)
    payload["totals"].setdefault("two_cam_disagree", 0)
    payload["totals"].setdefault("single_cam_total", 0)
    payload["totals"].setdefault("score_events", 0)
    payload["totals"].setdefault("sum_detection_to_score_ms", 0.0)
    payload["totals"].setdefault("sum_inference_ms", 0.0)
    payload["totals"].setdefault("sum_score_total_ms", 0.0)
    payload["totals"].setdefault("sum_queue_wait_ms", 0.0)
    payload["totals"].setdefault("sum_preprocess_ms", 0.0)
    payload["totals"].setdefault("sum_decode_ms", 0.0)
    payload["totals"].setdefault("sum_selection_ms", 0.0)
    payload["totals"].setdefault("sum_calibration_ms", 0.0)
    payload["totals"].setdefault("sum_vote_ms", 0.0)
    return payload


def _save_payload(payload: dict[str, Any]) -> None:
    _STATS_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload["updated_at_ms"] = int(time.time() * 1000)
    _STATS_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _normalize_model_id(model_id: str | None) -> str:
    value = str(model_id or "").strip()
    return value if value else "unknown"


def _ensure_model(payload: dict[str, Any], model_id: str) -> dict[str, Any]:
    models = payload.setdefault("models", {})
    entry = models.setdefault(
        model_id,
        {
            "total_darts": 0,
            "detected_darts": 0,
            "no_detection": 0,
            "corrected_darts": 0,
            "score_events": 0,
            "sum_detection_to_score_ms": 0.0,
            "sum_inference_ms": 0.0,
            "sum_score_total_ms": 0.0,
            "sum_queue_wait_ms": 0.0,
            "sum_preprocess_ms": 0.0,
            "sum_decode_ms": 0.0,
            "sum_selection_ms": 0.0,
            "sum_calibration_ms": 0.0,
            "sum_vote_ms": 0.0,
            "last_used_at_ms": None,
            "last_corrected_at_ms": None,
            "three_cam_total": 0,
            "three_cam_all_match": 0,
            "three_cam_two_match": 0,
            "three_cam_all_diff": 0,
            "two_cam_total": 0,
            "two_cam_match": 0,
            "two_cam_disagree": 0,
            "single_cam_total": 0,
        },
    )
    entry.setdefault("total_darts", 0)
    entry.setdefault("detected_darts", 0)
    entry.setdefault("no_detection", 0)
    entry.setdefault("corrected_darts", 0)
    entry.setdefault("score_events", 0)
    entry.setdefault("sum_detection_to_score_ms", 0.0)
    entry.setdefault("sum_inference_ms", 0.0)
    entry.setdefault("sum_score_total_ms", 0.0)
    entry.setdefault("sum_queue_wait_ms", 0.0)
    entry.setdefault("sum_preprocess_ms", 0.0)
    entry.setdefault("sum_decode_ms", 0.0)
    entry.setdefault("sum_selection_ms", 0.0)
    entry.setdefault("sum_calibration_ms", 0.0)
    entry.setdefault("sum_vote_ms", 0.0)
    entry.setdefault("last_used_at_ms", None)
    entry.setdefault("last_corrected_at_ms", None)
    entry.setdefault("three_cam_total", 0)
    entry.setdefault("three_cam_all_match", 0)
    entry.setdefault("three_cam_two_match", 0)
    entry.setdefault("three_cam_all_diff", 0)
    entry.setdefault("two_cam_total", 0)
    entry.setdefault("two_cam_match", 0)
    entry.setdefault("two_cam_disagree", 0)
    entry.setdefault("single_cam_total", 0)
    return entry


def _score_value(candidate: dict[str, Any]) -> int | None:
    try:
        return int(candidate.get("score_value", 0))
    except Exception:
        return None


def _record_agreement_buckets(entry: dict[str, Any], candidates: list[dict[str, Any]]) -> None:
    hits = [c for c in candidates if isinstance(c, dict)]
    hit_count = len(hits)
    if hit_count <= 0:
        entry["no_detection"] = int(entry.get("no_detection", 0)) + 1
        return

    entry["detected_darts"] = int(entry.get("detected_darts", 0)) + 1
    if hit_count == 1:
        entry["single_cam_total"] = int(entry.get("single_cam_total", 0)) + 1
        return

    values = [_score_value(c) for c in hits]
    if hit_count == 2:
        entry["two_cam_total"] = int(entry.get("two_cam_total", 0)) + 1
        if values[0] is not None and values[0] == values[1]:
            entry["two_cam_match"] = int(entry.get("two_cam_match", 0)) + 1
        else:
            entry["two_cam_disagree"] = int(entry.get("two_cam_disagree", 0)) + 1
        return

    entry["three_cam_total"] = int(entry.get("three_cam_total", 0)) + 1
    unique_scores = {v for v in values if v is not None}
    if len(unique_scores) == 1:
        entry["three_cam_all_match"] = int(entry.get("three_cam_all_match", 0)) + 1
    elif len(unique_scores) == 2:
        entry["three_cam_two_match"] = int(entry.get("three_cam_two_match", 0)) + 1
    else:
        entry["three_cam_all_diff"] = int(entry.get("three_cam_all_diff", 0)) + 1


def record_model_detection(
    model_id: str | None,
    candidates: list[dict[str, Any]] | None = None,
    total_ms: float | None = None,
    processing_ms: float | None = None,
    timings: dict[str, Any] | None = None,
) -> None:
    if not is_model_stats_enabled():
        return
    model = _normalize_model_id(model_id)
    safe_candidates = candidates if isinstance(candidates, list) else []
    with _LOCK:
        payload = _load_payload()
        entry = _ensure_model(payload, model)
        entry["total_darts"] = int(entry.get("total_darts", 0)) + 1
        _record_agreement_buckets(entry, safe_candidates)
        safe_timings = timings if isinstance(timings, dict) else {}
        score_total_ms = float(safe_timings.get("total_ms", 0.0) or 0.0)
        preprocess_ms = float(safe_timings.get("preprocess_ms", 0.0) or 0.0)
        decode_ms = float(safe_timings.get("decode_ms", 0.0) or 0.0)
        selection_ms = float(safe_timings.get("selection_ms", 0.0) or 0.0)
        calibration_ms = float(safe_timings.get("calibration_ms", 0.0) or 0.0)
        vote_ms = float(safe_timings.get("vote_ms", 0.0) or 0.0)
        queue_wait_ms = max(0.0, float(total_ms or 0.0) - score_total_ms)
        try:
            if total_ms is not None:
                entry["sum_detection_to_score_ms"] = float(entry.get("sum_detection_to_score_ms", 0.0)) + float(total_ms)
            if processing_ms is not None:
                entry["sum_inference_ms"] = float(entry.get("sum_inference_ms", 0.0)) + float(processing_ms)
            entry["sum_score_total_ms"] = float(entry.get("sum_score_total_ms", 0.0)) + score_total_ms
            entry["sum_queue_wait_ms"] = float(entry.get("sum_queue_wait_ms", 0.0)) + queue_wait_ms
            entry["sum_preprocess_ms"] = float(entry.get("sum_preprocess_ms", 0.0)) + preprocess_ms
            entry["sum_decode_ms"] = float(entry.get("sum_decode_ms", 0.0)) + decode_ms
            entry["sum_selection_ms"] = float(entry.get("sum_selection_ms", 0.0)) + selection_ms
            entry["sum_calibration_ms"] = float(entry.get("sum_calibration_ms", 0.0)) + calibration_ms
            entry["sum_vote_ms"] = float(entry.get("sum_vote_ms", 0.0)) + vote_ms
            if total_ms is not None or processing_ms is not None:
                entry["score_events"] = int(entry.get("score_events", 0)) + 1
        except Exception:
            pass
        entry["last_used_at_ms"] = int(time.time() * 1000)
        totals = payload["totals"]
        totals["total_darts"] = int(totals.get("total_darts", 0)) + 1
        _record_agreement_buckets(totals, safe_candidates)
        try:
            if total_ms is not None:
                totals["sum_detection_to_score_ms"] = float(totals.get("sum_detection_to_score_ms", 0.0)) + float(total_ms)
            if processing_ms is not None:
                totals["sum_inference_ms"] = float(totals.get("sum_inference_ms", 0.0)) + float(processing_ms)
            totals["sum_score_total_ms"] = float(totals.get("sum_score_total_ms", 0.0)) + score_total_ms
            totals["sum_queue_wait_ms"] = float(totals.get("sum_queue_wait_ms", 0.0)) + queue_wait_ms
            totals["sum_preprocess_ms"] = float(totals.get("sum_preprocess_ms", 0.0)) + preprocess_ms
            totals["sum_decode_ms"] = float(totals.get("sum_decode_ms", 0.0)) + decode_ms
            totals["sum_selection_ms"] = float(totals.get("sum_selection_ms", 0.0)) + selection_ms
            totals["sum_calibration_ms"] = float(totals.get("sum_calibration_ms", 0.0)) + calibration_ms
            totals["sum_vote_ms"] = float(totals.get("sum_vote_ms", 0.0)) + vote_ms
            if total_ms is not None or processing_ms is not None:
                totals["score_events"] = int(totals.get("score_events", 0)) + 1
        except Exception:
            pass
        _save_payload(payload)


def record_model_correction(model_id: str | None) -> None:
    if not is_model_stats_enabled():
        return
    model = _normalize_model_id(model_id)
    with _LOCK:
        payload = _load_payload()
        entry = _ensure_model(payload, model)
        entry["corrected_darts"] = int(entry.get("corrected_darts", 0)) + 1
        entry["last_corrected_at_ms"] = int(time.time() * 1000)
        totals = payload["totals"]
        totals["corrected_darts"] = int(totals.get("corrected_darts", 0)) + 1
        _save_payload(payload)


def _compute_accuracy(total_darts: int, corrected_darts: int) -> float | None:
    if total_darts <= 0:
        return None
    acc = 100.0 * (float(total_darts - corrected_darts) / float(total_darts))
    if acc < 0.0:
        acc = 0.0
    if acc > 100.0:
        acc = 100.0
    return round(acc, 2)


def get_model_accuracy_stats(active_model_id: str | None = None) -> dict[str, Any]:
    with _LOCK:
        payload = _load_payload()
    payload["totals"].setdefault("score_events", 0)
    payload["totals"].setdefault("sum_detection_to_score_ms", 0.0)
    payload["totals"].setdefault("sum_inference_ms", 0.0)
    payload["totals"].setdefault("sum_score_total_ms", 0.0)
    payload["totals"].setdefault("sum_queue_wait_ms", 0.0)
    payload["totals"].setdefault("sum_preprocess_ms", 0.0)
    payload["totals"].setdefault("sum_decode_ms", 0.0)
    payload["totals"].setdefault("sum_selection_ms", 0.0)
    payload["totals"].setdefault("sum_calibration_ms", 0.0)
    payload["totals"].setdefault("sum_vote_ms", 0.0)

    models_out: list[dict[str, Any]] = []
    for model_id, raw in payload.get("models", {}).items():
        total = int(raw.get("total_darts", 0))
        detected = int(raw.get("detected_darts", 0))
        corrected = int(raw.get("corrected_darts", 0))
        score_events = int(raw.get("score_events", 0))
        sum_total_ms = float(raw.get("sum_detection_to_score_ms", 0.0))
        sum_proc_ms = float(raw.get("sum_inference_ms", 0.0))
        sum_score_total_ms = float(raw.get("sum_score_total_ms", 0.0))
        sum_queue_wait_ms = float(raw.get("sum_queue_wait_ms", 0.0))
        sum_preprocess_ms = float(raw.get("sum_preprocess_ms", 0.0))
        sum_decode_ms = float(raw.get("sum_decode_ms", 0.0))
        sum_selection_ms = float(raw.get("sum_selection_ms", 0.0))
        sum_calibration_ms = float(raw.get("sum_calibration_ms", 0.0))
        sum_vote_ms = float(raw.get("sum_vote_ms", 0.0))
        models_out.append(
            {
                "model_id": model_id,
                "total_darts": total,
                "detected_darts": detected,
                "no_detection": int(raw.get("no_detection", 0)),
                "corrected_darts": corrected,
                "uncorrected_darts": max(0, total - corrected),
                "accuracy_percent": _compute_accuracy(total, corrected),
                "avg_detection_to_score_ms": (round(sum_total_ms / score_events, 2) if score_events > 0 else None),
                "avg_inference_ms": (round(sum_proc_ms / score_events, 2) if score_events > 0 else None),
                "avg_score_total_ms": (round(sum_score_total_ms / score_events, 2) if score_events > 0 else None),
                "avg_queue_wait_ms": (round(sum_queue_wait_ms / score_events, 2) if score_events > 0 else None),
                "avg_preprocess_ms": (round(sum_preprocess_ms / score_events, 2) if score_events > 0 else None),
                "avg_decode_ms": (round(sum_decode_ms / score_events, 2) if score_events > 0 else None),
                "avg_selection_ms": (round(sum_selection_ms / score_events, 2) if score_events > 0 else None),
                "avg_calibration_ms": (round(sum_calibration_ms / score_events, 2) if score_events > 0 else None),
                "avg_vote_ms": (round(sum_vote_ms / score_events, 2) if score_events > 0 else None),
                "three_cam_total": int(raw.get("three_cam_total", 0)),
                "three_cam_all_match": int(raw.get("three_cam_all_match", 0)),
                "three_cam_two_match": int(raw.get("three_cam_two_match", 0)),
                "three_cam_all_diff": int(raw.get("three_cam_all_diff", 0)),
                "two_cam_total": int(raw.get("two_cam_total", 0)),
                "two_cam_match": int(raw.get("two_cam_match", 0)),
                "two_cam_disagree": int(raw.get("two_cam_disagree", 0)),
                "single_cam_total": int(raw.get("single_cam_total", 0)),
                "last_used_at_ms": raw.get("last_used_at_ms"),
                "last_corrected_at_ms": raw.get("last_corrected_at_ms"),
            }
        )

    models_out.sort(key=lambda m: int(m.get("total_darts", 0)), reverse=True)
    totals = payload.get("totals", {})
    total_darts = int(totals.get("total_darts", 0))
    total_detected = int(totals.get("detected_darts", 0))
    total_corrected = int(totals.get("corrected_darts", 0))
    total_score_events = int(totals.get("score_events", 0))
    total_sum_total_ms = float(totals.get("sum_detection_to_score_ms", 0.0))
    total_sum_proc_ms = float(totals.get("sum_inference_ms", 0.0))
    total_sum_score_total_ms = float(totals.get("sum_score_total_ms", 0.0))
    total_sum_queue_wait_ms = float(totals.get("sum_queue_wait_ms", 0.0))
    total_sum_preprocess_ms = float(totals.get("sum_preprocess_ms", 0.0))
    total_sum_decode_ms = float(totals.get("sum_decode_ms", 0.0))
    total_sum_selection_ms = float(totals.get("sum_selection_ms", 0.0))
    total_sum_calibration_ms = float(totals.get("sum_calibration_ms", 0.0))
    total_sum_vote_ms = float(totals.get("sum_vote_ms", 0.0))

    return {
        "active_model_id": _normalize_model_id(active_model_id),
        "totals": {
            "total_darts": total_darts,
            "detected_darts": total_detected,
            "no_detection": int(totals.get("no_detection", 0)),
            "corrected_darts": total_corrected,
            "uncorrected_darts": max(0, total_darts - total_corrected),
            "accuracy_percent": _compute_accuracy(total_darts, total_corrected),
            "avg_detection_to_score_ms": (round(total_sum_total_ms / total_score_events, 2) if total_score_events > 0 else None),
            "avg_inference_ms": (round(total_sum_proc_ms / total_score_events, 2) if total_score_events > 0 else None),
            "avg_score_total_ms": (round(total_sum_score_total_ms / total_score_events, 2) if total_score_events > 0 else None),
            "avg_queue_wait_ms": (round(total_sum_queue_wait_ms / total_score_events, 2) if total_score_events > 0 else None),
            "avg_preprocess_ms": (round(total_sum_preprocess_ms / total_score_events, 2) if total_score_events > 0 else None),
            "avg_decode_ms": (round(total_sum_decode_ms / total_score_events, 2) if total_score_events > 0 else None),
            "avg_selection_ms": (round(total_sum_selection_ms / total_score_events, 2) if total_score_events > 0 else None),
            "avg_calibration_ms": (round(total_sum_calibration_ms / total_score_events, 2) if total_score_events > 0 else None),
            "avg_vote_ms": (round(total_sum_vote_ms / total_score_events, 2) if total_score_events > 0 else None),
            "three_cam_total": int(totals.get("three_cam_total", 0)),
            "three_cam_all_match": int(totals.get("three_cam_all_match", 0)),
            "three_cam_two_match": int(totals.get("three_cam_two_match", 0)),
            "three_cam_all_diff": int(totals.get("three_cam_all_diff", 0)),
            "two_cam_total": int(totals.get("two_cam_total", 0)),
            "two_cam_match": int(totals.get("two_cam_match", 0)),
            "two_cam_disagree": int(totals.get("two_cam_disagree", 0)),
            "single_cam_total": int(totals.get("single_cam_total", 0)),
        },
        "models": models_out,
        "updated_at_ms": payload.get("updated_at_ms"),
    }


def reset_model_accuracy_stats() -> dict[str, Any]:
    with _LOCK:
        payload = _default_payload()
        _save_payload(payload)
    return get_model_accuracy_stats(active_model_id=None)
