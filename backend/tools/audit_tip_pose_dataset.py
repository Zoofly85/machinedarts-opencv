#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
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
    p = argparse.ArgumentParser(
        description="Audit a YOLO tip-pose dataset and save the worst images with filename details for Roboflow cleanup."
    )
    p.add_argument("--dataset", required=True, help="YOLO dataset root containing split/images and split/labels")
    p.add_argument("--split", default="valid", help="Dataset split to audit: train, valid, test, or all")
    p.add_argument("--model", required=True, help="OpenVINO model directory or model id under models/tip")
    p.add_argument("--device", default="GPU", help="OpenVINO device, e.g. CPU, GPU, GPU.0, AUTO")
    p.add_argument("--performance-hint", default="LATENCY", choices=["LATENCY", "THROUGHPUT"])
    p.add_argument("--conf", type=float, default=0.25)
    p.add_argument("--iou", type=float, default=0.9)
    p.add_argument("--threshold", type=float, default=20.0, help="Matched tip distance threshold in pixels")
    p.add_argument("--limit", type=int, default=0, help="Optional max images per split; 0 means all")
    p.add_argument("--worst", type=int, default=200, help="Number of worst overlays to save")
    p.add_argument("--output-dir", default="", help="Optional output directory")
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
    if limit > 0:
        return images[:limit]
    return images


def roboflow_search_name(image_path: Path) -> str:
    # Roboflow exported names usually look like original_name_jpg.rf.hash.jpg.
    name = image_path.name
    marker = ".rf."
    if marker in name:
        base = name.split(marker, 1)[0]
        suffix = image_path.suffix.lower().lstrip(".")
        for encoded_suffix in ("_jpg", "_jpeg", "_png", "_webp", "_bmp"):
            if base.lower().endswith(encoded_suffix):
                base = base[: -len(encoded_suffix)]
                suffix = encoded_suffix.lstrip("_")
                break
        return f"{base}.{suffix}"
    return name


def parse_label_points(label_path: Path, width: int, height: int) -> tuple[list[dict[str, float]], list[str]]:
    points: list[dict[str, float]] = []
    issues: list[str] = []
    if not label_path.exists():
        return points, ["missing_label_file"]
    for line_no, raw in enumerate(label_path.read_text(encoding="utf-8").splitlines(), start=1):
        parts = raw.strip().split()
        if not parts:
            continue
        try:
            values = [float(part) for part in parts]
        except ValueError:
            issues.append(f"line_{line_no}_non_numeric")
            continue
        if len(values) >= 8:
            cx, cy, bw, bh = values[1], values[2], values[3], values[4]
            kx, ky, vis = values[5], values[6], values[7]
        elif len(values) >= 5:
            cx, cy, bw, bh = values[1], values[2], values[3], values[4]
            kx, ky, vis = cx, cy, 2.0
            issues.append(f"line_{line_no}_box_only_label")
        else:
            issues.append(f"line_{line_no}_too_few_values")
            continue
        for field_name, value in (("cx", cx), ("cy", cy), ("bw", bw), ("bh", bh), ("kx", kx), ("ky", ky)):
            if value < 0.0 or value > 1.0:
                issues.append(f"line_{line_no}_{field_name}_out_of_bounds")
        if bw <= 0.0 or bh <= 0.0:
            issues.append(f"line_{line_no}_invalid_box_size")
        points.append(
            {
                "x": float(kx * width),
                "y": float(ky * height),
                "cx": float(cx * width),
                "cy": float(cy * height),
                "w": float(bw * width),
                "h": float(bh * height),
                "visibility": float(vis),
            }
        )
    if not points:
        issues.append("empty_label_file")
    return points, sorted(set(issues))


