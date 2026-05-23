#!/usr/bin/env python3
"""Audit mask construction stages for correction/debug packs."""

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
from backend.core.opencv_dart_detection import DartScoringConfig, bridge_mask_gaps, detect_and_score_from_masks
from backend.core.opencv_dart_detection.dart_tip_detection import filter_small_components
from backend.core.opencv_dart_detection.scoring import final_score_key, format_score
from backend.core.opencv_dart_scoring import OpenCvDartScoringService

LAB_L_THRESHOLD = 22
LAB_AB_THRESHOLD = 10
GRAY_THRESHOLD = 24
CODE_NEW = 76
CODE_OLD = 152


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


def _read_mask_codes(pack: Path, cam_i: int) -> np.ndarray | None:
    return cv2.imread(str(pack / "masks" / f"cam{cam_i + 1}_mask_codes.png"), cv2.IMREAD_GRAYSCALE)


def _read_new_mask(pack: Path, cam_i: int) -> np.ndarray | None:
    return cv2.imread(str(pack / "masks" / f"cam{cam_i + 1}_new_mask.png"), cv2.IMREAD_GRAYSCALE)


def _lab_mask(current: np.ndarray, reference: np.ndarray) -> np.ndarray:
    cur = cv2.cvtColor(current, cv2.COLOR_BGR2LAB)
    ref = cv2.cvtColor(reference, cv2.COLOR_BGR2LAB)
    diff = cv2.absdiff(cur, ref)
    return (
        (diff[:, :, 0] > LAB_L_THRESHOLD)
        | (diff[:, :, 1] > LAB_AB_THRESHOLD)
        | (diff[:, :, 2] > LAB_AB_THRESHOLD)
    ).astype(np.uint8) * 255


def _gray_mask(current: np.ndarray, reference: np.ndarray) -> np.ndarray:
    cur = cv2.cvtColor(current, cv2.COLOR_BGR2GRAY)
    ref = cv2.cvtColor(reference, cv2.COLOR_BGR2GRAY)
    return (cv2.absdiff(cur, ref) > GRAY_THRESHOLD).astype(np.uint8) * 255


def _burst_lab_mask(pack: Path, cam_i: int, reference: np.ndarray, min_hits: int = 2) -> np.ndarray | None:
    hits = None
    count = 0
    for path in sorted((pack / "burst_frames").glob(f"burst_*_cam{cam_i + 1}.png")):
        frame = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if frame is None:
            continue
        mask = _lab_mask(frame, reference) > 0
        if hits is None:
            hits = np.zeros(mask.shape, dtype=np.uint8)
        hits += mask.astype(np.uint8)
        count += 1
    if hits is None:
        return None
    return (hits >= min(min_hits, max(1, count))).astype(np.uint8) * 255


def _clean(mask: np.ndarray | None) -> np.ndarray | None:
    if mask is None:
        return None
    return filter_small_components(mask, min_pixels=12)


def _bbox(mask: np.ndarray | None) -> list[int] | None:
    if mask is None:
        return None
    pts = cv2.findNonZero((mask > 0).astype(np.uint8))
    if pts is None:
        return None
    x, y, w, h = cv2.boundingRect(pts)
    return [int(x), int(y), int(w), int(h)]


def _score(masks: dict[int, np.ndarray], calibrators: dict[int, DartboardCalibrator], line_strategy: str) -> dict[str, Any]:
    config = DartScoringConfig(camera_calibration_map={i: i for i in calibrators})
    result = detect_and_score_from_masks(masks, calibrators, config=config, line_strategy=line_strategy)
    scoring = result.get("scoring", {}) if isinstance(result.get("scoring"), dict) else {}
    final = scoring.get("final") if isinstance(scoring.get("final"), dict) else {}
    score = final.get("score") if isinstance(final.get("score"), dict) else None
    return {
        "label": format_score(score),
        "key": _norm_key(score),
        "source": scoring.get("source"),
        "spread": scoring.get("intersection_spread_px"),
        "camera_votes": [
            {
                "camera_index": int(v.get("camera_index", -1)),
                "label": v.get("label"),
                "confidence": float(v.get("confidence") or 0.0),
                "bbox": v.get("bbox"),
            }
            for v in scoring.get("camera_votes", [])
            if isinstance(v, dict)
        ],
    }


def _score_stage(
    stage_name: str,
    masks: dict[int, np.ndarray],
    calibrators: dict[int, DartboardCalibrator],
    corrected_key: tuple[Any, Any, Any] | None,
    line_strategy: str,
) -> dict[str, Any]:
    cleaned = {i: m for i, m in masks.items() if m is not None and int(cv2.countNonZero(m)) > 0}
    if not cleaned:
        return {"stage": stage_name, "label": "NO_MASK", "matches": False, "camera_stats": {}}
    score = _score(cleaned, calibrators, line_strategy)
    return {
        "stage": stage_name,
        "label": score["label"],
        "matches": score["key"] == corrected_key,
        "source": score.get("source"),
        "spread": score.get("spread"),
        "camera_votes": score.get("camera_votes"),
        "camera_stats": {
            str(i): {
                "pixels": int(cv2.countNonZero(mask)),
                "bbox": _bbox(mask),
            }
            for i, mask in cleaned.items()
        },
    }


