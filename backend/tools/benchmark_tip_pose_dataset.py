#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path
from typing import Any

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.core.tip_scoring import OpenVinoTipDetector

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Benchmark OpenVINO tip pose models on a YOLO pose dataset subset.")
    p.add_argument("--dataset", required=True, help="YOLO dataset root containing split/images and split/labels")
    p.add_argument("--split", default="test", help="Dataset split to use, usually test or valid")
    p.add_argument("--models", nargs="+", required=True, help="OpenVINO model directories or model ids under models/tip")
    p.add_argument("--limit", type=int, default=200, help="Number of images to evaluate")
    p.add_argument("--device", default="GPU", help="OpenVINO device, e.g. CPU, GPU, GPU.0, AUTO")
    p.add_argument("--performance-hint", default="LATENCY", choices=["LATENCY", "THROUGHPUT"])
    p.add_argument("--conf", type=float, default=0.25)
    p.add_argument("--iou", type=float, default=0.9)
    p.add_argument("--thresholds", default="3,5,10,15,20", help="Pixel distance thresholds for matched tip accuracy")
    p.add_argument("--output", default="", help="Optional JSON output path")
    return p.parse_args()


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def resolve_model_path(value: str) -> Path:
    raw = Path(value).expanduser()
    if raw.exists():
        return raw.resolve()
    candidate = repo_root() / "models" / "tip" / value
    if candidate.exists():
        return candidate.resolve()
    raise FileNotFoundError(f"Model not found: {value}")


def collect_images(dataset: Path, split: str, limit: int) -> list[Path]:
    image_dir = dataset / split / "images"
    if not image_dir.exists():
        raise FileNotFoundError(f"Images directory not found: {image_dir}")
    images = [p for p in sorted(image_dir.iterdir(), key=lambda item: item.name.lower()) if p.suffix.lower() in IMAGE_EXTS]
    return images[: max(1, int(limit))]


def parse_label_points(label_path: Path, width: int, height: int) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    if not label_path.exists():
        return points
    for raw in label_path.read_text(encoding="utf-8").splitlines():
        parts = raw.strip().split()
        if len(parts) >= 7:
            kx = float(parts[5]) * width
            ky = float(parts[6]) * height
        elif len(parts) >= 5:
            kx = float(parts[1]) * width
            ky = float(parts[2]) * height
        else:
            continue
        points.append((kx, ky))
    return points


def greedy_match_distances(
    gt_points: list[tuple[float, float]],
    pred_points: list[tuple[float, float]],
) -> tuple[list[float], int]:
    pairs: list[tuple[float, int, int]] = []
    for gi, gt in enumerate(gt_points):
        for pi, pred in enumerate(pred_points):
            pairs.append((math.dist(gt, pred), gi, pi))
    pairs.sort(key=lambda row: row[0])

    used_gt: set[int] = set()
    used_pred: set[int] = set()
    distances: list[float] = []
    for distance, gi, pi in pairs:
        if gi in used_gt or pi in used_pred:
            continue
        used_gt.add(gi)
        used_pred.add(pi)
        distances.append(distance)
        if len(used_gt) == len(gt_points) or len(used_pred) == len(pred_points):
            break
    return distances, len(pred_points) - len(used_pred)