def greedy_match(
    gt_points: list[dict[str, float]],
    pred_points: list[dict[str, float]],
) -> tuple[list[dict[str, Any]], list[int], list[int]]:
    pairs: list[tuple[float, int, int]] = []
    for gi, gt in enumerate(gt_points):
        for pi, pred in enumerate(pred_points):
            pairs.append((math.dist((gt["x"], gt["y"]), (pred["x"], pred["y"])), gi, pi))
    pairs.sort(key=lambda row: row[0])

    used_gt: set[int] = set()
    used_pred: set[int] = set()
    matches: list[dict[str, Any]] = []
    for distance, gi, pi in pairs:
        if gi in used_gt or pi in used_pred:
            continue
        used_gt.add(gi)
        used_pred.add(pi)
        matches.append({"gt_index": gi, "pred_index": pi, "distance_px": float(distance)})
        if len(used_gt) == len(gt_points) or len(used_pred) == len(pred_points):
            break
    missed = [idx for idx in range(len(gt_points)) if idx not in used_gt]
    false_positives = [idx for idx in range(len(pred_points)) if idx not in used_pred]
    return matches, missed, false_positives


def draw_overlay(
    frame: Any,
    gt_points: list[dict[str, float]],
    pred_points: list[dict[str, float]],
    matches: list[dict[str, Any]],
    title: str,
) -> Any:
    overlay = frame.copy()
    for gt in gt_points:
        x, y = int(round(gt["x"])), int(round(gt["y"]))
        cv2.drawMarker(overlay, (x, y), (0, 255, 255), cv2.MARKER_CROSS, 18, 2)
    for pred in pred_points:
        x, y = int(round(pred["x"])), int(round(pred["y"]))
        cv2.circle(overlay, (x, y), 7, (0, 0, 255), 2)
        cv2.putText(overlay, f'{pred.get("score_confidence", 0.0):.2f}', (x + 8, y - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 255), 1)
    for match in matches:
        gt = gt_points[int(match["gt_index"])]
        pred = pred_points[int(match["pred_index"])]
        cv2.line(
            overlay,
            (int(round(gt["x"])), int(round(gt["y"]))),
            (int(round(pred["x"])), int(round(pred["y"]))),
            (255, 180, 0),
            1,
        )
    cv2.rectangle(overlay, (0, 0), (overlay.shape[1], 34), (0, 0, 0), -1)
    cv2.putText(overlay, title[:150], (10, 23), cv2.FONT_HERSHEY_SIMPLEX, 0.58, (255, 255, 255), 1)
    return overlay


def score_row(row: dict[str, Any], threshold: float) -> float:
    miss = int(row["missed_gt_at_threshold"])
    fp = int(row["false_positives"])
    label_issue = 1 if row["label_issues"] else 0
    max_error = float(row["max_error_px"] or 0.0)
    low_conf = max(0.0, 0.5 - float(row["best_confidence"] or 0.0)) * 100.0 if int(row["pred_points"]) else 50.0
    over_threshold = max(0.0, max_error - threshold)
    return label_issue * 5000.0 + miss * 1000.0 + fp * 250.0 + over_threshold * 5.0 + low_conf


def audit_split(
    detector: OpenVinoTipDetector,
    dataset: Path,
    split: str,
    limit: int,
    threshold: float,
) -> list[dict[str, Any]]:
    images = collect_images(dataset, split, limit)
    label_root = dataset / split / "labels"
    rows: list[dict[str, Any]] = []
    batch_size = max(1, int(getattr(detector, "_batch_size", 1) or 1))

    for offset in range(0, len(images), batch_size):
        batch_paths = images[offset : offset + batch_size]
        frames = [cv2.imread(str(path), cv2.IMREAD_COLOR) for path in batch_paths]
        batch_results, _timing = detector.detect_tip_candidates_batch_timed(frames, max_candidates=12)
        for image_path, frame, candidates in zip(batch_paths, frames, batch_results):
            if frame is None:
                rows.append(
                    {
                        "split": split,
                        "image": image_path.name,
                        "roboflow_search_name": roboflow_search_name(image_path),
                        "image_path": str(image_path),
                        "label_path": str(label_root / f"{image_path.stem}.txt"),
                        "issue_score": 999999.0,
                        "label_issues": "unreadable_image",
                    }
                )
                continue
            height, width = frame.shape[:2]
            label_path = label_root / f"{image_path.stem}.txt"
            gt_points, label_issues = parse_label_points(label_path, width, height)
            pred_points = [
                {
                    "x": float(c["x"]),
                    "y": float(c["y"]),
                    "confidence": float(c.get("confidence", 0.0)),
                    "score_confidence": float(c.get("score_confidence", c.get("confidence", 0.0))),
                }
                for c in candidates
            ]
            matches, missed, false_positives = greedy_match(gt_points, pred_points)
            distances = [float(match["distance_px"]) for match in matches]
            missed_at_threshold = len(gt_points) - sum(1 for d in distances if d <= threshold)
            row: dict[str, Any] = {
                "split": split,
                "image": image_path.name,
                "roboflow_search_name": roboflow_search_name(image_path),
                "image_path": str(image_path),
                "label_path": str(label_path),
                "width": width,
                "height": height,
                "gt_points": len(gt_points),
                "pred_points": len(pred_points),
                "matched_points": len(matches),
                "missed_gt": len(missed),
                "missed_gt_at_threshold": missed_at_threshold,
                "false_positives": len(false_positives),
                "mean_error_px": round(sum(distances) / len(distances), 3) if distances else "",
                "max_error_px": round(max(distances), 3) if distances else "",
                "best_confidence": round(max((p["score_confidence"] for p in pred_points), default=0.0), 4),
                "label_issues": ";".join(label_issues),
                "_gt_points": gt_points,
                "_pred_points": pred_points,
                "_matches": matches,
            }
            row["issue_score"] = round(score_row(row, threshold), 3)
            rows.append(row)
    return rows


