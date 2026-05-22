import React from "react";
import { RotateCcw } from "lucide-react";
import BackendTopNav from "../components/BackendTopNav";
import { onDetectionOpen, subscribeDetection } from "../game/services/detectionSocket";
import {
  getDetectionInsights,
  getDetectionSettings,
  resetDetectionSettings,
  setDetectionPageActive,
  updateDetectionSettings,
} from "../services/api";

type DetectionSettings = {
  movement_threshold: number;
  dart_detection_gate_threshold: number;
  diff_threshold: number;
  remove_darts_start: number;
  remove_darts_finish: number;
  direct_takeout_threshold: number;
  remove_darts_min_foreground: number;
  dart_detection_cooldown_ms: number;
};

type SliderScale = "linear" | "log";

const emptySettings: DetectionSettings = {
  movement_threshold: 0.001,
  dart_detection_gate_threshold: 0.001,
  diff_threshold: 0.15,
  remove_darts_start: 0.02,
  remove_darts_finish: 0.3,
  direct_takeout_threshold: 0.8,
  remove_darts_min_foreground: 200,
  dart_detection_cooldown_ms: 350,
};

export default function DetectionSettingsPage() {
  const [settings, setSettings] = React.useState<DetectionSettings>(emptySettings);
  const [insights, setInsights] = React.useState<any>(null);
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    const s = await getDetectionSettings();
    setSettings({ ...emptySettings, ...(s.settings ?? {}) });
  }, []);

  React.useEffect(() => {
    load().catch(console.error);
  }, [load]);

  React.useEffect(() => {
    let closed = false;
    void setDetectionPageActive(true).catch(() => {});
    let inFlight = false;
    let eventRefreshTimer: number | null = null;
    let fallbackPollTimer: number | null = null;

    const EVENT_REFRESH_DEBOUNCE_MS = 700;
    // Fast polling while this page is open so threshold meters behave like a live monitor.
    const VISIBLE_POLL_MS = 300;
    const HIDDEN_POLL_MS = 1500;

    const refreshInsights = async () => {
      if (closed || inFlight) return;
      inFlight = true;
      try {
        const payload = await getDetectionInsights();
        if (!closed) {
          setInsights(payload.insights ?? null);
        }
      } catch {
        // Keep last rendered values if refresh fails.
      } finally {
        inFlight = false;
      }
    };

    const queueEventRefresh = () => {
      if (closed) return;
      if (eventRefreshTimer) {
        window.clearTimeout(eventRefreshTimer);
      }
      eventRefreshTimer = window.setTimeout(async () => {
        await refreshInsights();
      }, EVENT_REFRESH_DEBOUNCE_MS);
    };

    const scheduleFallbackPoll = () => {
      if (closed) return;
      if (fallbackPollTimer) {
        window.clearTimeout(fallbackPollTimer);
      }
      const delay = document.visibilityState === "visible" ? VISIBLE_POLL_MS : HIDDEN_POLL_MS;
      fallbackPollTimer = window.setTimeout(async () => {
        await refreshInsights();
        scheduleFallbackPoll();
      }, delay);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshInsights();
      }
      scheduleFallbackPoll();
    };

    const unsubscribeDetection = subscribeDetection(() => {
      queueEventRefresh();
    });
    const unsubscribeOpen = onDetectionOpen(() => {
      queueEventRefresh();
    });

    void refreshInsights();
    scheduleFallbackPoll();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      closed = true;
      void setDetectionPageActive(false).catch(() => {});
      if (eventRefreshTimer) {
        window.clearTimeout(eventRefreshTimer);
      }
      if (fallbackPollTimer) {
        window.clearTimeout(fallbackPollTimer);
      }
      unsubscribeDetection();
      unsubscribeOpen();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await updateDetectionSettings(settings as unknown as Record<string, unknown>);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    try {
      const r = await resetDetectionSettings();
      setSettings(r.settings);
    } finally {
      setSaving(false);
    }
  };

  const clampNumber = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

  const countStepDecimals = (step: number) => {
    const raw = String(step).toLowerCase();
    if (raw.includes("e-")) {
      const exp = Number(raw.split("e-")[1] ?? "0");
      return Number.isFinite(exp) ? exp : 0;
    }
    const fraction = raw.split(".")[1];
    return fraction ? fraction.length : 0;
  };

  const slider = (
    label: string,
    key: keyof DetectionSettings,
    min: number,
    max: number,
    step: number,
    digits = 3,
    className = "mb-5",
    scale: SliderScale = "linear",
  ) => {
    const currentValue = clampNumber(Number(settings[key] ?? min), min, max);
    const useLogScale = scale === "log" && min > 0 && max > min;
    const stepDecimals = countStepDecimals(step);
    const logMin = useLogScale ? Math.log(min) : 0;
    const logRange = useLogScale ? Math.log(max) - logMin : 0;
    const inputMin = useLogScale ? 0 : min;
    const inputMax = useLogScale ? 1000 : max;
    const inputStep = useLogScale ? 1 : step;
    const sliderValue = useLogScale
      ? ((Math.log(currentValue) - logMin) / logRange) * 1000
      : currentValue;

    const handleChange = (rawValue: string) => {
      const nextRaw = Number(rawValue);
      const nextValue = useLogScale
        ? Math.exp(logMin + (clampNumber(nextRaw, 0, 1000) / 1000) * logRange)
        : nextRaw;
      const rounded = Number(clampNumber(nextValue, min, max).toFixed(stepDecimals));
      setSettings((prev) => ({ ...prev, [key]: rounded }));
    };

    return (
      <div className={className}>
        <div className="flex items-center justify-between text-sm mb-2">
          <span>{label}</span>
          <span className="text-zinc-400">{currentValue.toFixed(digits)}</span>
        </div>
        <input
          type="range"
          min={inputMin}
          max={inputMax}
          step={inputStep}
          value={sliderValue}
          onChange={(e) => handleChange(e.target.value)}
          className="w-full"
        />
      </div>
    );
  };

  const asNumber = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return null;
  };

  const barMeter = (
    label: string,
    valueRaw: unknown,
    thresholdRaw: unknown,
    min: number,
    max: number,
    digits = 4,
    warningThresholdRaw?: unknown,
    idealRaw?: unknown,
    idealLabel = "ideal",
    idealZoneMaxRaw?: unknown,
    idealZoneLabel = "good idle",
    helperDigits?: number,
    footerNote?: React.ReactNode,
    thresholdLabel = "thr",
    showThreshold = true,
    className = "mb-4",
  ) => {
    const value = asNumber(valueRaw);
    const threshold = asNumber(thresholdRaw);
    const warningThreshold = asNumber(warningThresholdRaw);
    const ideal = asNumber(idealRaw);
    const idealZoneMax = asNumber(idealZoneMaxRaw);
    const helperPrecision = Number.isFinite(helperDigits) ? Number(helperDigits) : digits;
    const range = max - min;
    const clampPct = (n: number) => Math.max(0, Math.min(100, ((n - min) / range) * 100));
    const fillPct = value == null ? 0 : clampPct(value);
    const thresholdPct = threshold == null ? null : clampPct(threshold);
    const warningPct = warningThreshold == null ? null : clampPct(warningThreshold);
    const idealPct = ideal == null ? null : clampPct(ideal);
    const idealZonePct = idealZoneMax == null ? null : clampPct(idealZoneMax);
    const over = value != null && threshold != null && value >= threshold;
    const overWarning = value != null && warningThreshold != null && value >= warningThreshold;
    const markerLabelStyle = (pct: number): React.CSSProperties => {
      if (pct <= 4) {
        return { left: "0%", transform: "translateX(0)" };
      }
      if (pct >= 96) {
        return { left: "100%", transform: "translateX(-100%)" };
      }
      return { left: `${pct}%`, transform: "translateX(-50%)" };
    };

    return (
      <div className={className}>
        <div className="flex items-center justify-between text-xs mb-1">
          <span>{label}</span>
          <span className={overWarning ? "text-red-300" : over ? "text-amber-300" : "text-zinc-400"}>
            {value == null ? "-" : value.toFixed(digits)}
          </span>
        </div>
        <div className="relative h-6 rounded bg-zinc-900 border border-zinc-500 overflow-hidden">
          {idealZonePct != null && idealZonePct > 0 && (
            <div
              className="absolute top-0 bottom-0 left-0 border-r border-dashed border-cyan-300/80 bg-cyan-400/10"
              style={{ width: `${idealZonePct}%` }}
              title={`${idealZoneLabel}: ${min.toFixed(digits)} - ${idealZoneMax?.toFixed(digits)}`}
            />
          )}
          <div
            className={`h-full ${overWarning ? "bg-red-500" : "bg-emerald-500"}`}
            style={{ width: `${fillPct}%` }}
          />
          {showThreshold && thresholdPct != null && (
            <div
              className="absolute top-0 bottom-0 w-[4px] bg-rose-300 shadow-[0_0_8px_rgba(251,113,133,0.8)]"
              style={{ left: `${thresholdPct}%` }}
              title={`Threshold: ${threshold.toFixed(digits)}`}
            />
          )}
          {warningPct != null && (
            <div
              className="absolute top-0 bottom-0 w-[4px] bg-amber-200 shadow-[0_0_8px_rgba(253,230,138,0.8)]"
              style={{ left: `${warningPct}%` }}
              title={`Warning: ${warningThreshold?.toFixed(digits)}`}
            />
          )}
          {idealPct != null && (
            <div
              className="absolute top-0 bottom-0 w-[2px] bg-cyan-300 shadow-[0_0_8px_rgba(103,232,249,0.85)]"
              style={{ left: `${idealPct}%` }}
              title={`${idealLabel}: ${ideal.toFixed(digits)}`}
            />
          )}
        </div>
        <div className="flex items-center justify-between text-[10px] text-zinc-500 mt-1">
          <span>{min.toFixed(digits)}</span>
          <span>{max.toFixed(digits)}</span>
        </div>
        {showThreshold && thresholdPct != null && threshold != null && (
          <div className="relative h-4 text-[10px] text-zinc-500 mt-1">
            <span className="absolute whitespace-nowrap" style={markerLabelStyle(thresholdPct)}>
              {thresholdLabel} {threshold.toFixed(digits)}
            </span>
          </div>
        )}
        {(ideal != null || idealZoneMax != null) && (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
            {ideal != null && (
              <span className="text-cyan-300">
                {idealLabel} {ideal.toFixed(helperPrecision)}
              </span>
            )}
            {idealZoneMax != null && (
              <span className="text-cyan-200/90">
                {idealZoneLabel} {"<="} {idealZoneMax.toFixed(helperPrecision)}
              </span>
            )}
          </div>
        )}
        {footerNote != null && (
          <div className="mt-1 text-[11px]">
            {footerNote}
          </div>
        )}
      </div>
    );
  };

  const detectorStateRaw = String(insights?.current_state ?? "init");
  const detectorStateLabel: Record<string, string> = {
    init: "Warmup",
    no_movement: "Board Stable",
    movement: "Motion Detected",
    removing_darts: "Takeout In Progress",
    partial_takeout: "Partial Takeout",
  };
  const stateText = detectorStateLabel[detectorStateRaw] ?? detectorStateRaw;
  const sceneChange = asNumber(insights?.color_change_value) ?? 0;
  const fpsValue = asNumber(insights?.fps);
  const scenePenalty = Math.min(60, Math.round((sceneChange / 0.001) * 60));
  const fpsPenalty = fpsValue == null ? 15 : Math.min(40, Math.max(0, Math.round(Math.abs(30 - fpsValue) * 4)));
  const stabilityScore = Math.max(0, 100 - scenePenalty - fpsPenalty);
  const readinessLabel =
    detectorStateRaw === "removing_darts" || detectorStateRaw === "partial_takeout"
      ? "Takeout Window Open"
      : detectorStateRaw === "no_movement" && sceneChange <= 0.0005
        ? "Ready to Throw"
        : "Stabilizing";
  const readinessClass =
    readinessLabel === "Ready to Throw"
      ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
      : readinessLabel === "Takeout Window Open"
        ? "bg-amber-500/20 text-amber-200 border-amber-500/40"
        : "bg-zinc-800 text-zinc-300 border-zinc-600";
  const movementThresholdValue = Number(settings.movement_threshold || 0);
  const dartDetectionGateValue = Number(settings.dart_detection_gate_threshold || 0);
  const lastDartDetectValue = asNumber(insights?.start_detect_dart_value);
  const lastDartDetectScaleMax = Math.max(
    0.002,
    dartDetectionGateValue * 2.0,
    lastDartDetectValue != null ? lastDartDetectValue * 1.15 : 0,
  );
  const lastDartDetectDelta =
    lastDartDetectValue != null ? lastDartDetectValue - dartDetectionGateValue : null;
  const lastDartDetectRatio =
    lastDartDetectValue != null && dartDetectionGateValue > 0
      ? lastDartDetectValue / dartDetectionGateValue
      : null;
  const lastDartDetectNote =
    lastDartDetectValue == null
      ? <span className="text-zinc-500">Waiting for a dart-detect sample.</span>
      : lastDartDetectDelta != null && lastDartDetectDelta >= 0
        ? (
          <span className="text-emerald-300">
            Threshold met by +{lastDartDetectDelta.toFixed(6)}
            {lastDartDetectRatio != null ? ` (${lastDartDetectRatio.toFixed(1)}x thr)` : ""}
          </span>
        )
        : (
          <span className="text-amber-300">
            Below threshold by {Math.abs(lastDartDetectDelta ?? 0).toFixed(6)}
            {lastDartDetectRatio != null ? ` (${lastDartDetectRatio.toFixed(2)}x thr)` : ""}
          </span>
        );

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden">
      <div className="pointer-events-none fixed inset-0 [background:
        radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
        linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95)_30%,rgba(255,255,255,0.04)_60%,rgba(0,0,0,1)_100%)
      ]" />
      <BackendTopNav />
      <main className="relative z-10 w-full px-6 md:px-10 pb-10 max-w-6xl mx-auto space-y-4">
        <section className="rounded-xl border border-white/10 bg-white/5 p-5">
          <h1 className="text-2xl font-bold mb-4">Detection Settings</h1>
          {slider("Pixel Difference Sensitivity", "diff_threshold", 0.01, 0.5, 0.01, 2)}
          <div>
            {slider("Motion Start Threshold", "movement_threshold", 0.0001, 0.01, 0.0001, 4, "mb-2", "log")}
          </div>
          <div className="mb-3 text-[11px] text-zinc-500">
            Keep live idle motion inside the good idle zone.
          </div>
          {barMeter(
            "Live Motion / Idle Value",
            insights?.live_motion_value,
            settings.movement_threshold,
            0.0,
            Math.max(0.002, Number(settings.movement_threshold || 0) * 2.0),
            6,
            undefined,
            0.0,
            "ideal idle",
            Math.max(0.0, Number(settings.movement_threshold || 0) * 0.10),
            "good idle zone",
            4,
            <span className="text-zinc-500">Use the live motion bar to tune idle stability.</span>,
            "start thr",
            true,
            "mb-4",
          )}
          {slider("Dart Detection Gate", "dart_detection_gate_threshold", 0.0001, 0.01, 0.0001, 4, "mb-3", "log")}
          {barMeter(
            "Dart Detection Value",
            insights?.start_detect_dart_value,
            settings.dart_detection_gate_threshold,
            0.0,
            lastDartDetectScaleMax,
            6,
            undefined,
            undefined,
            "ideal",
            undefined,
            "good idle",
            undefined,
            undefined,
            "detect gate",
            true,
            "mb-2",
          )}
          <div className="-mt-3 mb-4 text-[11px]">
            {lastDartDetectNote}
          </div>

          {slider("Takeout Start Threshold", "remove_darts_start", 0.001, 0.2, 0.001, 3)}
          {barMeter(
            "Takeout Start Value",
            insights?.start_remove_darts_value,
            settings.remove_darts_start,
            0.0,
            Math.max(0.1, settings.remove_darts_start * 1.25),
            4,
          )}

          {slider("Takeout Confirm Threshold", "remove_darts_finish", 0.05, 1.0, 0.01, 2)}
          {barMeter("Takeout Confirm Value", insights?.finish_remove_darts_value, settings.remove_darts_finish, 0.0, 1.0, 3)}

          <div className="flex items-center gap-2 mt-4">
            <button onClick={save} disabled={saving} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold hover:bg-red-500 disabled:opacity-60">
              {saving ? "Saving..." : "Save Settings"}
            </button>
            <button onClick={reset} disabled={saving} className="inline-flex items-center gap-2 rounded-lg border border-white/20 bg-white/5 px-4 py-2 text-sm">
              <RotateCcw className="h-4 w-4" /> Reset
            </button>
          </div>
        </section>
        <section className="rounded-xl border border-white/10 bg-white/5 p-5">
          <h2 className="text-xl font-semibold mb-4">Throw Engine</h2>
          <div className="mb-4 flex items-center justify-between">
            <div className="text-sm">
              <div className="text-zinc-400">Live Status</div>
              <div className="text-base font-semibold">{stateText}</div>
            </div>
            <div className={`rounded-md border px-3 py-1 text-xs font-semibold ${readinessClass}`}>
              {readinessLabel}
            </div>
          </div>
          <div className="mb-4">
            <div className="flex items-center justify-between text-xs mb-1">
              <span>Stability Score</span>
              <span className="text-zinc-300">{stabilityScore}/100</span>
            </div>
            <div className="h-2 rounded bg-zinc-800 border border-zinc-700 overflow-hidden">
              <div
                className={`${stabilityScore >= 80 ? "bg-emerald-500" : stabilityScore >= 60 ? "bg-amber-500" : "bg-red-500"} h-full`}
                style={{ width: `${stabilityScore}%` }}
              />
            </div>
          </div>
          <div className="text-sm space-y-3">
            <div>Last Detection Event: <span className="text-zinc-300">{insights?.result_of_last_detection ?? "-"}</span></div>
            <div>Engine State Code: <span className="text-zinc-300">{insights?.current_state ?? "-"}</span></div>
            <div>Darts On Board: <span className="text-zinc-300">{insights?.darts_on_board ?? "-"}</span></div>
            <div>Process Images Duration: <span className="text-zinc-300">{insights?.process_images_duration_ms ?? "-"} ms</span></div>
            <div>FPS: <span className="text-zinc-300">{insights?.fps ?? "-"}</span></div>
          </div>
          <div className="mt-5 rounded-xl border border-white/10 bg-zinc-950/40 p-4 text-sm space-y-2">
            <div className="text-zinc-400">Last Tip Scoring Breakdown</div>
            <div>Preprocess: <span className="text-zinc-300">{insights?.last_tip_preprocess_ms ?? "-"} ms</span></div>
            <div>Inference: <span className="text-zinc-300">{insights?.last_tip_inference_ms ?? "-"} ms</span></div>
            <div>Decode: <span className="text-zinc-300">{insights?.last_tip_decode_ms ?? "-"} ms</span></div>
            <div>Selection: <span className="text-zinc-300">{insights?.last_tip_selection_ms ?? "-"} ms</span></div>
            <div>Calibration: <span className="text-zinc-300">{insights?.last_tip_calibration_ms ?? "-"} ms</span></div>
            <div>Vote/Postprocess: <span className="text-zinc-300">{insights?.last_tip_vote_ms ?? "-"} ms</span></div>
            <div>Total Score Frames: <span className="text-zinc-300">{insights?.last_tip_total_ms ?? insights?.last_tip_scoring_ms ?? "-"} ms</span></div>
          </div>
        </section>
      </main>
    </div>
  );
}
