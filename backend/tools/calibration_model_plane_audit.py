from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.calibration.calibration import DartboardCalibrator, SEGMENT_ANGLE_OFFSET
from backend.core.opencv_dart_detection.scoring import canonical_model_point, model_score_rotation_offset


COLORS = {
    0: (255, 80, 80),
    1: (80, 220, 80),
    2: (80, 140, 255),
    3: (220, 220, 80),
}


def _angle_deg(center: tuple[float, float], point: tuple[float, float]) -> float:
    return float((math.degrees(math.atan2(point[1] - center[1], point[0] - center[0])) + 360.0) % 360.0)


def _angle_diff(a: float, b: float) -> float:
    d = abs(float(a) - float(b)) % 360.0
    return float(min(d, 360.0 - d))


def _canonical_boundary_angles() -> list[float]:
    return [float((math.degrees(SEGMENT_ANGLE_OFFSET + i * 2.0 * math.pi / 20.0) + 360.0) % 360.0) for i in range(20)]


def _nearest_angle_error(angle: float, expected: list[float]) -> tuple[int, float, float]:
    pairs = [(i, _angle_diff(angle, exp), exp) for i, exp in enumerate(expected)]
    i, err, exp = min(pairs, key=lambda item: item[1])
    return int(i), float(err), float(exp)


