import React from "react";
import BackendTopNav from "../components/BackendTopNav";
import { getModelAccuracyStats, getModelSettings, resetModelAccuracyStats } from "../services/api";
import { buildEventsWsUrl } from "../services/ws";

type ModelStatsRow = {
  model_id: string;
  total_darts: number;
  detected_darts: number;
  no_detection: number;
  corrected_darts: number;
  uncorrected_darts: number;
  accuracy_percent: number | null;
  avg_detection_to_score_ms: number | null;
  avg_inference_ms: number | null;
  avg_score_total_ms: number | null;
  avg_queue_wait_ms: number | null;
  avg_preprocess_ms: number | null;
  avg_decode_ms: number | null;
  avg_selection_ms: number | null;
  avg_calibration_ms: number | null;
  avg_vote_ms: number | null;
  three_cam_total: number;
  three_cam_all_match: number;
  three_cam_two_match: number;
  three_cam_all_diff: number;
  two_cam_total: number;
  two_cam_match: number;
  two_cam_disagree: number;
  single_cam_total: number;
  last_used_at_ms?: number | null;
};

type StatsPayload = {
  active_model_id: string;
  totals: {
    total_darts: number;
    detected_darts: number;
    no_detection: number;
    corrected_darts: number;
    uncorrected_darts: number;
    accuracy_percent: number | null;
    avg_detection_to_score_ms: number | null;
    avg_inference_ms: number | null;
    avg_score_total_ms: number | null;
    avg_queue_wait_ms: number | null;
    avg_preprocess_ms: number | null;
    avg_decode_ms: number | null;
    avg_selection_ms: number | null;
    avg_calibration_ms: number | null;
    avg_vote_ms: number | null;
    three_cam_total: number;
    three_cam_all_match: number;
    three_cam_two_match: number;
    three_cam_all_diff: number;
    two_cam_total: number;
    two_cam_match: number;
    two_cam_disagree: number;
    single_cam_total: number;
  };
  models: ModelStatsRow[];
};

