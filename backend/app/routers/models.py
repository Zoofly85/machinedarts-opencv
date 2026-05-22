from __future__ import annotations

from fastapi import APIRouter, HTTPException

router = APIRouter(tags=["model-settings"])


def _opencv_model_settings() -> dict:
    return {
        "enabled": True,
        "mode": "opencv-line-fit-only",
        "active_model_id": "opencv-line-fit",
        "selected_model_id": "opencv-line-fit",
        "selected_device": "CPU",
        "available_models": [
            {
                "id": "opencv-line-fit",
                "label": "OpenCV line-fit scorer",
                "runtime": "opencv",
                "encrypted": False,
            }
        ],
        "available_openvino_devices": [],
        "available_openvino_device_details": [],
        "openvino": {
            "device": "CPU",
            "performance_hint": "LATENCY",
        },
        "message": "AI scoring models are disabled in this build; calibration models remain available.",
    }


@router.get("/api/settings/models")
def get_models_settings() -> dict:
    return _opencv_model_settings()


@router.put("/api/settings/models")
def update_models_settings(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="settings payload must be an object")
    try:
        return _opencv_model_settings()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save model settings: {exc}") from exc


@router.get("/api/debug/models-paths")
def get_models_debug_paths() -> dict:
    return {
        "mode": "opencv-line-fit-only",
        "tip_models_root": None,
        "available_tip_models_count": 0,
        "message": "AI scoring models are disabled in this OpenCV scorer build; calibration models are still used by calibration.",
    }
