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

interface ShanghaiPlayerState {
  name: string;
  totalScored: number;
  dartsThrown: number;
  legsWon: number;
  setsWon: number;
  shanghaiHits: number;
  isBot?: boolean;
  botLevel?: number;
}

interface ShanghaiState {
  players: ShanghaiPlayerState[];
  settings: {
    roundRange: "1-10" | "1-20";
    modeType: "legs_sets" | "free_play";
    legsPerSet: number;
    setsToWin: number;
  };
  matchWinnerIndex: number | null;
  legWinnerIndex: number | null;
  winnerIndex?: number | null;
  completedLegs?: Array<{
    leg: number;
    set: number;
    winnerIndex: number;
    wonByShanghai: boolean;
    players: Array<{ playerIndex: number; name: string; legScore: number; darts: number }>;
  }>;
  currentTurn?: {
    darts: (DartScore | null)[];
  };
}

interface LocationState {
  summary?: ShanghaiState;
  players?: PlayerConfig[];
}

export default function ShanghaiStatsPage() {
  const { state } = useLocation() as { state?: LocationState };
  const navigate = useNavigate();
  const summary = state?.summary;

  if (!summary) {
    navigate("/shanghai", { replace: true });
    return null;
  }

  const players = summary.players || [];
  const winnerIdx = summary.matchWinnerIndex ?? summary.winnerIndex ?? summary.legWinnerIndex;
  const winner = typeof winnerIdx === "number" ? players[winnerIdx] : null;

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden flex flex-col">
      <div className="pointer-events-none fixed inset-0 [background:radial-gradient(ellipse_at_top,rgba(220,38,38,0.15),transparent_50%),linear-gradient(to_bottom,rgba(0,0,0,0.95),rgba(0,0,0,1))]" />

      <header className="relative z-10 w-full px-6 py-6 border-b border-white/10 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold">Shanghai Stats</h1>
          <p className="text-sm text-zinc-400">
            {summary.settings.roundRange} • {summary.settings.modeType === "free_play" ? "Free Play" : `Sets to win ${summary.settings.setsToWin}`}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => navigate("/lobby")} className="px-4 py-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 transition-colors">New Match</button>
          <button onClick={() => navigate("/")} className="px-4 py-2 rounded-lg bg-red-600/80 hover:bg-red-500/80 transition-colors">Home</button>
        </div>
      </header>

      <main className="relative z-10 flex-1 px-4 md:px-10 pb-10">
        <div className="max-w-6xl mx-auto mt-6 space-y-6">
          {winner && (
            <div className="rounded-2xl border border-emerald-500/60 bg-emerald-600/15 px-6 py-4">
              <p className="text-lg font-semibold text-emerald-200">{winner.name} wins the match!</p>
              <p className="text-xs uppercase tracking-[0.3em] text-emerald-300 mt-1">
                Legs {winner.legsWon} • Sets {winner.setsWon} • Shanghai hits {winner.shanghaiHits}
              </p>
            </div>
          )}

          <div className="rounded-2xl border border-white/10 bg-black/40 overflow-hidden shadow-[0_18px_50px_rgba(0,0,0,0.35)]">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-separate [border-spacing:0]">
              <thead>
                <tr className="bg-black/60">
                  <th className="px-4 py-3 text-left text-xs uppercase tracking-[0.3em] text-zinc-500">Player</th>
                  <th className="px-4 py-3 text-right text-xs uppercase tracking-[0.3em] text-zinc-500">Score</th>
                  <th className="px-4 py-3 text-right text-xs uppercase tracking-[0.3em] text-zinc-500">Darts</th>
                  <th className="px-4 py-3 text-right text-xs uppercase tracking-[0.3em] text-zinc-500">Legs</th>
                  <th className="px-4 py-3 text-right text-xs uppercase tracking-[0.3em] text-zinc-500">Sets</th>
                  <th className="px-4 py-3 text-right text-xs uppercase tracking-[0.3em] text-zinc-500">Shanghai</th>
                </tr>
              </thead>
              <tbody>
                {players.map((player, idx) => (
                  <tr key={player.name + idx} className="border-t border-white/5 odd:bg-black/30 even:bg-black/40">
                    <td className="px-4 py-3 text-sm font-semibold text-white">{player.name}</td>
                    <td className="px-4 py-3 text-right text-lg font-bold text-emerald-400">{player.totalScored}</td>
                    <td className="px-4 py-3 text-right text-sm text-zinc-300">{player.dartsThrown}</td>
                    <td className="px-4 py-3 text-right text-sm text-zinc-300">{player.legsWon}</td>
                    <td className="px-4 py-3 text-right text-sm text-zinc-300">{player.setsWon}</td>
                    <td className="px-4 py-3 text-right text-sm text-zinc-300">{player.shanghaiHits}</td>
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
          </div>

          {summary.completedLegs && summary.completedLegs.length > 0 && (
            <div className="rounded-2xl border border-white/10 bg-black/40 px-6 py-5">
              <h2 className="text-lg font-semibold mb-3">Legs</h2>
              <div className="space-y-3">
                {summary.completedLegs.map((leg) => (
                  <div key={`leg-${leg.set}-${leg.leg}`} className="rounded-xl border border-white/10 bg-zinc-900/40 p-4">
                    <div className="flex justify-between text-sm text-zinc-400 mb-2">
                      <span>Set {leg.set} • Leg {leg.leg}</span>
                      <span className="text-emerald-300">Winner: {players[leg.winnerIndex]?.name || `Player ${leg.winnerIndex + 1}`}{leg.wonByShanghai ? " (Shanghai)" : ""}</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {leg.players.map((p) => (
                        <div key={p.playerIndex} className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 flex items-center justify-between">
                          <span className="text-white">{p.name}</span>
                          <span className="text-emerald-300 font-semibold">{p.legScore}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
