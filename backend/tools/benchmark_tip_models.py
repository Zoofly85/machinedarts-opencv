#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Any, Optional

import cv2
import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.core.calibration_manager import CalibrationManager
from backend.core.tip_scoring import OpenVinoTipDetector, list_available_tip_models


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Replay saved benchmark_capture datasets against multiple tip-scoring scenarios.")
    p.add_argument("--dataset", required=True, help="Dataset name under backend/data/benchmark_capture")
    p.add_argument(
        "--modes",
        nargs="+",
        default=["full_frame", "roi_mask", "roi_crop"],
        choices=["full_frame", "roi_mask", "roi_crop"],
        help="Inference modes to compare",
    )
    p.add_argument(
        "--models",
        nargs="*",
        default=[],
        help="Model ids to test. Default: all available models on disk.",
    )
    p.add_argument("--device", default="CPU", help="OpenVINO device to use for the benchmark run")
    p.add_argument("--margin", type=float, default=0.08, help="ROI margin as a fraction of ROI width/height")
    p.add_argument("--output", default="", help="Optional output json path")
    return p.parse_args()


def dataset_root(dataset_name: str) -> Path:
    return Path(__file__).resolve().parents[1] / "data" / "benchmark_capture" / dataset_name


def load_dataset_turns(root: Path) -> list[dict[str, Any]]:
    turns: list[dict[str, Any]] = []
    for metadata_path in sorted(root.glob("turn_*/metadata.json")):
        payload = json.loads(metadata_path.read_text(encoding="utf-8"))
        payload["_turn_dir"] = str(metadata_path.parent)
        turns.append(payload)
    return turns


def load_roi_boxes(calibration_root: Path, margin_ratio: float) -> dict[int, tuple[int, int, int, int]]:
    out: dict[int, tuple[int, int, int, int]] = {}
    for cam_dir in sorted(calibration_root.glob("camera_*")):
        try:
            cam_idx = int(cam_dir.name.split("_")[1])
        except Exception:
            continue
        json_path = cam_dir / "dartboard_calibration.json"
        if not json_path.exists():
            continue
        payload = json.loads(json_path.read_text(encoding="utf-8"))
        ellipse = (((payload or {}).get("ellipse") or {}).get("outer_double_ellipse") or {})
        center = ellipse.get("center") or {}
        axes = ellipse.get("axes") or {}
        cx = float(center.get("x"))
        cy = float(center.get("y"))
        w = float(axes.get("width"))
        h = float(axes.get("height"))
        margin_x = w * float(margin_ratio)
        margin_y = h * float(margin_ratio)
        x1 = int(round(cx - (w / 2.0) - margin_x))
        y1 = int(round(cy - (h / 2.0) - margin_y))
        x2 = int(round(cx + (w / 2.0) + margin_x))
        y2 = int(round(cy + (h / 2.0) + margin_y))
        out[cam_idx] = (x1, y1, x2, y2)
    return out


def apply_mode(frame: np.ndarray, roi: Optional[tuple[int, int, int, int]], mode: str) -> np.ndarray:
    if roi is None or mode == "full_frame":
        return frame
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = roi
    x1 = max(0, min(w - 1, x1))
    y1 = max(0, min(h - 1, y1))
    x2 = max(x1 + 1, min(w, x2))
    y2 = max(y1 + 1, min(h, y2))
    if mode == "roi_mask":
        masked = np.zeros_like(frame)
        masked[y1:y2, x1:x2] = frame[y1:y2, x1:x2]
        return masked
    if mode == "roi_crop":
        return frame[y1:y2, x1:x2].copy()
    return frame


def map_candidate_to_fullframe(candidate: dict[str, float], roi: Optional[tuple[int, int, int, int]], mode: str) -> dict[str, float]:
    if roi is None or mode != "roi_crop":
        return dict(candidate)
    x1, y1, _, _ = roi
    out = dict(candidate)
    for key in ("x", "x1", "x2"):
        out[key] = float(out[key]) + float(x1)
    for key in ("y", "y1", "y2"):
        out[key] = float(out[key]) + float(y1)
    return out


def distance(a: tuple[float, float], b: tuple[float, float]) -> float:
    return float(math.hypot(a[0] - b[0], a[1] - b[1]))


