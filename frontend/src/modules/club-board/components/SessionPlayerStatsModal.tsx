import React from "react";
import { useLocation } from "react-router-dom";

import { useLobby } from "../../../game/context/LobbyContext";
import { API_BASE_URL } from "../../../services/api";

type PlayerStatsResponse = {
  player?: { name?: string };
  history?: Array<Record<string, unknown>>;
  modes?: {
    x01?: {
      overall?: {
        legs?: number;
        legsWon?: number;
        averages?: {
          ppr?: { current?: number };
          firstNine?: { current?: number };
          pprTo170?: { current?: number };
        };
        checkout?: {
          attempts?: number;
          successes?: number;
          percentage?: { current?: number };
        };
        buckets?: {
          total?: Record<string, number>;
        };
      };
    };
    cricket?: { overall?: { legs?: number; legsWon?: number; averages?: { mpr?: { current?: number } } } };
    around_the_clock?: { overall?: { legs?: number; legsWon?: number; averages?: { accuracy?: { current?: number } } } };
  };
};

const X01_BUCKET_LABELS: Array<{ key: string; label: string }> = [
  { key: "40plus", label: "40+" },
  { key: "60plus", label: "60+" },
  { key: "80plus", label: "80+" },
  { key: "100plus", label: "100+" },
  { key: "120plus", label: "120+" },
  { key: "140plus", label: "140+" },
  { key: "170plus", label: "170+" },
  { key: "180", label: "180" },
];

function round(value: number | undefined, digits: number = 2): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "0.00";
  return n.toFixed(digits);
}

export default function SessionPlayerStatsModal() {
  const { state } = useLobby();
  const location = useLocation();
  const [open, setOpen] = React.useState(false);
  const [selectedProfileId, setSelectedProfileId] = React.useState<string>("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string>("");
  const [stats, setStats] = React.useState<PlayerStatsResponse | null>(null);

  const inKioskSetup =
    location.pathname.startsWith("/kiosk") || location.pathname === "/setup" || location.pathname === "/";

  const profilePlayers = React.useMemo(
    () =>
      state.players
        .filter((p) => !p.isBot && p.profileId)
        .map((p, idx) => ({
          key: `${p.profileId}-${idx}`,
          profileId: String(p.profileId || ""),
          label: p.name || `Player ${idx + 1}`,
        })),
    [state.players],
  );

  React.useEffect(() => {
    if (!profilePlayers.length) {
      setSelectedProfileId("");
      return;
    }
    if (!selectedProfileId || !profilePlayers.some((p) => p.profileId === selectedProfileId)) {
      setSelectedProfileId(profilePlayers[0].profileId);
    }
  }, [profilePlayers, selectedProfileId]);

  React.useEffect(() => {
    if (!open || !selectedProfileId) return;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError("");
      try {
        const res = await fetch(`${API_BASE_URL}/api/players/${encodeURIComponent(selectedProfileId)}/stats`);
        if (!res.ok) throw new Error(`Failed to load stats (${res.status})`);
        const data = (await res.json()) as PlayerStatsResponse;
        if (!cancelled) setStats(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load stats");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [open, selectedProfileId]);

  if (inKioskSetup || !profilePlayers.length) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-40 rounded-xl border border-red-600/70 bg-red-600/90 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-red-900/40 hover:bg-red-500"
      >
        Player Stats
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-3xl rounded-2xl border border-white/10 bg-zinc-900/95 p-5 md:p-6 text-white">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-2xl font-extrabold">Player Stats</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
              >
                Close
              </button>
            </div>

            <div className="mt-4">
              <label className="text-xs uppercase tracking-[0.25em] text-zinc-400">Profile</label>
              <select
                value={selectedProfileId}
                onChange={(e) => setSelectedProfileId(e.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-700 bg-black/60 px-3 py-2"
              >
                {profilePlayers.map((p) => (
                  <option key={p.key} value={p.profileId}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            {loading && <div className="mt-5 text-sm text-zinc-300">Loading stats...</div>}
            {error && <div className="mt-5 text-sm text-red-300">{error}</div>}

            {!loading && !error && stats && (
              <div className="mt-5 space-y-4">
                <div className="rounded-xl border border-white/10 bg-black/40 p-4">
                  <div className="text-sm text-zinc-400">Player</div>
                  <div className="text-2xl font-bold">{stats.player?.name || "Unknown"}</div>
                  <div className="text-sm text-zinc-300 mt-1">Matches logged: {stats.history?.length ?? 0}</div>
                </div>

                <div className="grid md:grid-cols-3 gap-3">
                  <div className="rounded-xl border border-white/10 bg-black/40 p-4">
                    <div className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-2">X01</div>
                    <div className="text-sm text-zinc-200">Legs: {stats.modes?.x01?.overall?.legs ?? 0}</div>
                    <div className="text-sm text-zinc-200">Won: {stats.modes?.x01?.overall?.legsWon ?? 0}</div>
                    <div className="text-sm text-cyan-300 mt-1">PPR: {round(stats.modes?.x01?.overall?.averages?.ppr?.current)}</div>
                    <div className="text-sm text-cyan-300">First 9 Avg: {round(stats.modes?.x01?.overall?.averages?.firstNine?.current)}</div>
                    <div className="text-sm text-cyan-300">Avg To 170: {round(stats.modes?.x01?.overall?.averages?.pprTo170?.current)}</div>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-black/40 p-4">
                    <div className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-2">Cricket</div>
                    <div className="text-sm text-zinc-200">Legs: {stats.modes?.cricket?.overall?.legs ?? 0}</div>
                    <div className="text-sm text-zinc-200">Won: {stats.modes?.cricket?.overall?.legsWon ?? 0}</div>
                    <div className="text-sm text-cyan-300 mt-1">MPR: {round(stats.modes?.cricket?.overall?.averages?.mpr?.current)}</div>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-black/40 p-4">
                    <div className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-2">Around The Clock</div>
                    <div className="text-sm text-zinc-200">Legs: {stats.modes?.around_the_clock?.overall?.legs ?? 0}</div>
                    <div className="text-sm text-zinc-200">Won: {stats.modes?.around_the_clock?.overall?.legsWon ?? 0}</div>
                    <div className="text-sm text-cyan-300 mt-1">
                      Accuracy: {round(stats.modes?.around_the_clock?.overall?.averages?.accuracy?.current)}%
                    </div>
                  </div>
                </div>

                <div className="grid md:grid-cols-2 gap-3">
                  <div className="rounded-xl border border-white/10 bg-black/40 p-4">
                    <div className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-2">X01 Big Scores</div>
                    <div className="grid grid-cols-4 gap-2 text-sm">
                      {X01_BUCKET_LABELS.map((bucket) => (
                        <div key={bucket.key} className="rounded border border-zinc-800 bg-zinc-900/60 px-2 py-1">
                          <div className="text-zinc-400 text-[11px]">{bucket.label}</div>
                          <div className="text-cyan-300 font-semibold">
                            {stats.modes?.x01?.overall?.buckets?.total?.[bucket.key] ?? 0}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-black/40 p-4">
                    <div className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-2">X01 Checkout</div>
                    <div className="space-y-1 text-sm text-zinc-200">
                      <div>Attempts: {stats.modes?.x01?.overall?.checkout?.attempts ?? 0}</div>
                      <div>Successes: {stats.modes?.x01?.overall?.checkout?.successes ?? 0}</div>
                      <div className="text-cyan-300">
                        Checkout %: {round(stats.modes?.x01?.overall?.checkout?.percentage?.current)}%
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
