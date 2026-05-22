import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { CricketVariant, PlayerConfig } from "../context/LobbyContext";
import { getFlavorConfig } from "../../config/productFlavor";
import { getClubControlConfig } from "../../modules/shared-domain/clubControlConfig";
import { submitBoardMatchResult } from "../../modules/club-board/services/boardQueue";
import { getClubKioskSession, markQueuedMatchResultPosted } from "../../modules/club-board/kioskSession";

const targets: Array<number | "BULL"> = [20, 19, 18, 17, 16, 15, "BULL"];

interface DartScore {
  score: number;
  multiplier: number;
  segment: string;
  zone: string;
  confidence: number;
}

interface CricketPlayerState {
  name: string;
  score: number;
  marks: number[];
}

interface CricketStats {
  dartsThrown: number;
  marksTotal: number;
  mpr: number;
  firstNineMpr: number;
  bestTurnMarks: number;
  bestScore: number;
  markCounts: Record<string, number>;
}

interface CricketLegStatsEntry {
  setNumber?: number;
  legNumber?: number;
  winnerIndex?: number | null;
  stats: CricketStats[];
}

interface CricketSummaryState {
  mode: string;
  numbers: number[];
  currentPlayer: number | null;
  players: CricketPlayerState[];
  currentTurn: {
    darts: (DartScore | null)[];
  };
  lastCompletedTurn: (DartScore | null)[];
  winner?: number | null;
  legWinner?: number | null;
  setWinner?: number | null;
  match?: {
    legsPerSet?: number;
    setsToWin?: number;
    currentSet?: number;
    currentLeg?: number;
    legWinner?: number | null;
    setWinner?: number | null;
    matchWinner?: number | null;
  };
  stats?: CricketStats[];
  matchStats?: CricketStats[];
  legStats?: CricketLegStatsEntry[];
}

interface StatsLocationState {
  summary?: CricketSummaryState;
  variant?: CricketVariant;
  players?: PlayerConfig[];
}

function formatVariantLabel(variant?: CricketVariant) {
  switch (variant) {
    case "cutthroat":
      return "Cutthroat";
    case "no_score":
      return "No Score";
    case "standard":
    default:
      return "Standard";
  }
}

function getMarkClass(marks: number) {
  if (marks >= 3) {
    return "inline-flex h-8 w-8 items-center justify-center rounded-full border text-sm font-semibold border-emerald-500 bg-emerald-500/20 text-emerald-300";
  }
  if (marks > 0) {
    return "inline-flex h-8 w-8 items-center justify-center rounded-full border text-sm font-semibold border-red-500 bg-red-500/10 text-red-300";
  }
  return "inline-flex h-8 w-8 items-center justify-center rounded-full border text-sm font-semibold border-white/10 text-zinc-500";
}

