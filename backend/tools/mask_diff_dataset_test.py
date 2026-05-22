#!/usr/bin/env python3
"""Compare fast diff-mask builders on saved correction packs."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.calibration.calibration import DartboardCalibrator
from backend.core.opencv_dart_detection import DartScoringConfig, detect_and_score_from_masks
from backend.core.opencv_dart_detection.dart_tip_detection import bridge_mask_gaps, filter_small_components
from backend.core.opencv_dart_detection.scoring import final_score_key, format_score
from backend.core.opencv_dart_scoring import OpenCvDartScoringService


METHODS = [
    "saved",
    "gray",
    "bgr_or",
    "lab_or",
    "gray_burst_vote",
    "bgr_burst_vote",
]


def _norm_key(score: dict[str, Any] | None) -> tuple[Any, Any, Any] | None:
    if not isinstance(score, dict):
        return None
    key = list(final_score_key(score))
    for i in (0, 1):
        try:
            key[i] = int(key[i])
        except Exception:
            pass
    return tuple(key)


def _load_calibrators(pack: Path) -> dict[int, DartboardCalibrator]:
    return {
        i: DartboardCalibrator(calibration_dir=str(pack / "calibration" / f"camera_{i}"))
        for i in range(3)
    }


def _read_frame(pack: Path, cam_i: int, kind: str) -> np.ndarray | None:
    return cv2.imread(str(pack / "frames" / f"cam{cam_i + 1}_{kind}.png"), cv2.IMREAD_COLOR)


def _read_saved_mask(pack: Path, cam_i: int) -> np.ndarray | None:
    return cv2.imread(str(pack / "masks" / f"cam{cam_i + 1}_new_mask.png"), cv2.IMREAD_GRAYSCALE)


def _threshold_gray(current: np.ndarray, reference: np.ndarray, threshold: int) -> np.ndarray:
    gray_current = cv2.cvtColor(current, cv2.COLOR_BGR2GRAY)
    gray_ref = cv2.cvtColor(reference, cv2.COLOR_BGR2GRAY)
    diff = cv2.absdiff(gray_current, gray_ref)
    return (diff > threshold).astype(np.uint8) * 255


def _threshold_bgr_or(current: np.ndarray, reference: np.ndarray, gray_threshold: int, channel_threshold: int) -> np.ndarray:
    diff_bgr = cv2.absdiff(current, reference)
    diff_gray = cv2.cvtColor(diff_bgr, cv2.COLOR_BGR2GRAY)
    diff_max = np.max(diff_bgr, axis=2)
    return ((diff_gray > gray_threshold) | (diff_max > channel_threshold)).astype(np.uint8) * 255


def _threshold_lab_or(
    current: np.ndarray,
    reference: np.ndarray,
    l_threshold: int,
    ab_threshold: int,
) -> np.ndarray:
    current_lab = cv2.cvtColor(current, cv2.COLOR_BGR2LAB)
    ref_lab = cv2.cvtColor(reference, cv2.COLOR_BGR2LAB)
    diff = cv2.absdiff(current_lab, ref_lab)
    return (
        (diff[:, :, 0] > l_threshold)
        | (diff[:, :, 1] > ab_threshold)
        | (diff[:, :, 2] > ab_threshold)
    ).astype(np.uint8) * 255


def _clean_candidate(mask: np.ndarray, min_pixels: int) -> np.ndarray:
    return filter_small_components(mask, min_pixels=min_pixels)


def _load_burst_frames(pack: Path, cam_i: int) -> list[np.ndarray]:
    burst_dir = pack / "burst_frames"
    frames = []
    for path in sorted(burst_dir.glob(f"burst_*_cam{cam_i + 1}.png")):
        frame = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if frame is not None:
            frames.append(frame)
    return frames


def _burst_vote(masks: list[np.ndarray], min_hits: int) -> np.ndarray | None:
    if not masks:
        return None
    hits = np.zeros(masks[0].shape[:2], dtype=np.uint8)
    for mask in masks:
        hits += (mask > 0).astype(np.uint8)
    return (hits >= min_hits).astype(np.uint8) * 255


def _build_masks_for_method(
    pack: Path,
    method: str,
    *,
    gray_threshold: int,
    channel_threshold: int,
    lab_l_threshold: int,
    lab_ab_threshold: int,
    min_pixels: int,
    burst_min_hits: int,
) -> dict[int, np.ndarray]:
    masks: dict[int, np.ndarray] = {}
    for cam_i in range(3):
        if method == "saved":
            mask = _read_saved_mask(pack, cam_i)
        else:
            reference = _read_frame(pack, cam_i, "background")
            current = _read_frame(pack, cam_i, "detected")
            if reference is None or current is None:
                continue
            if method == "gray":
                mask = _threshold_gray(current, reference, gray_threshold)
            elif method == "bgr_or":
                mask = _threshold_bgr_or(current, reference, gray_threshold, channel_threshold)
            elif method == "lab_or":
                mask = _threshold_lab_or(current, reference, lab_l_threshold, lab_ab_threshold)
            elif method in {"gray_burst_vote", "bgr_burst_vote"}:
                frame_masks = []
                for burst in _load_burst_frames(pack, cam_i):
                    if method == "gray_burst_vote":
                        frame_masks.append(_threshold_gray(burst, reference, gray_threshold))
                    else:
                        frame_masks.append(_threshold_bgr_or(burst, reference, gray_threshold, channel_threshold))
                mask = _burst_vote(frame_masks, burst_min_hits)
            else:
                raise ValueError(f"Unknown method: {method}")
        if mask is not None:
            cleaned = _clean_candidate(mask, min_pixels=min_pixels)
            if int(cv2.countNonZero(cleaned)) > 0:
                masks[cam_i] = cleaned
    return masks


def _score_masks(masks: dict[int, np.ndarray], calibrators: dict[int, DartboardCalibrator], line_strategy: str) -> dict[str, Any]:
    config = DartScoringConfig(camera_calibration_map={i: i for i in calibrators})
    raw = detect_and_score_from_masks(masks, calibrators, config=config, line_strategy=line_strategy)
    raw.setdefault("scoring", {})["mask_mode"] = "raw"
    bridged = detect_and_score_from_masks(
        {i: bridge_mask_gaps(mask) for i, mask in masks.items()},
        calibrators,
        config=config,
        line_strategy=line_strategy,
    )
    bridged.setdefault("scoring", {})["mask_mode"] = "bridged"
    selected = OpenCvDartScoringService._select_mask_mode_result(raw, bridged)
    scoring = selected.get("scoring", {}) if isinstance(selected.get("scoring"), dict) else {}
    final = scoring.get("final") if isinstance(scoring.get("final"), dict) else {}
    score = final.get("score") if isinstance(final.get("score"), dict) else None
    camera_pixels = {
        str(i): int(cv2.countNonZero(mask))
        for i, mask in masks.items()
    }
    return {
        "label": format_score(score),
        "key": _norm_key(score),
        "source": scoring.get("source"),
        "mask_mode": scoring.get("mask_mode"),
        "spread": scoring.get("intersection_spread_px"),
        "camera_pixels": camera_pixels,
        "camera_count": len(masks),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--packs", default=str(ROOT / "backend" / "data" / "correction_debug"))
    parser.add_argument("--output", default=str(ROOT / "backend" / "data" / "calibration_audit" / "mask_diff_dataset_test.json"))
    parser.add_argument("--pack", action="append", default=[], help="Specific pack directory name to test. Can be repeated.")
    parser.add_argument("--line-strategy", default="tip_refit")
    parser.add_argument("--gray-threshold", type=int, default=24)
    parser.add_argument("--channel-threshold", type=int, default=28)
    parser.add_argument("--lab-l-threshold", type=int, default=22)
    parser.add_argument("--lab-ab-threshold", type=int, default=10)
    parser.add_argument("--min-pixels", type=int, default=12)
    parser.add_argument("--burst-min-hits", type=int, default=2)
    args = parser.parse_args()

    pack_root = Path(args.packs)
    rows = []
    totals = {method: 0 for method in METHODS}
    evaluated = 0
    selected_packs = set(args.pack or [])
    candidate_packs = sorted(p for p in pack_root.iterdir() if p.is_dir() and (p / "metadata.json").exists())
    if selected_packs:
        candidate_packs = [p for p in candidate_packs if p.name in selected_packs]
    for pack in candidate_packs:
        meta = json.loads((pack / "metadata.json").read_text(encoding="utf-8"))
        corrected = meta.get("corrected_score") if isinstance(meta.get("corrected_score"), dict) else None
        if corrected is None and bool(meta.get("assumed_correct")):
            corrected = meta.get("original_score") if isinstance(meta.get("original_score"), dict) else None
        corrected_key = _norm_key(corrected)
        if corrected_key is None:
            continue
        calibrators = _load_calibrators(pack)
        method_results = {}
        for method in METHODS:
            masks = _build_masks_for_method(
                pack,
                method,
                gray_threshold=args.gray_threshold,
                channel_threshold=args.channel_threshold,
                lab_l_threshold=args.lab_l_threshold,
                lab_ab_threshold=args.lab_ab_threshold,
                min_pixels=args.min_pixels,
                burst_min_hits=args.burst_min_hits,
            )
            result = _score_masks(masks, calibrators, args.line_strategy) if masks else {
                "label": "NO_MASK",
                "key": None,
                "source": None,
                "mask_mode": None,
                "spread": None,
                "camera_pixels": {},
                "camera_count": 0,
            }
            result["matches"] = result["key"] == corrected_key
            if result["matches"]:
                totals[method] += 1
            method_results[method] = result
        evaluated += 1
        rows.append(
            {
                "pack": pack.name,
                "corrected": format_score(corrected),
                "methods": method_results,
            }
        )

    summary = {
        "packs_evaluated": evaluated,
        "line_strategy": args.line_strategy,
        "thresholds": {
            "gray": args.gray_threshold,
            "channel": args.channel_threshold,
            "lab_l": args.lab_l_threshold,
            "lab_ab": args.lab_ab_threshold,
            "burst_min_hits": args.burst_min_hits,
            "min_pixels": args.min_pixels,
        },
        "totals": totals,
        "rows": rows,
    }
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print(f"packs evaluated: {evaluated}")
    for method in METHODS:
        print(f"{method}: {totals[method]}/{evaluated}")
    print()
    for row in rows:
        bits = []
        for method in METHODS:
            result = row["methods"][method]
            mark = "OK" if result["matches"] else "NO"
            bits.append(f"{method}={mark}:{result['label']}")
        print(f"{row['pack']} corrected={row['corrected']} | " + " | ".join(bits))
    print(f"\nreport: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
