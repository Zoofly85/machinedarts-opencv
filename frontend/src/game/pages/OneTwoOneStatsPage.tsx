import React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Trophy, Target } from "lucide-react";

interface AttemptSummary {
  target: number;
  success: boolean;
  dartsUsed: number;
  busts?: number;
}

interface OneTwoOnePlayerStats {
  name: string;
  currentTarget: number;
  startingTarget: number;
  targetLimit: number | null;
  successes: number;
  failures: number;
  busts: number;
  bestTargetReached: number;
  attemptHistory?: AttemptSummary[];
}

interface OneTwoOneStatsState {
  players: OneTwoOnePlayerStats[];
  winnerIndex: number | null;
  match?: { matchWinner?: number | null };
  stats?: Array<{
    attempts: number;
    successes: number;
    failures: number;
    checkoutPercentage: number;
    bestTargetReached: number;
    fastestCheckoutDarts: number | null;
    longestStreak: number;
  }>;
}

export default function OneTwoOneStatsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as OneTwoOneStatsState | null;
  const deriveStats = (player: OneTwoOnePlayerStats, index: number) => {
    const provided = state?.stats?.[index];
    if (provided) {
      return {
        attempts: provided.attempts,
        successes: provided.successes,
        failures: provided.failures,
        checkoutPercentage: provided.checkoutPercentage,
        bestTargetReached: provided.bestTargetReached,
        fastestCheckoutDarts: provided.fastestCheckoutDarts,
        longestStreak: provided.longestStreak,
      };
    }
    const attempts = player.attemptHistory?.length || 0;
    const successes = player.attemptHistory?.filter((a) => a.success).length || 0;
    const failures = attempts - successes;
    const checkoutPercentage = attempts ? (successes / attempts) * 100 : 0;
    const fastestCheckoutDarts = player.attemptHistory
      ?.filter((a) => a.success)
      .reduce<number | null>((min, a) => (min === null || a.dartsUsed < min ? a.dartsUsed : min), null) ?? null;
    let longestStreak = 0;
    let current = 0;
    player.attemptHistory?.forEach((a) => {
      if (a.success) {
        current += 1;
      } else {
        longestStreak = Math.max(longestStreak, current);
        current = 0;
      }
    });
    longestStreak = Math.max(longestStreak, current);
    return {
      attempts,
      successes,
      failures,
      checkoutPercentage,
      bestTargetReached: player.bestTargetReached,
      fastestCheckoutDarts,
      longestStreak,
    };
  };

  if (!state) {
    return (
      <div className="min-h-screen w-full bg-black text-white flex items-center justify-center">
        <div className="text-center">
          <div className="text-2xl font-bold mb-3">No stats available</div>
          <button
            onClick={() => navigate("/lobby")}
            className="px-5 py-3 rounded-lg bg-red-600 hover:bg-red-500 transition"
          >
            Lobby
          </button>
        </div>
      </div>
    );
  }

  const winnerIndex = state.match?.matchWinner ?? state.winnerIndex;
  const winner = winnerIndex !== null && winnerIndex !== undefined ? state.players[winnerIndex] : null;

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden">
      <div className="pointer-events-none fixed inset-0 [background:radial-gradient(ellipse_at_top,rgba(220,38,38,0.18),transparent_55%),radial-gradient(ellipse_at_bottom_right,rgba(255,255,255,0.05),transparent_60%),linear-gradient(to_bottom,rgba(0,0,0,0.95),rgba(0,0,0,1))]" />

      <header className="relative z-10 w-full px-6 py-6 border-b border-white/10">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-extrabold">
              One Two One <span className="text-red-500">Stats</span>
            </h1>
            <p className="text-zinc-400 text-sm">Checkout ladder practice • 3 visits (9 darts) per target</p>
          </div>
          <button
            onClick={() => navigate("/lobby")}
            className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/10"
          >
            Lobby
          </button>
        </div>
      </header>

      <main className="relative z-10 px-6 py-8">
        <div className="max-w-6xl mx-auto space-y-8">
          {winner && (
            <div className="rounded-2xl border border-red-500/60 bg-red-600/10 px-6 py-5 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Trophy className="text-red-400" />
                <div>
                  <div className="text-lg font-semibold text-white">{winner.name}</div>
                  <div className="text-sm text-red-200">Wins the ladder</div>
                </div>
              </div>
              <div className="text-sm text-red-200">Best Target: {winner.bestTargetReached}</div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {state.players.map((player, idx) => {
              const stats = deriveStats(player, idx);
              return (
                <div key={idx} className="rounded-2xl border border-white/10 bg-zinc-900/60 p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs uppercase tracking-[0.3em] text-zinc-500">Player</div>
                      <div className="text-xl font-semibold text-white">{player.name}</div>
                    </div>
                    <div className="flex items-center gap-2 text-red-400">
                      <Target size={18} />
                      <span className="text-sm">Best {stats.bestTargetReached}</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-sm text-zinc-300">
                    <div>
                      <div className="text-zinc-500 text-xs uppercase tracking-[0.2em]">Attempts</div>
                      <div className="text-lg font-semibold text-white">{stats.attempts}</div>
                    </div>
                    <div>
                      <div className="text-zinc-500 text-xs uppercase tracking-[0.2em]">Successes</div>
                      <div className="text-lg font-semibold text-white">{stats.successes}</div>
                    </div>
                    <div>
                      <div className="text-zinc-500 text-xs uppercase tracking-[0.2em]">Failures</div>
                      <div className="text-lg font-semibold text-white">{stats.failures}</div>
                    </div>
                    <div>
                      <div className="text-zinc-500 text-xs uppercase tracking-[0.2em]">Checkout %</div>
                      <div className="text-lg font-semibold text-white">{stats.checkoutPercentage.toFixed(1)}%</div>
                    </div>
                    <div>
                      <div className="text-zinc-500 text-xs uppercase tracking-[0.2em]">Fastest Checkout</div>
                      <div className="text-lg font-semibold text-white">
                        {stats.fastestCheckoutDarts ? `${stats.fastestCheckoutDarts} darts` : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-zinc-500 text-xs uppercase tracking-[0.2em]">Longest Streak</div>
                      <div className="text-lg font-semibold text-white">{stats.longestStreak}</div>
                    </div>
                  </div>

                  {player.attemptHistory && player.attemptHistory.length > 0 && (
                    <div className="border-t border-white/5 pt-3">
                      <div className="text-xs uppercase tracking-[0.3em] text-zinc-500 mb-2">Attempts</div>
                      <div className="flex flex-col gap-2 max-h-48 overflow-y-auto pr-1">
                        {player.attemptHistory.slice().reverse().map((attempt, attemptIdx) => (
                          <div
                            key={attemptIdx}
                            className={`rounded-lg px-3 py-2 text-sm flex justify-between ${
                              attempt.success ? "bg-red-600/10 border border-red-500/40" : "bg-zinc-800/60 border border-white/5"
                            }`}
                          >
                            <span>
                              Target {attempt.target} — {attempt.success ? "Success" : "Fail"}
                            </span>
                            <span className="text-zinc-300">{attempt.dartsUsed} darts</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </main>
    </div>
  );
}