def score_turn(
    detector: OpenVinoTipDetector,
    cal_manager: CalibrationManager,
    turn: dict[str, Any],
    mode: str,
    roi_boxes: dict[int, tuple[int, int, int, int]],
    duplicate_px: float = 4.0,
) -> list[dict[str, Any]]:
    tracked_tips: dict[int, list[tuple[float, float]]] = defaultdict(list)
    results: list[dict[str, Any]] = []
    turn_dir = Path(turn["_turn_dir"])
    for dart in turn.get("darts", []):
        dart_index = int(dart.get("dart_index", 0) or 0)
        if not dart.get("captured"):
            continue

        frames: list[Optional[np.ndarray]] = []
        source_frames: list[Optional[np.ndarray]] = []
        processed_rois: list[Optional[tuple[int, int, int, int]]] = []
        for cam_idx in range(3):
            image_path = turn_dir / f"dart_{dart_index}" / f"cam{cam_idx + 1}.png"
            if image_path.exists():
                frame = cv2.imread(str(image_path))
            else:
                frame = None
            source_frames.append(frame)
            roi = roi_boxes.get(cam_idx)
            processed_rois.append(roi)
            if frame is None:
                frames.append(None)
            else:
                frames.append(apply_mode(frame, roi, mode))

        total_t0 = time.perf_counter()
        batch_candidates, detect_timings = detector.detect_tip_candidates_batch_timed(frames, max_candidates=6)
        selection_ms = 0.0
        calibration_ms = 0.0
        vote_ms = 0.0
        candidates: list[dict[str, Any]] = []
        selected_new_tips: list[tuple[int, float, float]] = []

        for cam_idx, tip_candidates in enumerate(batch_candidates):
            selected = None
            roi = processed_rois[cam_idx]
            t0 = time.perf_counter()
            for candidate in tip_candidates:
                mapped = map_candidate_to_fullframe(candidate, roi, mode)
                p = (float(mapped["x"]), float(mapped["y"]))
                if any(distance(p, old) <= duplicate_px for old in tracked_tips.get(cam_idx, [])):
                    continue
                selected = mapped
                break
            selection_ms += (time.perf_counter() - t0) * 1000.0
            if selected is None:
                continue

            t0 = time.perf_counter()
            score_info = cal_manager.score(cam_idx, float(selected["x"]), float(selected["y"]))
            calibration_ms += (time.perf_counter() - t0) * 1000.0
            score_value = int(score_info.get("score", 0)) if isinstance(score_info, dict) else 0
            selected_new_tips.append((cam_idx, float(selected["x"]), float(selected["y"])))
            candidates.append(
                {
                    "camera_index": cam_idx,
                    "tip": {"x": float(selected["x"]), "y": float(selected["y"])},
                    "confidence": float(selected.get("score_confidence", selected.get("confidence", 0.0))),
                    "score": score_info,
                    "score_value": score_value,
                }
            )

        unavailable = False
        if not candidates:
            predicted_score = 0
            predicted = {"score": 0, "multiplier": 0, "segment": "0", "zone": "miss", "confidence": 1.0}
            votes = 0
            unavailable = True
        else:
            groups: dict[int, list[dict[str, Any]]] = defaultdict(list)
            t0 = time.perf_counter()
            for candidate in candidates:
                groups[int(candidate["score_value"])].append(candidate)
            winner_value = max(
                groups.keys(),
                key=lambda key: (len(groups[key]), float(np.mean([c["confidence"] for c in groups[key]]))),
            )
            winner_group = groups[winner_value]
            representative = max(winner_group, key=lambda item: item["confidence"])
            vote_ms += (time.perf_counter() - t0) * 1000.0
            predicted_score = int(winner_value)
            predicted = representative["score"]
            votes = len(winner_group)
            for cam_idx, x, y in selected_new_tips:
                tracked_tips[cam_idx].append((float(x), float(y)))

        total_ms = (time.perf_counter() - total_t0) * 1000.0
        final_score = dart.get("final_score") or {}
        gt_score = int((final_score or {}).get("score", 0) or 0)

        results.append(
            {
                "dart_index": dart_index,
                "ground_truth_score": gt_score,
                "predicted_score": predicted_score,
                "exact_match": bool(predicted_score == gt_score),
                "unavailable": unavailable,
                "votes": votes,
                "predicted": predicted,
                "ground_truth": final_score,
                "timings": {
                    "preprocess_ms": round(float(detect_timings.get("preprocess_ms", 0.0)), 2),
                    "inference_ms": round(float(detect_timings.get("inference_ms", 0.0)), 2),
                    "decode_ms": round(float(detect_timings.get("decode_ms", 0.0)), 2),
                    "selection_ms": round(selection_ms, 2),
                    "calibration_ms": round(calibration_ms, 2),
                    "vote_ms": round(vote_ms, 2),
                    "total_ms": round(total_ms, 2),
                },
            }
        )
    return results


