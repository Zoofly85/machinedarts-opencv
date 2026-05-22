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

interface X01PlayerState {
  name: string;
  score: number;
  startingScore: number;
  legsWon: number;
  setsWon: number;
  isBot?: boolean;
  botLevel?: number;
}

interface X01Stats {
  dartsThrown: number;
  average: number;
  firstNineAverage: number;
  averageTo170: number;
  turnBuckets: Record<string, number>;
  checkoutAttempts: number;
  checkoutSuccesses: number;
  checkoutPercentage: number;
  totalScored: number;
}

interface X01LegStatsEntry {
  setNumber?: number;
  legNumber?: number;
  winnerIndex?: number | null;
  stats: X01Stats[];
}

interface X01SummaryState {
  mode: string;
  settings: {
    startScore: number;
    inMode: string;
    outMode: string;
    legsPerSet: number;
    setsToWin: number;
    gameVariant?: "standard" | "last_man_standing";
  };
  lms?: {
    totalLegs: number;
    playerPoints: number[];
    legResults: number[][];
  };
  match?: {
    currentSet?: number;
    currentLeg?: number;
    legWinner?: number | null;
    setWinner?: number | null;
    matchWinner?: number | null;
  };
  players: X01PlayerState[];
  currentTurn: {
    darts: (DartScore | null)[];
  };
  lastCompletedTurn: (DartScore | null)[];
  winner?: number | null;
  legWinner?: number | null;
  setWinner?: number | null;
  matchWinner?: number | null;
  stats?: X01Stats[];
  matchStats?: X01Stats[];
  legStats?: X01LegStatsEntry[];
}

interface StatsLocationState {
  summary?: X01SummaryState;
  players?: PlayerConfig[];
}

interface AdvancedStatsPlayerPayload {
  profileId: string;
  name: string;
}