export default function CricketStatsPage() {
  const navigate = useNavigate();
  const { state } = useLocation() as { state?: StatsLocationState };
  const summary = state?.summary;
  const flavor = React.useMemo(() => getFlavorConfig(), []);
  const clubCfg = React.useMemo(() => getClubControlConfig(), []);
  const postedBoardResultRef = useRef(false);
  const [boardSubmitStatus, setBoardSubmitStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");

  const configPlayers: PlayerConfig[] | undefined = useMemo(() => {
    const raw = state?.players;
    return Array.isArray(raw) ? (raw as PlayerConfig[]) : undefined;
  }, [state?.players]);

  const playerRows = useMemo(() => summary?.players ?? [], [summary?.players]);

  const fallbackStats = useMemo<CricketStats[]>(() => {
    if (!summary) {
      return [];
    }
    if (Array.isArray(summary.stats) && summary.stats.length === playerRows.length) {
      return summary.stats;
    }
    return playerRows.map(() => ({
      dartsThrown: 0,
      marksTotal: 0,
      mpr: 0,
      firstNineMpr: 0,
      bestTurnMarks: 0,
      bestScore: 0,
      markCounts: {},
    }));
  }, [summary, playerRows]);

  const matchStats = useMemo(() => {
    if (summary && Array.isArray(summary.matchStats) && summary.matchStats.length === playerRows.length) {
      return summary.matchStats;
    }
    return fallbackStats;
  }, [summary, playerRows, fallbackStats]);

  const legStatsOptions = useMemo<CricketLegStatsEntry[]>(() => {
    if (summary && Array.isArray(summary.legStats) && summary.legStats.length) {
      return summary.legStats;
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
        marksTotal: 0,
        mpr: 0,
        firstNineMpr: 0,
        bestTurnMarks: 0,
        bestScore: 0,
        markCounts: {},
      } as CricketStats;
    });
  }, [playerRows, statsForScope]);

  const activeLegMeta = typeof selectedScope === "number" ? legStatsOptions[selectedScope] : undefined;

  const scopeButtonClasses = (isActive: boolean) =>
    `px-3 py-2 rounded-lg border text-xs uppercase tracking-[0.3em] transition-colors ${
      isActive
        ? "border-red-500/80 bg-red-600/20 text-red-200"
        : "border-white/10 bg-zinc-900/60 text-zinc-300 hover:border-white/30 hover:text-white"
    }`;

  useEffect(() => {
    if (!summary) {
      navigate("/", { replace: true });
    }
  }, [summary, navigate]);

  if (!summary) {
    return null;
  }

  const variantLabel = formatVariantLabel(state?.variant ?? (summary.mode as CricketVariant));
  const winnerIndex =
    typeof summary.match?.matchWinner === "number"
      ? summary.match.matchWinner
      : typeof summary.winner === "number"
        ? summary.winner
        : null;
  const isClubBoard = flavor.flavor === "club-board";

  useEffect(() => {
    if (!summary || winnerIndex === null || postedBoardResultRef.current) return;
    if (!isClubBoard) return;
    const session = getClubKioskSession();
    const queued = session?.queuedMatch;
    if (!queued || queued.resultPosted) return;
    if (!queued.socialNightId || !queued.matchId) return;

    const winnerName = String(summary.players[winnerIndex]?.name || "").trim().toLowerCase();
    const aName = String(queued.aName || "").trim().toLowerCase();
    const bName = String(queued.bName || "").trim().toLowerCase();
    const winner: "a" | "b" = winnerName && winnerName === bName ? "b" : "a";

    const aState = summary.players.find((p) => String(p.name || "").trim().toLowerCase() === aName);
    const bState = summary.players.find((p) => String(p.name || "").trim().toLowerCase() === bName);
    const scoreA = typeof aState?.score === "number" ? aState.score : undefined;
    const scoreB = typeof bState?.score === "number" ? bState.score : undefined;

    postedBoardResultRef.current = true;
    setBoardSubmitStatus("submitting");
    void submitBoardMatchResult({
      boardId: clubCfg.boardId,
      socialNightId: queued.socialNightId,
      matchId: queued.matchId,
      winner,
      scoreA,
      scoreB,
    }).then((ok) => {
      if (ok) {
        markQueuedMatchResultPosted();
        setBoardSubmitStatus("done");
      } else {
        postedBoardResultRef.current = false;
        setBoardSubmitStatus("error");
      }
    }).catch(() => {
      postedBoardResultRef.current = false;
      setBoardSubmitStatus("error");
    });
  }, [summary, winnerIndex, isClubBoard, clubCfg.boardId]);

  useEffect(() => {
    if (!isClubBoard || boardSubmitStatus !== "done") return;
    const id = window.setTimeout(() => navigate("/kiosk"), 2500);
    return () => window.clearTimeout(id);
  }, [isClubBoard, boardSubmitStatus, navigate]);

  const nameWithBot = (player: CricketPlayerState, index: number) => {
    const config = configPlayers?.[index];
    const isBotFromState = Boolean(config?.isBot || (player as any).isBot);
    const botLevel = config?.botLevel ?? (player as any).botLevel;
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
          Cricket <span className="text-red-500">Match Stats</span>
        </h1>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => navigate(isClubBoard ? "/kiosk" : "/lobby")}
            className="px-4 py-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 transition-colors"
          >
            {isClubBoard ? "Back To Queue" : "New Match"}
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
          {isClubBoard && boardSubmitStatus !== "idle" && (
            <div
              className={`rounded-xl border px-4 py-3 text-sm ${
                boardSubmitStatus === "done"
                  ? "border-emerald-600/70 bg-emerald-600/10 text-emerald-200"
                  : boardSubmitStatus === "error"
                    ? "border-amber-600/70 bg-amber-600/10 text-amber-200"
                    : "border-cyan-600/70 bg-cyan-600/10 text-cyan-200"
              }`}
            >
              {boardSubmitStatus === "submitting" && "Submitting match result to social night..."}
              {boardSubmitStatus === "done" && "Result submitted. Returning to board queue..."}
              {boardSubmitStatus === "error" && "Could not submit result automatically. You can still continue from queue."}
            </div>
          )}
          {winnerName && (
            <div className="rounded-2xl border border-emerald-500/60 bg-emerald-600/15 px-6 py-4">
              <p className="text-lg font-semibold text-emerald-200">{winnerName} wins the match!</p>
              <p className="text-xs uppercase tracking-[0.3em] text-emerald-300 mt-1">Variant: {variantLabel}</p>
            </div>
          )}

          <div className="rounded-2xl border border-white/10 bg-black/40 overflow-hidden shadow-[0_18px_50px_rgba(0,0,0,0.35)]">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-separate [border-spacing:0]">
              <thead>
                <tr className="bg-black/60">
                  <th className="px-4 py-3 text-left text-xs uppercase tracking-[0.3em] text-zinc-500">Player</th>
                  <th className="px-4 py-3 text-right text-xs uppercase tracking-[0.3em] text-zinc-500">Score</th>
                  {targets.map((target) => (
                    <th
                      key={'head-' + String(target)}
                      className="px-3 py-3 text-center text-xs uppercase tracking-[0.3em] text-zinc-500"
                    >
                      {target}
                    </th>
                  ))}
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
                    <td className="px-4 py-3 text-right text-lg font-bold text-red-500">
                      {player.score}
                    </td>
                    {targets.map((target, targetIndex) => {
                      const marks = player.marks?.[targetIndex] ?? 0;
                      const className = getMarkClass(marks);
                      return (
                        <td key={'mark-' + player.name + '-' + String(target)} className="px-3 py-3 text-center">
                          <span className={className}>{marks}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
              </table>
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
                  { label: "Darts Thrown", accessor: (stats: CricketStats) => stats.dartsThrown },
                  { label: "Total Marks", accessor: (stats: CricketStats) => stats.marksTotal },
                  {
                    label: "MPR",
                    accessor: (stats: CricketStats) => stats.mpr.toFixed(2),
                  },
                  {
                    label: "First 9 MPR",
                    accessor: (stats: CricketStats) => stats.firstNineMpr.toFixed(2),
                  },
                  {
                    label: "Best Turn (Marks)",
                    accessor: (stats: CricketStats) => stats.bestTurnMarks,
                  },
                  {
                    label: "Best Dart Score",
                    accessor: (stats: CricketStats) => stats.bestScore,
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
                {[5, 6, 7, 8, 9].map((marks) => (
                  <tr key={'mark-count-' + marks} className="border-t border-white/5">
                    <td className="px-4 py-3 text-left text-zinc-400">{marks} Marks</td>
                    {scopedStatsAligned.map((stats, index) => (
                      <td key={'mark-val-' + marks + '-' + index} className="px-4 py-3 text-right">
                        {stats.markCounts?.[String(marks)] ?? 0}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className="border-t border-white/5">
                  <td className="px-4 py-3 text-left text-zinc-400">White Horse</td>
                  {scopedStatsAligned.map((stats, index) => (
                    <td key={'white-horse-' + index} className="px-4 py-3 text-right">
                      {stats.markCounts?.["9"] ?? 0}
                    </td>
                  ))}
                </tr>
              </tbody>
              </table>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
