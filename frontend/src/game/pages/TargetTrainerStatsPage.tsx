import React, { useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { PlayerConfig } from "../context/LobbyContext";

interface DartScore {
  score: number;
  multiplier: number;
  segment: string;
  zone: string;
  confidence: number;
}

interface TargetTrainerPlayerState {
  name: string;
  hits: number;
  requiredHits: number;
  dartsThrown: number;
  bestStreak?: number;
  currentStreak?: number;
  accuracy?: number;
  isBot?: boolean;
  botLevel?: number;
  legsWon?: number;
  setsWon?: number;
  totalHits?: number;
  totalDarts?: number;
  bestStreakOverall?: number;
}

interface TargetTrainerSummaryState {
  mode: string;
  settings: {
    targetType: string;
    targetNumber: number;
    requiredHits: number;
    allowClose: boolean;
    sharedTarget: boolean;
    legsPerSet?: number;
    setsToWin?: number;
  };
  players: TargetTrainerPlayerState[];
  winnerIndex?: number | null;
  legWinner?: number | null;
  setWinner?: number | null;
  matchWinner?: number | null;
  currentLeg?: number;
  currentSet?: number;
  lastTurn?: { darts: (DartScore | null)[]; hitsThisTurn?: number; playerIndex?: number };
}

interface StatsLocationState {
  summary?: TargetTrainerSummaryState;
  players?: PlayerConfig[];
}

const formatTarget = (type: string, num: number) => {
  if (type.includes("bull")) return type === "inner_bull" ? "Inner Bull (50)" : "Outer Bull (25)";
  const prefix = type === "treble" ? "T" : type === "double" ? "D" : "S";
  return `${prefix}${num}`;
};

export default function TargetTrainerStatsPage() {
  const navigate = useNavigate();
  const { state } = useLocation() as { state?: StatsLocationState };
  const summary = state?.summary;

  const rows = useMemo(() => summary?.players ?? [], [summary?.players]);

  const winnerName = useMemo(() => {
    if (!summary) return null;
    const idx =
      summary.matchWinner !== undefined && summary.matchWinner !== null
        ? summary.matchWinner
        : summary.winnerIndex;
    if (idx === null || idx === undefined) {
      return null;
    }
    return rows[idx]?.name ?? null;
  }, [rows, summary]);

  if (!summary) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center px-4">
        <div className="max-w-xl text-center space-y-3">
          <h1 className="text-2xl font-bold">No stats available</h1>
          <p className="text-zinc-400 text-sm">Start a Target Trainer game to see results here.</p>
          <button
            type="button"
            onClick={() => navigate("/lobby")}
            className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 transition"
          >
            Lobby
          </button>
        </div>
      </div>
    );
  }

  const targetLabel = formatTarget(summary.settings.targetType, summary.settings.targetNumber);

  return (
    <div className="min-h-screen bg-black text-white relative overflow-hidden">
      <div
        className="pointer-events-none fixed inset-0 [background:
          radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
          radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.08),transparent_70%),
          radial-gradient(ellipse_at_bottom_left,rgba(255,255,255,0.06),transparent_70%),
          radial-gradient(ellipse_at_bottom_right,rgba(255,255,255,0.1),transparent_65%),
          linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95)_30%,rgba(255,255,255,0.04)_60%,rgba(0,0,0,1)_100%)
        ]"
      />

      <div className="relative z-10 px-6 py-8 max-w-5xl mx-auto space-y-6">
        <header className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Target Trainer</p>
            <h1 className="text-3xl font-bold">Stats · {targetLabel}</h1>
            <p className="text-sm text-zinc-400">
              Required hits: {summary.settings.requiredHits} · Allow close: {summary.settings.allowClose ? "On" : "Off"} · Shared:{" "}
              {summary.settings.sharedTarget ? "Yes" : "Per-player"} · Legs/Set: {summary.settings.legsPerSet ?? 1} · Sets to Win:{" "}
              {summary.settings.setsToWin ?? 1}
            </p>
            {(summary.currentLeg || summary.currentSet) && (
              <p className="text-xs text-zinc-500">
                Set {summary.currentSet ?? 1} · Leg {summary.currentLeg ?? 1}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => navigate("/lobby")}
            className="px-4 py-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 transition-colors"
          >
            Lobby
          </button>
        </header>

        {winnerName && (
          <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
            {winnerName} wins! 🎯
          </div>
        )}

        <div className="rounded-2xl border border-white/10 bg-black/50 overflow-hidden">
          <div className="grid grid-cols-8 gap-0 border-b border-white/5 text-xs uppercase tracking-[0.2em] text-zinc-500">
            <div className="px-4 py-3 col-span-2">Player</div>
            <div className="px-4 py-3 text-right">Hits</div>
            <div className="px-4 py-3 text-right">Darts</div>
            <div className="px-4 py-3 text-right">Accuracy</div>
            <div className="px-4 py-3 text-right">Best Streak</div>
            <div className="px-4 py-3 text-right">Legs</div>
            <div className="px-4 py-3 text-right">Sets</div>
          </div>
          <div className="divide-y divide-white/5">
            {rows.map((player, idx) => (
              <div key={player.name + idx} className="grid grid-cols-8 gap-0 px-4 py-3 items-center">
                <div className="col-span-2">
                  <div className="text-white font-semibold">{player.name}</div>
                  <div className="text-xs text-zinc-500">
                    Target {player.requiredHits} hits · {player.isBot ? `Bot${player.botLevel ? ` L${player.botLevel}` : ""}` : "Human"}
                  </div>
                </div>
                <div className="text-right text-white font-semibold tabular-nums">
                  {(player.totalHits ?? player.hits)}/{player.requiredHits}
                </div>
                <div className="text-right text-zinc-200 tabular-nums">{player.totalDarts ?? player.dartsThrown}</div>
                <div className="text-right text-zinc-200 tabular-nums">
                  {player.accuracy !== undefined
                    ? `${(player.accuracy * 100).toFixed(1)}%`
                    : (player.totalDarts ?? 0) > 0
                    ? `${(((player.totalHits ?? 0) / (player.totalDarts ?? 1)) * 100).toFixed(1)}%`
                    : (player.dartsThrown > 0 ? `${((player.hits / player.dartsThrown) * 100).toFixed(1)}%` : "—")}
                </div>
                <div className="text-right text-zinc-200 tabular-nums">
                  {player.bestStreakOverall ?? player.bestStreak ?? "—"}
                </div>
                <div className="text-right text-zinc-200 tabular-nums">{player.legsWon ?? 0}</div>
                <div className="text-right text-zinc-200 tabular-nums">{player.setsWon ?? 0}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