export default function X01StatsPage() {
  const navigate = useNavigate();
  const { state } = useLocation() as { state?: StatsLocationState };
  const summary = state?.summary;

  const configPlayers: PlayerConfig[] | undefined = useMemo(() => {
    const raw = state?.players;
    return Array.isArray(raw) ? (raw as PlayerConfig[]) : undefined;
  }, [state?.players]);

  const playerRows = useMemo(() => summary?.players ?? [], [summary?.players]);

  const advancedPlayers = useMemo<AdvancedStatsPlayerPayload[]>(() => {
    if (!configPlayers || !playerRows.length) {
      return [];
    }
    return configPlayers
      .map((playerConfig, index) => {
        if (!playerConfig?.profileId) {
          return null;
        }
        return {
          profileId: playerConfig.profileId,
          name: playerRows[index]?.name ?? playerConfig.name,
        };
      })
      .filter((item): item is AdvancedStatsPlayerPayload => Boolean(item?.profileId));
  }, [configPlayers, playerRows]);

  const fallbackStats = useMemo<X01Stats[]>(() => {
    if (!summary || !summary.players) {
      return [];
    }
    const turnHistory = Array.isArray((summary as any)?.turnHistory) ? (summary as any).turnHistory : [];
    return summary.players.map((_player, playerIndex) => {
      const playerTurns = turnHistory.filter((entry: any) => entry.playerIndex === playerIndex || entry[0] === playerIndex);

      let dartsThrown = 0;
      let totalScored = 0;
      const firstNineScores: number[] = [];
      let checkoutAttempts = 0;
      let checkoutSuccesses = 0;
      const turnBuckets: Record<string, number> = {
        "60plus": 0,
        "80plus": 0,
        "100plus": 0,
        "120plus": 0,
        "140plus": 0,
        "170plus": 0,
        "180": 0,
      };

      playerTurns.forEach((entry: any) => {
        const turn = entry.turnIndex !== undefined ? entry : entry[1];
        if (!turn) return;

        const dartsUsed = turn.dartsUsed || 0;
        const scored = turn.scored || 0;
        const appliedScores = turn.appliedScores || [];
        const scoreBefore = turn.scoreBefore || 0;
        const finished = turn.finished || false;

        dartsThrown += dartsUsed;
        totalScored += scored;

        if (firstNineScores.length < 9) {
          const remaining = 9 - firstNineScores.length;
          firstNineScores.push(...appliedScores.slice(0, Math.min(remaining, dartsUsed)));
        }

        const visitTotal = appliedScores.slice(0, dartsUsed).reduce((sum: number, score: number) => sum + score, 0);
        const bucketThresholds = [
          ["180", 180],
          ["170plus", 170],
          ["140plus", 140],
          ["120plus", 120],
          ["100plus", 100],
          ["80plus", 80],
          ["60plus", 60],
        ];

        for (const [key, threshold] of bucketThresholds) {
          if (visitTotal >= threshold) {
            turnBuckets[key as string] = (turnBuckets[key as string] || 0) + 1;
            break;
          }
        }

        if (scoreBefore <= 170) {
          checkoutAttempts++;
        }
        if (finished) {
          checkoutSuccesses++;
        }
      });

      const average = dartsThrown > 0 ? (totalScored / dartsThrown) * 3 : 0;
      const firstNineTotal = firstNineScores.reduce((sum, score) => sum + score, 0);
      const firstNineAverage = firstNineScores.length > 0 ? (firstNineTotal / firstNineScores.length) * 3 : 0;

      let remainingScore = summary.settings?.startScore || 501;
      let pre170Darts = 0;
      let pre170Score = 0;

      playerTurns.forEach((entry: any) => {
        const turn = entry.turnIndex !== undefined ? entry : entry[1];
        if (!turn || remainingScore <= 170) return;

        const appliedScores = turn.appliedScores || [];
        const dartsUsed = turn.dartsUsed || 0;

        for (let i = 0; i < dartsUsed && remainingScore > 170; i++) {
          pre170Darts++;
          pre170Score += appliedScores[i] || 0;
          remainingScore -= appliedScores[i] || 0;
        }
      });

      const averageTo170 = pre170Darts > 0 ? (pre170Score / pre170Darts) * 3 : 0;
      const checkoutPercentage = checkoutAttempts > 0 ? (checkoutSuccesses / checkoutAttempts) * 100 : 0;

      return {
        dartsThrown,
        average,
        firstNineAverage,
        averageTo170,
        turnBuckets,
        checkoutAttempts,
        checkoutSuccesses,
        checkoutPercentage,
        totalScored,
      };
    });
  }, [summary]);

  const matchStats = useMemo(() => {
    if (summary && Array.isArray(summary.matchStats) && summary.matchStats.length) {
      return summary.matchStats;
    }
    if (summary && Array.isArray(summary.stats) && summary.stats.length) {
      return summary.stats;
    }
    return fallbackStats;
  }, [summary, fallbackStats]);

  const legStatsOptions = useMemo<X01LegStatsEntry[]>(() => {
    if (summary && Array.isArray(summary.legStats) && summary.legStats.length) {
      return summary.legStats;
    }
    if (summary && Array.isArray(summary.stats) && summary.stats.length) {
      return [
        {
          setNumber: summary.match?.currentSet,
          legNumber: summary.match?.currentLeg,
          winnerIndex: summary.legWinner ?? summary.winner ?? null,
          stats: summary.stats,
        },
      ];
    }
    if (fallbackStats.length) {
      return [
        {
          setNumber: summary?.match?.currentSet,
          legNumber: summary?.match?.currentLeg,
          winnerIndex: summary?.legWinner ?? summary?.winner ?? null,
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
        dartsThrown: 0,
        average: 0,
        firstNineAverage: 0,
        averageTo170: 0,
        turnBuckets: {},
        checkoutAttempts: 0,
        checkoutSuccesses: 0,
        checkoutPercentage: 0,
        totalScored: 0,
      } as X01Stats;
    });
  }, [playerRows, statsForScope]);

  const activeLegMeta = typeof selectedScope === "number" ? legStatsOptions[selectedScope] : undefined;

  const scopeButtonClasses = (isActive: boolean) =>
    `px-3 py-2 rounded-lg border text-xs uppercase tracking-[0.3em] transition-colors ${
      isActive
        ? "border-red-500/80 bg-red-600/20 text-red-200"
        : "border-white/10 bg-zinc-900/60 text-zinc-300 hover:border-white/30 hover:text-white"
    }`;

  const handleAdvancedStats = () => {
    navigate("/x01/stats/advanced", {
      state: {
        players: advancedPlayers,
      },
    });
  };

  useEffect(() => {
    if (!summary) {
      navigate("/", { replace: true });
    }
  }, [summary, navigate]);

  if (!summary) {
    return null;
  }

  const winnerIndex = typeof summary.matchWinner === "number" ? summary.matchWinner : 
                      typeof summary.winner === "number" ? summary.winner : null;

  const nameWithBot = (player: X01PlayerState, index: number) => {
    const config = configPlayers?.[index];
    const isBotFromState = Boolean(config?.isBot || player.isBot);
    const botLevel = config?.botLevel ?? player.botLevel;
    if (!isBotFromState) {
      return player.name;
    }
    return `${player.name}${botLevel ? ` (Bot L${botLevel})` : " (Bot)"}`;
  };

  const winnerName = winnerIndex !== null ? nameWithBot(summary.players[winnerIndex], winnerIndex) : null;

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
          X01 <span className="text-red-500">Match Stats</span>
        </h1>
        <div className="flex gap-3 flex-wrap justify-end">
          <button
            type="button"
            onClick={handleAdvancedStats}
            className="px-4 py-2 rounded-lg border border-cyan-400/40 text-cyan-100 bg-cyan-500/10 hover:bg-cyan-500/20 transition-colors"
          >
            Advanced Stats
          </button>
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

      <main className="relative z-10 flex-1 px-4 md:px-10 pb-10">
        <div className="max-w-6xl mx-auto mt-6 space-y-6">
          {/* Match Info */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="rounded-xl border border-white/10 bg-black/40 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Game</p>
              <p className="text-lg font-bold text-white">{summary.settings.startScore}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/40 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Format</p>
              <p className="text-lg font-bold text-white">
                {summary.settings.setsToWin > 1 
                  ? `First to ${summary.settings.setsToWin}L` 
                  : `${summary.settings.legsPerSet} Legs`}
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/40 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">In</p>
              <p className="text-lg font-bold text-white">{summary.settings.inMode.toUpperCase()}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/40 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Out</p>
              <p className="text-lg font-bold text-white">{summary.settings.outMode.toUpperCase()}</p>
            </div>

          {/* Last Man Standing Results */}
          {summary.settings.gameVariant === "last_man_standing" && summary.lms && (
            <div className="rounded-xl border border-white/10 bg-zinc-900/60 p-6">
              <h2 className="text-xl font-bold mb-4 text-white">Last Man Standing Results</h2>
              
              {/* Final Standings */}
              <div className="space-y-2 mb-6">
                {summary.players
                  .map((player, idx) => ({ player, idx, points: summary.lms?.playerPoints[idx] || 0 }))
                  .sort((a, b) => b.points - a.points)
                  .map((item, rank) => (
                    <div 
                      key={item.idx} 
                      className={`flex items-center justify-between p-3 rounded ${
                        rank === 0 ? 'bg-yellow-900/30 border border-yellow-600/50' : 'bg-black/40'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-2xl font-bold text-zinc-500">#{rank + 1}</span>
                        <span className="font-semibold text-white">{item.player.name}</span>
                      </div>
                      <span className="text-xl font-bold text-emerald-400">
                        {item.points} pts
                      </span>
                    </div>
                  ))}
              </div>
              
              {/* Leg-by-Leg Breakdown */}
              <div className="mt-6">
                <h3 className="text-sm font-semibold mb-3 text-white">Leg Results</h3>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead>
                      <tr className="border-b border-white/10">
                        <th className="text-left p-2 text-zinc-400">Player</th>
                        {Array.from({ length: summary.lms.totalLegs }, (_, i) => (
                          <th key={i} className="text-center p-2 text-zinc-400">Leg {i + 1}</th>
                        ))}
                        <th className="text-right p-2 text-zinc-400">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.players.map((player, idx) => (
                        <tr key={idx} className="border-b border-white/5">
                          <td className="p-2 text-white">{player.name}</td>
                          {summary.lms?.legResults.map((legResult, legIdx) => {
                            const position = legResult[idx];
                            const points = position ? (7 - position) : 0;
                            return (
                              <td key={legIdx} className="text-center p-2 text-zinc-300">
                                {position ? (
                                  <span className="inline-block">
                                    #{position} <span className="text-emerald-400">({points}pts)</span>
                                  </span>
                                ) : '-'}
                              </td>
                            );
                          })}
                          <td className="text-right p-2 font-bold text-white">
                            {summary.lms?.playerPoints[idx] || 0}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
          </div>

          {winnerName && (
            <div className="rounded-2xl border border-emerald-500/60 bg-emerald-600/15 px-6 py-4">
              <p className="text-lg font-semibold text-emerald-200">{winnerName} wins the match!</p>
              <p className="text-xs uppercase tracking-[0.3em] text-emerald-300 mt-1">
                {summary.settings.startScore} · {summary.settings.inMode}/{summary.settings.outMode}
              </p>
            </div>
          )}

          {/* Match Score */}
          <div className="rounded-2xl border border-white/10 bg-black/40 overflow-hidden shadow-[0_18px_50px_rgba(0,0,0,0.35)]">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-separate [border-spacing:0]">
              <thead>
                <tr className="bg-black/60">
                  <th className="px-4 py-3 text-left text-xs uppercase tracking-[0.3em] text-zinc-500">Player</th>
                  <th className="px-4 py-3 text-center text-xs uppercase tracking-[0.3em] text-zinc-500">Sets Won</th>
                  <th className="px-4 py-3 text-center text-xs uppercase tracking-[0.3em] text-zinc-500">Legs Won</th>
                </tr>
              </thead>
              <tbody>
                {playerRows.map((player, index) => (
                  <tr
                    key={'player-' + player.name + '-' + index}
                    className="border-t border-white/5 odd:bg-black/30 even:bg-black/40"
                  >
                    <td className="px-4 py-3 text-sm font-semibold text-white">
                      {nameWithBot(player, index)}
                    </td>
                    <td className="px-4 py-3 text-center text-lg font-bold text-red-500">
                      {player.setsWon}
                    </td>
                    <td className="px-4 py-3 text-center text-lg font-bold text-blue-400">
                      {player.legsWon}
                    </td>
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
          </div>

          {/* Stats Scope */}
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

          {/* Statistics Table */}
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
                  { label: "Darts Thrown", accessor: (stats: X01Stats) => stats.dartsThrown },
                  { label: "Total Scored", accessor: (stats: X01Stats) => stats.totalScored },
                  {
                    label: "Average",
                    accessor: (stats: X01Stats) => stats.average.toFixed(2),
                  },
                  {
                    label: "First 9 Average",
                    accessor: (stats: X01Stats) => stats.firstNineAverage.toFixed(2),
                  },
                  {
                    label: "Average to 170",
                    accessor: (stats: X01Stats) => stats.averageTo170.toFixed(2),
                  },
                  {
                    label: "Checkout %",
                    accessor: (stats: X01Stats) => 
                      `${stats.checkoutPercentage.toFixed(1)}% (${stats.checkoutSuccesses}/${stats.checkoutAttempts})`,
                  },
                ].map((row) => (
                  <tr key={'stat-row-' + row.label} className="border-t border-white/5">
                    <td className="px-4 py-3 text-left text-zinc-400">{row.label}</td>
                    {scopedStatsAligned.map((stats, index) => (
                      <td key={'stat-val-' + row.label + '-' + index} className="px-4 py-3 text-right">
                        {row.accessor(stats) as React.ReactNode}
                      </td>
                    ))}
                  </tr>
                ))}
                
                {/* Visit Buckets */}
                <tr className="border-t border-white/10">
                  <td colSpan={playerRows.length + 1} className="px-4 py-2 text-left text-xs uppercase tracking-[0.3em] text-zinc-500 bg-black/40">
                    Visit Scores
                  </td>
                </tr>
                {["60+", "80+", "100+", "120+", "140+", "170+", "180"].map((bucket) => (
                  <tr key={'bucket-' + bucket} className="border-t border-white/5">
                    <td className="px-4 py-3 text-left text-zinc-400">{bucket}</td>
                    {scopedStatsAligned.map((stats, index) => (
                      <td key={'bucket-val-' + bucket + '-' + index} className="px-4 py-3 text-right">
                        {stats.turnBuckets?.[bucket.replace("+", "plus")] ?? 0}
                      </td>
                    ))}
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
}