export default function ModelStatsPage() {
  const [enabled, setEnabled] = React.useState<boolean | null>(null);
  const [stats, setStats] = React.useState<StatsPayload | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [resetting, setResetting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const settings = await getModelSettings();
      const modelStatsEnabled = Boolean(settings?.settings?.features?.enable_model_stats ?? false);
      setEnabled(modelStatsEnabled);
      if (!modelStatsEnabled) {
        setStats(null);
        return;
      }
      const data = await getModelAccuracyStats();
      setStats((data?.stats ?? null) as StatsPayload | null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load stats");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshStatsOnly = React.useCallback(async () => {
    if (!enabled) {
      return;
    }
    try {
      const data = await getModelAccuracyStats();
      setStats((data?.stats ?? null) as StatsPayload | null);
    } catch {
      // Keep current stats if refresh fails.
    }
  }, [enabled]);

  React.useEffect(() => {
    load();
  }, [load]);

  React.useEffect(() => {
    if (!enabled) {
      return;
    }
    let refreshTimeout: number | null = null;
    const ws = new WebSocket(buildEventsWsUrl());
    ws.onmessage = (event) => {
      let payload: { type?: string } | null = null;
      try {
        payload = JSON.parse(event.data) as { type?: string };
      } catch {
        return;
      }
      const eventType = String(payload?.type ?? "");
      if (
        eventType !== "dart_score" &&
        eventType !== "dart_score_unavailable" &&
        eventType !== "dart_score_corrected" &&
        eventType !== "takeout_complete"
      ) {
        return;
      }
      if (refreshTimeout != null) {
        window.clearTimeout(refreshTimeout);
      }
      refreshTimeout = window.setTimeout(() => {
        refreshStatsOnly();
      }, 250);
    };

    return () => {
      if (refreshTimeout != null) {
        window.clearTimeout(refreshTimeout);
      }
      ws.close();
    };
  }, [enabled, refreshStatsOnly]);

  const resetStats = async () => {
    setResetting(true);
    setError(null);
    try {
      const data = await resetModelAccuracyStats();
      setStats((data?.stats ?? null) as StatsPayload | null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to reset stats");
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden">
      <div
        className="pointer-events-none fixed inset-0 [background:
        radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
        linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95)_30%,rgba(255,255,255,0.04)_60%,rgba(0,0,0,1)_100%)
      ]"
      />
      <BackendTopNav />

      <main className="relative z-10 w-full max-w-6xl mx-auto px-6 md:px-10 pb-10">
        <section className="rounded-xl border border-white/10 bg-white/5 p-5 mt-5">
          <div className="flex items-center justify-between gap-3 mb-4">
            <h1 className="text-2xl font-bold">Model Accuracy Stats</h1>
            <button
              onClick={resetStats}
              disabled={resetting}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold hover:bg-red-500 disabled:opacity-60"
            >
              {resetting ? "Resetting..." : "Reset Stats"}
            </button>
          </div>

          {loading ? <div className="text-zinc-400">Loading stats...</div> : null}
          {error ? <div className="text-red-300 text-sm mb-3">{error}</div> : null}

          {!loading && enabled === false ? (
            <div className="rounded-lg border border-white/10 bg-zinc-950/50 p-4 text-sm text-zinc-300">
              Model stats are disabled. Turn on <span className="font-semibold text-white">Enable model stats</span> in
              the <span className="font-semibold text-white">Models</span> page when you want to compare models.
            </div>
          ) : null}

          {!loading && enabled !== false && stats ? (
            <>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
                <div className="rounded-lg border border-white/10 bg-zinc-950/50 p-3">
                  <div className="text-xs text-zinc-400">Active Model</div>
                  <div className="text-sm text-zinc-200 break-all">{stats.active_model_id || "-"}</div>
                </div>
                <div className="rounded-lg border border-white/10 bg-zinc-950/50 p-3">
                  <div className="text-xs text-zinc-400">Total Darts</div>
                  <div className="text-xl font-semibold">{stats.totals.total_darts}</div>
                </div>
                <div className="rounded-lg border border-white/10 bg-zinc-950/50 p-3">
                  <div className="text-xs text-zinc-400">Detected Darts</div>
                  <div className="text-xl font-semibold">{stats.totals.detected_darts}</div>
                </div>
                <div className="rounded-lg border border-white/10 bg-zinc-950/50 p-3">
                  <div className="text-xs text-zinc-400">Corrections</div>
                  <div className="text-xl font-semibold">{stats.totals.corrected_darts}</div>
                </div>
                <div className="rounded-lg border border-white/10 bg-zinc-950/50 p-3">
                  <div className="text-xs text-zinc-400">System Accuracy</div>
                  <div className="text-xl font-semibold">
                    {stats.totals.accuracy_percent == null ? "-" : `${stats.totals.accuracy_percent}%`}
                  </div>
                </div>
                <div className="rounded-lg border border-white/10 bg-zinc-950/50 p-3">
                  <div className="text-xs text-zinc-400">Avg Detect-&gt;Score</div>
                  <div className="text-xl font-semibold">
                    {stats.totals.avg_detection_to_score_ms == null ? "-" : `${stats.totals.avg_detection_to_score_ms} ms`}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-5">
                <div className="rounded-lg border border-white/10 bg-zinc-950/50 p-3 text-sm">
                  <div className="text-zinc-400 mb-1">3-Cam Agreement</div>
                  <div>total: <span className="text-zinc-200">{stats.totals.three_cam_total}</span></div>
                  <div>all match: <span className="text-zinc-200">{stats.totals.three_cam_all_match}</span></div>
                  <div>two match: <span className="text-zinc-200">{stats.totals.three_cam_two_match}</span></div>
                  <div>all diff: <span className="text-zinc-200">{stats.totals.three_cam_all_diff}</span></div>
                </div>
                <div className="rounded-lg border border-white/10 bg-zinc-950/50 p-3 text-sm">
                  <div className="text-zinc-400 mb-1">2-Cam Agreement</div>
                  <div>total: <span className="text-zinc-200">{stats.totals.two_cam_total}</span></div>
                  <div>match: <span className="text-zinc-200">{stats.totals.two_cam_match}</span></div>
                  <div>disagree: <span className="text-zinc-200">{stats.totals.two_cam_disagree}</span></div>
                </div>
                <div className="rounded-lg border border-white/10 bg-zinc-950/50 p-3 text-sm">
                  <div className="text-zinc-400 mb-1">Single-Cam</div>
                  <div>total: <span className="text-zinc-200">{stats.totals.single_cam_total}</span></div>
                  <div>no detection: <span className="text-zinc-200">{stats.totals.no_detection}</span></div>
                </div>
              </div>

              <div className="overflow-auto rounded-lg border border-white/10">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-900/80">
                    <tr>
                      <th className="text-left px-3 py-2">Model</th>
                      <th className="text-right px-3 py-2">Total</th>
                      <th className="text-right px-3 py-2">Detected</th>
                      <th className="text-right px-3 py-2">Corrections</th>
                      <th className="text-right px-3 py-2">3C A/T/D</th>
                      <th className="text-right px-3 py-2">2C M/D</th>
                      <th className="text-right px-3 py-2">1C</th>
                      <th className="text-right px-3 py-2">Uncorrected</th>
                      <th className="text-right px-3 py-2">Accuracy</th>
                      <th className="text-right px-3 py-2">Avg D-&gt;S</th>
                      <th className="text-right px-3 py-2">Avg Infer</th>
                      <th className="text-right px-3 py-2">Avg Queue</th>
                      <th className="text-right px-3 py-2">Avg Pre</th>
                      <th className="text-right px-3 py-2">Avg Decode</th>
                      <th className="text-right px-3 py-2">Avg Select</th>
                      <th className="text-right px-3 py-2">Avg Cal</th>
                      <th className="text-right px-3 py-2">Avg Vote</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.models.length === 0 ? (
                      <tr>
                        <td colSpan={17} className="px-3 py-4 text-zinc-500">
                          No stats yet. Throw darts and score corrections to populate this table.
                        </td>
                      </tr>
                    ) : (
                      stats.models.map((row) => (
                        <tr key={row.model_id} className="border-t border-white/10">
                          <td className="px-3 py-2 break-all">{row.model_id}</td>
                          <td className="px-3 py-2 text-right">{row.total_darts}</td>
                          <td className="px-3 py-2 text-right">{row.detected_darts}</td>
                          <td className="px-3 py-2 text-right">{row.corrected_darts}</td>
                          <td className="px-3 py-2 text-right">
                            {row.three_cam_all_match}/{row.three_cam_two_match}/{row.three_cam_all_diff}
                          </td>
                          <td className="px-3 py-2 text-right">{row.two_cam_match}/{row.two_cam_disagree}</td>
                          <td className="px-3 py-2 text-right">{row.single_cam_total}</td>
                          <td className="px-3 py-2 text-right">{row.uncorrected_darts}</td>
                          <td className="px-3 py-2 text-right">
                            {row.accuracy_percent == null ? "-" : `${row.accuracy_percent}%`}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {row.avg_detection_to_score_ms == null ? "-" : `${row.avg_detection_to_score_ms} ms`}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {row.avg_inference_ms == null ? "-" : `${row.avg_inference_ms} ms`}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {row.avg_queue_wait_ms == null ? "-" : `${row.avg_queue_wait_ms} ms`}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {row.avg_preprocess_ms == null ? "-" : `${row.avg_preprocess_ms} ms`}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {row.avg_decode_ms == null ? "-" : `${row.avg_decode_ms} ms`}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {row.avg_selection_ms == null ? "-" : `${row.avg_selection_ms} ms`}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {row.avg_calibration_ms == null ? "-" : `${row.avg_calibration_ms} ms`}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {row.avg_vote_ms == null ? "-" : `${row.avg_vote_ms} ms`}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </section>
      </main>
    </div>
  );
}
