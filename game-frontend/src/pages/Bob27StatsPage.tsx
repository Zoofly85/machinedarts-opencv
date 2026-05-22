import React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { PlayerConfig } from "../context/LobbyContext";

interface DartScore {
  score: number;
  multiplier: number;
  segment: string;
  zone: string;
  confidence: number;
}

interface Bob27PlayerState {
  name: string;
  score: number;
  dartsThrown: number;
  hits: number;
  attempts: number;
  bestRound: number;
  roundsPlayed: number;
  perDoubleHits: Record<number, number>;
  perDoubleAttempts: Record<number, number>;
}

interface Bob27SummaryState {
  players: Bob27PlayerState[];
  settings: { includeBull: boolean; allowNegative: boolean };
  matchWinnerIndex: number | null;
  turnHistory?: Array<{
    playerIndex: number;
    target: number;
    darts: (DartScore | null)[];
    roundScore: number;
  }>;
}

interface StatsLocationState {
  summary?: Bob27SummaryState;
  players?: PlayerConfig[];
}

export default function Bob27StatsPage() {
  const navigate = useNavigate();
  const { state } = useLocation() as { state?: StatsLocationState };
  const summary = state?.summary;

  if (!summary) {
    return (
      <div className="min-h-screen w-full bg-black text-white flex items-center justify-center">
        <div className="text-center">
          <div className="text-2xl font-bold mb-4 text-red-500">No Stats Available</div>
          <button
            onClick={() => navigate("/lobby")}
            className="px-6 py-3 bg-red-600 hover:bg-red-700 rounded-lg transition"
          >
            Lobby
          </button>
        </div>
      </div>
    );
  }

  const players = summary.players || [];
  const winnerIdx = summary.matchWinnerIndex;
  const winner = typeof winnerIdx === "number" ? players[winnerIdx] : null;

  const baseTargets = Array.from({ length: 20 }, (_v, i) => i + 1);
  const targetList = summary.settings.includeBull ? [...baseTargets, 25] : baseTargets;

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden flex flex-col">
      <div className="pointer-events-none fixed inset-0 [background:radial-gradient(ellipse_at_top,rgba(220,38,38,0.15),transparent_50%),linear-gradient(to_bottom,rgba(0,0,0,0.95),rgba(0,0,0,1))]" />

      <header className="relative z-10 w-full px-6 py-6 border-b border-white/10 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold">Bob&apos;s 27 Stats</h1>
          <p className="text-sm text-zinc-400">
            {summary.settings.includeBull ? "D1-D20 + DB" : "D1-D20"} • {summary.settings.allowNegative ? "Negatives allowed" : "Ends if score below 0"}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => navigate("/lobby")} className="px-4 py-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 transition-colors">New Game</button>
          <button onClick={() => navigate("/")} className="px-4 py-2 rounded-lg bg-red-600/80 hover:bg-red-500/80 transition-colors">Home</button>
        </div>
      </header>

      <main className="relative z-10 flex-1 px-4 md:px-10 pb-10">
        <div className="max-w-6xl mx-auto mt-6 space-y-6">
          {winner && (
            <div className="rounded-2xl border border-emerald-500/60 bg-emerald-600/15 px-6 py-4">
              <p className="text-lg font-semibold text-emerald-200">{winner.name} wins!</p>
              <p className="text-xs uppercase tracking-[0.3em] text-emerald-300 mt-1">Score {winner.score}</p>
            </div>
          )}

          <div className="rounded-2xl border border-white/10 bg-black/40 overflow-hidden shadow-[0_18px_50px_rgba(0,0,0,0.35)]">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-separate [border-spacing:0]">
              <thead>
                <tr className="bg-black/60">
                  <th className="px-4 py-3 text-left text-xs uppercase tracking-[0.3em] text-zinc-500">Player</th>
                  <th className="px-4 py-3 text-right text-xs uppercase tracking-[0.3em] text-zinc-500">Score</th>
                  <th className="px-4 py-3 text-right text-xs uppercase tracking-[0.3em] text-zinc-500">Hits/Attempts</th>
                  <th className="px-4 py-3 text-right text-xs uppercase tracking-[0.3em] text-zinc-500">Best Round</th>
                  <th className="px-4 py-3 text-right text-xs uppercase tracking-[0.3em] text-zinc-500">Rounds</th>
                </tr>
              </thead>
              <tbody>
                {players.map((player, idx) => (
                  <tr key={player.name + idx} className="border-t border-white/5 odd:bg-black/30 even:bg-black/40">
                    <td className="px-4 py-3 text-sm font-semibold text-white">{player.name}</td>
                    <td className="px-4 py-3 text-right text-lg font-bold text-emerald-400">{player.score}</td>
                    <td className="px-4 py-3 text-right text-sm text-zinc-300">{player.hits}/{player.attempts}</td>
                    <td className="px-4 py-3 text-right text-sm text-zinc-300">{player.bestRound}</td>
                    <td className="px-4 py-3 text-right text-sm text-zinc-300">{player.roundsPlayed}</td>
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/40 px-6 py-5">
            <h2 className="text-lg font-semibold mb-3">Per-Double Hit Rates</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-separate [border-spacing:0]">
                <thead>
                  <tr className="bg-black/60">
                    <th className="px-3 py-2 text-left text-xs uppercase tracking-[0.3em] text-zinc-500">Double</th>
                    {players.map((p, idx) => (
                      <th key={"head"+idx} className="px-3 py-2 text-right text-xs uppercase tracking-[0.3em] text-zinc-500">{p.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {targetList.map((num) => (
                    <tr key={"row"+num} className="border-t border-white/5">
                      <td className="px-3 py-2 text-sm text-zinc-400">D{num}</td>
                      {players.map((p, idx) => {
                        const hits = p.perDoubleHits?.[num] ?? 0;
                        const att = p.perDoubleAttempts?.[num] ?? 0;
                        const pct = att > 0 ? ((hits / att) * 100).toFixed(1) : "0.0";
                        return <td key={`cell-${num}-${idx}`} className="px-3 py-2 text-right text-sm text-zinc-200">{pct}%</td>;
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
}
