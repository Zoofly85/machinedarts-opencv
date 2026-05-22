#!/usr/bin/env python3
from __future__ import annotations

import argparse
import random
from pathlib import Path
from typing import Iterable

import cv2
import numpy as np
import nncf
import openvino as ov
import yaml


IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Quantize an OpenVINO FP32 model to INT8 with fixed rectangular input (e.g. 736x1280)."
    )
    p.add_argument("--model-xml", required=True, help="Path to FP32 OpenVINO .xml model")
    p.add_argument("--data-yaml", required=True, help="Dataset yaml path (Ultralytics/Roboflow style)")
    p.add_argument("--output-dir", required=True, help="Output directory for INT8 model")
    p.add_argument("--img-h", type=int, default=736, help="Model input height")
    p.add_argument("--img-w", type=int, default=1280, help="Model input width")
    p.add_argument("--subset-size", type=int, default=300, help="Calibration subset size")
    p.add_argument("--split", choices=["train", "val"], default="val", help="Dataset split used for calibration")
    p.add_argument("--seed", type=int, default=42, help="Shuffle seed")
    return p.parse_args()


def _resolve_split_dir(yaml_path: Path, split_key: str) -> Path:
    payload = yaml.safe_load(yaml_path.read_text(encoding="utf-8")) or {}
    split_raw = str(payload.get(split_key, "")).strip()
    if not split_raw:
        raise ValueError(f"'{split_key}' not found in {yaml_path}")

    split_path = Path(split_raw)
    if split_path.is_absolute():
        return split_path

    base = yaml_path.parent
    # Roboflow often sets `path: ...` and relative train/val entries.
    root = payload.get("path")
    if root:
        root_path = Path(str(root))
        if not root_path.is_absolute():
            root_path = (base / root_path).resolve()
        resolved = (root_path / split_path).resolve()
    else:
        resolved = (base / split_path).resolve()

    if resolved.exists():
        return resolved

    # Roboflow zips sometimes contain `train/valid/test` next to data.yaml,
    # while yaml entries still use `../train/images`. Fall back to local sibling path.
    split_str = split_raw.replace("\\", "/")
    while split_str.startswith("../"):
        split_str = split_str[3:]
    sibling = (base / split_str).resolve()
    return sibling


def _list_images(folder: Path) -> list[Path]:
    if not folder.exists():
        raise FileNotFoundError(f"Calibration split directory not found: {folder}")
    files: list[Path] = []
    for p in folder.rglob("*"):
        if p.is_file() and p.suffix.lower() in IMAGE_EXTS:
            files.append(p)
    if not files:
        raise RuntimeError(f"No calibration images found under: {folder}")
    return files


def _letterbox_bgr(img: np.ndarray, out_h: int, out_w: int) -> np.ndarray:
    src_h, src_w = img.shape[:2]
    scale = min(out_w / float(src_w), out_h / float(src_h))
    new_w = max(1, int(round(src_w * scale)))
    new_h = max(1, int(round(src_h * scale)))
    resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
    canvas = np.full((out_h, out_w, 3), 114, dtype=np.uint8)
    pad_x = (out_w - new_w) // 2
    pad_y = (out_h - new_h) // 2
    canvas[pad_y : pad_y + new_h, pad_x : pad_x + new_w] = resized
    return canvas


def _preprocess_image(path: Path, img_h: int, img_w: int) -> np.ndarray:
    img = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError(f"Failed reading image: {path}")
    canvas = _letterbox_bgr(img, img_h, img_w)
    rgb = canvas[:, :, ::-1].astype(np.float32) / 255.0
    chw = np.transpose(rgb, (2, 0, 1))
    # NNCF/OpenVINO expect NCHW with explicit batch.
    return np.expand_dims(chw, axis=0)


def _build_dataset(paths: Iterable[Path], img_h: int, img_w: int) -> nncf.Dataset:
    return nncf.Dataset(list(paths), transform_func=lambda p: _preprocess_image(Path(p), img_h, img_w))


def _write_metadata(source_model_dir: Path, output_dir: Path, img_h: int, img_w: int, subset_size: int) -> None:
    src_meta = source_model_dir / "metadata.yaml"
    if not src_meta.exists():
        return
    payload = yaml.safe_load(src_meta.read_text(encoding="utf-8")) or {}
    args = payload.get("args", {}) if isinstance(payload.get("args"), dict) else {}
    args["int8"] = True
    args["half"] = False
    payload["args"] = args
    payload["imgsz"] = [int(img_h), int(img_w)]
    payload["quantization"] = {
        "backend": "nncf_openvino",
        "subset_size": int(subset_size),
    }
    (output_dir / "metadata.yaml").write_text(yaml.safe_dump(payload, sort_keys=False), encoding="utf-8")


def main() -> None:
    args = parse_args()

    model_xml = Path(args.model_xml).resolve()
    if not model_xml.exists():
        raise FileNotFoundError(f"Model XML not found: {model_xml}")
    data_yaml = Path(args.data_yaml).resolve()
    if not data_yaml.exists():
        raise FileNotFoundError(f"data.yaml not found: {data_yaml}")

    split_dir = _resolve_split_dir(data_yaml, args.split)
    image_paths = _list_images(split_dir)
    random.Random(args.seed).shuffle(image_paths)
    subset = image_paths[: max(1, min(args.subset_size, len(image_paths)))]

    print(f"[quant] model: {model_xml}")
    print(f"[quant] split: {split_dir} ({len(image_paths)} images, subset={len(subset)})")
    print(f"[quant] input shape: [1, 3, {args.img_h}, {args.img_w}]")

    core = ov.Core()
    model = core.read_model(str(model_xml))
    # Force static rectangular shape to match calibration preprocessing.
    model.reshape({model.input(0).get_any_name(): [1, 3, int(args.img_h), int(args.img_w)]})

    dataset = _build_dataset(subset, args.img_h, args.img_w)
    quantized_model = nncf.quantize(model, dataset, subset_size=len(subset))

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    out_xml = output_dir / model_xml.name
    ov.save_model(quantized_model, str(out_xml), compress_to_fp16=False)
    _write_metadata(model_xml.parent, output_dir, args.img_h, args.img_w, len(subset))

    print(f"[quant] INT8 model saved: {out_xml}")


if __name__ == "__main__":
    main()
