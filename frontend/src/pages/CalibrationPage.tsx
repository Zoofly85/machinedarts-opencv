import React, { useState, useEffect, useRef, useMemo } from "react";
import { motion } from "framer-motion";
import { Camera, RotateCw, RotateCcw, Save, Crosshair, CheckCircle, Focus, X, AlertCircle } from "lucide-react";
import BackendTopNav from "../components/BackendTopNav";
import { API_BASE_URL } from "../services/api";
import { buildCameraWsUrl } from "../services/ws";

interface CalibrationStatus {
  is_calibrated: boolean;
  calibration_quality: number;
  current_segment: number;
  camera_index: number;
}

type CalibrationQualitySummary = {
  label: "Bad" | "Good" | "Excellent";
  textClassName: string;
  barClassName: string;
};

const getCalibrationQualitySummary = (quality: number): CalibrationQualitySummary => {
  if (quality >= 0.99) {
    return {
      label: "Excellent",
      textClassName: "text-emerald-400",
      barClassName: "bg-emerald-500",
    };
  }

  if (quality >= 0.97) {
    return {
      label: "Good",
      textClassName: "text-yellow-400",
      barClassName: "bg-yellow-500",
    };
  }

  return {
    label: "Bad",
    textClassName: "text-red-400",
    barClassName: "bg-red-500",
  };
};

interface CameraInfo {
  index: number; // logical slot index
  name: string;
  device_index?: number;
  label?: string;
  role?: "scoring" | "player";
  calibratable?: boolean;
}

interface CameraDevice {
  index: number;
  available: boolean;
  status: string;
  width?: number;
  height?: number;
  fps?: number;
  backend?: string;
  label?: string;
  device_id?: string | null;
}

interface FocusMetrics {
  camera_index: number;
  focus_score: number;
  quality: string;
  laplacian_var?: number;
  tenengrad?: number;
  brenner?: number;
  siemens_radius?: number;
}