def _build_stage_masks(pack: Path) -> dict[str, dict[int, np.ndarray]]:
    stages: dict[str, dict[int, np.ndarray]] = {
        "saved_new": {},
        "saved_codes_new": {},
        "rebuilt_gray": {},
        "rebuilt_lab": {},
        "lab_minus_saved_old": {},
        "lab_or_burst_lab": {},
        "saved_bridged": {},
        "lab_bridged": {},
    }
    for cam_i in range(3):
        detected = _read_frame(pack, cam_i, "detected")
        background = _read_frame(pack, cam_i, "background")
        saved_new = _clean(_read_new_mask(pack, cam_i))
        codes = _read_mask_codes(pack, cam_i)
        saved_codes_new = _clean(((codes == CODE_NEW).astype(np.uint8) * 255) if codes is not None else None)
        saved_old = ((codes == CODE_OLD).astype(np.uint8) * 255) if codes is not None else None
        lab = None
        if detected is not None and background is not None:
            lab = _clean(_lab_mask(detected, background))
            gray = _clean(_gray_mask(detected, background))
            burst_lab = _clean(_burst_lab_mask(pack, cam_i, background))
            if gray is not None:
                stages["rebuilt_gray"][cam_i] = gray
            if lab is not None:
                stages["rebuilt_lab"][cam_i] = lab
                if saved_old is not None:
                    stages["lab_minus_saved_old"][cam_i] = _clean((lab > 0) & ~(saved_old > 0))
                if burst_lab is not None:
                    stages["lab_or_burst_lab"][cam_i] = _clean(((lab > 0) | (burst_lab > 0)).astype(np.uint8) * 255)
                stages["lab_bridged"][cam_i] = bridge_mask_gaps(lab)
        if saved_new is not None:
            stages["saved_new"][cam_i] = saved_new
            stages["saved_bridged"][cam_i] = bridge_mask_gaps(saved_new)
        if saved_codes_new is not None:
            stages["saved_codes_new"][cam_i] = saved_codes_new
    return stages


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--packs", default=str(ROOT / "backend" / "data" / "correction_debug"))
    parser.add_argument("--pack", action="append", default=[], help="Specific pack directory name. Can be repeated.")
    parser.add_argument("--line-strategy", default="tip_refit")
    parser.add_argument("--output", default=str(ROOT / "backend" / "data" / "calibration_audit" / "mask_stage_audit.json"))
    args = parser.parse_args()

    pack_root = Path(args.packs)
    selected = set(args.pack or [])
    packs = sorted(p for p in pack_root.iterdir() if p.is_dir() and (p / "metadata.json").exists())
    if selected:
        packs = [p for p in packs if p.name in selected]

    rows = []
    totals: dict[str, dict[str, Any]] = {}
    for pack in packs:
        meta = json.loads((pack / "metadata.json").read_text(encoding="utf-8"))
        corrected = meta.get("corrected_score") if isinstance(meta.get("corrected_score"), dict) else None
        if corrected is None and bool(meta.get("assumed_correct")):
            corrected = meta.get("original_score") if isinstance(meta.get("original_score"), dict) else None
        corrected_key = _norm_key(corrected)
        if corrected_key is None:
            continue
        calibrators = _load_calibrators(pack)
        stages = _build_stage_masks(pack)
        stage_results = [
            _score_stage(stage_name, masks, calibrators, corrected_key, args.line_strategy)
            for stage_name, masks in stages.items()
        ]
        for stage in stage_results:
            name = str(stage.get("stage") or "")
            bucket = totals.setdefault(
                name,
                {
                    "matches": 0,
                    "evaluated": 0,
                    "no_mask": 0,
                    "source_counts": {},
                    "label_counts": {},
                },
            )
            bucket["evaluated"] += 1
            if stage.get("label") == "NO_MASK":
                bucket["no_mask"] += 1
            if bool(stage.get("matches")):
                bucket["matches"] += 1
            source = str(stage.get("source") or "unknown")
            label = str(stage.get("label") or "unknown")
            bucket["source_counts"][source] = int(bucket["source_counts"].get(source, 0)) + 1
            bucket["label_counts"][label] = int(bucket["label_counts"].get(label, 0)) + 1
        rows.append(
            {
                "pack": pack.name,
                "corrected": format_score(corrected),
                "line_strategy": args.line_strategy,
                "stages": stage_results,
            }
        )

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"summary": totals, "rows": rows}, indent=2), encoding="utf-8")

    print(f"packs evaluated: {len(rows)}")
    for name, bucket in sorted(totals.items()):
        evaluated = int(bucket.get("evaluated") or 0)
        matches = int(bucket.get("matches") or 0)
        pct = (matches / evaluated * 100.0) if evaluated else 0.0
        print(f"{name:<22} {matches:>4}/{evaluated:<4} {pct:>6.2f}% no_mask={bucket.get('no_mask', 0)}")

    for row in rows:
        print(f"\n{row['pack']} corrected={row['corrected']} strategy={row['line_strategy']}")
        for stage in row["stages"]:
            mark = "OK" if stage["matches"] else "NO"
            stats = " ".join(
                f"cam{k}:px={v['pixels']} bbox={v['bbox']}"
                for k, v in sorted(stage.get("camera_stats", {}).items())
            )
            print(f"  {stage['stage']:<22} {mark:<2} {stage['label']:<10} {stats}")
    print(f"\nreport: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
