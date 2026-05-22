
import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, RefreshCw, Trophy, Target, Flame, TimerReset, Orbit, Crown, Gauge, Activity, ChevronRight } from "lucide-react";
import { useLocation } from "react-router-dom";
import { API_BASE_URL } from "../../services/api";

const API_URL = API_BASE_URL;

type AdvancedStatsNavState = { players?: { profileId: string; name: string }[] };

interface PlayerProfile { id: string; name: string; createdAt: string; }
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
interface MetricTriple { current: number; previous: number; best: number; }
interface X01WindowSummary {
  legs: number;
  legsWon: number;
  averages: { ppr: MetricTriple; pprTo170: MetricTriple; firstNine: MetricTriple; };
  checkout: { attempts: number; successes: number; percentage: MetricTriple; };
  buckets: { total: Record<string, number>; perLeg: Record<string, number>; };
}
interface PlayerStatsResponse {
  player: PlayerProfile;
  history: HistoryRecord[];
  modes?: { x01?: { overall?: X01WindowSummary; windows?: Record<string, X01WindowSummary> } };
}
interface PeriodPoint { key: string; label: string; average: number; }
interface ChartPoint { label: string; value: number; }
interface FastestLegEntry { darts: number; count: number; label: string; }
interface CheckoutEntry { value: number; count: number; }

const BUCKET_KEYS = ["40under", "40plus", "60plus", "80plus", "100plus", "120plus", "140plus", "170plus", "180"] as const;
type BucketKey = (typeof BUCKET_KEYS)[number];
const BUCKET_LABELS: Record<BucketKey, string> = {
  "40under": "<40", "40plus": "40+", "60plus": "60+", "80plus": "80+", "100plus": "100+", "120plus": "120+", "140plus": "140+", "170plus": "170+", "180": "180",
};

