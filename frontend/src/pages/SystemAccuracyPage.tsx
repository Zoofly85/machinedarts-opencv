import React from "react";
import { Activity, RotateCcw, Target } from "lucide-react";
import BackendTopNav from "../components/BackendTopNav";
import { getSystemAccuracyStats, resetSystemAccuracyStats } from "../services/api";

type SystemAccuracyStats = {
  started_at_ms: number;
  updated_at_ms: number;
  dart_count: number;
  correction_count: number;
  correct_count: number;
  accuracy_percent: number | null;
  correction_rate_percent: number | null;
};

const emptyStats: SystemAccuracyStats = {
  started_at_ms: 0,
  updated_at_ms: 0,
  dart_count: 0,
  correction_count: 0,
  correct_count: 0,
  accuracy_percent: null,
  correction_rate_percent: null,
};

function formatPercent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "-" : `${value.toFixed(2)}%`;
}

function formatDate(ms: number): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleString();
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
      <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">{label}</div>
      <div className="mt-3 text-3xl font-semibold text-white">{value}</div>
      {sub ? <div className="mt-2 text-sm text-zinc-400">{sub}</div> : null}
    </div>
  );
}

export default function SystemAccuracyPage() {
  const [stats, setStats] = React.useState<SystemAccuracyStats>(emptyStats);
  const [loading, setLoading] = React.useState(true);
  const [message, setMessage] = React.useState("");

  const load = React.useCallback(async () => {
    const payload = await getSystemAccuracyStats();
    setStats({ ...emptyStats, ...(payload.stats ?? {}) });
  }, []);

  React.useEffect(() => {
    let closed = false;
    const refresh = async () => {
      try {
        await load();
        if (!closed) setMessage("");
      } catch (err) {
        if (!closed) setMessage(err instanceof Error ? err.message : String(err));
      } finally {
        if (!closed) setLoading(false);
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      closed = true;
      window.clearInterval(timer);
    };
  }, [load]);

  const reset = async () => {
    if (!window.confirm("Reset system accuracy counters?")) return;
    setLoading(true);
    try {
      const payload = await resetSystemAccuracyStats();
      setStats({ ...emptyStats, ...(payload.stats ?? {}) });
      setMessage("Accuracy counters reset.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-black text-white">
      <BackendTopNav />
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 md:px-10">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-sm text-cyan-300">
              <Activity className="h-4 w-4" />
              System Accuracy
            </div>
            <h1 className="text-3xl font-semibold">OpenCV scoring accuracy</h1>
            <p className="mt-2 max-w-2xl text-sm text-zinc-400">
              Tracks confirmed darts and manual corrections during play so you can see whether the scoring system is improving.
            </p>
          </div>
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-white hover:bg-white/10"
          >
            <RotateCcw className="h-4 w-4" />
            Reset
          </button>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <StatTile label="Accuracy" value={formatPercent(stats.accuracy_percent)} sub="Darts without correction" />
          <StatTile label="Darts" value={String(stats.dart_count)} sub="Confirmed scored darts" />
          <StatTile label="Corrections" value={String(stats.correction_count)} sub="Manual score fixes" />
          <StatTile label="Correction Rate" value={formatPercent(stats.correction_rate_percent)} sub="Lower is better" />
        </div>

        <section className="mt-6 rounded-lg border border-white/10 bg-white/[0.03] p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-white">
            <Target className="h-4 w-4 text-cyan-300" />
            Current Sample
          </div>
          <div className="grid grid-cols-1 gap-3 text-sm text-zinc-300 md:grid-cols-3">
            <div>
              <span className="text-zinc-500">Correct darts</span>
              <div className="mt-1 text-lg text-white">{stats.correct_count}</div>
            </div>
            <div>
              <span className="text-zinc-500">Started</span>
              <div className="mt-1 text-lg text-white">{formatDate(stats.started_at_ms)}</div>
            </div>
            <div>
              <span className="text-zinc-500">Updated</span>
              <div className="mt-1 text-lg text-white">{formatDate(stats.updated_at_ms)}</div>
            </div>
          </div>
        </section>

        {loading ? <div className="mt-4 text-sm text-zinc-500">Loading...</div> : null}
        {message ? <div className="mt-4 text-sm text-zinc-400">{message}</div> : null}
      </main>
    </div>
  );
}
