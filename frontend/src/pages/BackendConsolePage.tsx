import React from "react";
import BackendTopNav from "../components/BackendTopNav";
import { API_BASE_URL } from "../services/api";
import { connectSystemStatus } from "../services/systemStatusSocket";
import { buildEventsWsUrl } from "../services/ws";

type DetectionStatusPayload = {
  initialization?: {
    is_ready?: boolean;
    current_step?: string;
    error?: string | null;
  };
};

type DetectionEvent = {
  seq?: number;
  at_ms?: number;
  type?: string;
  [key: string]: unknown;
};

export default function BackendConsolePage() {
  const [status, setStatus] = React.useState<DetectionStatusPayload | null>(null);
  const [insights, setInsights] = React.useState<any>(null);
  const [turnScores, setTurnScores] = React.useState<Array<number | null>>([null, null, null]);
  const [backendOnline, setBackendOnline] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [correctionDartIndex, setCorrectionDartIndex] = React.useState<number | null>(null);
  const [correctionMultiplier, setCorrectionMultiplier] = React.useState<number>(1);
  const [correctionSegment, setCorrectionSegment] = React.useState<number>(20);
  const [correctionSaving, setCorrectionSaving] = React.useState(false);
  const [correctionMessage, setCorrectionMessage] = React.useState<string | null>(null);
  const [playMessage, setPlayMessage] = React.useState<string | null>(null);
  const [shutdownPending, setShutdownPending] = React.useState(false);

  const gameplayUrl = React.useMemo(() => {
    const override = window.localStorage.getItem("machineDartsGameplayUrl");
    if (override && override.trim()) {
      return override.trim();
    }
    if (window.location.port === "5173") {
      return "http://127.0.0.1:5173/#/";
    }
    return `${API_BASE_URL}/#/`;
  }, []);

  React.useEffect(() => {
    const disconnect = connectSystemStatus(
      (payload) => {
        setStatus((payload.detection_status as DetectionStatusPayload | null) ?? null);
        setInsights(payload.insights ?? null);
        setBackendOnline(true);
        setError(null);
      },
      (state) => {
        if (state === "closed" || state === "error") {
          setBackendOnline(false);
          setError("Backend unavailable");
        }
      },
    );
    return disconnect;
  }, []);

  React.useEffect(() => {
    const ws = new WebSocket(buildEventsWsUrl());
    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as DetectionEvent;

        if (parsed.type === "state_changed") {
          setInsights((prev: any) => ({
            ...(prev ?? {}),
            current_state: parsed.to_state ?? prev?.current_state ?? "-",
            darts_on_board: parsed.darts_on_board ?? prev?.darts_on_board ?? 0,
          }));
          return;
        }

        if (parsed.type === "dart_detected") {
          setInsights((prev: any) => ({
            ...(prev ?? {}),
            result_of_last_detection: "dart_detected",
            darts_on_board: parsed.darts_on_board ?? prev?.darts_on_board ?? 0,
          }));
          return;
        }

        if (parsed.type === "takeout_complete") {
          setInsights((prev: any) => ({
            ...(prev ?? {}),
            result_of_last_detection: "takeout_complete",
            darts_on_board: 0,
            current_state: "no_movement",
          }));
          setTurnScores([null, null, null]);
          return;
        }

        if (parsed.type === "dart_score") {
          const scoreValueRaw = parsed.score_value;
          const scoreValue =
            typeof scoreValueRaw === "number"
              ? scoreValueRaw
              : typeof scoreValueRaw === "string"
                ? Number(scoreValueRaw)
                : NaN;
          if (!Number.isFinite(scoreValue)) {
            return;
          }

          const totalMsRaw = parsed.total_ms;
          const totalMs =
            typeof totalMsRaw === "number"
              ? totalMsRaw
              : typeof totalMsRaw === "string"
                ? Number(totalMsRaw)
                : NaN;
          const procMsRaw = parsed.processing_ms;
          const procMs =
            typeof procMsRaw === "number"
              ? procMsRaw
              : typeof procMsRaw === "string"
                ? Number(procMsRaw)
                : NaN;

          const timings =
            parsed.timings && typeof parsed.timings === "object"
              ? (parsed.timings as Record<string, unknown>)
              : null;
          setInsights((prev: any) => ({
            ...(prev ?? {}),
            result_of_last_detection: "dart_score",
            last_voted_score: scoreValue,
            last_tip_scoring_ms: Number.isFinite(procMs) ? procMs : prev?.last_tip_scoring_ms,
            last_tip_preprocess_ms: timings?.preprocess_ms ?? prev?.last_tip_preprocess_ms,
            last_tip_inference_ms: timings?.inference_ms ?? prev?.last_tip_inference_ms,
            last_tip_decode_ms: timings?.decode_ms ?? prev?.last_tip_decode_ms,
            last_tip_selection_ms: timings?.selection_ms ?? prev?.last_tip_selection_ms,
            last_tip_calibration_ms: timings?.calibration_ms ?? prev?.last_tip_calibration_ms,
            last_tip_vote_ms: timings?.vote_ms ?? prev?.last_tip_vote_ms,
            last_tip_total_ms: timings?.total_ms ?? prev?.last_tip_total_ms,
          }));

          setTurnScores((prev) => {
            const next = [...prev];
            const emptyIndex = next.findIndex((v) => v === null);
            if (emptyIndex >= 0) {
              next[emptyIndex] = scoreValue;
            }
            return next;
          });
          return;
        }

        if (parsed.type === "dart_score_unavailable") {
          const procMsRaw = parsed.processing_ms;
          const procMs =
            typeof procMsRaw === "number"
              ? procMsRaw
              : typeof procMsRaw === "string"
                ? Number(procMsRaw)
                : NaN;
          const timings =
            parsed.timings && typeof parsed.timings === "object"
              ? (parsed.timings as Record<string, unknown>)
              : null;
          setInsights((prev: any) => ({
            ...(prev ?? {}),
            result_of_last_detection: "dart_score_unavailable",
            last_tip_scoring_ms: Number.isFinite(procMs) ? procMs : prev?.last_tip_scoring_ms,
            last_tip_preprocess_ms: timings?.preprocess_ms ?? prev?.last_tip_preprocess_ms,
            last_tip_inference_ms: timings?.inference_ms ?? prev?.last_tip_inference_ms,
            last_tip_decode_ms: timings?.decode_ms ?? prev?.last_tip_decode_ms,
            last_tip_selection_ms: timings?.selection_ms ?? prev?.last_tip_selection_ms,
            last_tip_calibration_ms: timings?.calibration_ms ?? prev?.last_tip_calibration_ms,
            last_tip_vote_ms: timings?.vote_ms ?? prev?.last_tip_vote_ms,
            last_tip_total_ms: timings?.total_ms ?? prev?.last_tip_total_ms,
          }));
          return;
        }

        if (parsed.type === "dart_score_corrected") {
          const dartIndexRaw = parsed.dart_index;
          const correctedRaw = parsed.corrected_score_value;
          const dartIndex =
            typeof dartIndexRaw === "number"
              ? dartIndexRaw
              : typeof dartIndexRaw === "string"
                ? Number(dartIndexRaw)
                : NaN;
          const correctedScore =
            typeof correctedRaw === "number"
              ? correctedRaw
              : typeof correctedRaw === "string"
                ? Number(correctedRaw)
                : NaN;
          if (Number.isInteger(dartIndex) && dartIndex >= 0 && dartIndex < 3 && Number.isFinite(correctedScore)) {
            setTurnScores((prev) => {
              const next = [...prev];
              next[dartIndex] = correctedScore;
              return next;
            });
          }
          setInsights((prev: any) => ({
            ...(prev ?? {}),
            result_of_last_detection: "dart_score_corrected",
          }));
        }
      } catch {
        // Ignore malformed events.
      }
    };
    return () => ws.close();
  }, []);

  const readiness = status?.initialization?.is_ready ? "Ready" : "Initializing";
  const fps = insights?.fps ?? "-";
  const state = insights?.current_state ?? "-";
  const darts = insights?.darts_on_board ?? "-";
  const turnTotal = turnScores.reduce((sum, value) => sum + (value ?? 0), 0);

  const openCorrection = (idx: number) => {
    setCorrectionDartIndex(idx);
    setCorrectionMessage(null);
    const original = turnScores[idx];
    if (original === 50) {
      setCorrectionSegment(25);
      setCorrectionMultiplier(2);
    } else if (original === 25) {
      setCorrectionSegment(25);
      setCorrectionMultiplier(1);
    } else if (original != null && original > 0 && original <= 20) {
      setCorrectionSegment(original);
      setCorrectionMultiplier(1);
    } else {
      setCorrectionSegment(20);
      setCorrectionMultiplier(1);
    }
  };

  const closeCorrection = () => {
    if (correctionSaving) return;
    setCorrectionDartIndex(null);
  };

  const finalCorrectionScore =
    correctionMultiplier === 0
      ? 0
      : correctionSegment === 25
        ? correctionMultiplier === 2
          ? 50
          : 25
        : correctionSegment * correctionMultiplier;

  const saveCorrection = async () => {
    if (correctionDartIndex == null) return;
    setCorrectionSaving(true);
    setCorrectionMessage(null);
    try {
      const resp = await fetch(`${API_BASE_URL}/api/correction/score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dartIndex: correctionDartIndex,
          multiplier: correctionMultiplier,
          segment: correctionSegment,
          score: finalCorrectionScore,
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(data?.detail || data?.message || `Correction failed (${resp.status})`);
      }
      setTurnScores((prev) => {
        const next = [...prev];
        next[correctionDartIndex] = finalCorrectionScore;
        return next;
      });
      const saved = Number(data?.training_data?.saved_images ?? 0);
      setCorrectionMessage(`Correction saved. Training images saved: ${saved}`);
      setCorrectionDartIndex(null);
    } catch (err) {
      setCorrectionMessage(err instanceof Error ? err.message : "Failed to save correction");
    } finally {
      setCorrectionSaving(false);
    }
  };

  const openGameplayFrontend = async () => {
    setPlayMessage(null);
    const popup = window.open(gameplayUrl, "_blank", "noopener,noreferrer");
    if (!popup) {
      setPlayMessage(`Could not open browser automatically. Open: ${gameplayUrl}`);
    }
  };

  const stopBackend = async () => {
    setError(null);
    setPlayMessage(null);
    setShutdownPending(true);
    try {
      const resp = await fetch(`${API_BASE_URL}/api/shutdown`, { method: "POST" });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(data?.detail || data?.message || `Shutdown failed (${resp.status})`);
      }
      setBackendOnline(false);
      setPlayMessage("Backend shutting down. Cameras will be released in a moment.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to stop backend");
      setShutdownPending(false);
    }
  };

  return (
    <div className="min-h-screen w-full bg-slate-950 text-white">
      <BackendTopNav />
      <main className="px-4 sm:px-6 md:px-10 py-6">
        <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-5">
          <section className="rounded-xl border border-white/10 bg-black/30 p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h1 className="text-xl font-semibold">Backend Console</h1>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={openGameplayFrontend}
                  className="rounded-lg bg-cyan-500 text-slate-950 px-3 py-2 text-sm font-semibold hover:bg-cyan-400"
                >
                  Play
                </button>
                <button
                  type="button"
                  onClick={stopBackend}
                  disabled={shutdownPending}
                  className="rounded-lg border border-red-400/60 text-red-200 px-3 py-2 text-sm font-semibold hover:bg-red-500/10 disabled:opacity-60"
                >
                  {shutdownPending ? "Stopping..." : "Stop Backend"}
                </button>
              </div>
            </div>
            <div className="text-sm">
              Backend:{" "}
              <span className={backendOnline ? "text-emerald-300" : "text-red-300"}>
                {backendOnline ? "Online" : "Offline"}
              </span>
            </div>
            <div className="text-xs text-zinc-400">
              Gameplay frontend: <span className="text-zinc-300">{gameplayUrl}</span>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-lg border border-white/10 bg-zinc-900/40 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500">Readiness</div>
                <div className="text-zinc-100 font-medium">{readiness}</div>
              </div>
              <div className="rounded-lg border border-white/10 bg-zinc-900/40 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500">State</div>
                <div className="text-zinc-100 font-medium">{state}</div>
              </div>
              <div className="rounded-lg border border-white/10 bg-zinc-900/40 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500">FPS</div>
                <div className="text-zinc-100 font-medium">{fps}</div>
              </div>
              <div className="rounded-lg border border-white/10 bg-zinc-900/40 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500">Darts On Board</div>
                <div className="text-zinc-100 font-medium">{darts}</div>
              </div>
            </div>
            <div className="pt-2">
              <div className="text-xs text-zinc-400 mb-2">Current Turn Scores</div>
              <div className="grid grid-cols-3 gap-2">
                {turnScores.map((score, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => openCorrection(idx)}
                    className="rounded-lg border border-white/10 bg-zinc-900/60 px-2 py-3 text-center hover:border-cyan-400 transition-colors"
                  >
                    <div className="text-[10px] text-zinc-500 mb-1">Dart {idx + 1}</div>
                    <div className="text-lg font-semibold text-zinc-100">{score ?? "-"}</div>
                  </button>
                ))}
              </div>
              <div className="text-xs text-zinc-400 mt-2">
                Turn total: <span className="text-zinc-200">{turnTotal}</span>
              </div>
            </div>
            {correctionMessage ? <div className="text-xs text-amber-300 break-all">{correctionMessage}</div> : null}
            {playMessage ? <div className="text-xs text-amber-300 break-all">{playMessage}</div> : null}
            {error ? <div className="text-xs text-red-300 break-all">{error}</div> : null}
          </section>
        </div>
      </main>

      {correctionDartIndex != null ? (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl border border-white/20 bg-zinc-900 p-5">
            <h2 className="text-lg font-semibold mb-1">Correct Dart {correctionDartIndex + 1}</h2>
            <p className="text-xs text-zinc-400 mb-4">Choose multiplier and segment, then save correction.</p>

            <div className="mb-4">
              <div className="text-xs text-zinc-400 mb-2">Multiplier</div>
              <div className="grid grid-cols-4 gap-2">
                {[0, 1, 2, 3].map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setCorrectionMultiplier(m)}
                    className={`rounded-lg px-2 py-2 text-sm border ${
                      correctionMultiplier === m
                        ? "bg-cyan-500 text-slate-950 border-cyan-400 font-semibold"
                        : "border-white/20 hover:border-cyan-400"
                    }`}
                  >
                    {m === 0 ? "Miss" : m === 1 ? "Single" : m === 2 ? "Double" : "Triple"}
                  </button>
                ))}
              </div>
            </div>

            <div className="mb-4">
              <div className="text-xs text-zinc-400 mb-2">Segment</div>
              <div className="grid grid-cols-7 gap-1 max-h-48 overflow-auto rounded border border-white/10 p-2">
                {[...Array(20)].map((_, i) => i + 1).concat([25]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setCorrectionSegment(s)}
                    className={`rounded px-2 py-1 text-xs border ${
                      correctionSegment === s
                        ? "bg-cyan-500 text-slate-950 border-cyan-400 font-semibold"
                        : "border-white/20 hover:border-cyan-400"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-white/10 bg-black/40 p-3 mb-4 text-sm">
              Final score: <span className="text-zinc-200 font-semibold">{finalCorrectionScore}</span>
            </div>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={closeCorrection}
                disabled={correctionSaving}
                className="rounded-lg border border-white/20 px-3 py-2 text-sm hover:border-cyan-400 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveCorrection}
                disabled={correctionSaving}
                className="rounded-lg bg-cyan-500 text-slate-950 px-3 py-2 text-sm font-semibold disabled:opacity-60"
              >
                {correctionSaving ? "Saving..." : "Save Correction"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