export default function CalibrationPage({ embedded = false }: { embedded?: boolean } = {}) {
  // State
  const [cameras, setCameras] = useState<CameraInfo[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<number>(0);
  const [calibrationStatus, setCalibrationStatus] = useState<CalibrationStatus | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [detectionResult, setDetectionResult] = useState<any>(null);
  const [includeInnerPoints, setIncludeInnerPoints] = useState<boolean>(true);
  const [clickToScoreEnabled, setClickToScoreEnabled] = useState<boolean>(true);
  const [lastClick, setLastClick] = useState<{ x: number; y: number } | null>(null);
  const [lastClickScore, setLastClickScore] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFocusMetrics, setShowFocusMetrics] = useState<boolean>(false);
  const [focusMetrics, setFocusMetrics] = useState<FocusMetrics[]>([]);
  const [focusMode, setFocusMode] = useState<boolean>(false);
  const [starCenter, setStarCenter] = useState<{x: number, y: number} | null>(null);
  const [liveFocusScore, setLiveFocusScore] = useState<{contrast: number, sharpness: number} | null>(null);
  const [cameraDevices, setCameraDevices] = useState<CameraDevice[]>([]);
  const [cameraSelection, setCameraSelection] = useState<(number | null)[]>([]);
  const [isSavingSelection, setIsSavingSelection] = useState<boolean>(false);
  const [selectionMessage, setSelectionMessage] = useState<{type: "success" | "error"; text: string} | null>(null);
  const [cameraFlip, setCameraFlip] = useState<Record<number, boolean>>({});
  const [playerCamRotation, setPlayerCamRotation] = useState<number>(0);
  const [playerCamPortraitCrop, setPlayerCamPortraitCrop] = useState<boolean>(false);
  const [isSavingPlayerView, setIsSavingPlayerView] = useState<boolean>(false);
  const [isAutoCalibrating, setIsAutoCalibrating] = useState<boolean>(false);
  const [recalibratingCamera, setRecalibratingCamera] = useState<number | null>(null);
  const [autoCalibrationSummary, setAutoCalibrationSummary] = useState<string | null>(null);
  const isFlipped = Boolean(cameraFlip[selectedCamera]);
  const calibrationQualitySummary = calibrationStatus
    ? getCalibrationQualitySummary(calibrationStatus.calibration_quality)
    : null;
  
  // Refs
  const videoRef = useRef<HTMLImageElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const focusIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const focusToolActiveRef = useRef<boolean>(false);

  const normalizeFlipMap = (raw: Record<string, any> | null | undefined) => {
    const next: Record<number, boolean> = {};
    if (!raw) return next;
    Object.entries(raw).forEach(([key, value]) => {
      const idx = Number(key);
      if (!Number.isNaN(idx)) {
        next[idx] = Boolean(value);
      }
    });
    return next;
  };

  const getOverlayPositionStyle = (point: { x: number; y: number } | null) => {
    if (!point || !videoRef.current || !feedRef.current) return undefined;
    const imgWidth = videoRef.current.naturalWidth || 0;
    const imgHeight = videoRef.current.naturalHeight || 0;
    if (imgWidth <= 0 || imgHeight <= 0) return undefined;

    const rect = feedRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return undefined;

    const mappedPoint = isFlipped
      ? { x: imgWidth - 1 - point.x, y: imgHeight - 1 - point.y }
      : point;

    const scale = Math.min(rect.width / imgWidth, rect.height / imgHeight);
    const displayedWidth = imgWidth * scale;
    const displayedHeight = imgHeight * scale;
    const offsetX = (rect.width - displayedWidth) / 2;
    const offsetY = (rect.height - displayedHeight) / 2;

    const leftPx = offsetX + mappedPoint.x * scale;
    const topPx = offsetY + mappedPoint.y * scale;

    return {
      left: `${(leftPx / rect.width) * 100}%`,
      top: `${(topPx / rect.height) * 100}%`,
      transform: "translate(-50%, -50%)",
    } as const;
  };

  // Fetch cameras on mount
  useEffect(() => {
    fetchCameras();
    fetchCameraDevices();
    fetchCameraFlips();
    fetchPlayerCamViewSettings();
    
    // Cleanup on unmount
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      stopLiveFocusMonitoring();
    };
  }, []);

  const slotSelections = useMemo(() => cameraSelection.slice(0, cameras.length), [cameraSelection, cameras.length]);

  const deviceMap = useMemo<Record<number, CameraDevice>>(() => {
    const map: Record<number, CameraDevice> = {};
    cameraDevices.forEach((device) => {
      map[device.index] = device;
    });
    return map;
  }, [cameraDevices]);

  const selectedCameraInfo = useMemo(
    () => cameras.find((camera) => camera.index === selectedCamera),
    [cameras, selectedCamera],
  );
  const isSelectedCameraCalibratable = selectedCameraInfo?.calibratable !== false;
  const isPlayerCamPortraitPreview = !isSelectedCameraCalibratable && (playerCamPortraitCrop || [90, 270].includes(playerCamRotation));

  const describeDevice = (deviceIndex: number | null | undefined) => {
    if (deviceIndex === null || deviceIndex === undefined) {
      return "Not assigned";
    }
    const device = deviceMap[deviceIndex];
    if (!device) {
      return `Device ${deviceIndex} - Not detected`;
    }
    const parts: string[] = [];
    if (device.label) {
      parts.push(device.label);
    }
    const shortId = shortDeviceId(device);
    if (shortId) {
      parts.push(`ID ${shortId}`);
    }
    parts.push(device.available ? "Ready" : (device.status || "Unavailable"));
    if (device.width && device.height) {
      parts.push(`${device.width}x${device.height}`);
    }
    if (device.fps) {
      parts.push(`${Math.round(device.fps)} FPS`);
    }
    if (device.backend) {
      parts.push(device.backend);
    }
    return `Device ${device.index} - ${parts.join(" | ")}`;
  };

  const shortDeviceId = (device: CameraDevice) => {
    const id = String(device.device_id || "").trim();
    if (!id) {
      return "";
    }
    const parts = id.split("\\").filter(Boolean);
    const tail = parts[parts.length - 1] || id;
    return tail.length > 12 ? tail.slice(-12) : tail;
  };

  const formatDeviceOption = (device: CameraDevice) => {
    const shortId = shortDeviceId(device);
    const label = device.label || `Device ${device.index}`;
    const status = device.available ? "" : " (not detected)";
    return `Device ${device.index} - ${label}${shortId ? ` - ID ${shortId}` : ""}${status}`;
  };

  const normalizePlayerRotation = (value: unknown) => {
    const rotation = Number(value);
    if ([0, 90, 180, 270].includes(rotation)) {
      return rotation;
    }
    return 0;
  };

  const disconnectCameraFeed = () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  };

  // Connect to WebSocket when selected camera changes
  useEffect(() => {
    fetchCalibrationStatus();
    if (document.visibilityState === "visible") {
      connectToWebSocket();
    }
    return () => {
      disconnectCameraFeed();
    };
  }, [selectedCamera]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        connectToWebSocket();
        fetchCalibrationStatus().catch(() => {
          // keep current status on visibility resume failure
        });
      } else {
        disconnectCameraFeed();
        stopLiveFocusMonitoring();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [selectedCamera]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch available cameras
  const fetchCameras = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/cameras`);
      const data = await response.json();
      setCameras(data.cameras || []);

      if (Array.isArray(data.selected) && data.selected.length) {
        setCameraSelection(data.selected);
      } else if (data.cameras?.length) {
        setCameraSelection(data.cameras.map((cam: CameraInfo) => cam.device_index || cam.index));
      }

      if (data.cameras?.length) {
        setSelectedCamera((prev) => {
          if (data.cameras.some((cam: CameraInfo) => cam.index === prev)) {
            return prev;
          }
          return data.cameras[0].index;
        });
      }
    } catch (err) {
      console.error("Error fetching cameras:", err);
      setError("Failed to fetch cameras. Make sure the API server is running.");
    }
  };

  const fetchCameraDevices = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/camera/devices?max_devices=20`);
      const data = await response.json();
      setCameraDevices(data.devices || []);
      if (Array.isArray(data.selected) && data.selected.length) {
        setCameraSelection(data.selected);
      }
    } catch (err) {
      console.error("Error fetching camera devices:", err);
    }
  };

  const fetchCameraFlips = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/camera/flip`);
      if (!response.ok) {
        throw new Error("Failed to fetch camera flip settings.");
      }
      const data = await response.json();
      setCameraFlip(normalizeFlipMap(data?.flips));
    } catch (err) {
      console.error("Error fetching camera flips:", err);
    }
  };

  const fetchPlayerCamViewSettings = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/settings/detection`);
      if (!response.ok) {
        throw new Error("Failed to fetch player cam view settings.");
      }
      const data = await response.json();
      setPlayerCamRotation(normalizePlayerRotation(data?.settings?.player_replay_rotation));
      setPlayerCamPortraitCrop(Boolean(data?.settings?.player_replay_portrait_crop));
    } catch (err) {
      console.error("Error fetching player cam view settings:", err);
    }
  };

  const savePlayerCamViewSettings = async (settings: { rotation?: number; portraitCrop?: boolean }) => {
    const nextRotation = settings.rotation === undefined ? playerCamRotation : normalizePlayerRotation(settings.rotation);
    const nextPortraitCrop = settings.portraitCrop === undefined ? playerCamPortraitCrop : Boolean(settings.portraitCrop);
    const previousRotation = playerCamRotation;
    const previousPortraitCrop = playerCamPortraitCrop;
    setPlayerCamRotation(nextRotation);
    setPlayerCamPortraitCrop(nextPortraitCrop);
    setIsSavingPlayerView(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE_URL}/api/settings/detection`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            player_replay_rotation: nextRotation,
            player_replay_portrait_crop: nextPortraitCrop,
          },
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.detail || "Failed to save player cam view settings.");
      }
      setPlayerCamRotation(normalizePlayerRotation(data?.settings?.player_replay_rotation));
      setPlayerCamPortraitCrop(Boolean(data?.settings?.player_replay_portrait_crop));
      disconnectCameraFeed();
      window.setTimeout(() => {
        if (document.visibilityState === "visible") {
          connectToWebSocket();
        }
      }, 250);
    } catch (err: any) {
      console.error("Error saving player cam view settings:", err);
      setPlayerCamRotation(previousRotation);
      setPlayerCamPortraitCrop(previousPortraitCrop);
      setError(err?.message || "Failed to save player cam view settings.");
    } finally {
      setIsSavingPlayerView(false);
    }
  };

  const saveCameraSelection = async () => {
    if (!cameras.length) {
      setSelectionMessage({ type: "error", text: "No camera slots available to update." });
      return;
    }

    const trimmedSelection = cameraSelection.slice(0, cameras.length);
    const hasEmptySelection = trimmedSelection.some((idx) => idx === undefined || idx === null);
    if (hasEmptySelection) {
      setSelectionMessage({ type: "error", text: "Please choose a device for every camera slot." });
      return;
    }

    const normalizedSelection = trimmedSelection.map((idx) => Number(idx));
    const unique = new Set(normalizedSelection);
    if (unique.size !== cameras.length) {
      setSelectionMessage({ type: "error", text: "Each slot must map to a different physical camera." });
      return;
    }

    setIsSavingSelection(true);
    setSelectionMessage(null);

    try {
      disconnectCameraFeed();
      const response = await fetch(`${API_BASE_URL}/api/camera/devices/select`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ indices: normalizedSelection }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || "Failed to update camera selection.");
      }

      setSelectionMessage({
        type: "success",
        text: "Camera selection applied. Detection was reset; recalibrate any changed slots.",
      });
      await fetchCameras();
      await fetchCameraDevices();
    } catch (err: any) {
      console.error("Error saving camera selection:", err);
      setSelectionMessage({ type: "error", text: err.message || "Failed to save camera selection." });
    } finally {
      setIsSavingSelection(false);
    }
  };

  const toggleCameraFlip = async () => {
    const previous = isFlipped;
    const nextValue = !previous;
    setCameraFlip((prev) => ({ ...prev, [selectedCamera]: nextValue }));
    try {
      const response = await fetch(`${API_BASE_URL}/api/camera/flip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ camera_index: selectedCamera, flipped: nextValue }),
      });
      if (!response.ok) {
        throw new Error("Failed to save camera flip.");
      }
      const data = await response.json();
      if (data?.flips) {
        setCameraFlip(normalizeFlipMap(data.flips));
      }
    } catch (err) {
      console.error("Error saving camera flip:", err);
      setCameraFlip((prev) => ({ ...prev, [selectedCamera]: previous }));
      setError("Failed to save camera flip.");
    }
  };

  // Fetch calibration status
  const fetchCalibrationStatus = async (cameraIndex = selectedCamera) => {
    const cameraInfo = cameras.find((camera) => camera.index === cameraIndex);
    if (cameraInfo?.calibratable === false) {
      setCalibrationStatus(null);
      setDetectionResult(null);
      return;
    }
    try {
      const response = await fetch(`${API_BASE_URL}/api/calibration/status/${cameraIndex}`);
      const data = await response.json();
      setCalibrationStatus(data);
    } catch (err) {
      console.error("Error fetching calibration status:", err);
      setError("Failed to fetch calibration status.");
    }
  };

  // Connect to camera WebSocket
  const connectToWebSocket = () => {
    // Close existing connection
    if (wsRef.current) {
      wsRef.current.close();
    }

    // Create new WebSocket connection
    const ws = new WebSocket(buildCameraWsUrl(selectedCamera));
    
    ws.onopen = () => {
      console.log("WebSocket connected");
      setError(null); // Clear error state on successful connection
    };
    
    ws.onmessage = (event) => {
      // Convert blob to image URL
      if (event.data instanceof Blob) {
        const url = URL.createObjectURL(event.data);
        if (videoRef.current) {
          videoRef.current.src = url;
          
          // Revoke previous URL to avoid memory leaks
          const prevUrl = videoRef.current.dataset.prevUrl;
          if (prevUrl) {
            URL.revokeObjectURL(prevUrl);
          }
          videoRef.current.dataset.prevUrl = url;
        }
      }
    };
    
    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
      setError("WebSocket connection error. Make sure the API server is running.");
    };
    
    ws.onclose = () => {
      console.log("WebSocket disconnected");
    };
    
    wsRef.current = ws;
  };

  const runDetectionForCamera = async (cameraIndex: number) => {
    const targetCamera = cameras.find((camera) => camera.index === cameraIndex);
    if (targetCamera?.calibratable === false) {
      setError("Player Cam is preview-only. Calibrate the board scoring cameras.");
      return;
    }
    setSelectedCamera(cameraIndex);
    setIsLoading(true);
    setRecalibratingCamera(cameraIndex);
    setError(null);
    setAutoCalibrationSummary(null);
    
    try {
      const response = await fetch(`${API_BASE_URL}/api/calibration/detect/${cameraIndex}?include_inner_points=${includeInnerPoints ? "true" : "false"}`, {
        method: 'POST'
      });
      
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.detail || "Failed to run detection.");
      }
      setDetectionResult(data);
      if (data?.captured) {
        setAutoCalibrationSummary(`${targetCamera?.name || `Camera ${cameraIndex + 1}`} calibrated.`);
      }
      
      // Auto-refresh calibration status
      fetchCalibrationStatus(cameraIndex);
    } catch (err) {
      console.error("Error running detection:", err);
      setError(err instanceof Error ? err.message : "Failed to run detection.");
    } finally {
      setIsLoading(false);
      setRecalibratingCamera(null);
    }
  };

  // Run calibration detection
  const runDetection = async () => {
    await runDetectionForCamera(selectedCamera);
  };

  const autoCalibrateScoringCameras = async () => {
    setIsAutoCalibrating(true);
    setIsLoading(true);
    setError(null);
    setAutoCalibrationSummary(null);

    try {
      const response = await fetch(`${API_BASE_URL}/api/calibration/auto?include_inner_points=${includeInnerPoints ? "true" : "false"}&only_missing=false`, {
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.detail || "Failed to auto-calibrate cameras.");
      }

      const capturedCount = Number(data?.captured_count || 0);
      const scoringCount = Number(data?.scoring_camera_count || 0);
      setAutoCalibrationSummary(`Auto-calibrated ${capturedCount}/${scoringCount} scoring cameras.`);
      fetchCalibrationStatus(selectedCamera);
    } catch (err) {
      console.error("Error auto-calibrating cameras:", err);
      setError(err instanceof Error ? err.message : "Failed to auto-calibrate cameras.");
    } finally {
      setIsAutoCalibrating(false);
      setIsLoading(false);
    }
  };

  // Rotate calibration
  const rotateCalibration = async () => {
    if (!isSelectedCameraCalibratable) {
      setError("Player Cam is preview-only. Calibrate the board scoring cameras.");
      return;
    }
    setIsLoading(true);
    setError(null);
    
    try {
      const response = await fetch(`${API_BASE_URL}/api/calibration/rotate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ camera_index: selectedCamera })
      });
      
      await response.json();
      
      // Auto-refresh calibration status
      fetchCalibrationStatus(selectedCamera);
    } catch (err) {
      console.error("Error rotating calibration:", err);
      setError("Failed to rotate calibration.");
    } finally {
      setIsLoading(false);
    }
  };

  // Save calibration
  const saveCalibration = async () => {
    if (!isSelectedCameraCalibratable) {
      setError("Player Cam is preview-only. Calibrate the board scoring cameras.");
      return;
    }
    setIsLoading(true);
    setError(null);
    
    try {
      const response = await fetch(`${API_BASE_URL}/api/calibration/save/${selectedCamera}`, {
        method: 'POST'
      });
      
      await response.json();
      
      // Auto-refresh calibration status
      fetchCalibrationStatus();
    } catch (err) {
      console.error("Error saving calibration:", err);
      setError("Failed to save calibration.");
    } finally {
      setIsLoading(false);
    }
  };

  // Toggle focus mode on/off
  const checkFocus = () => {
    if (focusMode || liveFocusScore) {
      // Turn off - stop monitoring and clear state
      stopLiveFocusMonitoring();
    } else {
      // Turn on - enable focus selection mode
      setFocusMode(true);
      setStarCenter(null);
      setError("Click on the center of the Siemens star pattern");
    }
  };

  // Start live focus monitoring
  const startLiveFocusMonitoring = async (centerX: number, centerY: number) => {
    // Stop any existing monitoring
    if (focusIntervalRef.current) {
      clearInterval(focusIntervalRef.current);
    }

    // Function to fetch focus metrics
    const fetchLiveFocus = async () => {
      if (!focusToolActiveRef.current) return;
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch(
          `${API_BASE_URL}/api/focus/metrics-camera_index=${selectedCamera}&center_x=${centerX}&center_y=${centerY}`
        );
        const data = await response.json();
        
        if (data.cameras && data.cameras[0]) {
          const metrics = data.cameras[0];
          setLiveFocusScore({
            contrast: metrics.contrast_score || 0,
            sharpness: metrics.sharpness_score || 0
          });
        }
      } catch (err) {
        console.error("Error fetching live focus:", err);
      }
    };

    // Initial fetch
    await fetchLiveFocus();

    if (!focusToolActiveRef.current) return;
    // Set up interval for continuous updates (every 1000ms)
    focusIntervalRef.current = setInterval(fetchLiveFocus, 1000);
  };

  // Stop live focus monitoring
  const stopLiveFocusMonitoring = () => {
    if (focusIntervalRef.current) {
      clearInterval(focusIntervalRef.current);
      focusIntervalRef.current = null;
    }
    setLiveFocusScore(null);
    setFocusMode(false);
    setStarCenter(null);
  };

  // Keep live focus polling strictly tied to Focus tool state.
  useEffect(() => {
    focusToolActiveRef.current = focusMode || Boolean(liveFocusScore);
    if (!focusToolActiveRef.current && focusIntervalRef.current) {
      clearInterval(focusIntervalRef.current);
      focusIntervalRef.current = null;
    }
  }, [focusMode, liveFocusScore]);

  // Handle click on camera feed to select star center
  const handleImageClick = async (e: React.MouseEvent<HTMLDivElement>) => {
    if (!videoRef.current) return;
    if (!focusMode && !clickToScoreEnabled) return;
    if (!focusMode && !isSelectedCameraCalibratable) return;
     
    const rect = videoRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    // Convert to image coordinates
    const imgWidth = videoRef.current.naturalWidth;
    const imgHeight = videoRef.current.naturalHeight;

    // When using `object-contain`, the image may be letterboxed inside the element.
    // Map clicks to the actual displayed image region, not the full element box.
    const scale = Math.min(rect.width / imgWidth, rect.height / imgHeight);
    const displayedWidth = imgWidth * scale;
    const displayedHeight = imgHeight * scale;
    const offsetX = (rect.width - displayedWidth) / 2;
    const offsetY = (rect.height - displayedHeight) / 2;

    const insideX = x - offsetX;
    const insideY = y - offsetY;
    if (insideX < 0 || insideY < 0 || insideX > displayedWidth || insideY > displayedHeight) {
      return;
    }

    let imageX = Math.round(insideX / scale);
    let imageY = Math.round(insideY / scale);
    if (isFlipped) {
      imageX = imgWidth - 1 - imageX;
      imageY = imgHeight - 1 - imageY;
    }

    if (focusMode) {
      setStarCenter({ x: imageX, y: imageY });
      setError(null);
      await startLiveFocusMonitoring(imageX, imageY);
      return;
    }

    // Click-to-score verification
    setLastClick({ x: imageX, y: imageY });
    setLastClickScore(null);
    try {
      const response = await fetch(`${API_BASE_URL}/api/calibration/score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ camera_index: selectedCamera, x: imageX, y: imageY }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data?.detail || "Failed to score click.");
        return;
      }
      setError(null);
      setLastClickScore(data?.score || null);
    } catch (err) {
      console.error("Error scoring click:", err);
      setError("Failed to score click.");
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopLiveFocusMonitoring();
      // Refresh dartcounter background baseline after calibration UI is closed.
      fetch(`${API_BASE_URL}/api/detection/reset`, { method: "POST" }).catch(() => undefined);
    };
  }, []);

  return (
    <div className={`${embedded ? "min-h-full" : "h-dvh"} w-full bg-black text-white relative overflow-hidden flex flex-col`}>
      {/* Reflective glossy edges */}
      {!embedded && (
        <div className="pointer-events-none fixed inset-0 [background:
          radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
          radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.08),transparent_70%),
          radial-gradient(ellipse_at_bottom_left,rgba(255,255,255,0.06),transparent_70%),
          radial-gradient(ellipse_at_bottom_right,rgba(255,255,255,0.1),transparent_65%),
          linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95) 30%,rgba(255,255,255,0.04) 60%,rgba(0,0,0,1) 100%)
        ]" />
      )}

      {!embedded && (
        <BackendTopNav />
      )}

      <main className={`relative z-10 w-full px-4 sm:px-6 md:px-10 flex-1 flex flex-col overflow-hidden min-h-0 ${embedded ? "pt-4" : ""}` }>

        <motion.h1
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="text-2xl sm:text-3xl md:text-4xl font-bold mb-3 sm:mb-4 text-center flex-shrink-0"
        >
          Camera Calibration
        </motion.h1>

        {error && (
          <div className="bg-red-900/50 border border-red-500 text-white p-2 sm:p-3 rounded-lg mb-3 sm:mb-4 flex-shrink-0 text-sm">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] xl:grid-cols-[1fr_380px] gap-3 sm:gap-4 lg:gap-6 flex-1 min-h-0">
          {/* Camera Feed */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5 }}
            className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-2 sm:p-3 flex flex-col min-h-0"
          >
            {/* Camera feed - flexible height */}
            <div
              className={`relative bg-black rounded-lg overflow-hidden mb-2 flex-1 min-h-0 ${
                 isPlayerCamPortraitPreview ? 'mx-auto aspect-[9/16] w-auto max-w-full' : 'w-full'
              } ${
                 focusMode ? 'cursor-crosshair ring-2 ring-yellow-500' : ''
              }`}
              ref={feedRef}
              onClick={handleImageClick}
            >
              <img
                ref={videoRef}
                className={`w-full h-full object-contain transition-transform duration-150 ${
                  isFlipped ? "rotate-180" : ""
                }`}
                alt="Camera feed"
              />
              
              {/* Focus mode overlay */}
              {focusMode && !liveFocusScore && (
                <div className="absolute top-2 left-2 bg-yellow-600/90 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 whitespace-nowrap">
                  <Focus className="h-4 w-4 flex-shrink-0" />
                  Click on the center of the Siemens star
                </div>
              )}
              
              {/* Live focus score overlay - Left side vertical */}
              {liveFocusScore && (
                <div className="absolute left-2 top-2 bottom-2 flex flex-col gap-2 w-32">
                  <div className="bg-black/80 text-white px-3 py-4 rounded-lg backdrop-blur-sm flex flex-col h-full">
                    {/* Header with close button */}
                    <div className="flex items-center justify-between mb-3">
                      <Focus className="h-5 w-5 text-yellow-400" />
                      <button
                        onClick={stopLiveFocusMonitoring}
                        className="text-zinc-400 hover:text-white transition-colors"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    
                    {/* Contrast Score */}
                    <div className="mb-4">
                      <div className="text-xs text-zinc-400 mb-1">Contrast</div>
                      <div className={`text-2xl font-bold font-mono ${
                        liveFocusScore.contrast > 50 ? 'text-green-400' :
                        liveFocusScore.contrast > 30 ? 'text-yellow-400' : 'text-red-400'
                      }`}>
                        {liveFocusScore.contrast.toFixed(1)}
                      </div>
                      <div className="text-xs text-zinc-400 mt-1">
                        {liveFocusScore.contrast > 50 ? 'Good' :
                          liveFocusScore.contrast > 30 ? 'Fair' : 'Poor'}
                      </div>
                    </div>
                    
                    {/* Sharpness Score */}
                    <div className="mb-4">
                      <div className="text-xs text-zinc-400 mb-1">Sharpness</div>
                      <div className={`text-2xl font-bold font-mono ${
                        liveFocusScore.sharpness > 40 ? 'text-green-400' :
                        liveFocusScore.sharpness > 25 ? 'text-yellow-400' : 'text-red-400'
                      }`}>
                        {liveFocusScore.sharpness.toFixed(1)}
                      </div>
                      <div className="text-xs text-zinc-400 mt-1">
                        {liveFocusScore.sharpness > 40 ? 'Sharp' :
                          liveFocusScore.sharpness > 25 ? 'Moderate' : 'Blurry'}
                      </div>
                    </div>
                    
                    {/* Live indicator at bottom */}
                    <div className="mt-auto text-xs text-zinc-400 flex flex-col items-center gap-1">
                      <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
                      <span className="text-center">Live</span>
                    </div>
                  </div>
                </div>
              )}
              
              {/* Star center marker */}
              {starCenter && (
                <div
                  className="absolute w-4 h-4 border-2 border-yellow-400 rounded-full"
                  style={getOverlayPositionStyle(starCenter)}
                >
                  <div className="absolute inset-0 bg-yellow-400/30 rounded-full animate-ping"></div>
                </div>
              )}

              {/* Click-to-score marker */}
              {lastClick && (
                <div
                  className="absolute w-4 h-4 border-2 border-yellow-300 rounded-full pointer-events-none"
                  style={getOverlayPositionStyle(lastClick)}
                />
              )}

              {lastClickScore?.description && !focusMode && (
                <div className="absolute top-3 right-3 bg-black/80 text-white px-5 py-3 rounded-xl text-xl sm:text-2xl font-bold border border-zinc-700/50 shadow-lg">
                  {lastClickScore.description}
                </div>
              )}
               
              {/* Loading overlay */}
              {isLoading && (
                <div className="absolute inset-0 bg-black/70 flex items-center justify-center">
                  <div className="animate-spin rounded-full h-10 w-10 sm:h-12 sm:w-12 border-t-2 border-b-2 border-white"></div>
                </div>
              )}
            </div>

            {/* Camera selector */}
            <div className="flex flex-wrap gap-1.5 mb-1.5 flex-shrink-0">
              {cameras.map((camera) => (
                <button
                  key={camera.index}
                  onClick={() => setSelectedCamera(camera.index)}
                  className={`px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg flex items-center gap-1.5 transition-colors text-xs ${
                    selectedCamera === camera.index
                      ? "bg-blue-600 text-white"
                      : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                  }`}
                >
                  <Camera className="h-3 w-3 sm:h-4 sm:w-4" />
                  {camera.name}
                </button>
              ))}
            </div>

            <section className="mb-3 sm:mb-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 sm:p-4">
              <div className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-zinc-400">
                <Camera className="h-4 w-4" />
                Camera Selection
              </div>

              {selectionMessage && (
                <div
                  className={`mt-3 text-sm px-3 py-2 rounded-lg border ${
                    selectionMessage.type === "success"
                      ? "bg-green-900/40 border-green-700 text-green-200"
                      : "bg-red-900/40 border-red-700 text-red-200"
                  }`}
                >
                  {selectionMessage.text}
                </div>
              )}

              {autoCalibrationSummary && (
                <div className="mt-3 text-sm px-3 py-2 rounded-lg border bg-emerald-900/30 border-emerald-700 text-emerald-200">
                  {autoCalibrationSummary}
                </div>
              )}

              {cameras.length === 0 ? (
                <div className="mt-3 text-sm text-zinc-400">
                  No camera slots available. Start the backend to configure cameras.
                </div>
              ) : (
                <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {cameras.map((camera, slot) => {
                    const selectedValue = slotSelections[slot];
                    const isPlayerSlot = camera.calibratable === false;
                    return (
                      <div
                        key={camera.index}
                        className={`bg-black/30 border rounded-lg p-3 flex flex-col gap-2 ${
                          isPlayerSlot ? "border-cyan-800/70" : "border-zinc-800"
                        }`}
                      >
                        <div className="flex items-center justify-between text-sm font-semibold">
                          <span>{camera.name}</span>
                          <span className={`text-xs ${isPlayerSlot ? "text-cyan-300" : "text-zinc-400"}`}>
                            {isPlayerSlot ? "Player" : `Slot #${camera.index}`}
                          </span>
                        </div>
                        <label className="block">
                          <span className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">Assigned Device</span>
                          <select
                            value={selectedValue ?? ""}
                            onChange={(event) => {
                              const value = event.target.value === "" ? null : Number(event.target.value);
                              setCameraSelection((prev) => {
                                const next = [...prev];
                                next[slot] = value;
                                return next;
                              });
                              setSelectionMessage(null);
                            }}
                            disabled={isSavingSelection}
                            className="mt-1 h-11 w-full rounded-lg border border-zinc-800 bg-zinc-950/80 px-3 text-sm font-semibold text-white outline-none transition focus:border-cyan-500 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <option value="">Not assigned</option>
                            {cameraDevices.map((device) => (
                              <option key={device.index} value={device.index}>
                                {formatDeviceOption(device)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <p className="text-xs text-zinc-400">{describeDevice(selectedValue)}</p>
                        {isPlayerSlot ? (
                          <div className="rounded-lg border border-cyan-900/60 bg-cyan-950/20 px-3 py-2 text-xs text-cyan-200">
                            Preview only
                          </div>
                        ) : (
                          <button
                            onClick={() => runDetectionForCamera(camera.index)}
                            disabled={isLoading || isAutoCalibrating}
                            className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {recalibratingCamera === camera.index ? "Calibrating..." : "Re-calibrate"}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="mt-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="text-xs text-yellow-300 flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  Applying camera changes pauses the feed briefly, resets detection, and requires recalibration for changed scoring slots.
                </div>
                <div className="flex flex-wrap gap-2 sm:justify-end">
                  <button
                    onClick={autoCalibrateScoringCameras}
                    disabled={isSavingSelection || isLoading || isAutoCalibrating || !cameras.length}
                    className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                      isSavingSelection || isLoading || isAutoCalibrating || !cameras.length
                        ? "bg-zinc-700 text-zinc-400 cursor-not-allowed"
                        : "bg-blue-600 hover:bg-blue-500 text-white"
                    }`}
                  >
                    {isAutoCalibrating ? "Auto-calibrating..." : "Auto Calibrate"}
                  </button>
                  <button
                    onClick={saveCameraSelection}
                    disabled={isSavingSelection || !cameras.length}
                    className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                      isSavingSelection || !cameras.length
                        ? "bg-zinc-700 text-zinc-400 cursor-not-allowed"
                        : "bg-cyan-600 hover:bg-cyan-500 text-white"
                    }`}
                  >
                    {isSavingSelection ? "Applying..." : "Apply Camera Selection"}
                  </button>
                </div>
              </div>
            </section>

            {/* Action buttons */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 sm:gap-2 flex-shrink-0">
              <button
                onClick={runDetection}
                disabled={isLoading || !isSelectedCameraCalibratable}
                className="bg-blue-600 hover:bg-blue-700 text-white px-2 py-2 sm:py-2.5 rounded-lg flex flex-col items-center justify-center gap-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Crosshair className="h-4 w-4 sm:h-5 sm:w-5" />
                <span className="text-xs">Recalibrate</span>
              </button>
              
              <button
                onClick={rotateCalibration}
                disabled={isLoading || !isSelectedCameraCalibratable || !calibrationStatus?.is_calibrated}
                className="bg-purple-600 hover:bg-purple-700 text-white px-2 py-2 sm:py-2.5 rounded-lg flex flex-col items-center justify-center gap-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <RotateCw className="h-4 w-4 sm:h-5 sm:w-5" />
                <span className="text-xs">Rotate</span>
              </button>

              <button
                onClick={toggleCameraFlip}
                disabled={isLoading}
                className={`${
                  isFlipped
                    ? "bg-amber-600 hover:bg-amber-700 ring-2 ring-amber-400"
                    : "bg-zinc-700 hover:bg-zinc-600"
                } text-white px-2 py-2 sm:py-2.5 rounded-lg flex flex-col items-center justify-center gap-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <RotateCcw className="h-4 w-4 sm:h-5 sm:w-5" />
                <span className="text-xs">Flip 180</span>
              </button>
              
              <button
                onClick={saveCalibration}
                disabled={isLoading || !isSelectedCameraCalibratable || !calibrationStatus?.is_calibrated}
                className="bg-green-600 hover:bg-green-700 text-white px-2 py-2 sm:py-2.5 rounded-lg flex flex-col items-center justify-center gap-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Save className="h-4 w-4 sm:h-5 sm:w-5" />
                <span className="text-xs">Save</span>
              </button>
              
              <button
                onClick={checkFocus}
                disabled={isLoading}
                className={`${
                  focusMode || liveFocusScore
                    ? 'bg-green-600 hover:bg-green-700 ring-2 ring-green-400'
                    : 'bg-yellow-600 hover:bg-yellow-700'
                } text-white px-2 py-2 sm:py-2.5 rounded-lg flex flex-col items-center justify-center gap-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <Focus className="h-4 w-4 sm:h-5 sm:w-5" />
                <span className="text-xs">{focusMode || liveFocusScore ? 'Stop' : 'Focus'}</span>
              </button>
            </div>
          </motion.div>

          {/* Status Panel */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-2 sm:p-3 lg:p-4 flex flex-col min-h-0 overflow-y-auto"
          >
            <h2 className="text-lg sm:text-xl font-bold mb-3 sm:mb-4 flex items-center gap-2 flex-shrink-0">
              <Camera className="h-4 w-4 sm:h-5 sm:w-5" />
              {selectedCameraInfo?.name || `Camera ${selectedCamera + 1}`} Status
            </h2>

            {!isSelectedCameraCalibratable ? (
              <div className="space-y-3 sm:space-y-4 flex-1 min-h-0 overflow-y-auto">
                <div className="p-2 sm:p-3 bg-cyan-900/20 border border-cyan-800/30 rounded-lg flex-shrink-0">
                  <h3 className="font-semibold mb-1.5 sm:mb-2 text-xs sm:text-sm">Player Cam</h3>
                  <p className="text-[10px] sm:text-xs text-zinc-300">
                    Preview-only camera for the player view. Use the board cameras for calibration and scoring.
                  </p>
                  <div className="mt-3">
                    <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-cyan-200">
                      View
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {[
                        { value: false, label: "Full" },
                        { value: true, label: "Shorts 9:16" },
                      ].map((viewMode) => (
                        <button
                          key={viewMode.label}
                          onClick={() => savePlayerCamViewSettings({ portraitCrop: viewMode.value })}
                          disabled={isSavingPlayerView}
                          className={`rounded-lg border px-2 py-2 text-xs font-semibold transition-colors disabled:opacity-60 ${
                            playerCamPortraitCrop === viewMode.value
                              ? "border-cyan-300 bg-cyan-600 text-white"
                              : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
                          }`}
                        >
                          {viewMode.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="mt-3">
                    <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-cyan-200">
                      Orientation
                    </div>
                    <div className="grid grid-cols-4 gap-1.5">
                      {[
                        { value: 0, label: "0°" },
                        { value: 90, label: "90° R" },
                        { value: 180, label: "180°" },
                        { value: 270, label: "90° L" },
                      ].map((rotation) => (
                        <button
                          key={rotation.value}
                          onClick={() => savePlayerCamViewSettings({ rotation: rotation.value })}
                          disabled={isSavingPlayerView}
                          className={`rounded-lg border px-2 py-2 text-xs font-semibold transition-colors disabled:opacity-60 ${
                            playerCamRotation === rotation.value
                              ? "border-cyan-300 bg-cyan-600 text-white"
                              : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
                          }`}
                        >
                          {rotation.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="p-2 sm:p-3 bg-yellow-900/20 border border-yellow-800/30 rounded-lg flex-shrink-0">
                  <h3 className="font-semibold mb-1.5 sm:mb-2 text-xs sm:text-sm flex items-center gap-2">
                    <Focus className="h-4 w-4" />
                    Focus Tool
                  </h3>
                  <p className="text-[10px] sm:text-xs text-zinc-300 mb-2">
                    Focus still works on the Player Cam for aiming the camera at the oche.
                  </p>
                  <a
                    href="/siemenststern A4 16x16 (1).pdf"
                    download="Siemens-Star-A4-16x16.pdf"
                    className="w-full bg-yellow-600 hover:bg-yellow-700 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 transition-colors text-xs sm:text-sm"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    Download Siemens Star
                  </a>
                </div>
              </div>
            ) : calibrationStatus ? (
              <div className="space-y-3 sm:space-y-4 flex-1 min-h-0 overflow-y-auto">
                {/* Calibration status */}
                <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
                  <div className={`h-3 w-3 sm:h-4 sm:w-4 rounded-full ${
                    calibrationStatus.is_calibrated ? "bg-green-500" : "bg-red-500"
                  }`}></div>
                  <span className="text-sm sm:text-base">
                    {calibrationStatus.is_calibrated ? "Calibrated" : "Not Calibrated"}
                  </span>
                </div>

                {/* Quality meter */}
                {calibrationStatus.is_calibrated && (
                  <div className="flex-shrink-0">
                    <div className="flex justify-between mb-1 text-xs sm:text-sm">
                      <span>Quality</span>
                      <div className="flex items-center gap-2">
                        <span>{Math.round(calibrationStatus.calibration_quality * 100)}%</span>
                        {calibrationQualitySummary && (
                          <span className={`font-medium ${calibrationQualitySummary.textClassName}`}>
                            {calibrationQualitySummary.label}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="w-full bg-zinc-700 rounded-full h-2">
                      <div
                        className={`${calibrationQualitySummary?.barClassName ?? "bg-green-600"} h-2 rounded-full`}
                        style={{ width: `${Math.round(calibrationStatus.calibration_quality * 100)}%` }}
                      ></div>
                    </div>
                  </div>
                )}

                {/* Current segment */}
                {calibrationStatus.is_calibrated && (
                  <div className="flex-shrink-0">
                    <div className="flex justify-between text-xs sm:text-sm">
                      <span>Current Segment</span>
                      <span>{calibrationStatus.current_segment}</span>
                    </div>
                  </div>
                )}

                {/* Detection results */}
                {detectionResult && (
                  <div className="p-2 sm:p-3 bg-zinc-800/50 rounded-lg flex-shrink-0">
                    <h3 className="font-semibold mb-2 text-xs sm:text-sm">Detection Results</h3>
                    <div className="grid grid-cols-2 gap-2 sm:gap-3">
                      <div>
                        <div className="text-[10px] sm:text-xs text-zinc-400">Outer Ring</div>
                        <div className="text-base sm:text-lg font-mono">{detectionResult.cal_count}/20</div>
                      </div>
                      <div>
                        <div className="text-[10px] sm:text-xs text-zinc-400">Triple Ring</div>
                        <div className="text-base sm:text-lg font-mono">{detectionResult.cal1_count}/20</div>
                      </div>
                      {typeof detectionResult.cal2_count === "number" && (
                        <div>
                          <div className="text-[10px] sm:text-xs text-zinc-400">Inner Triple</div>
                          <div className="text-base sm:text-lg font-mono">{detectionResult.cal2_count}/20</div>
                        </div>
                      )}
                      {typeof detectionResult.cal3_count === "number" && (
                        <div>
                          <div className="text-[10px] sm:text-xs text-zinc-400">Inner Double</div>
                          <div className="text-base sm:text-lg font-mono">{detectionResult.cal3_count}/20</div>
                        </div>
                      )}
                      {typeof detectionResult.twenty_count === "number" && (
                        <div className="col-span-2">
                          <div className="text-[10px] sm:text-xs text-zinc-400">20 Marker</div>
                          <div className="text-base sm:text-lg font-mono">{detectionResult.twenty_count}</div>
                        </div>
                      )}
                    </div>

                    <label className="mt-2 flex items-center gap-2 text-[10px] sm:text-xs text-zinc-300 select-none">
                      <input
                        type="checkbox"
                        checked={includeInnerPoints}
                        onChange={(e) => setIncludeInnerPoints(e.target.checked)}
                      />
                      Use inner points (cal2/cal3)
                    </label>

                    <label className="mt-2 flex items-center gap-2 text-[10px] sm:text-xs text-zinc-300 select-none">
                      <input
                        type="checkbox"
                        checked={clickToScoreEnabled}
                        onChange={(e) => setClickToScoreEnabled(e.target.checked)}
                      />
                      Click-to-score verification
                    </label>
                    
                    {detectionResult.enough_points ? (
                      <div className="mt-2 flex items-center gap-1.5 text-green-400 text-xs sm:text-sm">
                        <CheckCircle className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                        <span>Enough points</span>
                      </div>
                    ) : (
                      <div className="mt-2 text-yellow-400 text-xs sm:text-sm">
                        Need 8+ points each
                      </div>
                    )}
                  </div>
                )}

                {/* Instructions */}
                <div className="p-2 sm:p-3 bg-blue-900/20 border border-blue-800/30 rounded-lg flex-shrink-0">
                  <h3 className="font-semibold mb-1.5 sm:mb-2 text-xs sm:text-sm">Instructions</h3>
                  <ol className="list-decimal list-inside space-y-1 text-[10px] sm:text-xs text-zinc-300">
                    <li>Select camera</li>
                    <li>Detect calibration points</li>
                    <li>Rotate to align segments</li>
                    <li>Save calibration</li>
                    <li>Click board to verify score</li>
                    <li>Repeat for each board scoring camera</li>
                  </ol>
                </div>

                {/* Siemens Star Download */}
                <div className="p-2 sm:p-3 bg-yellow-900/20 border border-yellow-800/30 rounded-lg flex-shrink-0">
                  <h3 className="font-semibold mb-1.5 sm:mb-2 text-xs sm:text-sm flex items-center gap-2">
                    <Focus className="h-4 w-4" />
                    Focus Tool
                  </h3>
                  <p className="text-[10px] sm:text-xs text-zinc-300 mb-2">
                    Download and print the Siemens star pattern for camera focus testing
                  </p>
                  <a
                    href="/siemenststern A4 16x16 (1).pdf"
                    download="Siemens-Star-A4-16x16.pdf"
                    className="w-full bg-yellow-600 hover:bg-yellow-700 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 transition-colors text-xs sm:text-sm"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    Download Siemens Star
                  </a>
                </div>
              </div>
            ) : (
              <div className="animate-pulse flex space-x-4">
                <div className="flex-1 space-y-3 py-1">
                  <div className="h-3 bg-zinc-700 rounded w-3/4"></div>
                  <div className="h-3 bg-zinc-700 rounded"></div>
                  <div className="h-3 bg-zinc-700 rounded w-5/6"></div>
                </div>
              </div>
            )}
          </motion.div>
        </div>
      </main>

      {/* Focus Metrics Modal */}
      {showFocusMetrics && focusMetrics && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 max-w-2xl w-full max-h-[80vh] overflow-y-auto"
          >
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold flex items-center gap-2">
                <Focus className="h-5 w-5" />
                Focus Metrics (Siemens Star)
              </h2>
              <button
                onClick={() => setShowFocusMetrics(false)}
                className="text-zinc-400 hover:text-white transition-colors"
              >
                <X className="h-6 w-6" />
              </button>
            </div>

            <div className="space-y-4">
              {Object.entries(focusMetrics).map(([cameraId, metrics]: [string, any]) => (
                <div key={cameraId} className="bg-zinc-800/50 rounded-lg p-4">
                  <h3 className="font-semibold mb-3 flex items-center gap-2">
                    <Camera className="h-4 w-4" />
                    Camera {cameraId}
                    {metrics.center_x && metrics.center_y && (
                      <span className="text-xs text-zinc-400 font-normal ml-2">
                        Center: ({metrics.center_x}, {metrics.center_y})
                      </span>
                    )}
                  </h3>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-xs text-zinc-400 mb-1">Contrast Score</div>
                      <div className="text-2xl font-mono">{metrics.contrast_score?.toFixed(2) || metrics.focus_score?.toFixed(2) || 'N/A'}</div>
                      <div className={`text-xs mt-1 ${
                        (metrics.contrast_score || metrics.focus_score || 0) > 50 ? 'text-green-400' :
                        (metrics.contrast_score || metrics.focus_score || 0) > 30 ? 'text-yellow-400' : 'text-red-400'
                      }`}>
                        {(metrics.contrast_score || metrics.focus_score || 0) > 50 ? 'Good Focus' :
                           (metrics.contrast_score || metrics.focus_score || 0) > 30 ? 'Fair Focus' : 'Poor Focus'}
                      </div>
                    </div>
                    
                    <div>
                      <div className="text-xs text-zinc-400 mb-1">Sharpness Score</div>
                      <div className="text-2xl font-mono">{metrics.sharpness_score?.toFixed(2) || metrics.focus_score?.toFixed(2) || 'N/A'}</div>
                      <div className={`text-xs mt-1 ${
                        (metrics.sharpness_score || metrics.focus_score || 0) > 40 ? 'text-green-400' :
                        (metrics.sharpness_score || metrics.focus_score || 0) > 25 ? 'text-yellow-400' : 'text-red-400'
                      }`}>
                        {(metrics.sharpness_score || metrics.focus_score || 0) > 40 ? 'Sharp' :
                           (metrics.sharpness_score || metrics.focus_score || 0) > 25 ? 'Moderate' : 'Blurry'}
                      </div>
                    </div>
                  </div>

                  {metrics.error && (
                    <div className="mt-3 text-xs text-red-400 bg-red-900/20 border border-red-800/30 rounded p-2">
                      {metrics.error}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="mt-6 p-4 bg-blue-900/20 border border-blue-800/30 rounded-lg">
              <h4 className="font-semibold text-sm mb-2">Focus Guidelines</h4>
              <ul className="text-xs text-zinc-300 space-y-1">
                <li>- Contrast Score &gt; 50: Good focus, sharp edges detected</li>
                <li>- Sharpness Score &gt; 40: Clear details, minimal blur</li>
                <li>- Adjust camera focus if scores are low</li>
                <li>- Ensure Siemens star pattern is visible and well-lit</li>
              </ul>
            </div>

            <button
              onClick={() => setShowFocusMetrics(false)}
              className="mt-4 w-full bg-blue-600 hover:bg-blue-700 text-white py-2 rounded-lg transition-colors"
            >
              Close
            </button>
          </motion.div>
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="fixed bottom-4 right-4 bg-red-600 text-white px-4 py-3 rounded-lg shadow-lg z-50 max-w-md">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5" />
            <span>{error}</span>
          </div>
        </div>
      )}

      {!embedded && (
        <footer className="relative z-10 border-t border-white/10 py-2 sm:py-3 text-center text-[10px] sm:text-xs text-zinc-500 flex-shrink-0">
          (c) {new Date().getFullYear()} Machine Darts | Built for precision
        </footer>
      )}
    </div>
  );
}
