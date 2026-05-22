import React from "react";

import { createSocialNight, createTournament, getBoards, getPlaytimeMetrics, startBoardSession, stopBoardSession } from "../services/clubApi";
import type { Board, PlaytimeMetrics } from "../../shared-domain/contracts/club";

const EMPTY_METRICS: PlaytimeMetrics = {
  occupancy_seconds: 0,
  active_play_seconds: 0,
  average_session_seconds: 0,
};

export default function MasterDashboardPage() {
  const [boards, setBoards] = React.useState<Board[]>([]);
  const [metrics, setMetrics] = React.useState<PlaytimeMetrics>(EMPTY_METRICS);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [creatingTournament, setCreatingTournament] = React.useState(false);
  const [selectedBoards, setSelectedBoards] = React.useState<Record<string, boolean>>({});
  const [actingBoardId, setActingBoardId] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextBoards, nextMetrics] = await Promise.all([getBoards(), getPlaytimeMetrics()]);
      setBoards(nextBoards);
      setMetrics(nextMetrics || EMPTY_METRICS);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load club dashboard.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreateSocialNight = async () => {
    const ids = boards
      .map((b) => b.board_id)
      .filter((id) => selectedBoards[id]);
    const targetBoardIds = ids.length ? ids : boards.map((b) => b.board_id);
    try {
      setCreating(true);
      await createSocialNight(`Social Night ${new Date().toLocaleDateString()}`, targetBoardIds);
      await Promise.all(
        targetBoardIds.map((boardId) =>
          startBoardSession(boardId, "Social Night Session", "Started by Club Master")
        )
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create social night.");
    } finally {
      setCreating(false);
    }
  };

  const handleCreateTournament = async () => {
    const ids = boards
      .map((b) => b.board_id)
      .filter((id) => selectedBoards[id]);
    const targetBoardIds = ids.length ? ids : boards.map((b) => b.board_id);
    try {
      setCreatingTournament(true);
      await createTournament(`Tournament ${new Date().toLocaleDateString()}`, targetBoardIds, "Club tournament");
      await Promise.all(
        targetBoardIds.map((boardId) =>
          startBoardSession(boardId, "Tournament Session", "Started by Club Master")
        )
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create tournament.");
    } finally {
      setCreatingTournament(false);
    }
  };

  const handleStartBoard = async (boardId: string) => {
    try {
      setActingBoardId(boardId);
      await startBoardSession(boardId, "Operator Session", "Manual start from master dashboard");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start board session.");
    } finally {
      setActingBoardId(null);
    }
  };

  const handleStopBoard = async (boardId: string) => {
    try {
      setActingBoardId(boardId);
      await stopBoardSession(boardId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to stop board session.");
    } finally {
      setActingBoardId(null);
    }
  };

  return (
    <div className="min-h-screen bg-black text-white p-6 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="border border-cyan-900/70 rounded-2xl p-5 bg-zinc-950/90">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl md:text-3xl font-extrabold text-cyan-300">Club Master Dashboard</h1>
              <p className="text-zinc-300 mt-2">Monitor board activity, run social nights, and track retention metrics.</p>
            </div>
            <a
              href="#/club/master/players"
              className="inline-flex items-center rounded-lg border border-emerald-700 px-4 py-2 text-sm text-emerald-200 hover:bg-emerald-900/30"
            >
              Players
            </a>
            <a
              href="#/club/master/social-night"
              className="inline-flex items-center rounded-lg border border-fuchsia-700 px-4 py-2 text-sm text-fuchsia-200 hover:bg-fuchsia-900/30"
            >
              Social Night
            </a>
            <a
              href="#/club/master/setup"
              className="inline-flex items-center rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800/60"
            >
              Master Setup
            </a>
          </div>
        </header>

        {error && <div className="border border-red-700/60 bg-red-950/30 text-red-200 rounded-xl px-4 py-3">{error}</div>}

        <section className="grid md:grid-cols-3 gap-4">
          <MetricCard label="Board Occupancy" value={`${Math.round((metrics.occupancy_seconds || 0) / 60)} min`} />
          <MetricCard label="Active Play" value={`${Math.round((metrics.active_play_seconds || 0) / 60)} min`} />
          <MetricCard label="Avg Session" value={`${Math.round((metrics.average_session_seconds || 0) / 60)} min`} />
        </section>

        <section className="border border-cyan-900/70 rounded-2xl p-5 bg-zinc-950/90">
          <div className="flex items-center justify-between gap-3 mb-4">
            <h2 className="text-xl font-bold text-cyan-200">Boards</h2>
            <div className="flex gap-2">
              <button
                className="px-4 py-2 rounded-lg border border-cyan-700 text-cyan-200 hover:bg-cyan-900/30"
                onClick={() => void refresh()}
                disabled={loading}
              >
                Refresh
              </button>
              <button
                className="px-4 py-2 rounded-lg border border-emerald-700 text-emerald-200 hover:bg-emerald-900/30 disabled:opacity-50"
                onClick={() => void handleCreateSocialNight()}
                disabled={creating || loading}
              >
                {creating ? "Creating..." : "Create Social Night"}
              </button>
              <button
                className="px-4 py-2 rounded-lg border border-fuchsia-700 text-fuchsia-200 hover:bg-fuchsia-900/30 disabled:opacity-50"
                onClick={() => void handleCreateTournament()}
                disabled={creatingTournament || loading}
              >
                {creatingTournament ? "Creating..." : "Create Tournament"}
              </button>
            </div>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {boards.map((board) => (
              <div key={board.board_id} className="border border-zinc-800 rounded-xl p-4 bg-zinc-900/70">
                <label className="flex items-center gap-2 text-xs text-zinc-300 mb-2">
                  <input
                    type="checkbox"
                    checked={!!selectedBoards[board.board_id]}
                    onChange={(e) =>
                      setSelectedBoards((prev) => ({ ...prev, [board.board_id]: e.target.checked }))
                    }
                  />
                  Include in bulk launch
                </label>
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-400">Board</span>
                  <span className="font-semibold">{board.board_id}</span>
                </div>
                <div className="flex justify-between text-sm mt-1">
                  <span className="text-zinc-400">Status</span>
                  <span className="font-semibold">{board.status}</span>
                </div>
                <div className="text-xs text-zinc-500 mt-2">Venue: {board.venue_id}</div>
                <div className="text-xs text-zinc-500 mt-1">Machine: {board.machine_id || "-"}</div>
                <div className="text-xs text-zinc-500 mt-1">Session: {board.active_session?.title || "-"}</div>
                <div className="mt-3 flex gap-2">
                  <button
                    className="px-3 py-1.5 rounded-md border border-emerald-700 text-emerald-200 hover:bg-emerald-900/30 disabled:opacity-50 text-xs"
                    onClick={() => void handleStartBoard(board.board_id)}
                    disabled={actingBoardId === board.board_id}
                  >
                    Start
                  </button>
                  <button
                    className="px-3 py-1.5 rounded-md border border-red-700 text-red-200 hover:bg-red-900/30 disabled:opacity-50 text-xs"
                    onClick={() => void handleStopBoard(board.board_id)}
                    disabled={actingBoardId === board.board_id}
                  >
                    Stop
                  </button>
                </div>
              </div>
            ))}
            {!boards.length && !loading && <div className="text-zinc-400 text-sm">No boards available.</div>}
          </div>
        </section>
      </div>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-cyan-900/70 rounded-xl p-4 bg-zinc-950/90">
      <div className="text-xs uppercase tracking-[0.2em] text-zinc-400">{label}</div>
      <div className="text-2xl font-extrabold text-cyan-300 mt-2">{value}</div>
    </div>
  );
}
