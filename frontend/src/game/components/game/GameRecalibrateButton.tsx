import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { API_BASE_URL } from "../../../services/api";
import { GameControlButton } from "./GameControl";

type RecalibrationState = "idle" | "running" | "success" | "error";

export default function GameRecalibrateButton({ className = "" }: { className?: string }) {
  const [state, setState] = useState<RecalibrationState>("idle");
  const [message, setMessage] = useState("Recalibrate scoring cameras");
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const resetLater = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      setState("idle");
      setMessage("Recalibrate scoring cameras");
    }, 3500);
  };

  const recalibrate = async () => {
    setState("running");
    setMessage("Calibrating scoring cameras...");
    try {
      const response = await fetch(`${API_BASE_URL}/api/calibration/auto?include_inner_points=true&only_missing=false`, {
        method: "POST",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.detail || "Calibration failed");
      }
      const capturedCount = Number(data?.captured_count || 0);
      const scoringCount = Number(data?.scoring_camera_count || 0);
      setState("success");
      setMessage(`Calibrated ${capturedCount}/${scoringCount} cameras`);
      resetLater();
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : "Calibration failed");
      resetLater();
    }
  };

  const label =
    state === "running"
      ? "Calibrating..."
      : state === "success"
        ? "Calibrated"
        : state === "error"
          ? "Retry Calibration"
          : "Recalibrate Cams";

  return (
    <GameControlButton
      label={label}
      icon={<RefreshCw className={`h-4 w-4 ${state === "running" ? "animate-spin" : ""}`} />}
      variant="neutral"
      onClick={recalibrate}
      disabled={state === "running"}
      title={message}
      className={className}
    />
  );
}
