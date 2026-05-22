import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, RotateCcw, Save } from "lucide-react";
import Logo from "../components/Logo";

const API_BASE = "http://localhost:8000";

type DetectionSettings = {
  movement_threshold: number;
  diff_threshold: number;
  remove_darts_start: number;
  remove_darts_finish: number;
  dart_detection_cooldown_ms: number;
};

const DEFAULTS: DetectionSettings = {
  movement_threshold: 0.001,
  diff_threshold: 0.25,
  remove_darts_start: 0.02,
  remove_darts_finish: 0.3,
  dart_detection_cooldown_ms: 350,
};

function asNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export default function DetectionSettingsPage() {
  const [settings, setSettings] = useState<DetectionSettings>(DEFAULTS);
  const [insights, setInsights] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSettings = async () => {
    const res = await fetch(`${API_BASE}/api/settings/detection`);
    if (!res.ok) throw new Error(`Failed to load settings (${res.status})`);
    const payload = await res.json();
    if (payload?.settings) setSettings((p) => ({ ...p, ...payload.settings }));
  };

  const loadInsights = async () => {
    const res = await fetch(`${API_BASE}/api/settings/detection/insights`);
    if (!res.ok) return;
    const payload = await res.json();
    if (payload?.insights) setInsights(payload.insights);
  };

  useEffect(() => {
    loadSettings().catch((e) => setError(e instanceof Error ? e.message : "Failed to load."));
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async () => { try { await loadInsights(); } catch { /* keep polling */ } };
    tick();
    const id = setInterval(() => { if (alive) tick(); }, 700);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const save = async () => {
    setSaving(true); setMessage(null); setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/settings/detection`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((payload as any)?.detail || `Save failed (${res.status})`);
      if (payload?.settings) setSettings((p) => ({ ...p, ...payload.settings }));
      setMessage("Settings saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true); setMessage(null); setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/settings/detection/reset`, { method: "POST" });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((payload as any)?.detail || `Reset failed (${res.status})`);
      if (payload?.settings) setSettings((p) => ({ ...p, ...payload.settings }));
      setMessage("Settings reset to defaults.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reset failed.");
    } finally {
      setSaving(false);
    }
  };

  // Slider + live bar meter pair — same pattern as the other app
  const slider = (
    label: string,
    key: keyof DetectionSettings,
    min: number,
    max: number,
    step: number,
    digits = 3
  ) => (
    <div className="mb-5">
      <div className="flex items-center justify-between text-sm mb-2">
        <span>{label}</span>
        <span className="text-zinc-400">{Number(settings[key]).toFixed(digits)}</span>
      </div>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={settings[key] as number}
        onChange={(e) => setSettings((p) => ({ ...p, [key]: Number(e.target.value) }))}
        className="w-full"
      />
    </div>
  );

  const barMeter = (
    label: string,
    valueRaw: unknown,
    thresholdRaw: unknown,
    min: number,
    max: number,
    digits = 4,
    warningThresholdRaw?: unknown
  ) => {
    const value = asNum(valueRaw);
    const threshold = asNum(thresholdRaw);
    const warningThreshold = asNum(warningThresholdRaw);
    const range = Math.max(0.000001, max - min);
    const clampPct = (n: number) => Math.max(0, Math.min(100, ((n - min) / range) * 100));
    const fillPct = value == null ? 0 : clampPct(value);
    const thresholdPct = threshold == null ? null : clampPct(threshold);
    const warningPct = warningThreshold == null ? null : clampPct(warningThreshold);
    const over = value != null && threshold != null && value >= threshold;
    const overWarning = value != null && warningThreshold != null && value >= warningThreshold;

    return (
      <div className="mb-4">
        <div className="flex items-center justify-between text-xs mb-1">
          <span>{label}</span>
          <span className={overWarning ? "text-red-300" : over ? "text-amber-300" : "text-zinc-400"}>
            {value == null ? "-" : value.toFixed(digits)}
          </span>
        </div>
        <div className="relative h-6 rounded bg-zinc-900 border border-zinc-600 overflow-hidden">
          <div
            className={`h-full transition-all ${overWarning ? "bg-red-500" : "bg-emerald-500"}`}
            style={{ width: `${fillPct}%` }}
          />
          {thresholdPct != null && (
            <div
              className="absolute top-0 bottom-0 w-[4px] bg-rose-300 shadow-[0_0_8px_rgba(251,113,133,0.8)]"
              style={{ left: `${thresholdPct}%` }}
              title={`Threshold: ${threshold?.toFixed(digits)}`}
            />
          )}
          {warningPct != null && (
            <div
              className="absolute top-0 bottom-0 w-[4px] bg-amber-200 shadow-[0_0_8px_rgba(253,230,138,0.8)]"
              style={{ left: `${warningPct}%` }}
              title={`Warning: ${warningThreshold?.toFixed(digits)}`}
            />
          )}
        </div>
        <div className="flex items-center justify-between text-[10px] text-zinc-500 mt-1">
          <span>{min.toFixed(digits)}</span>
          <span>thr {threshold == null ? "-" : threshold.toFixed(digits)}</span>
          <span>{max.toFixed(digits)}</span>
        </div>
      </div>
    );
  };

  // Throw Engine section values
  const detectorStateRaw = String(insights?.current_state ?? "init");
  const stateLabels: Record<string, string> = {
    init: "Warmup",
    no_movement: "Board Stable",
    movement: "Motion Detected",
    removing_darts: "Takeout In Progress",
    partial_takeout: "Partial Takeout",
  };
  const stateText = stateLabels[detectorStateRaw] ?? detectorStateRaw;
  const sceneChange = asNum(insights?.color_change_value) ?? 0;
  const fpsValue = asNum(insights?.fps);
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

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden">
      <div className="pointer-events-none fixed inset-0 [background:radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95)_30%,rgba(255,255,255,0.04)_60%,rgba(0,0,0,1)_100%)]" />
      <header className="relative z-10 w-full px-6 md:px-10 py-6 flex items-center justify-between">
        <Logo />
        <Link
          to="/backend-settings"
          className="inline-flex items-center gap-2 rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-xs hover:bg-white/10 transition"
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>
      </header>

      <main className="relative z-10 w-full px-6 md:px-10 pb-10 max-w-6xl mx-auto space-y-4">
        {error && <div className="text-sm text-red-300">{error}</div>}
        {message && <div className="text-sm text-emerald-300">{message}</div>}

        {/* Detection Settings */}
        <section className="rounded-xl border border-white/10 bg-white/5 p-5">
          <h1 className="text-2xl font-bold mb-4">Detection Settings</h1>

          {slider("Pixel Difference Sensitivity", "diff_threshold", 0.01, 0.5, 0.01, 2)}
          {barMeter(
            "Live Scene Change",
            insights?.color_change_value,
            0.0,
            -settings.movement_threshold,
            settings.movement_threshold,
            4,
            0.0005
          )}

          {slider("Motion Start Threshold", "movement_threshold", 0.0001, 0.01, 0.0001, 4)}
          {barMeter("Live Motion Value", insights?.start_detect_dart_value, settings.movement_threshold, 0.0, 0.03, 4)}

          {slider("Takeout Start Threshold", "remove_darts_start", 0.001, 0.2, 0.001, 3)}
          {barMeter(
            "Takeout Start Value",
            insights?.start_remove_darts_value,
            settings.remove_darts_start,
            0.0,
            Math.max(0.1, settings.remove_darts_start * 1.25),
            4
          )}

          {slider("Takeout Confirm Threshold", "remove_darts_finish", 0.05, 1.0, 0.01, 2)}
          {barMeter("Takeout Confirm Value", insights?.finish_remove_darts_value, settings.remove_darts_finish, 0.0, 1.0, 3)}

          {slider("Detection Cooldown (ms)", "dart_detection_cooldown_ms", 0, 2000, 10, 0)}

          <div className="flex items-center gap-2 mt-4">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold hover:bg-cyan-500 disabled:opacity-60"
            >
              <Save className="h-4 w-4" />
              {saving ? "Saving..." : "Save Settings"}
            </button>
            <button
              type="button"
              onClick={reset}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg border border-white/20 bg-white/5 px-4 py-2 text-sm hover:bg-white/10 transition"
            >
              <RotateCcw className="h-4 w-4" /> Reset
            </button>
          </div>
        </section>

        {/* Throw Engine */}
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
                className={`h-full ${stabilityScore >= 80 ? "bg-emerald-500" : stabilityScore >= 60 ? "bg-amber-500" : "bg-red-500"}`}
                style={{ width: `${stabilityScore}%` }}
              />
            </div>
          </div>

          <div className="text-sm space-y-3">
            <div>Last Detection Event: <span className="text-zinc-300">{String(insights?.result_of_last_detection ?? "-")}</span></div>
            <div>Engine State: <span className="text-zinc-300">{String(insights?.current_state ?? "-")}</span></div>
            <div>Darts On Board: <span className="text-zinc-300">{String(insights?.darts_on_board ?? "-")}</span></div>
            <div>Process Time: <span className="text-zinc-300">{String(insights?.process_images_duration_ms ?? "-")} ms</span></div>
            <div>FPS: <span className="text-zinc-300">{String(insights?.fps ?? "-")}</span></div>
          </div>
        </section>
      </main>
    </div>
  );
}