def _draw_model_spider(cal: DartboardCalibrator) -> np.ndarray:
    img = np.zeros((cal.image_height, cal.image_width, 3), dtype=np.uint8)
    cx, cy = cal.model_center
    for r, color, thickness in [
        (cal.bull_radius_px, (0, 80, 180), 1),
        (cal.outer_bull_radius_px, (0, 80, 180), 1),
        (cal.triple_inner_radius_px, (0, 180, 0), 1),
        (cal.triple_outer_radius_px, (0, 220, 0), 1),
        (cal.double_inner_radius_px, (0, 0, 220), 1),
        (cal.double_outer_radius_px, (0, 0, 255), 1),
    ]:
        cv2.circle(img, (int(cx), int(cy)), int(r), color, thickness)
    for ang in _canonical_boundary_angles():
        rad = math.radians(ang)
        inner = (int(cx + math.cos(rad) * cal.outer_bull_radius_px), int(cy + math.sin(rad) * cal.outer_bull_radius_px))
        outer = (int(cx + math.cos(rad) * cal.double_outer_radius_px), int(cy + math.sin(rad) * cal.double_outer_radius_px))
        cv2.line(img, inner, outer, (70, 70, 70), 1)
    cv2.putText(img, "canonical model plane", (20, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (230, 230, 230), 2)
    return img


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    calibration_root = ROOT / "backend" / "data" / "calibration"
    out_dir = ROOT / "backend" / "data" / "calibration_audit"
    out_dir.mkdir(parents=True, exist_ok=True)

    reference = DartboardCalibrator(str(calibration_root / "camera_0"))
    overlay = _draw_model_spider(reference)
    expected_angles = _canonical_boundary_angles()
    expected_radii = {
        "inner_triple": float(reference.triple_inner_radius_px),
        "outer_triple": float(reference.triple_outer_radius_px),
        "inner_double": float(reference.double_inner_radius_px),
        "outer_double": float(reference.double_outer_radius_px),
    }

    report: dict = {
        "calibration_root": str(calibration_root),
        "output_dir": str(out_dir),
        "expected_boundary_angles_deg": expected_angles,
        "expected_radii_px": expected_radii,
        "cameras": [],
    }

    for cam_dir in sorted(calibration_root.glob("camera_*")):
        json_path = cam_dir / "dartboard_calibration.json"
        npz_path = cam_dir / "dartboard_calibration.npz"
        if not json_path.exists() or not npz_path.exists():
            continue
        cam_index = int(cam_dir.name.split("_")[-1])
        cal = DartboardCalibrator(str(cam_dir))
        data = _load_json(json_path)
        ellipse = data.get("ellipse") or {}
        boundary_groups = ellipse.get("boundary_points") or []
        color = COLORS.get(cam_index, (200, 200, 200))

        angle_errors = []
        radius_errors_by_ring: dict[str, list[float]] = {k: [] for k in expected_radii}
        projected_points = []
        center = tuple(map(float, cal.model_center))

        for group_i, group in enumerate(boundary_groups):
            transformed_group = []
            for point_i, point in enumerate(group or []):
                x = float(point.get("x"))
                y = float(point.get("y"))
                raw_model = cal.transform_point_to_model((x, y))
                model = canonical_model_point(raw_model, cal)
                mx, my = float(model[0]), float(model[1])
                transformed_group.append((mx, my))
                projected_points.append((mx, my))

                r = math.hypot(mx - center[0], my - center[1])
                ring_name, ring_radius = min(
                    expected_radii.items(),
                    key=lambda item: abs(float(r) - float(item[1])),
                )
                radius_errors_by_ring[ring_name].append(float(r - ring_radius))

            if transformed_group:
                mean_x = float(np.mean([p[0] for p in transformed_group]))
                mean_y = float(np.mean([p[1] for p in transformed_group]))
                ang = _angle_deg(center, (mean_x, mean_y))
                nearest_i, err, expected = _nearest_angle_error(ang, expected_angles)
                angle_errors.append(
                    {
                        "group_index": int(group_i),
                        "nearest_boundary_index": int(nearest_i),
                        "angle_deg": float(ang),
                        "expected_deg": float(expected),
                        "error_deg": float(err),
                    }
                )

        for mx, my in projected_points:
            cv2.circle(overlay, (int(round(mx)), int(round(my))), 3, color, -1)

        q = data.get("quality_details") or {}
        cam_report = {
            "camera": cam_index,
            "rotation_angle": data.get("rotation_angle"),
            "model_score_rotation_offset": model_score_rotation_offset(cal),
            "calibration_quality": data.get("calibration_quality"),
            "calibration_error_px": data.get("calibration_error_px"),
            "quality_metric": data.get("calibration_quality_metric"),
            "ring_error_px": q.get("ring_error_px"),
            "radial_error_px": q.get("radial_error_px"),
            "homography_quality": data.get("homography_quality"),
            "homography_error_px": data.get("homography_error_px"),
            "boundary_angle_error_deg": {
                "mean": float(np.mean([e["error_deg"] for e in angle_errors])) if angle_errors else None,
                "max": float(np.max([e["error_deg"] for e in angle_errors])) if angle_errors else None,
                "top_20_1_5": [
                    e for e in angle_errors if e["nearest_boundary_index"] in {0, 1, 18, 19}
                ],
            },
            "radius_error_px": {
                ring: {
                    "mean_signed": float(np.mean(vals)) if vals else None,
                    "mean_abs": float(np.mean(np.abs(vals))) if vals else None,
                    "max_abs": float(np.max(np.abs(vals))) if vals else None,
                }
                for ring, vals in radius_errors_by_ring.items()
            },
        }
        report["cameras"].append(cam_report)

    legend_y = 58
    for cam in report["cameras"]:
        cam_i = int(cam["camera"])
        color = COLORS.get(cam_i, (200, 200, 200))
        cv2.circle(overlay, (25, legend_y), 5, color, -1)
        cv2.putText(overlay, f"camera_{cam_i}", (40, legend_y + 5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (220, 220, 220), 1)
        legend_y += 22

    overlay_path = out_dir / "model_plane_calibration_points.png"
    report_path = out_dir / "calibration_audit_report.json"
    markdown_path = out_dir / "calibration_audit_summary.md"
    cv2.imwrite(str(overlay_path), overlay)
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    lines = ["# Calibration Model-Plane Audit", ""]
    lines.append(f"Overlay: `{overlay_path}`")
    lines.append(f"JSON report: `{report_path}`")
    lines.append("")
    lines.append("| Camera | Quality | Fit err px | Ring err px | Radial err px | Boundary mean/max deg | Top boundary max deg |")
    lines.append("|---:|---:|---:|---:|---:|---:|---:|")
    for cam in report["cameras"]:
        top = cam["boundary_angle_error_deg"]["top_20_1_5"] or []
        top_max = max([float(e["error_deg"]) for e in top], default=0.0)
        lines.append(
            f"| {cam['camera']} | {float(cam['calibration_quality'] or 0):.6f} | "
            f"{float(cam['calibration_error_px'] or 0):.3f} | {float(cam['ring_error_px'] or 0):.3f} | "
            f"{float(cam['radial_error_px'] or 0):.3f} | "
            f"{float(cam['boundary_angle_error_deg']['mean'] or 0):.3f}/{float(cam['boundary_angle_error_deg']['max'] or 0):.3f} | "
            f"{top_max:.3f} |"
        )
    lines.append("")
    lines.append("Notes:")
    lines.append("- Boundary points are transformed from camera space into the canonical model plane used by line scoring.")
    lines.append("- Tiny errors here are expected because points come from the saved ellipse/radial fit.")
    lines.append("- Homography quality is lower than ellipse/radial quality; current scoring relies on the canonical model-plane rotation plus homography for line intersections.")
    markdown_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"Wrote {overlay_path}")
    print(f"Wrote {report_path}")
    print(f"Wrote {markdown_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
