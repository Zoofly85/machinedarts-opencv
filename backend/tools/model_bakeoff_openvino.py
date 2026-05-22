#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from ultralytics import YOLO


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Convert PT -> OpenVINO (FP32/FP16/INT8) and benchmark accuracy+speed.")
    p.add_argument("--pt", required=True, help="Path to .pt model")
    p.add_argument("--data-yaml", required=True, help="Path to dataset data.yaml")
    p.add_argument("--img-h", type=int, default=720)
    p.add_argument("--img-w", type=int, default=1280)
    p.add_argument("--split", default="val", choices=["train", "val", "test"])
    p.add_argument("--subset-size", type=int, default=300, help="INT8 calibration subset size")
    p.add_argument("--tag", default="bakeoff", help="Suffix for output model directories")
    p.add_argument("--output-json", default="", help="Optional output JSON path")
    p.add_argument("--skip-convert", action="store_true", help="Use existing converted model dirs")
    return p.parse_args()


def ensure_path(path: str, label: str) -> Path:
    p = Path(path).expanduser().resolve()
    if not p.exists():
        raise FileNotFoundError(f"{label} not found: {p}")
    return p


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def copy_export_dir(src_dir: Path, dst_dir: Path) -> None:
    if dst_dir.exists():
        shutil.rmtree(dst_dir)
    shutil.copytree(src_dir, dst_dir)


def run_quantize(fp32_xml: Path, data_yaml: Path, out_dir: Path, img_h: int, img_w: int, split: str, subset_size: int) -> None:
    if out_dir.exists():
        shutil.rmtree(out_dir)
    cmd = [
        sys.executable,
        str(repo_root() / "backend" / "tools" / "quantize_openvino_rect_int8.py"),
        "--model-xml",
        str(fp32_xml),
        "--data-yaml",
        str(data_yaml),
        "--output-dir",
        str(out_dir),
        "--img-h",
        str(img_h),
        "--img-w",
        str(img_w),
        "--subset-size",
        str(subset_size),
        "--split",
        str(split),
    ]
    subprocess.run(cmd, check=True)


def export_openvino(pt_model: Path, img_h: int, img_w: int, *, half: bool) -> Path:
    model = YOLO(str(pt_model))
    # Ultralytics creates <stem>_openvino_model next to source model.
    export_dir = pt_model.with_name(f"{pt_model.stem}_openvino_model")
    if export_dir.exists():
        shutil.rmtree(export_dir)
    model.export(format="openvino", imgsz=(img_h, img_w), half=half, int8=False)
    if not export_dir.exists():
        raise RuntimeError(f"Expected export dir not found: {export_dir}")
    return export_dir


def candidate_igpu_devices() -> list[str]:
    # Different Ultralytics/OpenVINO stacks accept different strings.
    return ["intel:gpu", "gpu", "GPU", "openvino:GPU"]


def safe_float(value: Any) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except Exception:
        return None


def run_val(model_path: Path, data_yaml: Path, split: str, img_h: int, img_w: int, device: str) -> dict[str, Any]:
    m = YOLO(str(model_path), task="pose")
    started = time.time()
    res = m.val(
        task="pose",
        data=str(data_yaml),
        split=split,
        imgsz=(img_h, img_w),
        device=device,
        verbose=False,
    )
    elapsed_s = time.time() - started
    box = getattr(res, "box", None)
    pose = getattr(res, "pose", None)
    speed = getattr(res, "speed", {}) or {}
    map50 = safe_float(getattr(pose, "map50", None))
    map50_95 = safe_float(getattr(pose, "map", None))
    precision = safe_float(getattr(pose, "mp", None))
    recall = safe_float(getattr(pose, "mr", None))
    if map50 is None and box is not None:
        map50 = safe_float(getattr(box, "map50", None))
    if map50_95 is None and box is not None:
        map50_95 = safe_float(getattr(box, "map", None))
    if precision is None and box is not None:
        precision = safe_float(getattr(box, "mp", None))
    if recall is None and box is not None:
        recall = safe_float(getattr(box, "mr", None))
    return {
        "device": device,
        "elapsed_s": round(elapsed_s, 3),
        "map50": map50,
        "map50_95": map50_95,
        "precision": precision,
        "recall": recall,
        "speed_ms": {
            "preprocess": safe_float(speed.get("preprocess")),
            "inference": safe_float(speed.get("inference")),
            "postprocess": safe_float(speed.get("postprocess")),
        },
    }


