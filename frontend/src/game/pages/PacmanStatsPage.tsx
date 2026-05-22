import React, { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

type PacmanPlayerState = {
  name: string;
  score: number;
  lives: number;
  pelletsEaten: number;
  missesOrEmptyHits: number;
  gameOver: boolean;
};

type PacmanState = {
  players: PacmanPlayerState[];
  winnerIndex: number | null;
  settings?: {
    livesPerPlayer?: number;
  };
  _statsMatchId?: string;
};

type HighScoreEntry = {
  name: string;
  score: number;
  pelletsEaten: number;
  lives: number;
  timestamp: string;
};

const KEY = "machine_darts_pacman_top10_v1";
const SAVED_MATCH_IDS_KEY = "machine_darts_pacman_saved_match_ids_v1";

function readScores(): HighScoreEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item.name === "string" && Number.isFinite(item.score));
  } catch {
    return [];
  }
}

function writeScores(entries: HighScoreEntry[]) {
  localStorage.setItem(KEY, JSON.stringify(entries.slice(0, 10)));
}

function dedupeScores(entries: HighScoreEntry[]): HighScoreEntry[] {
  const seen = new Set<string>();
  const out: HighScoreEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.name}|${entry.score}|${entry.pelletsEaten}|${entry.lives}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function readSavedMatchIds(): string[] {
  try {
    const raw = localStorage.getItem(SAVED_MATCH_IDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => typeof item === "string");
  } catch {
    return [];
  }
}

function writeSavedMatchIds(ids: string[]) {
  localStorage.setItem(SAVED_MATCH_IDS_KEY, JSON.stringify(ids.slice(-200)));
}

export default function PacmanStatsPage() {
  const navigate = useNavigate();
  const { state } = useLocation() as { state?: PacmanState };
  const summary = state;
  const [highscores, setHighscores] = useState<HighScoreEntry[]>(() =>
    dedupeScores(readScores().sort((a, b) => b.score - a.score)).slice(0, 10),
  );

  useEffect(() => {
    if (!summary?.players?.length) return;
    const fallbackMatchId = [
      "legacy",
      String(summary.winnerIndex ?? -1),
      ...summary.players.map((p) => `${p.name}|${p.score}|${p.pelletsEaten}|${p.lives}|${p.missesOrEmptyHits}`),
    ].join("::");
    const matchId = String(summary._statsMatchId || fallbackMatchId);
    const savedMatchIds = readSavedMatchIds();
    if (savedMatchIds.includes(matchId)) {
      const clean = dedupeScores(readScores().sort((a, b) => b.score - a.score)).slice(0, 10);
      writeScores(clean);
      setHighscores(clean);
      return;
    }

    const existing = readScores();
    const additions: HighScoreEntry[] = summary.players.map((player) => ({
      name: player.name,
      score: Number(player.score || 0),
      pelletsEaten: Number(player.pelletsEaten || 0),
      lives: Number(player.lives || 0),
      timestamp: new Date().toISOString(),
    }));
    const merged = dedupeScores([...existing, ...additions].sort((a, b) => b.score - a.score)).slice(0, 10);
    writeScores(merged);
    setHighscores(merged);
    writeSavedMatchIds([...savedMatchIds, matchId]);
  }, [summary]);

  if (!summary?.players?.length) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-400 text-lg mb-4">No PacDarts stats found</p>
          <button onClick={() => navigate("/lobby")} className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700">Lobby</button>
        </div>
      </div>
    );
  }

  const winner = summary.winnerIndex != null ? summary.players[summary.winnerIndex] : null;

  return (
    <div className="min-h-screen bg-black text-white p-4 md:p-6">
      <div className="max-w-5xl mx-auto space-y-5">
        <header className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">PacDarts Match Stats</h1>
            {winner && <p className="text-emerald-300 text-sm mt-1">Winner: {winner.name} ({winner.score})</p>}
          </div>
          <div className="flex gap-2">
            <button onClick={() => navigate("/lobby")} className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700">New Match</button>
            <button onClick={() => navigate("/")} className="px-4 py-2 rounded bg-red-700 hover:bg-red-600">Home</button>
          </div>
        </header>

        <section className="rounded-2xl border border-white/10 bg-zinc-900/50 overflow-hidden">
          <table className="w-full">
            <thead className="bg-black/40 text-zinc-400 text-xs uppercase tracking-[0.2em]">
              <tr>
                <th className="text-left px-4 py-3">Player</th>
                <th className="text-right px-4 py-3">Score</th>
                <th className="text-right px-4 py-3">Pellets</th>
                <th className="text-right px-4 py-3">Lives</th>
                <th className="text-right px-4 py-3">Empty/Miss</th>
              </tr>
            </thead>
            <tbody>
              {summary.players.map((p, idx) => (
                <tr key={`${p.name}-${idx}`} className="border-t border-white/10">
                  <td className="px-4 py-3">{p.name}</td>
                  <td className="px-4 py-3 text-right font-semibold text-emerald-300">{p.score}</td>
                  <td className="px-4 py-3 text-right">{p.pelletsEaten}</td>
                  <td className="px-4 py-3 text-right">{p.lives}</td>
                  <td className="px-4 py-3 text-right">{p.missesOrEmptyHits}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="rounded-2xl border border-white/10 bg-zinc-900/50 overflow-hidden">
          <div className="px-4 py-3 border-b border-white/10 text-sm uppercase tracking-[0.2em] text-zinc-400">Top 10 High Scores</div>
          <table className="w-full">
            <thead className="bg-black/30 text-zinc-400 text-xs uppercase tracking-[0.2em]">
              <tr>
                <th className="text-left px-4 py-2">#</th>
                <th className="text-left px-4 py-2">Name</th>
                <th className="text-right px-4 py-2">Score</th>
                <th className="text-right px-4 py-2">Pellets</th>
              </tr>
            </thead>
            <tbody>
              {highscores.map((entry, idx) => (
                <tr key={`${entry.name}-${entry.timestamp}-${idx}`} className="border-t border-white/10">
                  <td className="px-4 py-2">{idx + 1}</td>
                  <td className="px-4 py-2">{entry.name}</td>
                  <td className="px-4 py-2 text-right font-semibold text-emerald-300">{entry.score}</td>
                  <td className="px-4 py-2 text-right">{entry.pelletsEaten}</td>
                </tr>
              ))}
              {!highscores.length && (
                <tr>
                  <td colSpan={4} className="px-4 py-4 text-center text-zinc-500">No highscores yet</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