export default function X01AdvancedStatsPage() {
  const { state } = useLocation() as { state?: AdvancedStatsNavState };
  const preselectedPlayerId = state?.players?.[0]?.profileId ?? null;

  const [players, setPlayers] = useState<PlayerProfile[]>([]);
  const [playersLoading, setPlayersLoading] = useState(false);
  const [playersError, setPlayersError] = useState<string | null>(null);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(preselectedPlayerId);
  const [stats, setStats] = useState<PlayerStatsResponse | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let mounted = true;
    const loadPlayers = async () => {
      setPlayersLoading(true);
      setPlayersError(null);
      try {
        const response = await fetch(`${API_URL}/api/players`);
        if (!response.ok) throw new Error(`Failed to load players (${response.status})`);
        const payload = await response.json();
        if (mounted) setPlayers(payload.players ?? []);
      } catch (error) {
        if (mounted) setPlayersError(error instanceof Error ? error.message : "Unable to load players.");
      } finally {
        if (mounted) setPlayersLoading(false);
      }
    };
    loadPlayers();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!players.length) return;
    const exists = selectedPlayerId ? players.some((p) => p.id === selectedPlayerId) : false;
    if (!selectedPlayerId || !exists) setSelectedPlayerId(players[0].id);
  }, [players, selectedPlayerId]);

  useEffect(() => {
    if (!selectedPlayerId) return;
    const controller = new AbortController();
    const loadStats = async () => {
      setStatsLoading(true);
      setStatsError(null);
      try {
        const response = await fetch(`${API_URL}/api/players/${selectedPlayerId}/stats?gameMode=x01&limit=5000`, { signal: controller.signal });
        if (!response.ok) throw new Error(`Failed to load stats (${response.status})`);
        const payload = (await response.json()) as PlayerStatsResponse;
        setStats(payload);
      } catch (error) {
        if (controller.signal.aborted) return;
        setStats(null);
        setStatsError(error instanceof Error ? error.message : "Unable to load stats.");
      } finally {
        if (!controller.signal.aborted) setStatsLoading(false);
      }
    };
    loadStats();
    return () => controller.abort();
  }, [selectedPlayerId, reloadToken]);

  const selectedPlayer = useMemo(() => stats?.player ?? players.find((p) => p.id === selectedPlayerId) ?? null, [stats?.player, players, selectedPlayerId]);
  const historyChronological = useMemo(() => [...(stats?.history ?? [])].sort((a, b) => new Date(a.finishedAt).getTime() - new Date(b.finishedAt).getTime()), [stats]);
  const totals = useMemo(() => summarizeTotals(historyChronological), [historyChronological]);
  const monthlySeries = useMemo(() => buildPeriodSeries(historyChronological), [historyChronological]);
  const matchesPerDay = useMemo(() => buildMatchesPerDay(historyChronological), [historyChronological]);
  const oneEightiesPerDay = useMemo(() => build180sPerDay(historyChronological), [historyChronological]);
  const fastestLegs = useMemo(() => buildFastestLegs(historyChronological), [historyChronological]);
  const highCheckouts = useMemo(() => buildHighCheckouts(historyChronological), [historyChronological]);

  const x01Windows = stats?.modes?.x01?.windows ?? {};
  const window10 = x01Windows["10"];
  const windowAll = x01Windows["all"] ?? stats?.modes?.x01?.overall;

  const bucketPerLeg = useMemo(() => {
    const fromHistory = buildPerLegBucketsFromHistory(historyChronological);
    const source = Object.keys(fromHistory).length ? fromHistory : (windowAll?.buckets?.perLeg ?? window10?.buckets?.perLeg ?? {});
    return BUCKET_KEYS.map((key) => ({ key, label: BUCKET_LABELS[key], value: Number(source[key] ?? 0) }));
  }, [historyChronological, windowAll, window10]);

  const averagePpr = windowAll?.averages?.ppr?.current ?? 0;
  const previousPpr = windowAll?.averages?.ppr?.previous ?? 0;
  const bestPpr = windowAll?.averages?.ppr?.best ?? 0;
  const checkoutPct = windowAll?.checkout?.percentage?.current ?? 0;
  const firstNine = windowAll?.averages?.firstNine?.current ?? 0;
  const total180s = windowAll?.buckets?.total?.["180"] ?? 0;
  const total140s = windowAll?.buckets?.total?.["140plus"] ?? 0;
  const total100s = windowAll?.buckets?.total?.["100plus"] ?? 0;
  const totalPlayWeeks = totals.durationSeconds / (7 * 24 * 3600);
  const totalDistanceKm = totals.distanceKm;
  const winRatePct = totals.legs ? totals.winRate * 100 : 0;
  const formDelta = averagePpr - previousPpr;
  const peakCheckout = highCheckouts[0]?.value ?? 0;
  const hottestBucket = [...bucketPerLeg].sort((a, b) => b.value - a.value)[0];

  const heroMetrics = [
    { title: "Three-Dart Average", value: averagePpr ? averagePpr.toFixed(1) : "--", sub: `Best ${bestPpr ? bestPpr.toFixed(1) : "--"}`, delta: formDelta, icon: Gauge },
    { title: "Checkout Rate", value: `${checkoutPct.toFixed(1)}%`, sub: `${windowAll?.checkout?.successes ?? 0}/${windowAll?.checkout?.attempts ?? 0} finishes`, delta: (windowAll?.checkout?.percentage?.current ?? 0) - (windowAll?.checkout?.percentage?.previous ?? 0), icon: Target },
    { title: "First 9", value: firstNine ? firstNine.toFixed(1) : "--", sub: "Opening pressure", delta: (windowAll?.averages?.firstNine?.current ?? 0) - (windowAll?.averages?.firstNine?.previous ?? 0), icon: Flame },
    { title: "Win Rate", value: `${winRatePct.toFixed(1)}%`, sub: `${totals.legsWon}/${totals.legs} legs`, delta: null, icon: Trophy },
  ];

  const insightCards = [
    { label: "Peak checkout", value: peakCheckout ? peakCheckout.toString() : "--", caption: peakCheckout ? "Best tracked finish" : "No finish data yet", icon: Crown },
    { label: "Hottest scoring band", value: hottestBucket ? hottestBucket.label : "--", caption: hottestBucket ? `${hottestBucket.value.toFixed(2)} per leg` : "No bucket data", icon: Activity },
    { label: "Total 180s", value: total180s.toString(), caption: `${total140s} x 140+ and ${total100s} x 100+`, icon: Orbit },
    { label: "Board time", value: `${totalPlayWeeks.toFixed(2)} wks`, caption: formatDuration(totals.durationSeconds), icon: TimerReset },
  ];

  const recentMatches = historyChronological.slice(-6).reverse();
  const hasData = historyChronological.length > 0;
  return (
    <div className="min-h-screen bg-[#050505] text-white overflow-hidden">
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(220,38,38,0.20),transparent_30%),radial-gradient(circle_at_85%_20%,rgba(59,130,246,0.14),transparent_25%),radial-gradient(circle_at_50%_100%,rgba(255,255,255,0.06),transparent_20%)]" />
      </div>

      <div className="relative z-10 max-w-[1700px] mx-auto px-4 md:px-8 xl:px-10 pb-12">
        <header className="pt-6 pb-6">
          <div className="rounded-[28px] border border-white/10 bg-white/[0.03] backdrop-blur-xl shadow-2xl shadow-black/40 overflow-hidden">
            <div className="border-b border-white/10 px-5 md:px-7 py-5 flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex items-center gap-4">
                <button type="button" onClick={() => { if (typeof window !== "undefined" && window.history.length > 1) window.history.back(); }} className="h-11 w-11 rounded-2xl border border-white/10 bg-white/5 hover:bg-white/10 transition flex items-center justify-center">
                  <ArrowLeft size={18} />
                </button>
                <div>
                  <div className="text-[10px] md:text-xs uppercase tracking-[0.45em] text-red-300/80">Machine Darts Performance Lab</div>
                  <h1 className="mt-1 text-2xl md:text-4xl font-semibold tracking-tight">X01 Advanced Stats</h1>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-3 xl:items-end">
                <div className="min-w-[220px]">
                  <label className="block text-[10px] uppercase tracking-[0.35em] text-zinc-500 mb-2">Player</label>
                  <select className="w-full h-11 rounded-2xl bg-black/50 border border-white/10 px-4 text-sm focus:outline-none focus:ring-2 focus:ring-red-500/40" value={selectedPlayerId ?? ""} onChange={(event) => setSelectedPlayerId(event.target.value)} disabled={playersLoading || players.length === 0}>
                    {players.map((player) => (<option key={player.id} value={player.id}>{player.name}</option>))}
                  </select>
                </div>
                <button type="button" onClick={() => setReloadToken((token) => token + 1)} className="h-11 px-4 rounded-2xl border border-white/10 bg-white/5 hover:bg-white/10 transition inline-flex items-center justify-center gap-2">
                  <RefreshCw size={16} />
                  Refresh
                </button>
              </div>
            </div>

            {(playersError || statsError) && (<div className="px-5 md:px-7 pt-4 text-sm text-red-300">{playersError ?? statsError}</div>)}

            <div className="px-5 md:px-7 py-5 md:py-7 space-y-6">
              <section className="grid grid-cols-1 2xl:grid-cols-[1.3fr_0.7fr] gap-6">
                <div className="rounded-[28px] border border-white/10 bg-gradient-to-br from-red-500/15 via-white/[0.04] to-blue-500/10 p-5 md:p-7">
                  <h2 className="text-3xl md:text-5xl font-semibold tracking-tight">{selectedPlayer?.name ?? "--"}</h2>
                  <p className="mt-2 text-zinc-300 max-w-2xl">Active since {selectedPlayer ? formatDate(selectedPlayer.createdAt) : "Unknown"}.</p>
                  <div className="mt-6 flex flex-wrap gap-3">
                    <HeroPill label="Total Darts" value={totals.darts.toLocaleString()} />
                    <HeroPill label="Distance Walked" value={`${totalDistanceKm.toFixed(2)} km`} />
                    <HeroPill label="Tracked Legs" value={totals.legs.toString()} />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  {insightCards.map((item) => {
                    const Icon = item.icon;
                    return (
                      <div key={item.label} className="rounded-[24px] border border-white/10 bg-white/[0.04] p-4 md:p-5">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-[10px] uppercase tracking-[0.35em] text-zinc-500">{item.label}</div>
                          <Icon size={18} className="text-red-200" />
                        </div>
                        <div className="mt-4 text-2xl md:text-3xl font-semibold">{item.value}</div>
                        <div className="mt-1 text-xs text-zinc-500">{item.caption}</div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                {heroMetrics.map((metric) => {
                  const Icon = metric.icon;
                  return <MetricCard key={metric.title} title={metric.title} value={metric.value} subtitle={metric.sub} delta={metric.delta} icon={<Icon size={18} className="text-red-100" />} />;
                })}
              </section>

              <section className="grid grid-cols-1 xl:grid-cols-[1.15fr_0.85fr] gap-6">
                <div className="space-y-6">
                  <GlassPanel title="Average Trend" subtitle="Monthly three-dart average" accent="red">
                    <PremiumBarChart data={monthlySeries.map((point) => ({ label: point.label, value: point.average }))} tone="red" maxBars={18} showValues />
                  </GlassPanel>
                  <div className="grid grid-cols-1 2xl:grid-cols-2 gap-6">
                    <GlassPanel title="Matches Volume" subtitle="Last 90 days" accent="blue"><PremiumBarChart data={matchesPerDay} tone="blue" maxBars={90} /></GlassPanel>
                    <GlassPanel title="180 Tracker" subtitle="Last 90 days" accent="gold"><PremiumBarChart data={oneEightiesPerDay} tone="gold" maxBars={90} integerYAxis /></GlassPanel>
                  </div>
                  <GlassPanel title="Scoring Pressure Map" subtitle="Average visits per leg by scoring band" accent="red">
                    {hasData ? <HeatBuckets data={bucketPerLeg} /> : <EmptyState text="Play a few more legs to unlock the pressure map." />}
                  </GlassPanel>
                </div>

                <div className="space-y-6">
                  <GlassPanel title="Fastest Winning Legs" subtitle="Your quickest finishes" accent="gold">
                    {fastestLegs.length ? <div className="space-y-3">{fastestLegs.map((leg, index) => <SpeedRow key={`${leg.label}-${leg.darts}-${index}`} rank={index + 1} entry={leg} />)}</div> : <EmptyState text="Winning legs will appear here once tracked." />}
                  </GlassPanel>
                  <GlassPanel title="Top Checkouts" subtitle="Best tracked finishes" accent="red">
                    {highCheckouts.length ? <div className="grid grid-cols-1 gap-3">{highCheckouts.map((entry, index) => <CheckoutCard key={`${entry.value}-${index}`} rank={index + 1} entry={entry} />)}</div> : <EmptyState text="Finish more legs to unlock checkout highlights." />}
                  </GlassPanel>
                  <GlassPanel title="Recent Match Feed" subtitle="Latest tracked legs" accent="blue">
                    {recentMatches.length ? <div className="space-y-3">{recentMatches.map((match, index) => <RecentMatchRow key={`${match.finishedAt}-${index}`} match={match} />)}</div> : <EmptyState text="Recent activity will appear here." />}
                  </GlassPanel>
                </div>
              </section>

              {(playersLoading || statsLoading) && (<div className="text-sm text-zinc-400">Loading advanced stats...</div>)}
              {!statsLoading && !hasData && (<div className="text-sm text-zinc-500">No X01 history yet for this player.</div>)}
            </div>
          </div>
        </header>
      </div>
    </div>
  );
}
function MetricCard({ title, value, subtitle, delta, icon }: { title: string; value: string; subtitle: string; delta: number | null; icon: React.ReactNode; }) {
  const positive = delta !== null && delta >= 0;
  const deltaText = delta === null ? "No comparison" : `${positive ? "+" : ""}${delta.toFixed(1)} vs previous`;
  return (
    <div className="rounded-[24px] border border-white/10 bg-white/[0.04] p-4 md:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.35em] text-zinc-500">{title}</div>
          <div className="mt-3 text-3xl font-semibold tracking-tight">{value}</div>
          <div className="mt-1 text-sm text-zinc-400">{subtitle}</div>
        </div>
        <div className="h-11 w-11 rounded-2xl border border-white/10 bg-white/5 flex items-center justify-center">{icon}</div>
      </div>
      <div className="mt-4 flex items-center gap-2 text-xs">
        <span className={`rounded-full px-2 py-1 border ${delta === null ? "border-white/10 text-zinc-500" : positive ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-red-500/30 bg-red-500/10 text-red-300"}`}>{deltaText}</span>
      </div>
    </div>
  );
}

function GlassPanel({ title, subtitle, accent, children }: { title: string; subtitle?: string; accent?: "red" | "blue" | "gold"; children: React.ReactNode; }) {
  const accentGlow = accent === "blue" ? "from-blue-500/14" : accent === "gold" ? "from-amber-500/14" : "from-red-500/14";
  return (
    <div className="relative overflow-hidden rounded-[28px] border border-white/10 bg-white/[0.04] p-5 md:p-6">
      <div className={`pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b ${accentGlow} to-transparent`} />
      <div className="relative">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.35em] text-zinc-500">{title}</div>
            {subtitle ? <div className="mt-2 text-sm text-zinc-400">{subtitle}</div> : null}
          </div>
          <div className="h-9 w-9 rounded-2xl border border-white/10 bg-white/5 flex items-center justify-center text-zinc-400"><ChevronRight size={16} /></div>
        </div>
        <div className="mt-5">{children}</div>
      </div>
    </div>
  );
}

function PremiumBarChart({
  data,
  tone,
  maxBars = 60,
  showValues = false,
  integerYAxis = false,
}: {
  data: ChartPoint[];
  tone: "red" | "blue" | "gold";
  maxBars?: number;
  showValues?: boolean;
  integerYAxis?: boolean;
}) {
  const safeData = Array.isArray(data) ? data : [];
  if (!safeData.length) return <EmptyState text="No data yet." />;
  const sliced = safeData.slice(-maxBars);
  const maxValue = Math.max(...sliced.map((point) => point.value), 1);
  const toneClasses = tone === "blue" ? "from-blue-400 via-cyan-300 to-blue-700" : tone === "gold" ? "from-amber-300 via-yellow-200 to-amber-600" : "from-red-400 via-rose-300 to-red-700";
  const yTicks = buildYAxisTicks(maxValue, integerYAxis);

  return (
    <div className="space-y-3">
      <div className="flex gap-3 h-56">
        <div className="w-10 flex flex-col justify-between text-[10px] text-zinc-500">
          {yTicks.map((tick, i) => (
            <span key={i}>{integerYAxis ? Math.round(tick).toString() : (Number.isInteger(tick) ? tick.toFixed(0) : tick.toFixed(1))}</span>
          ))}
        </div>
        <div className="flex-1 flex items-end gap-1 md:gap-1.5">
          {sliced.map((point, index) => {
            const height = Math.max(8, (point.value / maxValue) * 100);
            return (
              <div key={`${point.label}-${index}`} className="flex-1 min-w-0 flex flex-col items-center justify-end gap-2 h-full">
                {showValues ? <div className="text-[10px] text-zinc-500">{point.value.toFixed(1)}</div> : <div className="h-4" />}
                <div className="w-full h-full rounded-t-[14px] bg-white/[0.04] border border-white/5 relative overflow-hidden flex items-end">
                  <div className={`w-full rounded-t-[14px] bg-gradient-to-t ${toneClasses}`} style={{ height: `${height}%` }} />
                </div>
                {index % Math.max(1, Math.floor(sliced.length / 6)) === 0 ? <div className="text-[10px] text-zinc-500 text-center leading-tight whitespace-nowrap max-w-full">{point.label}</div> : <div className="h-4" />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function buildYAxisTicks(maxValue: number, integerYAxis: boolean): number[] {
  if (!integerYAxis) return [maxValue, maxValue * 0.75, maxValue * 0.5, maxValue * 0.25, 0];
  const top = Math.max(1, Math.ceil(maxValue));
  const raw = Array.from({ length: 5 }, (_, i) => Math.round(top - (top * i) / 4));
  const unique = Array.from(new Set(raw)).sort((a, b) => b - a);
  if (unique[unique.length - 1] !== 0) unique.push(0);
  return unique;
}

function HeatBuckets({ data }: { data: { key: string; label: string; value: number }[] }) {
  if (!data.length) return <EmptyState text="No scoring-band data yet." />;
  const max = Math.max(...data.map((item) => item.value), 1);
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
      {data.map((item) => {
        const intensity = item.value / max;
        return (
          <div key={item.key} className="rounded-[22px] border border-white/10 p-4" style={{ background: `linear-gradient(180deg, rgba(239,68,68,${0.10 + intensity * 0.35}), rgba(255,255,255,0.02))` }}>
            <div className="text-[10px] uppercase tracking-[0.3em] text-zinc-400">{item.label}</div>
            <div className="mt-5 text-2xl font-semibold">{item.value.toFixed(2)}</div>
          </div>
        );
      })}
    </div>
  );
}

function SpeedRow({ rank, entry }: { rank: number; entry: FastestLegEntry }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/30 p-3">
      <div className="flex items-center gap-3">
        <div className="h-11 w-11 rounded-2xl bg-gradient-to-br from-amber-300/25 to-red-500/15 border border-white/10 flex items-center justify-center text-sm font-semibold text-white">#{rank}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-zinc-300">{entry.label}</div>
            <div className="text-lg font-semibold">{entry.darts} darts</div>
          </div>
          <div className="mt-2 text-xs text-zinc-500">Repeated {entry.count} time{entry.count === 1 ? "" : "s"}</div>
        </div>
      </div>
    </div>
  );
}

function CheckoutCard({ rank, entry }: { rank: number; entry: CheckoutEntry }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/30 p-4 flex items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <div className="h-11 w-11 rounded-2xl border border-red-400/20 bg-red-500/10 flex items-center justify-center text-sm font-semibold text-red-100">#{rank}</div>
        <div>
          <div className="text-xs uppercase tracking-[0.3em] text-zinc-500">Checkout</div>
          <div className="text-2xl font-semibold">{entry.value}</div>
        </div>
      </div>
      <div className="text-right"><div className="text-xs uppercase tracking-[0.3em] text-zinc-500">Count</div><div className="text-lg font-semibold text-white">x{entry.count}</div></div>
    </div>
  );
}

function RecentMatchRow({ match }: { match: HistoryRecord }) {
  const score = extractX01Summary(match);
  const resultTone = match.won ? "text-emerald-300 border-emerald-500/30 bg-emerald-500/10" : "text-zinc-300 border-white/10 bg-white/5";
  return (
    <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm text-white">{formatShortDate(match.finishedAt)}</div>
          <div className="text-xs text-zinc-500 mt-1">{score.score} scored - {match.darts} darts - {score.checkoutSuccesses}/{score.checkoutAttempts} finishes</div>
        </div>
        <div className={`rounded-full px-3 py-1 text-xs border ${resultTone}`}>{match.won ? "Won" : "Played"}</div>
      </div>
    </div>
  );
}

function HeroPill({ label, value }: { label: string; value: string }) {
  return <div className="rounded-full border border-white/10 bg-black/30 px-4 py-2"><span className="text-[10px] uppercase tracking-[0.3em] text-zinc-500 mr-2">{label}</span><span className="text-sm font-medium text-white">{value}</span></div>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-4 py-8 text-center text-sm text-zinc-500">{text}</div>;
}
function summarizeTotals(history: HistoryRecord[]) {
  let legsWon = 0;
  let darts = 0;
  let durationSeconds = 0;
  let visits = 0;
  history.forEach((record) => {
    if (record.won) legsWon += 1;
    darts += Number(record.darts ?? 0);
    const start = Date.parse(record.startedAt);
    const end = Date.parse(record.finishedAt);
    if (!Number.isNaN(start) && !Number.isNaN(end)) durationSeconds += Math.max(0, (end - start) / 1000);
    visits += Math.max(1, Math.ceil((record.darts ?? 0) / 3));
  });
  const legs = history.length;
  const winRate = legs ? legsWon / legs : 0;
  const distanceKm = (visits * 4.74) / 1000;
  return { legs, legsWon, darts, winRate, durationSeconds, distanceKm };
}

function buildPeriodSeries(history: HistoryRecord[]): PeriodPoint[] {
  const bucketMap = new Map<string, { label: string; records: HistoryRecord[] }>();
  history.forEach((record) => {
    const finished = new Date(record.finishedAt);
    if (Number.isNaN(finished.getTime())) return;
    const key = monthKey(finished);
    const label = formatMonthLabel(key);
    const existing = bucketMap.get(key);
    if (existing) existing.records.push(record);
    else bucketMap.set(key, { label, records: [record] });
  });
  return Array.from(bucketMap.entries()).sort(([a], [b]) => (a > b ? 1 : -1)).map(([key, payload]) => {
    const summary = summarizePeriod(payload.records);
    return { key, label: payload.label, average: summary.average };
  });
}

function buildMatchesPerDay(history: HistoryRecord[]): ChartPoint[] {
  const counts = new Map<string, number>();
  history.forEach((record) => {
    const key = (record.finishedAt || "").slice(0, 10);
    if (!key) return;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return Array.from(counts.entries()).sort(([a], [b]) => (a > b ? 1 : -1)).map(([key, value]) => ({ label: formatDayLabel(key), value }));
}

function build180sPerDay(history: HistoryRecord[]): ChartPoint[] {
  const counts = new Map<string, number>();
  history.forEach((record) => {
    const key = (record.finishedAt || "").slice(0, 10);
    if (!key) return;
    const visitBuckets = extractVisitBuckets(record);
    const value = Number(visitBuckets["180"] ?? 0);
    counts.set(key, (counts.get(key) ?? 0) + value);
  });
  return Array.from(counts.entries()).sort(([a], [b]) => (a > b ? 1 : -1)).map(([key, value]) => ({ label: formatDayLabel(key), value }));
}

function buildFastestLegs(history: HistoryRecord[]): FastestLegEntry[] {
  const buckets = new Map<number, { count: number; date: string }>();
  history.forEach((record) => {
    if (!record.won) return;
    const darts = Number(record.darts ?? 0);
    if (!Number.isFinite(darts) || darts <= 0) return;
    const existing = buckets.get(darts);
    if (existing) {
      existing.count += 1;
      existing.date = record.finishedAt;
    } else {
      buckets.set(darts, { count: 1, date: record.finishedAt });
    }
  });
  return Array.from(buckets.entries()).sort(([a], [b]) => a - b).slice(0, 10).map(([darts, meta]) => ({ darts, count: meta.count, label: formatShortDate(meta.date) }));
}

function buildHighCheckouts(history: HistoryRecord[]): CheckoutEntry[] {
  const buckets = new Map<number, number>();
  history.forEach((record) => {
    const checkout = extractCheckoutScore(record);
    if (checkout > 0) buckets.set(checkout, (buckets.get(checkout) ?? 0) + 1);
  });
  return Array.from(buckets.entries()).sort(([a], [b]) => b - a).slice(0, 5).map(([value, count]) => ({ value, count }));
}

function buildPerLegBucketsFromHistory(history: HistoryRecord[]): Record<string, number> {
  const legs = history.length;
  if (!legs) return {};
  const totals: Record<string, number> = Object.fromEntries(BUCKET_KEYS.map((key) => [key, 0]));
  for (const record of history) {
    const summary = record.summary ?? {};
    const visitBuckets = (summary.visitBuckets ?? {}) as Record<string, number>;
    let trackedVisits = 0;
    for (const key of BUCKET_KEYS) {
      if (key === "40under") continue;
      const value = Number(visitBuckets[key] ?? 0);
      if (Number.isFinite(value) && value > 0) {
        totals[key] += value;
        trackedVisits += value;
      }
    }
    const totalVisits = Number(summary.visitCount ?? 0);
    const explicitUnder40 = Number(visitBuckets["40under"] ?? 0);
    if (Number.isFinite(explicitUnder40) && explicitUnder40 > 0) {
      totals["40under"] += explicitUnder40;
    } else if (Number.isFinite(totalVisits) && totalVisits >= trackedVisits) {
      totals["40under"] += totalVisits - trackedVisits;
    }
  }
  for (const key of BUCKET_KEYS) totals[key] = legs > 0 ? totals[key] / legs : 0;
  return totals;
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
  return { average: darts ? (score / darts) * 3 : 0, checkout: attempts ? (successes / attempts) * 100 : 0, dartsPerLeg: records.length ? darts / records.length : 0 };
}

function extractX01Summary(record: HistoryRecord) {
  const summary = record.summary ?? {};
  return {
    darts: Number(summary.darts ?? record.darts ?? 0),
    score: Number(summary.score ?? 0),
    checkoutAttempts: Number(summary.checkoutAttempts ?? 0),
    checkoutSuccesses: Number(summary.checkoutSuccesses ?? 0),
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
  if (!record.won) return 0;
  const summary = record.summary ?? {};
  const visits = Array.isArray(summary.visits) ? summary.visits : null;
  if (!visits || !visits.length) return 0;
  const value = Number(visits[visits.length - 1] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function monthKey(date: Date) { return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`; }

function formatMonthLabel(key: string) {
  const [year, month] = key.split("-");
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
  return date.toLocaleString(undefined, { month: "short", year: "numeric" });
}

function formatDayLabel(key: string) {
  const date = new Date(`${key}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return key;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatShortDate(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatDate(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString(undefined, { dateStyle: "medium" });
}

function formatDuration(totalSeconds: number) {
  if (!totalSeconds) return "0h 00m";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
}

function computeMomentumScore(averagePpr: number, checkoutPct: number, total180s: number, legs: number) {
  const pprScore = Math.min(50, averagePpr * 0.75);
  const checkoutScore = Math.min(30, checkoutPct * 0.3);
  const heavyScore = Math.min(20, legs ? (total180s / Math.max(legs, 1)) * 40 : 0);
  return Math.round(pprScore + checkoutScore + heavyScore);
}
