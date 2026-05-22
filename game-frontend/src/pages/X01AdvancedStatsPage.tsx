import React, { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, RefreshCw } from "lucide-react";

const API_URL = "http://localhost:8000";

type AdvancedStatsNavState = {
  players?: { profileId: string; name: string }[];
};

interface PlayerProfile {
  id: string;
  name: string;
  createdAt: string;
}

interface HistoryRecord {
  gameMode: string;
  startedAt: string;
  finishedAt: string;
  darts: number;
  accuracy: number;
  won: boolean;
  corrections: number;
  summary?: Record<string, any>;
}

interface MetricTriple {
  current: number;
  previous: number;
  best: number;
}

interface X01WindowSummary {
  legs: number;
  legsWon: number;
  averages: {
    ppr: MetricTriple;
    pprTo170: MetricTriple;
    firstNine: MetricTriple;
  };
  checkout: {
    attempts: number;
    successes: number;
    percentage: MetricTriple;
  };
  buckets: {
    total: Record<string, number>;
    perLeg: Record<string, number>;
  };
}

interface PlayerStatsResponse {
  player: PlayerProfile;
  history: HistoryRecord[];
  modes?: {
    x01?: {
      overall?: X01WindowSummary;
      windows?: Record<string, X01WindowSummary>;
    };
  };
}

interface PeriodPoint {
  key: string;
  label: string;
  legs: number;
  average: number;
  checkout: number;
  dartsPerLeg: number;
}

const BUCKET_KEYS = ["60plus", "80plus", "100plus", "120plus", "140plus", "170plus", "180"] as const;

