#!/usr/bin/env python3
"""Compare line-fit strategies on saved correction packs."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import cv2

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.calibration.calibration import DartboardCalibrator
from backend.core.opencv_dart_detection import DartScoringConfig, detect_and_score_from_masks
from backend.core.opencv_dart_detection.dart_tip_detection import bridge_mask_gaps
from backend.core.opencv_dart_detection.scoring import final_score_key, format_score
from backend.core.opencv_dart_scoring import OpenCvDartScoringService


IGNORE_BY_DEFAULT = {
    "dart_3_1779417338399",
}

STRATEGIES = [
    "tip_refit",
    "tip_refit_balanced",
    "tip_refit_strict",
    "full_centerline",
    "no_tip_refit",
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
    calibrators = {}
    for i in range(3):
        calibrators[i] = DartboardCalibrator(calibration_dir=str(pack / "calibration" / f"camera_{i}"))
    return calibrators


def _load_masks(pack: Path) -> dict[int, Any]:
    masks = {}
    for i in range(3):
        path = pack / "masks" / f"cam{i + 1}_new_mask.png"
        mask = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
        if mask is not None and int(cv2.countNonZero(mask)) > 0:
            masks[i] = mask
    return masks


def _score_pack(pack: Path, strategy: str) -> dict[str, Any]:
    calibrators = _load_calibrators(pack)
    masks = _load_masks(pack)
    config = DartScoringConfig(camera_calibration_map={i: i for i in calibrators})
    raw = detect_and_score_from_masks(
        masks,
        calibrators,
        config=config,
        line_strategy=strategy,
    )
    raw.setdefault("scoring", {})["mask_mode"] = "raw"
    bridged = detect_and_score_from_masks(
        {i: bridge_mask_gaps(mask) for i, mask in masks.items()},
        calibrators,
        config=config,
        line_strategy=strategy,
    )
    bridged.setdefault("scoring", {})["mask_mode"] = "bridged"
    selected = OpenCvDartScoringService._select_mask_mode_result(raw, bridged)
    scoring = selected.get("scoring", {}) if isinstance(selected.get("scoring"), dict) else {}
    final = scoring.get("final") if isinstance(scoring.get("final"), dict) else {}
    score = final.get("score") if isinstance(final.get("score"), dict) else None
    return {
        "label": format_score(score),
        "key": _norm_key(score),
        "source": scoring.get("source"),
        "intersection": scoring.get("intersection_consensus"),
        "ellipse": scoring.get("ellipse_radial_intersection_consensus"),
        "mask_mode": scoring.get("mask_mode"),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--packs", default=str(ROOT / "backend" / "data" / "correction_debug"))
    parser.add_argument("--pack", action="append", default=[], help="Specific pack directory name to test. Can be repeated.")
    parser.add_argument("--include-known-bad-labels", action="store_true")
    parser.add_argument("--output", default=str(ROOT / "backend" / "data" / "calibration_audit" / "line_fit_dataset_test.json"))
    args = parser.parse_args()

    pack_root = Path(args.packs)
    rows = []
    totals = {strategy: 0 for strategy in STRATEGIES}
    evaluated = 0
    selected_packs = set(args.pack or [])
    candidate_packs = sorted(p for p in pack_root.iterdir() if p.is_dir() and (p / "metadata.json").exists())
    if selected_packs:
        candidate_packs = [p for p in candidate_packs if p.name in selected_packs]
    for pack in candidate_packs:
        if not args.include_known_bad_labels and pack.name in IGNORE_BY_DEFAULT:
            continue
        meta = json.loads((pack / "metadata.json").read_text(encoding="utf-8"))
        corrected = meta.get("corrected_score") if isinstance(meta.get("corrected_score"), dict) else None
        if corrected is None and bool(meta.get("assumed_correct")):
            corrected = meta.get("original_score") if isinstance(meta.get("original_score"), dict) else None
        corrected_key = _norm_key(corrected)
        if corrected_key is None:
            continue
        evaluated += 1
        strategy_results = {}
        for strategy in STRATEGIES:
            result = _score_pack(pack, strategy)
            result["matches"] = result["key"] == corrected_key
            if result["matches"]:
                totals[strategy] += 1
            strategy_results[strategy] = result
        rows.append(
            {
                "pack": pack.name,
                "corrected": format_score(corrected),
                "strategies": strategy_results,
            }
        )

    summary = {
        "packs_evaluated": evaluated,
        "totals": totals,
        "rows": rows,
    }
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print(f"packs evaluated: {evaluated}")
    for strategy in STRATEGIES:
        print(f"{strategy}: {totals[strategy]}/{evaluated}")
    print()
    for row in rows:
        bits = []
        for strategy in STRATEGIES:
            result = row["strategies"][strategy]
            mark = "OK" if result["matches"] else "NO"
            bits.append(f"{strategy}={mark}:{result['label']}")
        print(f"{row['pack']} corrected={row['corrected']} | " + " | ".join(bits))
    print(f"\nreport: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