def run_val_igpu(model_path: Path, data_yaml: Path, split: str, img_h: int, img_w: int) -> dict[str, Any]:
    last_err: str | None = None
    for dev in candidate_igpu_devices():
        try:
            return run_val(model_path, data_yaml, split, img_h, img_w, dev)
        except Exception as exc:
            last_err = f"{dev}: {exc}"
    raise RuntimeError(f"iGPU validation failed for all device strings. Last error: {last_err}")


def first_xml_in_dir(model_dir: Path) -> Path:
    xmls = sorted(model_dir.glob("*.xml"))
    if not xmls:
        raise FileNotFoundError(f"No .xml found in {model_dir}")
    return xmls[0]


def main() -> None:
    args = parse_args()
    pt_model = ensure_path(args.pt, "PT model")
    data_yaml = ensure_path(args.data_yaml, "data.yaml")

    models_tip = repo_root() / "models" / "tip"
    models_tip.mkdir(parents=True, exist_ok=True)
    stem = pt_model.stem

    fp32_dir = models_tip / f"{stem}_{args.tag}_fp32_openvino_model"
    fp16_dir = models_tip / f"{stem}_{args.tag}_fp16_openvino_model"
    int8_dir = models_tip / f"{stem}_{args.tag}_int8_openvino_model"

    if not args.skip_convert:
        raw_fp32 = export_openvino(pt_model, args.img_h, args.img_w, half=False)
        copy_export_dir(raw_fp32, fp32_dir)
        shutil.rmtree(raw_fp32, ignore_errors=True)

        raw_fp16 = export_openvino(pt_model, args.img_h, args.img_w, half=True)
        copy_export_dir(raw_fp16, fp16_dir)
        shutil.rmtree(raw_fp16, ignore_errors=True)

        run_quantize(
            first_xml_in_dir(fp32_dir),
            data_yaml,
            int8_dir,
            args.img_h,
            args.img_w,
            args.split,
            args.subset_size,
        )

    for required in (fp32_dir, fp16_dir, int8_dir):
        if not required.exists():
            raise FileNotFoundError(f"Expected model dir not found: {required}")

    scenarios = [
        ("fp32", fp32_dir),
        ("fp16", fp16_dir),
        ("int8", int8_dir),
    ]
    results: dict[str, Any] = {
        "pt_model": str(pt_model),
        "data_yaml": str(data_yaml),
        "imgsz": [args.img_h, args.img_w],
        "split": args.split,
        "models": {name: str(path) for name, path in scenarios},
        "runs": [],
    }

    print("=== Bake-off start ===")
    for name, model_dir in scenarios:
        print(f"\nModel: {name} ({model_dir})")
        cpu = run_val(model_dir, data_yaml, args.split, args.img_h, args.img_w, "cpu")
        print(
            f"  CPU  | pose-mAP50={cpu['map50']} pose-mAP50-95={cpu['map50_95']} "
            f"infer_ms={cpu['speed_ms']['inference']}"
        )
        row = {"model": name, "cpu": cpu}
        try:
            igpu = run_val_igpu(model_dir, data_yaml, args.split, args.img_h, args.img_w)
            print(
                f"  iGPU | pose-mAP50={igpu['map50']} pose-mAP50-95={igpu['map50_95']} "
                f"infer_ms={igpu['speed_ms']['inference']} (device={igpu['device']})"
            )
            row["igpu"] = igpu
        except Exception as exc:
            print(f"  iGPU | failed: {exc}")
            row["igpu_error"] = str(exc)
        results["runs"].append(row)

    out = Path(args.output_json).resolve() if args.output_json else repo_root() / "backend" / "data" / "benchmark_capture" / f"bakeoff_{int(time.time())}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"\nResults written: {out}")


if __name__ == "__main__":
    main()
