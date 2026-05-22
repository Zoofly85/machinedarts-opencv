import React from "react";
import { Activity, BarChart3, Gauge, RefreshCw, TrendingUp, Users } from "lucide-react";
import { Link } from "react-router-dom";

import type { OwnerAnalyticsDashboardPayload } from "../../services/ownerAnalyticsDashboard";
import { getOwnerAnalyticsDashboard } from "../../services/ownerAnalyticsDashboard";

type LinePoint = {
  label: string;
  value: number;
};

function formatDateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatMonthLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
}

function KpiCard({
  title,
  value,
  hint,
  icon,
}: {
  title: string;
  value: string;
  hint: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-[24px] border border-white/10 bg-zinc-950/80 p-5 shadow-[0_18px_45px_rgba(0,0,0,0.35)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">{title}</div>
          <div className="mt-3 text-4xl font-black text-white tabular-nums">{value}</div>
          <div className="mt-2 text-sm text-zinc-400">{hint}</div>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/5 p-3 text-zinc-200">{icon}</div>
      </div>
    </div>
  );
}

function EmptyCard({ title, message }: { title: string; message: string }) {
  return (
    <div className="rounded-[24px] border border-dashed border-white/10 bg-zinc-950/70 p-6">
      <div className="text-sm font-semibold text-white">{title}</div>
      <div className="mt-2 text-sm text-zinc-400">{message}</div>
    </div>
  );
}

function LineChartCard({
  title,
  subtitle,
  points,
  color,
}: {
  title: string;
  subtitle: string;
  points: LinePoint[];
  color: string;
}) {
  if (!points.length) {
    return <EmptyCard title={title} message="No data yet for this chart." />;
  }

  const width = 640;
  const height = 220;
  const padding = 28;
  const maxValue = Math.max(...points.map((point) => point.value), 1);
  const usableWidth = width - padding * 2;
  const usableHeight = height - padding * 2;
  const stepX = points.length > 1 ? usableWidth / (points.length - 1) : 0;

  const coordinates = points.map((point, index) => {
    const x = padding + index * stepX;
    const y = padding + usableHeight - (point.value / maxValue) * usableHeight;
    return { ...point, x, y };
  });

  const linePath = coordinates
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");
  const areaPath = `${linePath} L ${coordinates[coordinates.length - 1].x.toFixed(2)} ${(height - padding).toFixed(2)} L ${coordinates[0].x.toFixed(2)} ${(height - padding).toFixed(2)} Z`;

  return (
    <div className="rounded-[24px] border border-white/10 bg-zinc-950/80 p-6 shadow-[0_18px_45px_rgba(0,0,0,0.35)]">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-lg font-semibold text-white">{title}</div>
          <div className="mt-1 text-sm text-zinc-400">{subtitle}</div>
        </div>
        <div className="text-right">
          <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Latest</div>
          <div className="mt-1 text-2xl font-bold text-white tabular-nums">{points[points.length - 1].value}</div>
        </div>
      </div>

      <div className="mt-5">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-56 w-full overflow-visible">
          <defs>
            <linearGradient id={`line-fill-${title.replace(/\s+/g, "-").toLowerCase()}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.34" />
              <stop offset="100%" stopColor={color} stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
            const y = padding + usableHeight - tick * usableHeight;
            return (
              <line
                key={tick}
                x1={padding}
                y1={y}
                x2={width - padding}
                y2={y}
                stroke="rgba(255,255,255,0.08)"
                strokeWidth="1"
              />
            );
          })}
          <path d={areaPath} fill={`url(#line-fill-${title.replace(/\s+/g, "-").toLowerCase()})`} />
          <path d={linePath} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          {coordinates.map((point) => (
            <circle key={point.label} cx={point.x} cy={point.y} r="4.5" fill={color} />
          ))}
        </svg>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 overflow-hidden text-[11px] uppercase tracking-[0.18em] text-zinc-500">
        <span>{coordinates[0]?.label}</span>
        <span>{coordinates[Math.floor((coordinates.length - 1) / 2)]?.label}</span>
        <span>{coordinates[coordinates.length - 1]?.label}</span>
      </div>
    </div>
  );
}

function BarChartCard({
  title,
  subtitle,
  points,
  color,
}: {
  title: string;
  subtitle: string;
  points: LinePoint[];
  color: string;
}) {
  if (!points.length) {
    return <EmptyCard title={title} message="No data yet for this chart." />;
  }

  const maxValue = Math.max(...points.map((point) => point.value), 1);

  return (
    <div className="rounded-[24px] border border-white/10 bg-zinc-950/80 p-6 shadow-[0_18px_45px_rgba(0,0,0,0.35)]">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-lg font-semibold text-white">{title}</div>
          <div className="mt-1 text-sm text-zinc-400">{subtitle}</div>
        </div>
      </div>

      <div className="mt-5 flex h-56 items-end gap-3">
        {points.map((point) => {
          const percent = Math.max(4, Math.round((point.value / maxValue) * 100));
          return (
            <div key={point.label} className="flex min-w-0 flex-1 flex-col items-center gap-2">
              <div className="text-xs font-semibold text-zinc-300 tabular-nums">{point.value}</div>
              <div className="flex h-44 w-full items-end rounded-t-2xl bg-white/[0.04] px-1">
                <div
                  className="w-full rounded-t-xl shadow-[0_10px_20px_rgba(0,0,0,0.25)]"
                  style={{
                    height: `${percent}%`,
                    background: `linear-gradient(180deg, ${color}, rgba(255,255,255,0.08))`,
                  }}
                />
              </div>
              <div className="truncate text-[11px] uppercase tracking-[0.14em] text-zinc-500">{point.label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AccuracyTable({ rows }: { rows: OwnerAnalyticsDashboardPayload["x01QualityPerMonth"] }) {
  if (!rows.length) {
    return <EmptyCard title="X01 Quality" message="Finish a few local X01 matches to see monthly quality trends." />;
  }

  return (
    <div className="rounded-[24px] border border-white/10 bg-zinc-950/80 p-6 shadow-[0_18px_45px_rgba(0,0,0,0.35)]">
      <div className="text-lg font-semibold text-white">X01 Quality Snapshot</div>
      <div className="mt-1 text-sm text-zinc-400">Monthly estimated accuracy proxy and average corrections per match.</div>
      <div className="mt-5 overflow-hidden rounded-2xl border border-white/10">
        <div className="grid grid-cols-4 bg-white/[0.04] px-4 py-3 text-[11px] uppercase tracking-[0.18em] text-zinc-500">
          <div>Month</div>
          <div>Accuracy</div>
          <div>Corrections</div>
          <div>Matches</div>
        </div>
        {rows.map((row) => (
          <div
            key={row.month}
            className="grid grid-cols-4 border-t border-white/10 px-4 py-3 text-sm text-zinc-200 tabular-nums"
          >
            <div>{formatMonthLabel(String(row.month || ""))}</div>
            <div>{((Number(row.avg_estimated_accuracy || 0) || 0) * 100).toFixed(1)}%</div>
            <div>{Number(row.avg_corrections_per_match || 0).toFixed(2)}</div>
            <div>{Number(row.matches_played || 0)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function OwnerAnalyticsPage() {
  const [data, setData] = React.useState<OwnerAnalyticsDashboardPayload | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const payload = await getOwnerAnalyticsDashboard();
        if (!cancelled) {
          setData(payload);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load owner analytics");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const dailyAppOpens = React.useMemo(
    () =>
      (data?.dailyAppOpens ?? []).map((row) => ({
        label: formatDateLabel(String(row.day || "")),
        value: Number(row.app_opens || 0),
      })),
    [data],
  );
  const matchesPerDay = React.useMemo(
    () =>
      (data?.matchesPerDay ?? []).map((row) => ({
        label: formatDateLabel(String(row.day || "")),
        value: Number(row.matches_played || 0),
      })),
    [data],
  );
  const monthlyActiveInstalls = React.useMemo(
    () =>
      (data?.monthlyActiveInstalls ?? []).map((row) => ({
        label: formatMonthLabel(String(row.month || "")),
        value: Number(row.active_installs || 0),
      })),
    [data],
  );
  const dartsPerMonth = React.useMemo(
    () =>
      (data?.dartsPerMonth ?? []).map((row) => ({
        label: formatMonthLabel(String(row.month || "")),
        value: Number(row.total_darts || 0),
      })),
    [data],
  );

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(34,197,94,0.12),transparent_28%),radial-gradient(circle_at_top_right,rgba(59,130,246,0.16),transparent_32%),linear-gradient(180deg,#06070a_0%,#0d1017_55%,#070a0f_100%)] text-white">
      <div className="mx-auto max-w-[92rem] px-4 py-8 md:px-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-emerald-300/70">Workspace Analytics</div>
            <h1 className="mt-3 text-4xl font-black tracking-tight">Owner Analytics Dashboard</h1>
            <p className="mt-3 max-w-3xl text-sm text-zinc-400">
              Local-only dashboard for your Supabase owner metrics. This page reads backend aggregates, so your private
              Supabase secret stays out of the frontend.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setRefreshKey((value) => value + 1)}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-white/10"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
            <Link
              to="/"
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-white/10"
            >
              Back Home
            </Link>
          </div>
        </div>

        {loading && (
          <div className="mt-8 rounded-[24px] border border-white/10 bg-zinc-950/80 px-6 py-5 text-sm text-zinc-300">
            Loading owner analytics...
          </div>
        )}

        {error && (
          <div className="mt-8 rounded-[24px] border border-red-500/30 bg-red-950/30 px-6 py-5 text-sm text-red-200">
            {error}
            <div className="mt-2 text-red-300/80">
              Make sure you ran `docs/supabase-owner-analytics-views.sql` in Supabase after creating the base tables.
            </div>
          </div>
        )}

        {!loading && !error && data && (
          <>
            <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              <KpiCard
                title="Last 30 App Opens"
                value={String(data.overview.last30AppOpens)}
                hint="Recent app activity across all tracked installs."
                icon={<Activity className="h-5 w-5" />}
              />
              <KpiCard
                title="Last 30 Matches"
                value={String(data.overview.last30Matches)}
                hint="Finished local X01 matches recorded this month window."
                icon={<BarChart3 className="h-5 w-5" />}
              />
              <KpiCard
                title="Current Month Installs"
                value={String(data.overview.currentMonthActiveInstalls)}
                hint="Unique installs that opened the app this month."
                icon={<Users className="h-5 w-5" />}
              />
              <KpiCard
                title="12-Month Darts"
                value={String(data.overview.last12MonthsDarts)}
                hint="Total darts thrown in recorded local X01 matches."
                icon={<TrendingUp className="h-5 w-5" />}
              />
              <KpiCard
                title="Latest Accuracy Proxy"
                value={`${(data.overview.latestEstimatedAccuracy * 100).toFixed(1)}%`}
                hint="Monthly average based on correction activity."
                icon={<Gauge className="h-5 w-5" />}
              />
              <KpiCard
                title="Corrections / Match"
                value={data.overview.latestAvgCorrectionsPerMatch.toFixed(2)}
                hint="Average manual corrections in the latest month bucket."
                icon={<RefreshCw className="h-5 w-5" />}
              />
            </div>

            <div className="mt-8 grid grid-cols-1 gap-6 xl:grid-cols-2">
              <LineChartCard
                title="Daily App Opens"
                subtitle="Rolling daily usage over the last 30 tracked days."
                points={dailyAppOpens}
                color="#22c55e"
              />
              <LineChartCard
                title="Daily Matches"
                subtitle="Finished local X01 matches per day."
                points={matchesPerDay}
                color="#3b82f6"
              />
              <BarChartCard
                title="Monthly Active Installs"
                subtitle="Unique installs opening the app each month."
                points={monthlyActiveInstalls}
                color="#f59e0b"
              />
              <BarChartCard
                title="Monthly Darts Thrown"
                subtitle="Total darts thrown in recorded local X01 matches."
                points={dartsPerMonth}
                color="#ef4444"
              />
            </div>

            <div className="mt-8">
              <AccuracyTable rows={data.x01QualityPerMonth} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