def run_model(
    model_path: Path,
    images: list[Path],
    split: str,
    thresholds: list[float],
    device: str,
    performance_hint: str,
    conf: float,
    iou: float,
) -> dict[str, Any]:
    detector = OpenVinoTipDetector(
        model_path,
        conf_threshold=conf,
        iou_threshold=iou,
        device=device,
        performance_hint=performance_hint,
    )
    started = time.perf_counter()
    totals = {
        "images": 0,
        "gt_points": 0,
        "pred_points": 0,
        "false_positives": 0,
        "missed_at_20px": 0,
        "distance_sum": 0.0,
        "matched_points": 0,
    }
    hits = {str(int(t) if float(t).is_integer() else t): 0 for t in thresholds}
    timing = {"preprocess_ms": 0.0, "inference_ms": 0.0, "decode_ms": 0.0}
    per_image: list[dict[str, Any]] = []

    batch_size = max(1, int(getattr(detector, "_batch_size", 1) or 1))
    label_root = images[0].parents[1] / "labels" if images else Path()

    for offset in range(0, len(images), batch_size):
        batch_paths = images[offset : offset + batch_size]
        frames = [cv2.imread(str(path), cv2.IMREAD_COLOR) for path in batch_paths]
        batch_results, batch_timing = detector.detect_tip_candidates_batch_timed(frames, max_candidates=12)
        for key in timing:
            timing[key] += float(batch_timing.get(key, 0.0))

        for image_path, frame, candidates in zip(batch_paths, frames, batch_results):
            if frame is None:
                continue
            height, width = frame.shape[:2]
            label_path = label_root / f"{image_path.stem}.txt"
            gt_points = parse_label_points(label_path, width, height)
            pred_points = [(float(c["x"]), float(c["y"])) for c in candidates]
            distances, false_positives = greedy_match_distances(gt_points, pred_points)
            totals["images"] += 1
            totals["gt_points"] += len(gt_points)
            totals["pred_points"] += len(pred_points)
            totals["false_positives"] += false_positives
            totals["matched_points"] += len(distances)
            totals["distance_sum"] += sum(distances)

            for threshold in thresholds:
                key = str(int(threshold) if float(threshold).is_integer() else threshold)
                hits[key] += sum(1 for distance in distances if distance <= threshold)

            max_threshold = max(thresholds)
            totals["missed_at_20px"] += len(gt_points) - sum(1 for distance in distances if distance <= max_threshold)
            per_image.append(
                {
                    "image": str(image_path),
                    "gt_points": len(gt_points),
                    "pred_points": len(pred_points),
                    "matched_distances_px": [round(d, 3) for d in distances],
                }
            )

    elapsed_ms = (time.perf_counter() - started) * 1000.0
    gt_total = max(1, int(totals["gt_points"]))
    pred_total = max(1, int(totals["pred_points"]))
    result: dict[str, Any] = {
        "model": model_path.name,
        "model_path": str(model_path),
        "split": split,
        "device": device,
        "runtime": detector.runtime_info(),
        "conf": conf,
        "iou": iou,
        "images": totals["images"],
        "gt_points": totals["gt_points"],
        "pred_points": totals["pred_points"],
        "matched_points": totals["matched_points"],
        "false_positives": totals["false_positives"],
        "mean_matched_error_px": (totals["distance_sum"] / totals["matched_points"]) if totals["matched_points"] else None,
        "accuracy_by_threshold_px": {k: hits[k] / gt_total for k in hits},
        "precision_by_threshold_px": {k: hits[k] / pred_total for k in hits},
        "avg_timing_ms_per_image": {
            "preprocess": timing["preprocess_ms"] / max(1, totals["images"]),
            "inference": timing["inference_ms"] / max(1, totals["images"]),
            "decode": timing["decode_ms"] / max(1, totals["images"]),
            "total_wall": elapsed_ms / max(1, totals["images"]),
        },
        "per_image": per_image,
    }
    return result


def main() -> None:
    args = parse_args()
    dataset = Path(args.dataset).expanduser().resolve()
    thresholds = [float(item.strip()) for item in args.thresholds.split(",") if item.strip()]
    images = collect_images(dataset, args.split, args.limit)
    models = [resolve_model_path(value) for value in args.models]

    output: dict[str, Any] = {
        "dataset": str(dataset),
        "split": args.split,
        "limit": args.limit,
        "image_count": len(images),
        "first_image": str(images[0]) if images else None,
        "last_image": str(images[-1]) if images else None,
        "thresholds_px": thresholds,
        "runs": [],
    }
    for model_path in models:
        print(f"Benchmarking {model_path.name} on {args.device} ({len(images)} images)")
        row = run_model(
            model_path,
            images,
            args.split,
            thresholds,
            args.device,
            args.performance_hint,
            args.conf,
            args.iou,
        )
        output["runs"].append(row)
        acc10 = row["accuracy_by_threshold_px"].get("10")
        acc20 = row["accuracy_by_threshold_px"].get("20")
        err = row["mean_matched_error_px"]
        print(f"  acc@10px={acc10:.4f} acc@20px={acc20:.4f} mean_error={err:.2f}px")

    out_path = Path(args.output).expanduser().resolve() if args.output else dataset / f"tip_pose_benchmark_{int(time.time())}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(output, indent=2), encoding="utf-8")
    print(f"Results written: {out_path}")


if __name__ == "__main__":
    main()
