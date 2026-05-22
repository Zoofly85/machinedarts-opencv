export const ALLOWED_TIP_MODELS = new Set([
  "y11-p-n-1280-rect-10-2-2026_openvino_model",
  "y11-p-n-1280-rect-10-2-2026_int8_736x1280_openvino_model",
  "y11-p-n-1280-rect-10-2-2026_int8_1280_openvino_model",
]);

export const TIP_MODEL_ORDER = [
  "y11-p-n-1280-rect-10-2-2026_openvino_model",
  "y11-p-n-1280-rect-10-2-2026_int8_736x1280_openvino_model",
  "y11-p-n-1280-rect-10-2-2026_int8_1280_openvino_model",
];

export const TIP_MODEL_LABELS: Record<string, string> = {
  "y11-p-n-1280-rect-10-2-2026_openvino_model": "YOLO11 FP16 (Default)",
  "y11-p-n-1280-rect-10-2-2026_int8_736x1280_openvino_model": "YOLO11 INT8 (736x1280)",
  "y11-p-n-1280-rect-10-2-2026_int8_1280_openvino_model": "YOLO11 INT8 (1280)",
};

export const TIP_MODEL_DETAILS: Record<string, string> = {
  "y11-p-n-1280-rect-10-2-2026_openvino_model": "YOLO11n Pose 736x1280 FP16",
  "y11-p-n-1280-rect-10-2-2026_int8_736x1280_openvino_model": "YOLO11n Pose 736x1280 INT8",
  "y11-p-n-1280-rect-10-2-2026_int8_1280_openvino_model": "YOLO11n Pose 1280x1280 INT8",
};