def main() -> None:
    args = parse_args()
    dataset = Path(args.dataset).expanduser().resolve()
    model_path = resolve_model_path(args.model)
    out_dir = (
        Path(args.output_dir).expanduser().resolve()
        if args.output_dir
        else dataset / f"tip_dataset_audit_{int(time.time())}"
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    overlay_dir = out_dir / "worst_overlays"
    overlay_dir.mkdir(parents=True, exist_ok=True)

    splits = ["train", "valid", "test"] if args.split.lower() == "all" else [args.split]
    detector = OpenVinoTipDetector(
        model_path,
        conf_threshold=args.conf,
        iou_threshold=args.iou,
        device=args.device,
        performance_hint=args.performance_hint,
    )

    rows: list[dict[str, Any]] = []
    for split in splits:
        print(f"Auditing {split} with {model_path.name} on {args.device}")
        rows.extend(audit_split(detector, dataset, split, args.limit, args.threshold))

    rows.sort(key=lambda row: float(row.get("issue_score", 0.0)), reverse=True)
    csv_fields = [
        "issue_score",
        "split",
        "image",
        "roboflow_search_name",
        "image_path",
        "label_path",
        "width",
        "height",
        "gt_points",
        "pred_points",
        "matched_points",
        "missed_gt",
        "missed_gt_at_threshold",
        "false_positives",
        "mean_error_px",
        "max_error_px",
        "best_confidence",
        "label_issues",
    ]
    csv_path = out_dir / "report.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=csv_fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in csv_fields})

    summary = {
        "dataset": str(dataset),
        "model": str(model_path),
        "device": args.device,
        "threshold_px": args.threshold,
        "rows": len(rows),
        "flagged_with_label_issues": sum(1 for row in rows if row.get("label_issues")),
        "flagged_with_missed_gt_at_threshold": sum(1 for row in rows if int(row.get("missed_gt_at_threshold", 0) or 0) > 0),
        "flagged_with_false_positives": sum(1 for row in rows if int(row.get("false_positives", 0) or 0) > 0),
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    for rank, row in enumerate(rows[: max(0, int(args.worst))], start=1):
        frame = cv2.imread(str(row["image_path"]), cv2.IMREAD_COLOR)
        if frame is None:
            continue
        title = (
            f'{rank:03d} score={row["issue_score"]} miss@{args.threshold:g}px={row["missed_gt_at_threshold"]} '
            f'fp={row["false_positives"]} err={row["max_error_px"]} {row["image"]}'
        )
        overlay = draw_overlay(frame, row["_gt_points"], row["_pred_points"], row["_matches"], title)
        safe_name = f'{rank:03d}_{row["split"]}_{row["image"]}'
        cv2.imwrite(str(overlay_dir / safe_name), overlay)

    print(f"Rows audited: {len(rows)}")
    print(f"Report: {csv_path}")
    print(f"Worst overlays: {overlay_dir}")
    print(f"Summary: {out_dir / 'summary.json'}")


if __name__ == "__main__":
    main()
