export const ALLOWED_TIP_MODELS = new Set([
  "1280-11n-p-13052026_encrypted",
  "1280-11n-p-30042026_openvino_model",
  "y11-p-n-1280-rect-10-2-2026_openvino_model",
  "y11-p-1280-720-26032026_openvino_model",
]);

export const TIP_MODEL_ORDER = [
  "1280-11n-p-13052026_encrypted",
  "1280-11n-p-30042026_openvino_model",
  "y11-p-n-1280-rect-10-2-2026_openvino_model",
  "y11-p-1280-720-26032026_openvino_model",
];

export const TIP_MODEL_LABELS: Record<string, string> = {
  "1280-11n-p-13052026_encrypted": "YOLO11n FP16 (13 May 2026)",
  "1280-11n-p-30042026_openvino_model": "YOLO11n FP16 (30 Apr 2026)",
  "y11-p-n-1280-rect-10-2-2026_openvino_model": "YOLO11 FP16 (Default)",
  "y11-p-1280-720-26032026_openvino_model": "YOLO11 FP16 (Test)",
};

export const TIP_MODEL_DETAILS: Record<string, string> = {
  "1280-11n-p-13052026_encrypted": "YOLO11n Pose 736x1280 FP16",
  "1280-11n-p-30042026_openvino_model": "YOLO11n Pose 736x1280 FP16",
  "y11-p-n-1280-rect-10-2-2026_openvino_model": "YOLO11n Pose 736x1280 FP16",
  "y11-p-1280-720-26032026_openvino_model": "YOLO11 Pose 736x1280 FP16",
};
