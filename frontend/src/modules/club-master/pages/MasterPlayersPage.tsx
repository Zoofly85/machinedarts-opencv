import React from "react";
import { Link } from "react-router-dom";

import { getPlayers, type ClubPlayer } from "../services/clubApi";

function normalize(value: string): string {
  return String(value || "").trim().toLowerCase();
}

export default function MasterPlayersPage() {
  const [players, setPlayers] = React.useState<ClubPlayer[]>([]);
  const [query, setQuery] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getPlayers();
      setPlayers(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load players.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = React.useMemo(() => {
    const q = normalize(query);
    if (!q) return players;
    return players.filter((player) => normalize(player.name).includes(q));
  }, [players, query]);

  return (
    <div className="min-h-screen bg-black text-white p-6 md:p-8">
      <div className="max-w-6xl mx-auto space-y-5">
        <header className="border border-cyan-900/70 rounded-2xl p-5 bg-zinc-950/90">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl md:text-3xl font-extrabold text-cyan-300">Player Directory</h1>
              <p className="text-zinc-300 mt-2">Search players and open full profile stats for rankings and performance checks.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="px-4 py-2 rounded-lg border border-cyan-700 text-cyan-200 hover:bg-cyan-900/30"
                onClick={() => void refresh()}
                disabled={loading}
              >
                Refresh
              </button>
              <Link
                className="px-4 py-2 rounded-lg border border-zinc-700 text-zinc-200 hover:bg-zinc-800/60"
                to="/club/master"
              >
                Back to Dashboard
              </Link>
            </div>
          </div>
        </header>

        <section className="border border-cyan-900/70 rounded-2xl p-5 bg-zinc-950/90">
          <label className="text-xs uppercase tracking-[0.2em] text-zinc-400">Search Players</label>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type name..."
            className="mt-2 w-full rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2 text-zinc-100"
          />
          <div className="mt-3 text-sm text-zinc-400">
            Showing {filtered.length} of {players.length} players
          </div>
        </section>

        {error && <div className="border border-red-700/60 bg-red-950/30 text-red-200 rounded-xl px-4 py-3">{error}</div>}

        <section className="border border-cyan-900/70 rounded-2xl p-5 bg-zinc-950/90">
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {filtered.map((player) => (
              <Link
                key={player.id}
                to={`/club/master/players/${encodeURIComponent(player.id)}`}
                className="border border-zinc-800 rounded-xl p-4 bg-zinc-900/70 hover:border-cyan-700/60 hover:bg-zinc-900 transition"
              >
                <div className="text-lg font-bold text-white">{player.name}</div>
                <div className="text-xs text-zinc-500 mt-1">ID: {player.id}</div>
                {player.createdAt ? (
                  <div className="text-xs text-zinc-500 mt-1">Created: {new Date(player.createdAt).toLocaleString()}</div>
                ) : null}
              </Link>
            ))}
            {!loading && !filtered.length && (
              <div className="text-zinc-400 text-sm">No players matched your search.</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

