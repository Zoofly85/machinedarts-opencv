import React from "react";
import { Link, useParams } from "react-router-dom";

import { getPlayerStats, type ClubPlayerStats } from "../services/clubApi";

const X01_BUCKETS = [
  { key: "40plus", label: "40+" },
  { key: "60plus", label: "60+" },
  { key: "80plus", label: "80+" },
  { key: "100plus", label: "100+" },
  { key: "120plus", label: "120+" },
  { key: "140plus", label: "140+" },
  { key: "170plus", label: "170+" },
  { key: "180", label: "180" },
];

function round(value: number | undefined, digits = 2): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toFixed(digits) : "0.00";
}

function StatCard({ title, value, subtitle }: { title: string; value: string; subtitle?: string }) {
  return (
    <div className="border border-cyan-900/70 rounded-xl p-4 bg-zinc-950/90">
      <div className="text-xs uppercase tracking-[0.2em] text-zinc-400">{title}</div>
      <div className="text-2xl font-extrabold text-cyan-300 mt-2">{value}</div>
      {subtitle ? <div className="text-sm text-zinc-400 mt-1">{subtitle}</div> : null}
    </div>
  );
}

export default function MasterPlayerProfilePage() {
  const { playerId = "" } = useParams();
  const [stats, setStats] = React.useState<ClubPlayerStats | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    if (!playerId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await getPlayerStats(playerId);
      setStats(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load player stats.");
    } finally {
      setLoading(false);
    }
  }, [playerId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const x01 = stats?.modes?.x01?.overall;
  const cricket = stats?.modes?.cricket?.overall;
  const atc = stats?.modes?.around_the_clock?.overall;
  const checkoutAttempts = x01?.checkout?.attempts ?? 0;
  const checkoutSuccesses = x01?.checkout?.successes ?? 0;

  return (
    <div className="min-h-screen bg-black text-white p-6 md:p-8">
      <div className="max-w-6xl mx-auto space-y-5">
        <header className="border border-cyan-900/70 rounded-2xl p-5 bg-zinc-950/90">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl md:text-3xl font-extrabold text-cyan-300">Player Profile</h1>
              <p className="text-zinc-300 mt-2">
                {stats?.player?.name || "Unknown Player"} {stats?.history ? `| Matches: ${stats.history.length}` : ""}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                className="px-4 py-2 rounded-lg border border-cyan-700 text-cyan-200 hover:bg-cyan-900/30"
                onClick={() => void refresh()}
                disabled={loading}
              >
                Refresh
              </button>
              <Link
                className="px-4 py-2 rounded-lg border border-zinc-700 text-zinc-200 hover:bg-zinc-800/60"
                to="/club/master/players"
              >
                Back to Players
              </Link>
            </div>
          </div>
        </header>

        {error && <div className="border border-red-700/60 bg-red-950/30 text-red-200 rounded-xl px-4 py-3">{error}</div>}

        {!loading && !error && stats && (
          <>
            <section className="grid md:grid-cols-3 gap-4">
              <StatCard title="X01 PPR" value={round(x01?.averages?.ppr?.current)} subtitle={`Legs ${x01?.legs ?? 0} | Won ${x01?.legsWon ?? 0}`} />
              <StatCard title="First 9 Avg" value={round(x01?.averages?.firstNine?.current)} subtitle={`Avg to 170 ${round(x01?.averages?.pprTo170?.current)}`} />
              <StatCard
                title="Checkout %"
                value={`${round(x01?.checkout?.percentage?.current, 1)}%`}
                subtitle={`${checkoutSuccesses}/${checkoutAttempts} successful`}
              />
            </section>

            <section className="grid md:grid-cols-2 gap-4">
              <div className="border border-cyan-900/70 rounded-2xl p-5 bg-zinc-950/90">
                <div className="text-xs uppercase tracking-[0.2em] text-zinc-400 mb-3">X01 Big Scores</div>
                <div className="grid grid-cols-4 gap-2">
                  {X01_BUCKETS.map((bucket) => (
                    <div key={bucket.key} className="rounded border border-zinc-800 bg-zinc-900/60 px-2 py-1">
                      <div className="text-zinc-500 text-[11px]">{bucket.label}</div>
                      <div className="text-cyan-300 font-semibold">
                        {stats?.modes?.x01?.overall?.buckets?.total?.[bucket.key] ?? 0}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="border border-cyan-900/70 rounded-2xl p-5 bg-zinc-950/90">
                <div className="text-xs uppercase tracking-[0.2em] text-zinc-400 mb-3">Other Modes</div>
                <div className="space-y-4">
                  <div>
                    <div className="text-sm font-semibold text-cyan-200">Cricket</div>
                    <div className="text-sm text-zinc-300">MPR: {round(cricket?.averages?.mpr?.current)}</div>
                    <div className="text-sm text-zinc-400">Legs {cricket?.legs ?? 0} | Won {cricket?.legsWon ?? 0}</div>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-cyan-200">Around The Clock</div>
                    <div className="text-sm text-zinc-300">Accuracy: {round(atc?.averages?.accuracy?.current)}%</div>
                    <div className="text-sm text-zinc-400">Legs {atc?.legs ?? 0} | Won {atc?.legsWon ?? 0}</div>
                  </div>
                </div>
              </div>
            </section>
          </>
        )}

        {loading && (
          <div className="border border-zinc-800 rounded-xl px-4 py-3 text-sm text-zinc-300 bg-zinc-950/80">Loading player stats...</div>
        )}
      </div>
    </div>
  );
}