def summarize(results: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(results)
    exact = sum(1 for r in results if r["exact_match"])
    unavailable = sum(1 for r in results if r["unavailable"])
    avg = lambda key: round(sum(float(r["timings"].get(key, 0.0)) for r in results) / total, 2) if total else 0.0
    return {
        "total_darts": total,
        "exact_matches": exact,
        "accuracy_percent": round((exact / total) * 100.0, 2) if total else 0.0,
        "unavailable_count": unavailable,
        "avg_preprocess_ms": avg("preprocess_ms"),
        "avg_inference_ms": avg("inference_ms"),
        "avg_decode_ms": avg("decode_ms"),
        "avg_selection_ms": avg("selection_ms"),
        "avg_calibration_ms": avg("calibration_ms"),
        "avg_vote_ms": avg("vote_ms"),
        "avg_total_ms": avg("total_ms"),
    }


def main() -> None:
    args = parse_args()
    root = dataset_root(args.dataset)
    if not root.exists():
        raise SystemExit(f"Dataset not found: {root}")
    turns = load_dataset_turns(root)
    if not turns:
        raise SystemExit(f"No turns found in dataset: {root}")

    calibration_root = root / "calibration"
    if not calibration_root.exists():
        raise SystemExit(f"Dataset has no calibration snapshot: {calibration_root}")
    roi_boxes = load_roi_boxes(calibration_root, args.margin)
    cal_manager = CalibrationManager(num_cameras=3, calibration_dir=str(calibration_root))

    available_models = {m["id"]: m for m in list_available_tip_models()}
    selected_model_ids = args.models or list(available_models.keys())
    missing = [model_id for model_id in selected_model_ids if model_id not in available_models]
    if missing:
        raise SystemExit(f"Unknown model ids: {missing}")

    report: dict[str, Any] = {
        "dataset": args.dataset,
        "dataset_root": str(root),
        "device": args.device,
        "modes": args.modes,
        "models": {},
        "generated_at_ms": int(time.time() * 1000),
    }

    total_models = len(selected_model_ids)
    total_modes = len(args.modes)
    total_turns = len(turns)

    print(
        f"Benchmark start | dataset={args.dataset} | turns={total_turns} | "
        f"models={total_models} | modes={total_modes} | device={args.device}"
    )

    for model_idx, model_id in enumerate(selected_model_ids, start=1):
        model_info = available_models[model_id]
        model_dir = Path(model_info["path"])
        model_report: dict[str, Any] = {"path": str(model_dir), "modes": {}}
        print(f"[{model_idx}/{total_models}] Loading model: {model_id}")
        for mode_idx, mode in enumerate(args.modes, start=1):
            print(f"  [{mode_idx}/{total_modes}] Mode: {mode}")
            detector = OpenVinoTipDetector(model_dir=model_dir, device=args.device, performance_hint="THROUGHPUT")
            all_results: list[dict[str, Any]] = []
            mode_started_at = time.perf_counter()
            for turn_idx, turn in enumerate(turns, start=1):
                all_results.extend(score_turn(detector, cal_manager, turn, mode, roi_boxes))
                if turn_idx == 1 or turn_idx == total_turns or (turn_idx % 5 == 0):
                    elapsed_s = time.perf_counter() - mode_started_at
                    print(
                        f"    turn {turn_idx}/{total_turns} | "
                        f"results={len(all_results)} | elapsed={elapsed_s:.1f}s"
                    )
            model_report["modes"][mode] = {
                "summary": summarize(all_results),
                "results": all_results,
            }
            summary = model_report["modes"][mode]["summary"]
            print(
                f"  done {mode} | acc={summary['accuracy_percent']:.2f}% "
                f"| unavailable={summary['unavailable_count']} "
                f"| infer={summary['avg_inference_ms']:.2f} ms "
                f"| total={summary['avg_total_ms']:.2f} ms"
            )
        report["models"][model_id] = model_report

    output_path = Path(args.output) if args.output else root / f"benchmark_results_{int(time.time())}.json"
    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Benchmark written to {output_path}")
    for model_id, model_report in report["models"].items():
        for mode, payload in model_report["modes"].items():
            summary = payload["summary"]
            print(
                f"{model_id} | {mode} | acc={summary['accuracy_percent']:.2f}% "
                f"| unavailable={summary['unavailable_count']} | infer={summary['avg_inference_ms']:.2f} ms "
                f"| total={summary['avg_total_ms']:.2f} ms"
            )


if __name__ == "__main__":
    main()
