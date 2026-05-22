import React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Beer, TrendingUp, Target, Award } from "lucide-react";

interface BeerRacePlayerStats {
  name: string;
  totalScored: number;
  dartsThrown: number;
  visits: number;
  bestVisit: number;
  ppr: number;
  targetScore: number;
  bucketCounts: {
    "40plus": number;
    "60plus": number;
    "80plus": number;
    "100plus": number;
    "120plus": number;
    "140plus": number;
    "170plus": number;
    "180": number;
  };
  finished: boolean;
  isBot?: boolean;
  botLevel?: number;
}

interface BeerRaceStats {
  dartsThrown: number;
  totalScored: number;
  ppr: number;
  bucketCounts: {
    "40plus": number;
    "60plus": number;
    "80plus": number;
    "100plus": number;
    "120plus": number;
    "140plus": number;
    "170plus": number;
    "180": number;
  };
  bestVisit: number;
}

interface BeerRaceState {
  mode: "beer_race";
  targetScore: number;
  players: BeerRacePlayerStats[];
  stats?: BeerRaceStats[];
  winnerIndex: number | null;
  matchWinnerIndex?: number | null;
}

export default function BeerRaceStatsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const gameState = location.state as BeerRaceState | null;

  if (!gameState) {
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

  // Use stats array from backend if available, otherwise fall back to players array
  const matchStats = gameState.stats || [];
  const winnerIndex = gameState.matchWinnerIndex ?? gameState.winnerIndex;
  const winner = winnerIndex !== null ? gameState.players[winnerIndex] : null;
  const bucketKeys = ["180", "170plus", "140plus", "120plus", "100plus", "80plus", "60plus", "40plus"] as const;

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden">
      {/* Background */}
      <div className="pointer-events-none fixed inset-0 [background:radial-gradient(ellipse_at_top,rgba(220,38,38,0.15),transparent_50%),linear-gradient(to_bottom,rgba(0,0,0,0.95),rgba(0,0,0,1))]" />

      {/* Header */}
      <header className="relative z-10 w-full px-6 py-6 border-b border-white/10">
        <div className="max-w-7xl mx-auto">
          <h1 className="text-3xl font-extrabold mb-2">
            🍺 <span className="text-red-500">Beer Race</span> Stats
          </h1>
          <p className="text-zinc-400">Target: {gameState.targetScore}</p>
        </div>
      </header>

      {/* Main Content */}
      <main className="relative z-10 px-6 py-8 max-w-7xl mx-auto">
        {/* Winner Banner */}
        {winner && (
          <div className="bg-gradient-to-r from-red-900/40 to-emerald-900/40 border border-red-500/50 rounded-2xl p-8 mb-8 text-center">
            <div className="text-6xl mb-4">🏆</div>
            <div className="text-4xl font-extrabold text-red-400 mb-2">
              {winner.name} Wins!
            </div>
            <div className="text-xl text-zinc-300 mb-4">
              Final Score: <span className="text-red-500 font-bold">{winnerIndex !== null ? (matchStats[winnerIndex]?.totalScored || winner.totalScored || 0) : 0}</span>
            </div>
            <div className="flex justify-center gap-6 text-sm">
              <div>
                <div className="text-zinc-500">PPR</div>
                <div className="text-lg font-bold text-white">{winnerIndex !== null ? ((matchStats[winnerIndex]?.ppr || winner.ppr || 0).toFixed(2)) : '0.00'}</div>
              </div>
              <div>
                <div className="text-zinc-500">Darts</div>
                <div className="text-lg font-bold text-white">{winnerIndex !== null ? (matchStats[winnerIndex]?.dartsThrown || winner.dartsThrown || 0) : 0}</div>
              </div>
              <div>
                <div className="text-zinc-500">Best Visit</div>
                <div className="text-lg font-bold text-white">{winnerIndex !== null ? (matchStats[winnerIndex]?.bestVisit || winner.bestVisit || 0) : 0}</div>
              </div>
            </div>
          </div>
        )}

        {/* Player Stats Cards */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          {gameState.players.map((player, index) => {
            const isWinner = index === gameState.winnerIndex;
            const fillPercentage = (player.totalScored / player.targetScore) * 100;
            
            return (
              <div
                key={index}
                className={`rounded-2xl border p-6 ${
                  isWinner
                    ? "border-red-500 bg-red-900/20"
                    : "border-white/10 bg-zinc-900/40"
                }`}
              >
                {/* Player Header */}
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-xl font-bold text-white">
                      {player.name}
                      {player.isBot && (
                        <span className="ml-2 text-xs text-zinc-400">(Bot L{player.botLevel})</span>
                      )}
                    </h3>
                    {isWinner && (
                      <div className="text-sm text-red-500 font-semibold">Winner 🏆</div>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="text-3xl font-extrabold text-red-500">
                      {player.totalScored}
                    </div>
                    <div className="text-xs text-zinc-500">/ {player.targetScore}</div>
                  </div>
                </div>

                {/* Progress Bar */}
                <div className="mb-4">
                  <div className="h-3 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-red-600 to-red-400 transition-all duration-500"
                      style={{ width: `${Math.min(100, fillPercentage)}%` }}
                    />
                  </div>
                  <div className="text-xs text-zinc-500 mt-1 text-center">
                    {fillPercentage.toFixed(1)}% Complete
                  </div>
                </div>

                {/* Key Stats */}
                <div className="grid grid-cols-3 gap-4 mb-4">
                  <div className="text-center p-3 bg-black/40 rounded-lg">
                    <div className="flex items-center justify-center gap-1 text-amber-500 mb-1">
                      <TrendingUp className="h-4 w-4" />
                    </div>
                    <div className="text-xs text-zinc-500">PPR</div>
                    <div className="text-lg font-bold text-white">{(player.ppr || 0).toFixed(2)}</div>
                  </div>
                  <div className="text-center p-3 bg-black/40 rounded-lg">
                    <div className="flex items-center justify-center gap-1 text-amber-500 mb-1">
                      <Target className="h-4 w-4" />
                    </div>
                    <div className="text-xs text-zinc-500">Darts</div>
                    <div className="text-lg font-bold text-white">{player.dartsThrown}</div>
                  </div>
                  <div className="text-center p-3 bg-black/40 rounded-lg">
                    <div className="flex items-center justify-center gap-1 text-amber-500 mb-1">
                      <Award className="h-4 w-4" />
                    </div>
                    <div className="text-xs text-zinc-500">Best</div>
                    <div className="text-lg font-bold text-white">{player.bestVisit}</div>
                  </div>
                </div>

                {/* Visit Buckets */}
                <div>
                  <div className="text-xs text-zinc-500 mb-2 uppercase tracking-wider">
                    High Scoring Visits
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {bucketKeys.map((key) => {
                      const count = player.bucketCounts?.[key] || 0;
                      return (
                        <div
                          key={key}
                          className={`text-center p-2 rounded ${
                            count > 0
                              ? "bg-amber-900/40 border border-amber-600/30"
                              : "bg-zinc-800/40 border border-zinc-700/30"
                          }`}
                        >
                          <div className="text-xs text-zinc-400">{key}</div>
                          <div
                            className={`text-sm font-bold ${
                              count > 0 ? "text-amber-400" : "text-zinc-600"
                            }`}
                          >
                            {count}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Action Buttons */}
        <div className="flex justify-center gap-4">
          <button
            onClick={() => navigate("/lobby")}
            className="px-8 py-3 bg-amber-600 hover:bg-amber-700 rounded-lg font-semibold transition flex items-center gap-2"
          >
            <Beer className="h-5 w-5" />
            New Game
          </button>
          <button
            onClick={() => navigate("/")}
            className="px-8 py-3 bg-zinc-700 hover:bg-zinc-600 rounded-lg font-semibold transition"
          >
            Home
          </button>
        </div>
      </main>
    </div>
  );
}