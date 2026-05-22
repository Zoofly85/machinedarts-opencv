import React, { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { PlayerConfig } from "../context/LobbyContext";

interface DartScore {
  score: number;
  multiplier: number;
  segment: string;
  zone: string;
  confidence: number;
}

interface AroundTheClockPlayerState {
  name: string;
  currentTarget: number;
  dartsThrown: number;
  hitsPerTarget: number[];
  finished: boolean;
  legsWon: number;
  setsWon: number;
  isBot?: boolean;
  botLevel?: number;
}

interface AroundTheClockStats {
  darts: number;
  targetsHit: number;
  totalTargets: number;
  overallAccuracy: number;
  targetAccuracies: number[];
}

interface AroundTheClockLegStatsEntry {
  setNumber?: number;
  legNumber?: number;
  winnerIndex?: number | null;
  stats: AroundTheClockStats[];
}

interface AroundTheClockState {
  mode: string;
  currentPlayer: number | null;
  players: AroundTheClockPlayerState[];
  currentTurn: {
    darts: (DartScore | null)[];
  };
  lastCompletedTurn: (DartScore | null)[];
  winner: number | null;
  match: {
    legsPerSet: number;
    setsToWin: number;
    currentSet: number;
    currentLeg: number;
    legWinner: number | null;
    setWinner: number | null;
    matchWinner: number | null;
  };
  stats?: AroundTheClockStats[];
  matchStats?: AroundTheClockStats[];
  legStats?: AroundTheClockLegStatsEntry[];
}

interface StatsLocationState {
  summary?: AroundTheClockState;
  players?: PlayerConfig[];
}

const AroundTheClockStatsPage: React.FC = () => {
  const navigate = useNavigate();
  const { state } = useLocation() as { state?: StatsLocationState };
  const summary = state?.summary;

  const configPlayers: PlayerConfig[] | undefined = useMemo(() => {
    const raw = state?.players;
    return Array.isArray(raw) ? (raw as PlayerConfig[]) : undefined;
  }, [state?.players]);

  const playerRows = useMemo(() => summary?.players ?? [], [summary?.players]);

  const fallbackStats = useMemo<AroundTheClockStats[]>(() => {
    if (!summary) {
      return [];
    }
    if (Array.isArray(summary.stats) && summary.stats.length === playerRows.length) {
      return summary.stats;
    }
    return playerRows.map(() => ({
      darts: 0,
      targetsHit: 0,
      totalTargets: 0,
      overallAccuracy: 0,
      targetAccuracies: [],
    }));
  }, [summary, playerRows]);

  const matchStats = useMemo(() => {
    if (summary && Array.isArray(summary.matchStats) && summary.matchStats.length === playerRows.length) {
      return summary.matchStats;
    }
    return fallbackStats;
  }, [summary, playerRows, fallbackStats]);

  const legStatsOptions = useMemo<AroundTheClockLegStatsEntry[]>(() => {
    if (summary && Array.isArray(summary.legStats) && summary.legStats.length) {
      return summary.legStats;
    }
    if (fallbackStats.length) {
      return [
        {
          setNumber: summary?.match?.currentSet,
          legNumber: summary?.match?.currentLeg,
          winnerIndex: summary?.match?.legWinner ?? summary?.winner ?? null,
          stats: fallbackStats,
        },
      ];
    }
    return [];
  }, [summary, fallbackStats]);

  const hasLegStats = legStatsOptions.length > 0;

  const [selectedScope, setSelectedScope] = useState<"match" | number>("match");

  useEffect(() => {
    if (selectedScope !== "match" && (selectedScope < 0 || selectedScope >= legStatsOptions.length)) {
      setSelectedScope("match");
    }
  }, [selectedScope, legStatsOptions.length]);

  const statsForScope = useMemo(() => {
    if (selectedScope === "match") {
      return matchStats;
    }
    if (typeof selectedScope === "number") {
      const entry = legStatsOptions[selectedScope];
      return entry?.stats ?? matchStats;
    }
    return matchStats;
  }, [selectedScope, matchStats, legStatsOptions]);

  const scopedStatsAligned = useMemo(() => {
    if (!playerRows.length) {
      return [];
    }
    return playerRows.map((_, index) => {
      const stats = statsForScope[index];
      if (stats) {
        return stats;
      }
      return {
        darts: 0,
        targetsHit: 0,
        totalTargets: 0,
        overallAccuracy: 0,
        targetAccuracies: [],
      } as AroundTheClockStats;
    });
  }, [playerRows, statsForScope]);

  const activeLegMeta = typeof selectedScope === "number" ? legStatsOptions[selectedScope] : undefined;

  const scopeButtonClasses = (isActive: boolean) =>
    `px-3 py-2 rounded-lg border text-xs uppercase tracking-[0.3em] transition-colors ${
      isActive
        ? "border-red-500/80 bg-red-600/20 text-red-200"
        : "border-white/10 bg-zinc-900/60 text-zinc-300 hover:border-white/30 hover:text-white"
    }`;

  // Redirect to lobby if no summary data
  useEffect(() => {
    if (!summary) {
      navigate("/lobby", { replace: true });
    }
  }, [summary, navigate]);

  if (!summary) {
    return null;
  }

  const atcState = summary;

  const getModeColor = (mode: string): string => {
    switch (mode) {
      case "full":
        return "text-emerald-400";
      case "single":
        return "text-blue-400";
      case "double":
        return "text-orange-400";
      case "triple":
        return "text-red-400";
      default:
        return "text-white";
    }
  };

  const getModeLabel = (mode: string): string => {
    return mode.charAt(0).toUpperCase() + mode.slice(1);
  };

  const getTargetLabel = (index: number): string => {
    if (index >= 20) return "Bull";
    return (index + 1).toString();
  };

  const getAccuracyColor = (accuracy: number): string => {
    if (accuracy >= 50) return "text-emerald-400";
    if (accuracy >= 33) return "text-yellow-400";
    if (accuracy >= 20) return "text-orange-400";
    return "text-red-400";
  };

  const winnerIndex = atcState.match?.matchWinner ?? atcState.winner;
  const winnerName = winnerIndex !== null && winnerIndex !== undefined
    ? atcState.players[winnerIndex]?.name
    : null;

  const nameWithBot = (player: AroundTheClockPlayerState, index: number) => {
    const config = configPlayers?.[index];
    const isBotFromState = Boolean(config?.isBot || player.isBot);
    const botLevel = config?.botLevel ?? player.botLevel;
    if (!isBotFromState) {
      return player.name;
    }
    return `${player.name}${botLevel ? ` (Bot L${botLevel})` : " (Bot)"}`;
  };

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden flex flex-col">
      <div
        className="pointer-events-none fixed inset-0 [background:
          radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
          radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.08),transparent_70%),
          radial-gradient(ellipse_at_bottom_left,rgba(255,255,255,0.06),transparent_70%),
          radial-gradient(ellipse_at_bottom_right,rgba(255,255,255,0.1),transparent_65%),
          linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95)_30%,rgba(255,255,255,0.04)_60%,rgba(0,0,0,1)_100%)
        ]"
      />

      <header className="relative z-10 w-full px-6 md:px-10 py-6 flex items-center justify-between border-b border-white/10">
        <h1 className="text-xl font-extrabold tracking-wide">
          Around The Clock <span className="text-red-500">Match Stats</span>
        </h1>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => navigate("/lobby")}
            className="px-4 py-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 transition-colors"
          >
            New Match
          </button>
          <button
            type="button"
            onClick={() => navigate("/")}
            className="px-4 py-2 rounded-lg bg-red-600/80 hover:bg-red-500/80 transition-colors"
          >
            Home
          </button>
        </div>
      </header>

      <main className="relative z-10 flex-1 px-4 md:px-10 pb-10 overflow-y-auto">
        <div className="max-w-6xl mx-auto mt-6 space-y-6">
          {winnerName && (
            <div className="rounded-xl border border-emerald-500/60 bg-emerald-600/15 px-6 py-4">
              <p className="text-lg font-semibold text-emerald-200">{winnerName} wins the match!</p>
              <p className="text-xs uppercase tracking-[0.3em] text-emerald-300 mt-1">
                Mode: {getModeLabel(atcState.mode)}
              </p>
            </div>
          )}

          <div className="rounded-2xl border border-white/10 bg-black/40 px-6 py-5">
            <h2 className="text-lg font-semibold text-white mb-4">Match Summary</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <div className="text-zinc-500 uppercase tracking-wider text-xs">Mode</div>
                <div className={`text-lg font-semibold ${getModeColor(atcState.mode)}`}>
                  {getModeLabel(atcState.mode)}
                </div>
              </div>
              <div>
                <div className="text-zinc-500 uppercase tracking-wider text-xs">Sets</div>
                <div className="text-lg font-semibold text-white">
                  {atcState.match.setsToWin === 1 ? "Single Set" : `Best of ${atcState.match.setsToWin * 2 - 1}`}
                </div>
              </div>
              <div>
                <div className="text-zinc-500 uppercase tracking-wider text-xs">Legs</div>
                <div className="text-lg font-semibold text-white">
                  {atcState.match.legsPerSet === 1 ? "Single Leg" : `Best of ${atcState.match.legsPerSet * 2 - 1}`}
                </div>
              </div>
              <div>
                <div className="text-zinc-500 uppercase tracking-wider text-xs">Players</div>
                <div className="text-lg font-semibold text-white">{atcState.players.length}</div>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/40 px-6 py-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <h2 className="text-lg font-semibold text-white">Statistics Scope</h2>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={scopeButtonClasses(selectedScope === "match")}
                  onClick={() => setSelectedScope("match")}
                >
                  Match Totals
                </button>
                {legStatsOptions.map((leg, index) => {
                  const labelParts: string[] = [];
                  if (leg.setNumber) {
                    labelParts.push(`Set ${leg.setNumber}`);
                  }
                  labelParts.push(`Leg ${leg.legNumber ?? index + 1}`);
                  return (
                    <button
                      key={`leg-scope-${index}`}
                      type="button"
                      className={scopeButtonClasses(selectedScope === index)}
                      onClick={() => setSelectedScope(index)}
                    >
                      {labelParts.join(" · ")}
                    </button>
                  );
                })}
              </div>
            </div>
            {selectedScope === "match" ? (
              <p className="text-sm text-zinc-400">
                {hasLegStats
                  ? "Viewing cumulative match performance across all completed legs."
                  : "Per-leg breakdown is not available for this match, showing cumulative totals instead."}
              </p>
            ) : activeLegMeta ? (
              <div className="text-sm text-zinc-400 flex flex-wrap gap-3">
                <span>
                  Set {activeLegMeta.setNumber ?? 1}, Leg{" "}
                  {activeLegMeta.legNumber ?? (typeof selectedScope === "number" ? selectedScope + 1 : 1)}
                </span>
                {typeof activeLegMeta.winnerIndex === "number" &&
                  activeLegMeta.winnerIndex >= 0 &&
                  activeLegMeta.winnerIndex < playerRows.length && (
                    <span>
                      Winner:{" "}
                      <span className="text-white">
                        {nameWithBot(playerRows[activeLegMeta.winnerIndex], activeLegMeta.winnerIndex)}
                      </span>
                    </span>
                  )}
              </div>
            ) : (
              <p className="text-sm text-zinc-400">No per-leg detail is available for this selection.</p>
            )}
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/40 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-separate [border-spacing:0]">
              <thead>
                <tr className="bg-black/60">
                  <th className="px-4 py-3 text-left text-xs uppercase tracking-[0.3em] text-zinc-500">Stat</th>
                  {playerRows.map((player, index) => (
                    <th
                      key={'stat-head-' + player.name + '-' + index}
                      className="px-4 py-3 text-right text-xs uppercase tracking-[0.3em] text-zinc-500"
                    >
                      {nameWithBot(player, index)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="text-sm text-zinc-200">
                {[
                  { label: "Darts Thrown", accessor: (stats: AroundTheClockStats) => stats.darts },
                  { label: "Targets Hit", accessor: (stats: AroundTheClockStats) => stats.targetsHit },
                  { label: "Total Targets", accessor: (stats: AroundTheClockStats) => stats.totalTargets },
                  {
                    label: "Overall Accuracy",
                    accessor: (stats: AroundTheClockStats) => (
                      <span className={getAccuracyColor(stats.overallAccuracy)}>
                        {stats.overallAccuracy.toFixed(1)}%
                      </span>
                    ),
                  },
                  { label: "Legs Won", accessor: (_: AroundTheClockStats, idx: number) => playerRows[idx]?.legsWon ?? 0 },
                  { label: "Sets Won", accessor: (_: AroundTheClockStats, idx: number) => playerRows[idx]?.setsWon ?? 0 },
                ].map((row) => (
                  <tr key={'stat-row-' + row.label} className="border-t border-white/5">
                    <td className="px-4 py-3 text-left text-zinc-400">{row.label}</td>
                    {scopedStatsAligned.map((stats, index) => (
                      <td key={'stat-val-' + row.label + '-' + index} className="px-4 py-3 text-right">
                        {row.accessor(stats, index) as React.ReactNode}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/40 px-6 py-5">
            <h2 className="text-lg font-semibold text-white mb-4">Target-by-Target Accuracy</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-separate [border-spacing:0] text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-[0.25em] text-zinc-500">
                    <th className="px-3 py-2 text-left">Target</th>
                    {playerRows.map((player, index) => (
                      <th
                        key={'target-head-' + player.name + '-' + index}
                        className="px-3 py-2 text-center"
                      >
                        {nameWithBot(player, index)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="text-zinc-300">
                  {Array.from({ length: 21 }, (_, i) => i).map((targetIndex) => (
                    <tr key={'target-row-' + targetIndex} className="border-t border-white/5">
                      <td className="px-3 py-3 font-semibold text-white">{getTargetLabel(targetIndex)}</td>
                      {scopedStatsAligned.map((stats, playerIndex) => {
                        const accuracy = stats.targetAccuracies?.[targetIndex] ?? 0;
                        return (
                          <td
                            key={'target-acc-' + targetIndex + '-' + playerIndex}
                            className={`px-3 py-3 text-center font-semibold ${getAccuracyColor(accuracy)}`}
                          >
                            {accuracy.toFixed(1)}%
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default AroundTheClockStatsPage;
