import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertCircle,
  CheckCircle2,
  Monitor,
  Pause,
  Play,
  Settings,
  WifiOff,
} from "lucide-react";
import Logo from "../components/Logo";
import CalibrationPage from "../../pages/CalibrationPage";
import { API_BASE_URL } from "../../services/api";

const STATUS_POLL_VISIBLE_MS = 1000;
const STATUS_POLL_HIDDEN_MS = 5000;

interface DetectionStatus {
  is_active?: boolean;
  is_sleeping?: boolean;
  dart_count?: number;
  detection_state?: string;
  initialization?: {
    is_ready?: boolean;
    current_step?: string;
    steps?: Record<string, { status: string; message: string }>;
    error?: string | null;
  };
}

export default function BackendControlPage() {
  const [activeTab, setActiveTab] = useState<"control" | "calibration">("control");
  const [backendOnline, setBackendOnline] = useState<boolean>(false);
  const [detectionStatus, setDetectionStatus] = useState<DetectionStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState<boolean>(false);

  const fetchBackendStatus = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/detection/status`);
      const data = await response.json();
      setDetectionStatus(data);
      setBackendOnline(true);
      setMessage(null);
    } catch {
      setBackendOnline(false);
      setDetectionStatus(null);
    }
  };

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    const schedule = () => {
      if (cancelled) return;
      if (timer) {
        window.clearTimeout(timer);
      }
      const delay =
        document.visibilityState === "visible" ? STATUS_POLL_VISIBLE_MS : STATUS_POLL_HIDDEN_MS;
      timer = window.setTimeout(async () => {
        await fetchBackendStatus();
        schedule();
      }, delay);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void fetchBackendStatus();
      }
      schedule();
    };

    fetchBackendStatus();
    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      if (timer) {
        window.clearTimeout(timer);
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const startDetection = async () => {
    setIsBusy(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/detection/start`, { method: "POST" });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || "Failed to start detection.");
      }
      setMessage("Detection started.");
      await fetchBackendStatus();
    } catch (error: any) {
      setMessage(error.message || "Failed to start detection.");
    } finally {
      setIsBusy(false);
    }
  };

  const stopDetection = async () => {
    setIsBusy(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/detection/stop`, { method: "POST" });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || "Failed to stop detection.");
      }
      setMessage("Detection stopped.");
      await fetchBackendStatus();
    } catch (error: any) {
      setMessage(error.message || "Failed to stop detection.");
    } finally {
      setIsBusy(false);
    }
  };

  const detectionActive = Boolean(detectionStatus?.is_active);
  const detectionState = detectionStatus?.detection_state || "unknown";
  const openFrontendInBrowser = async () => {
    const frontendUrl = `${API_BASE_URL}/`;
    try {
      await invoke("open_in_browser", { url: frontendUrl });
      setMessage("Opened frontend in browser.");
    } catch {
      const popup = window.open(frontendUrl, "_blank", "noopener,noreferrer");
      if (!popup) {
        setMessage(`Could not open browser automatically. Open: ${frontendUrl}`);
      }
    }
  };

  return (
    <div className="min-h-screen w-full bg-slate-950 text-white relative overflow-hidden">
      <div
        className="pointer-events-none fixed inset-0 [background:
        radial-gradient(ellipse_at_top_left,rgba(14,165,233,0.22),transparent_55%),
        radial-gradient(ellipse_at_bottom_right,rgba(236,72,153,0.2),transparent_60%),
        linear-gradient(140deg,rgba(15,23,42,0.95),rgba(2,6,23,0.98)_45%,rgba(2,6,23,1)_100%)
      ]"
      />

      <header className="relative z-10 flex items-center justify-between px-6 md:px-10 py-5">
        <Logo />
        <div className="flex items-center gap-3">
          <button
            onClick={fetchBackendStatus}
            className="px-3 py-2 rounded-lg border border-white/10 text-xs uppercase tracking-[0.2em] text-zinc-200 hover:border-cyan-400 transition-colors"
          >
            Refresh
          </button>
        </div>
      </header>

      <main className="relative z-10 px-6 md:px-10 pb-10">
        <div className="max-w-6xl mx-auto space-y-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/40 p-1">
              <button
                onClick={() => setActiveTab("control")}
                className={`px-4 py-2 text-sm font-semibold rounded-full transition-colors ${
                  activeTab === "control"
                    ? "bg-cyan-500 text-slate-900"
                    : "text-zinc-200 hover:text-white"
                }`}
              >
                Control
              </button>
              <button
                onClick={() => setActiveTab("calibration")}
                className={`px-4 py-2 text-sm font-semibold rounded-full transition-colors ${
                  activeTab === "calibration"
                    ? "bg-cyan-500 text-slate-900"
                    : "text-zinc-200 hover:text-white"
                }`}
              >
                Calibration
              </button>
            </div>
            <div className="text-xs text-zinc-400 uppercase tracking-[0.2em]">Backend Suite</div>
          </div>

          {activeTab === "calibration" ? (
            <div className="rounded-2xl border border-white/10 bg-black/30 overflow-hidden">
              <CalibrationPage embedded />
            </div>
          ) : null}

          {activeTab === "control" ? (
            <div className="grid gap-4">
              <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6 shadow-xl">
                <div className="flex items-center justify-between">
                  <div>
                    <h1 className="text-2xl font-bold tracking-wide">Backend Control</h1>
                    <p className="text-sm text-zinc-400">
                      Configure cameras in Calibration, then start detection.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    {backendOnline ? (
                      <>
                        <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                        <span className="text-emerald-200">Backend online</span>
                      </>
                    ) : (
                      <>
                        <WifiOff className="h-5 w-5 text-red-400" />
                        <span className="text-red-200">Backend offline</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="mt-6 grid gap-4 sm:grid-cols-2">
                  <div className="rounded-xl border border-white/10 bg-black/30 p-4">
                    <div className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-zinc-400">
                      <Monitor className="h-4 w-4" />
                      Detection Status
                    </div>
                    <div className="mt-3 flex items-center justify-between">
                      <div>
                        <div className="text-lg font-semibold">
                          {detectionActive ? "Running" : "Stopped"}
                        </div>
                        <div className="text-xs text-zinc-400">State: {detectionState}</div>
                      </div>
                      <div className="text-right text-xs text-zinc-400">
                        Darts: {detectionStatus?.dart_count ?? "--"}
                      </div>
                    </div>
                    <div className="mt-3 flex gap-2">
                      <button
                        onClick={startDetection}
                        disabled={isBusy || detectionActive || !backendOnline}
                        className="flex-1 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                      >
                        <span className="inline-flex items-center gap-1.5">
                          <Play className="h-4 w-4" />
                          Start
                        </span>
                      </button>
                      <button
                        onClick={stopDetection}
                        disabled={isBusy || !detectionActive || !backendOnline}
                        className="flex-1 rounded-lg bg-slate-700 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-600 disabled:opacity-50"
                      >
                        <span className="inline-flex items-center gap-1.5">
                          <Pause className="h-4 w-4" />
                          Stop
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === "control" && message ? (
            <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-zinc-200">
              <AlertCircle className="h-4 w-4 text-amber-400" />
              {message}
            </div>
          ) : null}

          {activeTab === "control" ? (
            <div className="flex items-center justify-between text-xs text-zinc-500">
              <div className="flex items-center gap-2">
                <Settings className="h-3 w-3" />
                Keep the gameplay UI open in a browser at
                <a
                  className="text-cyan-300 hover:text-cyan-100 ml-1"
                  href="http://localhost:8000"
                  target="_blank"
                  rel="noreferrer"
                >
                  http://localhost:8000
                </a>
                <button
                  type="button"
                  onClick={openFrontendInBrowser}
                  className="ml-2 rounded-md border border-white/10 px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-zinc-200 hover:border-cyan-400 transition-colors"
                >
                  Open Frontend
                </button>
              </div>
              <div className="flex items-center gap-1">{isBusy && <span className="text-zinc-400">Working...</span>}</div>
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}