export default function X01AdvancedStatsPage() {
  const navigate = useNavigate();
  const { state } = useLocation() as { state?: AdvancedStatsNavState };
  const initialPlayerId = state?.players?.[0]?.profileId ?? null;

  const [players, setPlayers] = useState<PlayerProfile[]>([]);
  const [playersLoading, setPlayersLoading] = useState(false);
  const [playersError, setPlayersError] = useState<string | null>(null);

  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(initialPlayerId);
  const [stats, setStats] = useState<PlayerStatsResponse | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let isMounted = true;
    const loadPlayers = async () => {
      setPlayersLoading(true);
      setPlayersError(null);
      try {
        const response = await fetch(`${API_URL}/api/players`);
        if (!response.ok) {
          throw new Error(`Failed to load players (${response.status})`);
        }
        const data = await response.json();
        if (isMounted) {
          setPlayers(data.players ?? []);
        }
      } catch (error) {
        if (isMounted) {
          setPlayersError(error instanceof Error ? error.message : "Unable to load players.");
        }
      } finally {
        if (isMounted) {
          setPlayersLoading(false);
        }
      }
    };

    loadPlayers();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (players.length === 0) {
      return;
    }
    const exists = selectedPlayerId
      ? players.some((profile) => profile.id === selectedPlayerId)
      : false;
    if (!selectedPlayerId || !exists) {
      setSelectedPlayerId(players[0].id);
    }
  }, [players, selectedPlayerId]);

  useEffect(() => {
    if (!selectedPlayerId) {
      return;
    }
    const controller = new AbortController();
    const loadStats = async () => {
      setStatsLoading(true);
      setStatsError(null);
      try {
        const response = await fetch(
          `${API_URL}/api/players/${selectedPlayerId}/stats?gameMode=x01&limit=5000`,
          { signal: controller.signal }
        );
        if (!response.ok) {
          throw new Error(`Failed to load stats (${response.status})`);
        }
        const data = await response.json();
        setStats(data);
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        setStats(null);
        setStatsError(error instanceof Error ? error.message : "Unable to load stats.");
      } finally {
        if (!controller.signal.aborted) {
          setStatsLoading(false);
        }
      }
    };

    loadStats();
    return () => {
      controller.abort();
    };
  }, [selectedPlayerId, reloadToken]);

  const historyChronological = useMemo(() => {
    const records = stats?.history ?? [];
    return [...records].sort(
      (a, b) => new Date(a.finishedAt).getTime() - new Date(b.finishedAt).getTime()
    );
  }, [stats?.history]);

  const totals = useMemo(() => summarizeTotals(historyChronological), [historyChronological]);

  const monthlySeries = useMemo(
    () => buildPeriodSeries(historyChronological, "month"),
    [historyChronological]
  );
  const matchesPerDay = useMemo(
    () => buildMatchesPerDay(historyChronological),
    [historyChronological]
  );
  const oneEightiesPerDay = useMemo(
    () => build180sPerDay(historyChronological),
    [historyChronological]
  );
  const fastestLegs = useMemo(
    () => buildFastestLegs(historyChronological),
    [historyChronological]
  );
  const highCheckouts = useMemo(
    () => buildHighCheckouts(historyChronological),
    [historyChronological]
  );

  const x01Windows = stats?.modes?.x01?.windows ?? {};
  const window10 = x01Windows?.["10"];
  const windowAll = x01Windows?.["all"] ?? stats?.modes?.x01?.overall;

  const bucketPerLeg = useMemo(() => {
    const source = windowAll?.buckets?.perLeg ?? window10?.buckets?.perLeg ?? {};
    return BUCKET_KEYS.map((key) => ({
      key,
      label: key === "180" ? "180" : key.replace("plus", "+").toUpperCase(),
      value: Number(source?.[key] ?? 0),
    }));
  }, [windowAll, window10]);

  const selectedPlayer = useMemo(
    () => players.find((profile) => profile.id === selectedPlayerId) ?? null,
    [players, selectedPlayerId]
  );

  const loadingStats = statsLoading;
  const playerStats = stats;

  const averagePpr = windowAll?.averages?.ppr?.current ?? 0;
  const total180s = windowAll?.buckets?.total?.["180"] ?? 0;
  const total140s = windowAll?.buckets?.total?.["140plus"] ?? 0;
  const total100s = windowAll?.buckets?.total?.["100plus"] ?? 0;
  const totalPlayWeeks = totals.durationSeconds / (7 * 24 * 3600);
  const totalDistanceKm = totals.distanceKm;

  const advancedPlayersPayload = useMemo(() => {
    if (!selectedPlayerId || !selectedPlayer) {
      return null;
    }
    return [
      {
        profileId: selectedPlayerId,
        name: selectedPlayer.name,
      },
    ];
  }, [selectedPlayerId, selectedPlayer]);

  const handleAdvancedStats = () => {
    if (!advancedPlayersPayload) {
      return;
    }
    navigate("/x01/stats/advanced", {
      state: {
        players: advancedPlayersPayload,
      },
    });
  };

  const hasData = Boolean(historyChronological.length);

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden flex flex-col">
      <div
        className="pointer-events-none fixed inset-0 opacity-80 [background:
          radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.1),transparent_60%),
          radial-gradient(ellipse_at_bottom_right,rgba(255,255,255,0.05),transparent_70%),
          linear-gradient(135deg,rgba(3,7,18,0.6),rgba(0,0,0,0.95))
        ]"
      />

      <header className="relative z-10 w-full px-4 md:px-10 py-6 border-b border-white/10 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="inline-flex items-center gap-2 rounded-full border border-white/20 px-4 py-2 text-sm hover:bg-white/10 transition-colors"
          >
            <ArrowLeft size={16} />
            Back
          </button>
          <div>
            <p className="text-xs uppercase tracking-[0.4em] text-zinc-500">Insights</p>
            <h1 className="text-xl font-bold">
              X01 <span className="text-cyan-400">Advanced Stats</span>
            </h1>
          </div>
        </div>
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <div className="flex flex-col">
            <label className="text-[10px] uppercase tracking-[0.3em] text-zinc-500 mb-1">
              Player
            </label>
            <select
              className="rounded-lg bg-black/60 border border-white/15 px-4 py-2 text-sm focus:border-cyan-400 focus:outline-none"
              value={selectedPlayerId ?? ""}
              onChange={(event) => setSelectedPlayerId(event.target.value || null)}
            >
              {!selectedPlayerId && <option value="">Select player</option>}
              {players.map((player) => (
                <option key={player.id} value={player.id}>
                  {player.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={() => setReloadToken((token) => token + 1)}
            disabled={statsLoading || !selectedPlayerId}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/15 px-4 py-2 text-sm hover:border-cyan-400 hover:text-cyan-200 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={16} className={statsLoading ? "animate-spin" : undefined} />
            Refresh
          </button>
        </div>
      </header>

      <main className="relative z-10 flex-1 px-4 md:px-10 pb-16 overflow-y-auto">
        {playersError && (
          <div className="max-w-5xl mx-auto mt-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {playersError}
          </div>
        )}

        {!selectedPlayerId ? (
          <div className="max-w-5xl mx-auto mt-12 text-center text-zinc-400">
            {playersLoading ? "Loading players..." : "Select a player to view advanced stats."}
          </div>
        ) : (
          <>

            <section className="max-w-6xl mx-auto mt-8">
              <div className="rounded-2xl border border-white/10 bg-black/40 p-6 lg:p-8">
                {loadingStats && (
                  <div className="text-sm text-zinc-400">Loading player statistics...</div>
                )}
                {statsError && (
                  <div className="mb-4 rounded-lg border border-red-600 bg-red-900/30 px-4 py-3 text-sm text-red-200">
                    {statsError}
                  </div>
                )}
                {!loadingStats && !playerStats && !statsError && (
                  <div className="text-sm text-zinc-400">
                    Select a player to view performance dashboards.
                  </div>
                )}

                {playerStats && selectedPlayer && (
                  <div className="space-y-8">
                    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                      <div>
                        <h2 className="text-2xl font-semibold text-white">{selectedPlayer.name}</h2>
                        <p className="text-sm text-zinc-500">
                          Active since {formatDate(selectedPlayer.createdAt)}
                        </p>
                      </div>
                      <div className="flex flex-col items-stretch md:items-end gap-3">
                        <button
                          type="button"
                          onClick={handleAdvancedStats}
                          disabled={!advancedPlayersPayload}
                          className="rounded-xl border border-cyan-400/40 bg-cyan-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-cyan-100 transition hover:bg-cyan-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Advanced X01 Stats
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-6">
                      <div className="space-y-6">
                        <ChartPanel title="Average over time" subtitle="Monthly three-dart average">
                          <BarChart
                            data={monthlySeries.map((point) => ({
                              label: point.label,
                              value: point.average,
                            }))}
                            color="#22d3ee"
                            maxBars={18}
                          />
                        </ChartPanel>

                        <ChartPanel title="Matches per day" subtitle="Last 90 days">
                          <BarChart data={matchesPerDay} color="#2dd4bf" maxBars={90} />
                        </ChartPanel>

                        <ChartPanel title="180s per day" subtitle="Last 90 days">
                          <BarChart data={oneEightiesPerDay} color="#f472b6" maxBars={90} />
                        </ChartPanel>

                        <div className="rounded-2xl border border-white/10 bg-black/40 p-6 space-y-4">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Visit Mix</p>
                              <h2 className="text-lg font-semibold">Scoring distribution</h2>
                            </div>
                            <p className="text-sm text-zinc-400">
                              Lifetime sample &middot; {selectedPlayer.name}
                            </p>
                          </div>
                          {hasData ? (
                            <>
                              <BucketChart data={bucketPerLeg} />
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm text-zinc-300">
                                {bucketPerLeg.map((bucket) => (
                                  <div
                                    key={bucket.key}
                                    className="rounded-xl border border-white/10 bg-black/30 px-3 py-3"
                                  >
                                    <div className="text-[11px] uppercase tracking-[0.3em] text-zinc-500">
                                      {bucket.label}
                                    </div>
                                    <div className="text-xl font-semibold text-white mt-1">
                                      {bucket.value.toFixed(2)}
                                    </div>
                                    <div className="text-[11px] text-zinc-500">Avg per leg</div>
                                  </div>
                                ))}
                              </div>
                            </>
                          ) : (
                            <p className="text-sm text-zinc-500">
                              Play a few legs to unlock distribution insights.
                            </p>
                          )}
                        </div>
                      </div>

                      <aside className="space-y-4">
                        <KpiCard title="Average" value={averagePpr ? averagePpr.toFixed(1) : "--"} subtitle="All-time PPR" />
                        <KpiCard title="Total darts" value={totals.darts.toLocaleString()} subtitle="Across tracked legs" />
                        <div className="grid grid-cols-3 gap-3">
                          <KpiCard title="180s" value={total180s.toString()} compact />
                          <KpiCard title="140+" value={total140s.toString()} compact />
                          <KpiCard title="100+" value={total100s.toString()} compact />
                        </div>
                        <KpiCard
                          title="Play time"
                          value={`${totalPlayWeeks.toFixed(2)} weeks`}
                          subtitle={formatDuration(totals.durationSeconds)}
                        />
                        <KpiCard
                          title="Distance walked"
                          value={`${totalDistanceKm.toFixed(2)} km`}
                          subtitle="2.37m to the board and back"
                        />
                      <KpiCard title="High checkouts">
                        {highCheckouts.length ? (
                          <ul className="space-y-2 text-sm text-white">
                            {highCheckouts.map((entry, idx) => (
                              <li
                                key={`checkout-${idx}-${entry.value}`}
                                className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2"
                              >
                                <div className="flex items-center gap-2">
                                  <span className="text-xs uppercase tracking-[0.3em] text-zinc-500">
                                    #{idx + 1}
                                  </span>
                                  <span className="text-lg font-semibold">{entry.value}</span>
                                </div>
                                <span className="text-xs text-zinc-400">×{entry.count}</span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-sm text-zinc-500">Finish more legs to unlock.</p>
                        )}
                      </KpiCard>
                        <KpiCard title="Fastest legs">
                          {fastestLegs.length ? (
                            <div className="space-y-2">
                              {fastestLegs.map((leg) => {
                                const width = Math.min(100, Math.max(5, (33 - leg.darts) * 4));
                                return (
                                  <div
                                    key={`${leg.label}-${leg.darts}`}
                                    className="flex items-center gap-3 text-sm text-white"
                                  >
                                    <div className="flex-1">
                                      <div className="text-xs uppercase tracking-[0.3em] text-zinc-500 flex items-center justify-between">
                                        <span>{leg.label}</span>
                                        <span className="text-[10px] text-zinc-400">×{leg.count}</span>
                                      </div>
                                      <div className="h-2 w-full bg-white/5 rounded overflow-hidden mt-1">
                                        <div
                                          className="h-full rounded bg-gradient-to-r from-cyan-400 to-cyan-600"
                                          style={{ width: `${width}%` }}
                                        />
                                      </div>
                                    </div>
                                    <span className="text-lg font-semibold">{leg.darts}</span>
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <p className="text-sm text-zinc-500">
                              Quickest completed legs will display here.
                            </p>
                          )}
                        </KpiCard>
                      </aside>
                    </div>
                  </div>
                )}
              </div>
            </section>


            {statsError && (
              <div className="max-w-5xl mx-auto mt-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                {statsError}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function ChartPanel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/40 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">{title}</p>
          {subtitle && <p className="text-sm text-zinc-400 mt-1">{subtitle}</p>}
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function BucketChart({ data }: { data: { key: string; label: string; value: number }[] }) {
  const max = Math.max(...data.map((item) => item.value), 1);
  return (
    <div className="flex items-end gap-4 h-36">
      {data.map((item) => (
        <div key={item.key} className="flex-1 flex flex-col items-center gap-2">
          <div className="relative w-full bg-white/5 rounded-xl h-28 overflow-hidden">
            <div
              className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-cyan-500/80 via-cyan-400/60 to-transparent"
              style={{ height: `${(item.value / max) * 100}%` }}
            />
          </div>
          <div className="text-xs text-zinc-400">{item.label}</div>
        </div>
      ))}
    </div>
  );
}

interface ChartPoint {
  label: string;
  value: number;
}

interface FastestLegEntry {
  darts: number;
  count: number;
  label: string;
}

interface CheckoutEntry {
  value: number;
  count: number;
}

function BarChart({ data, color = "#22d3ee", maxBars = 60 }: { data: ChartPoint[]; color?: string; maxBars?: number }) {
  if (!data.length) {
    return <p className="text-sm text-zinc-500">No data yet.</p>;
  }
  const sliced = data.slice(-maxBars);
  const maxValue = Math.max(...sliced.map((point) => point.value), 1);

  return (
    <div className="flex items-end gap-[2px] h-44">
      {sliced.map((point, index) => (
        <div key={`${point.label}-${index}`} className="flex-1 flex flex-col items-center">
          <div className="w-full bg-white/5 rounded-t-sm" style={{ height: `${(point.value / maxValue) * 100}%` }}>
            <div
              className="w-full h-full rounded-t-sm"
              style={{ background: `linear-gradient(180deg, ${color}, ${color}80)` }}
            />
          </div>
          {index % Math.max(1, Math.floor(sliced.length / 6)) === 0 && (
            <div className="text-[10px] text-zinc-500 mt-2 text-center leading-tight">{point.label}</div>
          )}
        </div>
      ))}
    </div>
  );
}

function KpiCard({
  title,
  value,
  subtitle,
  compact,
  children,
}: {
  title: string;
  value?: string;
  subtitle?: string;
  compact?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={`rounded-2xl border border-white/10 bg-black/40 ${compact ? "px-3 py-3" : "px-4 py-4"}`}>
      <p className="text-[10px] uppercase tracking-[0.3em] text-zinc-500">{title}</p>
      {value !== undefined && <p className="text-2xl font-semibold text-white mt-2">{value}</p>}
      {subtitle && <p className="text-xs text-zinc-500 mt-1">{subtitle}</p>}
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

function summarizeTotals(history: HistoryRecord[]) {
  let legsWon = 0;
  let darts = 0;
  let durationSeconds = 0;
  let visits = 0;

  history.forEach((record) => {
    if (record.won) {
      legsWon += 1;
    }
    darts += Number(record.darts ?? 0);
    const start = Date.parse(record.startedAt);
    const end = Date.parse(record.finishedAt);
    if (!Number.isNaN(start) && !Number.isNaN(end)) {
      durationSeconds += Math.max(0, (end - start) / 1000);
    }
    visits += Math.max(1, Math.ceil((record.darts ?? 0) / 3));
  });

  const legs = history.length;
  const winRate = legs ? legsWon / legs : 0;
  const WALK_PER_VISIT_METERS = 4.74; // 2 * 2.37m (oche to board and back) = 4740mm
  const distanceKm = (visits * WALK_PER_VISIT_METERS) / 1000;

  return {
    legs,
    legsWon,
    darts,
    winRate,
    durationSeconds,
    distanceKm,
  };
}

function buildPeriodSeries(history: HistoryRecord[], period: "week" | "month"): PeriodPoint[] {
  const bucketMap = new Map<string, { label: string; records: HistoryRecord[] }>();
  history.forEach((record) => {
    const finished = new Date(record.finishedAt);
    if (Number.isNaN(finished.getTime())) {
      return;
    }
    const key = period === "week" ? weekKey(finished) : monthKey(finished);
    const label = period === "week" ? formatWeekLabel(key) : formatMonthLabel(key);
    const existing = bucketMap.get(key);
    if (existing) {
      existing.records.push(record);
    } else {
      bucketMap.set(key, { label, records: [record] });
    }
  });

  const sorted = Array.from(bucketMap.entries()).sort(([a], [b]) => (a > b ? 1 : -1));
  return sorted.map(([key, payload]) => {
    const summary = summarizePeriod(payload.records);
    return {
      key,
      label: payload.label,
      legs: summary.legs,
      average: summary.average,
      checkout: summary.checkout,
      dartsPerLeg: summary.dartsPerLeg,
    };
  });
}

function buildMatchesPerDay(history: HistoryRecord[]): ChartPoint[] {
  const counts = new Map<string, number>();
  history.forEach((record) => {
    const key = (record.finishedAt || "").slice(0, 10);
    if (!key) {
      return;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return Array.from(counts.entries())
    .sort(([a], [b]) => (a > b ? 1 : -1))
    .map(([key, value]) => ({ label: formatDayLabel(key), value }));
}

function build180sPerDay(history: HistoryRecord[]): ChartPoint[] {
  const counts = new Map<string, number>();
  history.forEach((record) => {
    const key = (record.finishedAt || "").slice(0, 10);
    if (!key) {
      return;
    }
    const visitBuckets = extractVisitBuckets(record);
    const value = Number(visitBuckets["180"] ?? 0);
    if (!value) {
      return;
    }
    counts.set(key, (counts.get(key) ?? 0) + value);
  });
  return Array.from(counts.entries())
    .sort(([a], [b]) => (a > b ? 1 : -1))
    .map(([key, value]) => ({ label: formatDayLabel(key), value }));
}

function buildFastestLegs(history: HistoryRecord[]): FastestLegEntry[] {
  const buckets = new Map<number, { count: number; date: string }>();
  history.forEach((record) => {
    if (!record.won) {
      return;
    }
    const darts = Number(record.darts ?? 0);
    if (!Number.isFinite(darts) || darts <= 0) {
      return;
    }
    const existing = buckets.get(darts);
    if (existing) {
      existing.count += 1;
      existing.date = record.finishedAt;
    } else {
      buckets.set(darts, { count: 1, date: record.finishedAt });
    }
  });
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .slice(0, 10)
    .map(([darts, meta]) => ({
      darts,
      count: meta.count,
      label: formatShortDate(meta.date),
    }));
}

function buildHighCheckouts(history: HistoryRecord[]): CheckoutEntry[] {
  const buckets = new Map<number, number>();
  history.forEach((record) => {
    const checkout = extractCheckoutScore(record);
    if (checkout > 0) {
      buckets.set(checkout, (buckets.get(checkout) ?? 0) + 1);
    }
  });
  return Array.from(buckets.entries())
    .sort(([a], [b]) => b - a)
    .slice(0, 5)
    .map(([value, count]) => ({ value, count }));
}

function summarizePeriod(records: HistoryRecord[]) {
  let darts = 0;
  let score = 0;
  let attempts = 0;
  let successes = 0;
  records.forEach((record) => {
    const payload = extractX01Summary(record);
    darts += payload.darts;
    score += payload.score;
    attempts += payload.checkoutAttempts;
    successes += payload.checkoutSuccesses;
  });
  const legs = records.length;
  const average = darts ? (score / darts) * 3 : 0;
  const checkout = attempts ? (successes / attempts) * 100 : 0;
  return {
    legs,
    average,
    checkout,
    dartsPerLeg: legs ? darts / legs : 0,
  };
}

function extractX01Summary(record: HistoryRecord) {
  const summary = record.summary ?? {};
  const darts = Number(summary.darts ?? record.darts ?? 0);
  const score = Number(summary.score ?? 0);
  const checkoutAttempts = Number(summary.checkoutAttempts ?? 0);
  const checkoutSuccesses = Number(summary.checkoutSuccesses ?? 0);
  return {
    darts,
    score,
    checkoutAttempts,
    checkoutSuccesses,
  };
}

function extractVisitBuckets(record: HistoryRecord): Record<string, number> {
  const summary = record.summary;
  if (summary && typeof summary === "object" && summary.visitBuckets && typeof summary.visitBuckets === "object") {
    return summary.visitBuckets as Record<string, number>;
  }
  return {};
}

function extractCheckoutScore(record: HistoryRecord): number {
  if (!record.won) {
    return 0;
  }
  const summary = record.summary ?? {};
  const visits = Array.isArray(summary.visits) ? summary.visits : null;
  if (!visits || !visits.length) {
    return 0;
  }
  const value = Number(visits[visits.length - 1] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function weekKey(date: Date) {
  const utc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const day = new Date(utc).getUTCDay();
  const diff = (day + 6) % 7;
  const monday = new Date(utc - diff * 24 * 60 * 60 * 1000);
  return monday.toISOString().slice(0, 10);
}

function monthKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function formatWeekLabel(key: string) {
  const date = new Date(`${key}T00:00:00Z`);
  return `Week of ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function formatMonthLabel(key: string) {
  const [year, month] = key.split("-");
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
  return date.toLocaleString(undefined, { month: "long", year: "numeric" });
}

function formatDayLabel(key: string) {
  const date = new Date(`${key}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return key;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatShortDate(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatDate(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return date.toLocaleString(undefined, { dateStyle: "medium" });
}

function formatDuration(totalSeconds: number) {
  if (!totalSeconds) {
    return "0h 00m";
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
}

