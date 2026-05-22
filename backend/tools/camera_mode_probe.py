from __future__ import annotations

import argparse
import time
from dataclasses import dataclass

import cv2


@dataclass(frozen=True)
class Mode:
    width: int
    height: int
    fps: int


COMMON_MODES: list[Mode] = [
    # 4:3
    Mode(640, 480, 30),
    Mode(800, 600, 30),
    Mode(1024, 768, 30),
    Mode(1280, 960, 30),
    Mode(1600, 1200, 30),
    # 16:9
    Mode(854, 480, 30),
    Mode(1280, 720, 30),
    Mode(1600, 900, 30),
    Mode(1920, 1080, 30),
]


def _parse_cams(raw: str) -> list[int]:
    out: list[int] = []
    for token in raw.split(","):
        token = token.strip()
        if not token:
            continue
        out.append(int(token))
    return out or [0]


def _parse_modes(raw: str | None) -> list[Mode]:
    if not raw:
        return COMMON_MODES
    out: list[Mode] = []
    for token in raw.split(","):
        token = token.strip().lower()
        if not token:
            continue
        # format: WIDTHxHEIGHT@FPS, e.g. 1280x720@30
        wh, fps = token.split("@", 1)
        w, h = wh.split("x", 1)
        out.append(Mode(int(w), int(h), int(fps)))
    return out


def _backend_flag(name: str) -> int:
    key = name.strip().lower()
    if key == "dshow":
        return cv2.CAP_DSHOW
    if key == "msmf":
        return cv2.CAP_MSMF
    return cv2.CAP_ANY


def _fourcc_int_to_str(value: int) -> str:
    try:
        return "".join(chr((value >> (8 * i)) & 0xFF) for i in range(4))
    except Exception:
        return "????"


def _probe_one_mode(cap: cv2.VideoCapture, mode: Mode) -> tuple[int, int, float, str, bool]:
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, float(mode.width))
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, float(mode.height))
    cap.set(cv2.CAP_PROP_FPS, float(mode.fps))
    # let driver settle a bit
    time.sleep(0.06)
    ok, _ = cap.read()
    got_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    got_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    got_fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    got_fourcc = _fourcc_int_to_str(int(cap.get(cv2.CAP_PROP_FOURCC) or 0))
    return got_w, got_h, got_fps, got_fourcc, bool(ok)


def main() -> None:
    parser = argparse.ArgumentParser(description="Probe camera-supported modes (requested vs actual).")
    parser.add_argument("--cams", default="0,1,2", help="Comma-separated camera indices. Example: 0,1,2")
    parser.add_argument("--backend", default="dshow", choices=["dshow", "msmf", "auto"], help="OpenCV backend")
    parser.add_argument(
        "--codecs",
        default="MJPG,YUY2",
        help="Comma-separated FOURCC list to try per camera. Example: MJPG,YUY2 (use AUTO to skip setting)",
    )
    parser.add_argument(
        "--modes",
        default="",
        help="Optional custom mode list: WIDTHxHEIGHT@FPS,WIDTHxHEIGHT@FPS",
    )
    args = parser.parse_args()

    cams = _parse_cams(args.cams)
    modes = _parse_modes(args.modes or None)
    codecs = [c.strip().upper() for c in args.codecs.split(",") if c.strip()]
    backend = _backend_flag(args.backend)

    print(f"Camera Mode Probe | cams={cams} backend={args.backend} codecs={codecs}")
    print("-" * 90)
    for cam in cams:
        print(f"\n=== Camera {cam} ===")
        cap = cv2.VideoCapture(cam, backend)
        if not cap.isOpened():
            print("  FAILED: cannot open camera")
            continue
        try:
            for codec in codecs:
                if codec != "AUTO" and len(codec) == 4:
                    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*codec))
                    time.sleep(0.03)
                active_codec = _fourcc_int_to_str(int(cap.get(cv2.CAP_PROP_FOURCC) or 0))
                print(f"\n  Codec request={codec} active={active_codec}")
                print("  req_mode           -> got_mode           got_fps  got_fourcc  frame_ok")
                for m in modes:
                    got_w, got_h, got_fps, got_fourcc, ok = _probe_one_mode(cap, m)
                    print(
                        f"  {m.width:4d}x{m.height:<4d}@{m.fps:<2d} -> "
                        f"{got_w:4d}x{got_h:<4d}          "
                        f"{got_fps:6.1f}   {got_fourcc:<8} {str(ok)}"
                    )
        finally:
            cap.release()


if __name__ == "__main__":
    main()
