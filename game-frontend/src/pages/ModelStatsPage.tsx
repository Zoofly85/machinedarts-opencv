import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, BarChart2, RefreshCw, Trash2 } from "lucide-react";
import Logo from "../components/Logo";
import ActionButton from "../components/ActionButton";
import { TIP_MODEL_LABELS, TIP_MODEL_ORDER } from "../constants/tipModels";

const API_BASE = "http://localhost:8000";

type ModelStats = {
  total_darts?: number;
  detected_darts?: number;
  no_detection?: number;
  three_cam_total?: number;
  three_cam_all_match?: number;
  three_cam_two_match?: number;
  three_cam_all_diff?: number;
  two_cam_total?: number;
  two_cam_match?: number;
  two_cam_disagree?: number;
  single_cam_total?: number;
};

type ModelStatsResponse = {
  models?: Record<string, ModelStats>;
};

const pct = (value: number, total: number) => {
  if (!total) return "0%";
  return `${((value / total) * 100).toFixed(0)}%`;
};

export default function ModelStatsPage() {
  const [stats, setStats] = useState<ModelStatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStats = async () => {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const resp = await fetch(`${API_BASE}/api/models/tip/stats`);
      const payload = await resp.json();
      if (!resp.ok) {
        throw new Error(payload?.detail || payload?.message || "Failed to load model stats.");
      }
      setStats(payload);
    } catch (err: any) {
      setError(err?.message || "Unable to load model stats.");
    } finally {
      setLoading(false);
    }
  };

  const resetStats = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`${API_BASE}/api/models/tip/stats/reset`, { method: "POST" });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(payload?.detail || payload?.message || "Failed to reset stats.");
      }
      setMessage("Model stats reset.");
      await loadStats();
    } catch (err: any) {
      setError(err?.message || "Failed to reset stats.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStats();
  }, []);

  const models = useMemo(() => stats?.models ?? {}, [stats]);
  const sortedEntries = useMemo(() => {
    return Object.entries(models).sort(([nameA], [nameB]) => {
      const idxA = TIP_MODEL_ORDER.indexOf(nameA);
      const idxB = TIP_MODEL_ORDER.indexOf(nameB);
      const rankA = idxA >= 0 ? idxA : Number.MAX_SAFE_INTEGER;
      const rankB = idxB >= 0 ? idxB : Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      return nameA.localeCompare(nameB);
    });
  }, [models]);

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden">
      <div className="pointer-events-none fixed inset-0 [background:
        radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
        radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.08),transparent_70%),
        radial-gradient(ellipse_at_bottom_left,rgba(255,255,255,0.06),transparent_70%),
        radial-gradient(ellipse_at_bottom_right,rgba(255,255,255,0.1),transparent_65%),
        linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95) 30%,rgba(255,255,255,0.04) 60%,rgba(0,0,0,1) 100%)
      ]" />

      <header className="relative z-10 w-full px-4 sm:px-6 md:px-10 py-4 flex items-center justify-between">
        <Logo />
        <ActionButton
          href="/settings/models"
          label="Back"
          aria="Return to settings"
          icon={<ArrowLeft className="h-5 w-5" />}
          className="bg-zinc-800 hover:bg-zinc-700 border-zinc-700 shadow-zinc-900/40 text-sm py-2 px-3"
        />
      </header>

      <main className="relative z-10 w-full px-4 sm:px-6 md:px-10 pb-10">
        <div className="flex items-center gap-3 mb-6">
          <BarChart2 className="h-7 w-7 text-red-400" />
          <h1 className="text-3xl sm:text-4xl font-bold">Model Stats</h1>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-500/50 bg-red-900/30 px-4 py-3 text-sm text-red-100">
            {error}
          </div>
        )}
        {message && (
          <div className="mb-4 rounded-lg border border-green-500/40 bg-green-900/30 px-4 py-3 text-sm text-green-100">
            {message}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 mb-6">
          <button
            type="button"
            onClick={loadStats}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs uppercase tracking-[0.2em] hover:bg-zinc-700 disabled:opacity-60"
          >
            <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            Refresh
          </button>
          <button
            type="button"
            onClick={resetStats}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-red-500/60 bg-red-900/20 px-3 py-2 text-xs uppercase tracking-[0.2em] text-red-200 hover:bg-red-900/40 disabled:opacity-60"
          >
            <Trash2 className="h-4 w-4" />
            Reset
          </button>
        </div>

        {loading ? (
          <div className="text-sm text-zinc-400">Loading model stats...</div>
        ) : sortedEntries.length === 0 ? (
          <div className="text-sm text-zinc-400">No model stats yet. Throw a few darts and refresh.</div>
        ) : (
          <div className="space-y-5">
            {sortedEntries.map(([name, entry]) => {
              const total = entry.total_darts ?? 0;
              const detected = entry.detected_darts ?? 0;
              const noDetection = entry.no_detection ?? 0;
              const threeTotal = entry.three_cam_total ?? 0;
              const threeAll = entry.three_cam_all_match ?? 0;
              const threeTwo = entry.three_cam_two_match ?? 0;
              const threeDiff = entry.three_cam_all_diff ?? 0;
              const twoTotal = entry.two_cam_total ?? 0;
              const twoMatch = entry.two_cam_match ?? 0;
              const twoDisagree = entry.two_cam_disagree ?? 0;
              const single = entry.single_cam_total ?? 0;

              return (
                <div key={name} className="rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="text-lg font-semibold">{TIP_MODEL_LABELS[name] ?? name}</div>
                  {TIP_MODEL_LABELS[name] && <div className="text-xs text-zinc-500 mt-0.5">{name}</div>}
                  <div className="text-xs text-zinc-400 mt-1">
                    Total darts: {total} • Detected: {detected} • No detection: {noDetection}
                  </div>

                  <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                      <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">3-cam accuracy</div>
                      <div className="text-xs text-zinc-400 mt-1">3-cam darts: {threeTotal}</div>
                      <div className="mt-2 space-y-1 text-sm">
                        <div className="flex items-center justify-between">
                          <span>3/3 match</span>
                          <span>{threeAll} ({pct(threeAll, threeTotal)})</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>2/3 match</span>
                          <span>{threeTwo} ({pct(threeTwo, threeTotal)})</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>All different</span>
                          <span>{threeDiff} ({pct(threeDiff, threeTotal)})</span>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                      <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">2-cam accuracy</div>
                      <div className="text-xs text-zinc-400 mt-1">2-cam darts: {twoTotal}</div>
                      <div className="mt-2 space-y-1 text-sm">
                        <div className="flex items-center justify-between">
                          <span>2/2 match</span>
                          <span>{twoMatch} ({pct(twoMatch, twoTotal)})</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>1/2 match</span>
                          <span>{twoDisagree} ({pct(twoDisagree, twoTotal)})</span>
                        </div>
                        <div className="flex items-center justify-between text-xs text-zinc-500 pt-2">
                          <span>Single cam only</span>
                          <span>{single}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
