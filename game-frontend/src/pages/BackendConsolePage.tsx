import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, Pause, Play, RefreshCw, WifiOff } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import Logo from "../components/Logo";

const API_BASE_URL = "http://localhost:8000";
const STATUS_POLL_MS = 1000;
const LOG_POLL_MS = 350;
const LOG_LINES = 220;

interface DetectionStatus {
  is_active?: boolean;
  detection_state?: string;
  dart_count?: number;
  initialization?: {
    is_ready?: boolean;
    current_step?: string;
    error?: string | null;
  };
}

interface DartScoreEntry {
  score?: number;
  segment?: number | string;
  multiplier?: number;
}

interface DetectionScoresResponse {
  dart_count?: number;
  scores?: DartScoreEntry[];
}

interface LogsTailResponse {
  content?: string;
  file?: string | null;
  lines?: number;
}

interface NativeLogsTailResponse {
  content?: string;
  file?: string | null;
  lines?: number;
}

export default function BackendConsolePage() {
  const [backendOnline, setBackendOnline] = useState(false);
  const [detectionStatus, setDetectionStatus] = useState<DetectionStatus | null>(null);
  const [detectionScores, setDetectionScores] = useState<DartScoreEntry[]>([]);
  const [logText, setLogText] = useState("");
  const [logFile, setLogFile] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const logsRef = useRef<HTMLPreElement>(null);

  const detectionActive = Boolean(detectionStatus?.is_active);
  const detectionState = detectionStatus?.detection_state || "unknown";
  const initStep = detectionStatus?.initialization?.current_step || "unknown";

  const refreshStatus = useCallback(async () => {
    try {
      const [statusResponse, scoresResponse] = await Promise.all([
        fetch(`${API_BASE_URL}/api/detection/status`),
        fetch(`${API_BASE_URL}/api/detection/scores`),
      ]);
      const data = (await statusResponse.json()) as DetectionStatus;
      setDetectionStatus(data);
      if (scoresResponse.ok) {
        const scoresPayload = (await scoresResponse.json()) as DetectionScoresResponse;
        setDetectionScores(Array.isArray(scoresPayload.scores) ? scoresPayload.scores : []);
      } else {
        setDetectionScores([]);
      }
      setBackendOnline(true);
    } catch {
      setBackendOnline(false);
      setDetectionStatus(null);
      setDetectionScores([]);
    }
  }, []);

  const refreshLogs = useCallback(async () => {
    const candidates = [
      `${API_BASE_URL}/api/diagnostics/logs/tail?lines=${LOG_LINES}`,
      `${API_BASE_URL}/api/logs/tail?lines=${LOG_LINES}`,
    ];

    try {
      let allNotFound = true;
      for (const url of candidates) {
        const response = await fetch(url);
        if (response.ok) {
          const data = (await response.json()) as LogsTailResponse;
          setLogText(data.content || "");
          setLogFile(data.file || null);
          return;
        }
        allNotFound = allNotFound && response.status === 404;
        if (response.status !== 404) {
          throw new Error(`Logs endpoint returned ${response.status}`);
        }
      }
      if (allNotFound) {
        const nativeLogs = (await invoke("read_backend_logs", {
          lines: LOG_LINES,
        })) as NativeLogsTailResponse;
        setLogText(nativeLogs.content || "");
        setLogFile(nativeLogs.file || null);
        return;
      }
    } catch (error) {
      setLogText(`Failed to load logs: ${error instanceof Error ? error.message : "unknown error"}`);
      setLogFile(null);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshStatus(), refreshLogs()]);
  }, [refreshLogs, refreshStatus]);

  useEffect(() => {
    refreshStatus();
    refreshLogs();

    const statusInterval = setInterval(refreshStatus, STATUS_POLL_MS);
    const logsInterval = setInterval(refreshLogs, LOG_POLL_MS);
    return () => {
      clearInterval(statusInterval);
      clearInterval(logsInterval);
    };
  }, [refreshLogs, refreshStatus]);

  useEffect(() => {
    if (!logsRef.current) return;
    logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [logText]);

  const startDetection = async () => {
    setIsBusy(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/detection/start`, { method: "POST" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.detail || "Failed to start detection.");
      }
      setMessage("Detection started.");
      await refreshStatus();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to start detection.");
    } finally {
      setIsBusy(false);
    }
  };

  const stopDetection = async () => {
    setIsBusy(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/detection/stop`, { method: "POST" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.detail || "Failed to stop detection.");
      }
      setMessage("Detection stopped.");
      await refreshStatus();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to stop detection.");
    } finally {
      setIsBusy(false);
    }
  };

  const openFrontendInBrowser = async () => {
    const frontendUrl = `${API_BASE_URL}/#/`;
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

  const statusBadge = useMemo(
    () =>
      backendOnline ? (
        <div className="inline-flex items-center gap-2 text-emerald-300 text-sm">
          <CheckCircle2 className="h-4 w-4" />
          Backend online
        </div>
      ) : (
        <div className="inline-flex items-center gap-2 text-red-300 text-sm">
          <WifiOff className="h-4 w-4" />
          Backend offline
        </div>
      ),
    [backendOnline]
  );

  const dartCount = detectionStatus?.dart_count ?? 0;
  const latestScore = dartCount > 0 ? detectionScores[dartCount - 1] : null;
  const latestScoreValue =
    latestScore && typeof latestScore.score === "number" ? latestScore.score : null;
  const turnTotal = detectionScores.reduce(
    (sum, entry) => sum + (typeof entry?.score === "number" ? entry.score : 0),
    0
  );

  return (
    <div className="min-h-screen w-full bg-slate-950 text-white">
      <header className="px-6 md:px-10 py-5 flex items-center justify-between border-b border-white/10">
        <Logo />
        <div className="flex items-center gap-2">
          <Link
            to="/console"
            className="px-3 py-2 rounded-md text-sm bg-cyan-500 text-slate-950 font-semibold"
          >
            Console
          </Link>
          <Link
            to="/backend-calibrate"
            className="px-3 py-2 rounded-md text-sm border border-white/20 hover:border-cyan-400"
          >
            Calibrate
          </Link>
          <Link
            to="/backend-settings"
            className="px-3 py-2 rounded-md text-sm border border-white/20 hover:border-cyan-400"
          >
            Settings
          </Link>
        </div>
      </header>

      <main className="px-6 md:px-10 py-6">
        <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-5">
          <section className="rounded-xl border border-white/10 bg-black/30 p-4 space-y-4">
            <h1 className="text-xl font-semibold">Console</h1>
            {statusBadge}
            <div className="text-xs text-zinc-400">
              State: <span className="text-zinc-200">{detectionState}</span>
            </div>
            <div className="text-xs text-zinc-400">
              Init: <span className="text-zinc-200">{initStep}</span>
            </div>
            {/* Dart score boxes */}
            <div className="grid grid-cols-3 gap-2">
              {[0, 1, 2].map((i) => {
                const entry = detectionScores[i];
                const scored = entry != null && typeof entry.score === "number";
                const scoreVal = scored ? entry.score : null;
                const seg = entry?.segment;
                const mul = entry?.multiplier ?? 1;
                const label = scored && seg != null
                  ? (mul === 3 ? `T${seg}` : mul === 2 ? `D${seg}` : `${seg}`)
                  : null;
                return (
                  <div
                    key={i}
                    className={`rounded-lg border p-2 text-center transition-colors ${
                      scored
                        ? "border-cyan-500/50 bg-cyan-950/40"
                        : "border-white/10 bg-white/5"
                    }`}
                  >
                    <div className="text-[10px] text-zinc-500 mb-1">D{i + 1}</div>
                    <div className={`text-xl font-bold tabular-nums ${scored ? "text-white" : "text-zinc-600"}`}>
                      {scoreVal !== null ? scoreVal : "--"}
                    </div>
                    <div className="text-[10px] text-zinc-500 mt-0.5 h-3">
                      {label ?? ""}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="text-xs text-zinc-400 text-center">
              Turn total: <span className="text-zinc-200 font-semibold">{turnTotal}</span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={startDetection}
                disabled={isBusy || detectionActive || !backendOnline}
                className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold disabled:opacity-50"
              >
                <span className="inline-flex items-center gap-1.5">
                  <Play className="h-4 w-4" />
                  Start
                </span>
              </button>
              <button
                onClick={stopDetection}
                disabled={isBusy || !detectionActive || !backendOnline}
                className="rounded-lg bg-slate-700 px-3 py-2 text-sm font-semibold disabled:opacity-50"
              >
                <span className="inline-flex items-center gap-1.5">
                  <Pause className="h-4 w-4" />
                  Stop
                </span>
              </button>
              <button
                onClick={openFrontendInBrowser}
                className="col-span-2 rounded-lg bg-cyan-600 px-3 py-2 text-sm font-semibold hover:bg-cyan-500"
              >
                <span className="inline-flex items-center gap-1.5">
                  <Play className="h-4 w-4" />
                  Play (Open Browser)
                </span>
              </button>
              <button
                onClick={refreshAll}
                className="col-span-2 rounded-lg border border-white/20 px-3 py-2 text-sm hover:border-cyan-400"
              >
                <span className="inline-flex items-center gap-1.5">
                  <RefreshCw className="h-4 w-4" />
                  Refresh
                </span>
              </button>
            </div>

            {message ? <div className="text-sm text-amber-300">{message}</div> : null}
            <div className="text-xs text-zinc-500 break-all">
              Frontend URL: <span className="text-zinc-300">http://localhost:8000</span>
            </div>
          </section>

          <section className="rounded-xl border border-white/10 bg-black/30 p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold">Backend Logs</h2>
              <div className="text-xs text-zinc-500">{logFile ? `File: ${logFile}` : "No log file"}</div>
            </div>
            <pre
              ref={logsRef}
              className="h-[68vh] overflow-auto rounded-lg bg-black border border-white/10 p-3 text-xs text-zinc-200 whitespace-pre-wrap"
            >
              {logText || "No logs yet..."}
            </pre>
          </section>
        </div>
      </main>
    </div>
  );
}
