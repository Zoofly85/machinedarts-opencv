import React from "react";
import { Link } from "react-router-dom";

import type { Board } from "../../shared-domain/contracts/club";
import {
  createSocialNightWithPlan,
  generateSocialNightPlayoffs,
  generateSocialNightPlan,
  getSocialNight,
  getBoards,
  getPlayers,
  startBoardSession,
  type ClubPlayer,
  type SocialNightPlan,
  type SocialNightPlayoffBracket,
  type SocialNightStandingsGroup,
  submitSocialNightResult,
} from "../services/clubApi";

export default function MasterSocialNightPage() {
  const [boards, setBoards] = React.useState<Board[]>([]);
  const [players, setPlayers] = React.useState<ClubPlayer[]>([]);
  const [selectedBoards, setSelectedBoards] = React.useState<Record<string, boolean>>({});
  const [selectedPlayers, setSelectedPlayers] = React.useState<Record<string, boolean>>({});
  const [name, setName] = React.useState(`Social Night ${new Date().toLocaleDateString()}`);
  const [format, setFormat] = React.useState<"singles" | "doubles">("singles");
  const [gameMode, setGameMode] = React.useState("x01");
  const [playersPerBoard, setPlayersPerBoard] = React.useState(6);
  const [qualifyWins, setQualifyWins] = React.useState(3);
  const [plan, setPlan] = React.useState<SocialNightPlan | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [generating, setGenerating] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [activeSocialNightId, setActiveSocialNightId] = React.useState<string | null>(null);
  const [standingsGroups, setStandingsGroups] = React.useState<SocialNightStandingsGroup[]>([]);
  const [playoffs, setPlayoffs] = React.useState<SocialNightPlayoffBracket | null>(null);
  const [resultBusyMatchId, setResultBusyMatchId] = React.useState<string | null>(null);
  const [generatingPlayoffs, setGeneratingPlayoffs] = React.useState(false);
  const [winnerByMatch, setWinnerByMatch] = React.useState<Record<string, "a" | "b">>({});
  const [scoreByMatch, setScoreByMatch] = React.useState<Record<string, { a?: number; b?: number }>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [info, setInfo] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextBoards, nextPlayers] = await Promise.all([getBoards(), getPlayers()]);
      setBoards(nextBoards);
      setPlayers(nextPlayers);
      if (!Object.keys(selectedBoards).length) {
        const defaultBoards: Record<string, boolean> = {};
        for (const b of nextBoards) defaultBoards[b.board_id] = true;
        setSelectedBoards(defaultBoards);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load social-night setup.");
    } finally {
      setLoading(false);
    }
  }, [selectedBoards]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectedBoardIds = React.useMemo(
    () => boards.map((b) => b.board_id).filter((id) => selectedBoards[id]),
    [boards, selectedBoards],
  );

  const selectedPlayerRows = React.useMemo(
    () => players.filter((p) => selectedPlayers[p.id]).map((p) => ({ id: p.id, name: p.name })),
    [players, selectedPlayers],
  );

  const handleGenerate = async () => {
    setGenerating(true);
    setError(null);
    setInfo(null);
    try {
      const nextPlan = await generateSocialNightPlan({
        name,
        format,
        game_mode: gameMode,
        board_ids: selectedBoardIds,
        players_per_board: playersPerBoard,
        qualify_wins: qualifyWins,
        players: selectedPlayerRows,
      });
      setPlan(nextPlan);
      setInfo("Plan generated. Review groups/fixtures and then start social night.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate social-night plan.");
    } finally {
      setGenerating(false);
    }
  };

  const handleStart = async () => {
    if (!plan) {
      setError("Generate a social-night plan first.");
      return;
    }
    setStarting(true);
    setError(null);
    setInfo(null);
    try {
      const social = await createSocialNightWithPlan(plan.name, plan.board_ids, plan);
      await Promise.all(
        plan.board_ids.map((boardId) =>
          startBoardSession(boardId, `Social Night: ${plan.name}`, `${plan.format} | ${plan.game_mode}`)
        )
      );
      setActiveSocialNightId(social.id);
      setStandingsGroups([]);
      setPlayoffs(null);
      setInfo("Social night started and board sessions launched.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start social night.");
    } finally {
      setStarting(false);
    }
  };

  const refreshActiveSocialNight = React.useCallback(async () => {
    if (!activeSocialNightId) return;
    try {
      const data = await getSocialNight(activeSocialNightId);
      const planFromServer = data?.social_night?.plan;
      if (planFromServer && typeof planFromServer === "object") {
        setPlan(planFromServer as SocialNightPlan);
      }
      setStandingsGroups(Array.isArray(data?.standings?.groups) ? data.standings.groups : []);
      setPlayoffs(data?.social_night?.playoffs || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refresh social-night standings.");
    }
  }, [activeSocialNightId]);

  React.useEffect(() => {
    if (!activeSocialNightId) return;
    void refreshActiveSocialNight();
    const id = window.setInterval(() => {
      void refreshActiveSocialNight();
    }, 8000);
    return () => window.clearInterval(id);
  }, [activeSocialNightId, refreshActiveSocialNight]);

  const handleSubmitResult = async (matchId: string) => {
    if (!activeSocialNightId) {
      setError("Start a social night first.");
      return;
    }
    const winner = winnerByMatch[matchId];
    if (!winner) {
      setError("Pick winner A/B first.");
      return;
    }
    const score = scoreByMatch[matchId] || {};
    setResultBusyMatchId(matchId);
    setError(null);
    try {
      const updated = await submitSocialNightResult({
        socialNightId: activeSocialNightId,
        matchId,
        winner,
        scoreA: score.a,
        scoreB: score.b,
      });
      setStandingsGroups(Array.isArray(updated?.groups) ? updated.groups : []);
      setInfo(`Result saved for ${matchId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit match result.");
    } finally {
      setResultBusyMatchId(null);
    }
  };

  const handleGeneratePlayoffs = async () => {
    if (!activeSocialNightId) {
      setError("Start a social night first.");
      return;
    }
    setGeneratingPlayoffs(true);
    setError(null);
    setInfo(null);
    try {
      const bracket = await generateSocialNightPlayoffs({ socialNightId: activeSocialNightId, minQualifiers: 4, maxQualifiers: 16 });
      setPlayoffs(bracket);
      setInfo("Playoff bracket generated from current qualifiers.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate playoff bracket.");
    } finally {
      setGeneratingPlayoffs(false);
    }
  };

  return (
    <div className="min-h-screen bg-black text-white p-6 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <header className="border border-cyan-900/70 rounded-2xl p-5 bg-zinc-950/90">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl md:text-3xl font-extrabold text-cyan-300">Social Night Planner</h1>
              <p className="text-zinc-300 mt-2">
                Configure weekly singles/doubles night, randomize groups per board, and apply handicap ladders.
              </p>
            </div>
            <Link className="px-4 py-2 rounded-lg border border-zinc-700 text-zinc-200 hover:bg-zinc-800/60" to="/club/master">
              Back to Dashboard
            </Link>
          </div>
        </header>

        {error ? <div className="border border-red-700/60 bg-red-950/30 text-red-200 rounded-xl px-4 py-3">{error}</div> : null}
        {info ? <div className="border border-emerald-700/60 bg-emerald-950/30 text-emerald-200 rounded-xl px-4 py-3">{info}</div> : null}

        <section className="border border-cyan-900/70 rounded-2xl p-5 bg-zinc-950/90 grid lg:grid-cols-3 gap-5">
          <div className="space-y-3">
            <label className="text-xs uppercase tracking-[0.2em] text-zinc-400">Night Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2"
            />
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs uppercase tracking-[0.2em] text-zinc-400">Format</label>
                <select
                  value={format}
                  onChange={(e) => setFormat(e.target.value === "doubles" ? "doubles" : "singles")}
                  className="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2"
                >
                  <option value="singles">Singles</option>
                  <option value="doubles">Doubles</option>
                </select>
              </div>
              <div>
                <label className="text-xs uppercase tracking-[0.2em] text-zinc-400">Game Mode</label>
                <select
                  value={gameMode}
                  onChange={(e) => setGameMode(e.target.value)}
                  className="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2"
                >
                  <option value="x01">X01</option>
                  <option value="cricket">Cricket</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs uppercase tracking-[0.2em] text-zinc-400">Players Per Board</label>
                <input
                  type="number"
                  min={2}
                  max={16}
                  value={playersPerBoard}
                  onChange={(e) => setPlayersPerBoard(Math.max(2, Math.min(16, Number(e.target.value) || 6)))}
                  className="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2"
                />
              </div>
              <div>
                <label className="text-xs uppercase tracking-[0.2em] text-zinc-400">Qualify Wins</label>
                <input
                  type="number"
                  min={1}
                  max={16}
                  value={qualifyWins}
                  onChange={(e) => setQualifyWins(Math.max(1, Math.min(16, Number(e.target.value) || 3)))}
                  className="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2"
                />
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <button
                className="px-4 py-2 rounded-lg border border-cyan-700 text-cyan-200 hover:bg-cyan-900/30 disabled:opacity-50"
                disabled={loading || generating}
                onClick={() => void handleGenerate()}
              >
                {generating ? "Generating..." : "Generate Plan"}
              </button>
              <button
                className="px-4 py-2 rounded-lg border border-emerald-700 text-emerald-200 hover:bg-emerald-900/30 disabled:opacity-50"
                disabled={starting || !plan}
                onClick={() => void handleStart()}
              >
                {starting ? "Starting..." : "Start Social Night"}
              </button>
            </div>
          </div>

          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-zinc-400 mb-2">Boards ({selectedBoardIds.length})</div>
            <div className="max-h-64 overflow-auto space-y-2 pr-1">
              {boards.map((board) => (
                <label key={board.board_id} className="flex items-center gap-2 text-sm border border-zinc-800 rounded-md px-3 py-2 bg-zinc-900/60">
                  <input
                    type="checkbox"
                    checked={!!selectedBoards[board.board_id]}
                    onChange={(e) => setSelectedBoards((prev) => ({ ...prev, [board.board_id]: e.target.checked }))}
                  />
                  <span>{board.board_id}</span>
                  <span className="text-zinc-500 text-xs ml-auto">{board.status}</span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-zinc-400 mb-2">Players ({selectedPlayerRows.length})</div>
            <div className="max-h-64 overflow-auto space-y-2 pr-1">
              {players.map((player) => (
                <label key={player.id} className="flex items-center gap-2 text-sm border border-zinc-800 rounded-md px-3 py-2 bg-zinc-900/60">
                  <input
                    type="checkbox"
                    checked={!!selectedPlayers[player.id]}
                    onChange={(e) => setSelectedPlayers((prev) => ({ ...prev, [player.id]: e.target.checked }))}
                  />
                  <span>{player.name}</span>
                </label>
              ))}
            </div>
          </div>
        </section>

        {plan ? (
          <section className="border border-cyan-900/70 rounded-2xl p-5 bg-zinc-950/90 space-y-4">
            <div className="flex flex-wrap gap-3 text-sm text-zinc-300">
              <span><strong className="text-cyan-300">Format:</strong> {plan.format}</span>
              <span><strong className="text-cyan-300">Mode:</strong> {plan.game_mode}</span>
              <span><strong className="text-cyan-300">Boards:</strong> {plan.board_ids.length}</span>
              <span><strong className="text-cyan-300">Qualify:</strong> {plan.qualify_wins} wins</span>
            </div>
            <div className="grid xl:grid-cols-2 gap-4">
              {plan.groups.map((group) => (
                <div key={group.group_name} className="border border-zinc-800 rounded-xl p-4 bg-zinc-900/60">
                  <h3 className="text-lg font-bold text-cyan-200">
                    {group.group_name} - {group.board_id}
                  </h3>
                  <div className="text-xs text-zinc-400 mb-3">
                    {group.participants.length} participants - {group.games_per_participant} games each - {group.qualify_wins} wins to qualify
                  </div>
                  <div className="space-y-1 mb-3">
                    {group.participants.map((p) => (
                      <div key={`${group.group_name}-${p.id}-${p.name}`} className="text-sm flex justify-between">
                        <span>{p.name}</span>
                        <span className="text-amber-300">Start {p.start_score ?? "-"}</span>
                      </div>
                    ))}
                  </div>
                  <div className="space-y-2">
                    {group.fixtures.map((round) => (
                      <div key={`${group.group_name}-r-${round.round}`} className="border border-zinc-800 rounded-md px-3 py-2 bg-black/30">
                        <div className="text-xs uppercase tracking-[0.2em] text-zinc-400 mb-1">Round {round.round}</div>
                        {round.matches.map((match) => (
                          <div key={match.match_id} className="text-sm text-zinc-200 border border-zinc-800 rounded-md p-2 mb-2">
                            <div>
                              {match.a.name} ({match.a.start_score}) vs {match.b.name} ({match.b.start_score})
                            </div>
                            {activeSocialNightId ? (
                              <div className="mt-2 flex flex-wrap gap-2 items-center">
                                <button
                                  className={`px-2 py-1 rounded border text-xs ${winnerByMatch[match.match_id] === "a" ? "border-emerald-500 text-emerald-300" : "border-zinc-700 text-zinc-300"}`}
                                  onClick={() => setWinnerByMatch((prev) => ({ ...prev, [match.match_id]: "a" }))}
                                >
                                  Winner A
                                </button>
                                <button
                                  className={`px-2 py-1 rounded border text-xs ${winnerByMatch[match.match_id] === "b" ? "border-emerald-500 text-emerald-300" : "border-zinc-700 text-zinc-300"}`}
                                  onClick={() => setWinnerByMatch((prev) => ({ ...prev, [match.match_id]: "b" }))}
                                >
                                  Winner B
                                </button>
                                <input
                                  type="number"
                                  placeholder="A score"
                                  className="w-20 rounded bg-zinc-900 border border-zinc-700 px-2 py-1 text-xs"
                                  onChange={(e) =>
                                    setScoreByMatch((prev) => ({
                                      ...prev,
                                      [match.match_id]: { ...(prev[match.match_id] || {}), a: Number(e.target.value) || 0 },
                                    }))
                                  }
                                />
                                <input
                                  type="number"
                                  placeholder="B score"
                                  className="w-20 rounded bg-zinc-900 border border-zinc-700 px-2 py-1 text-xs"
                                  onChange={(e) =>
                                    setScoreByMatch((prev) => ({
                                      ...prev,
                                      [match.match_id]: { ...(prev[match.match_id] || {}), b: Number(e.target.value) || 0 },
                                    }))
                                  }
                                />
                                <button
                                  className="px-2 py-1 rounded border border-cyan-700 text-cyan-200 text-xs disabled:opacity-50"
                                  disabled={resultBusyMatchId === match.match_id}
                                  onClick={() => void handleSubmitResult(match.match_id)}
                                >
                                  {resultBusyMatchId === match.match_id ? "Saving..." : "Save Result"}
                                </button>
                              </div>
                            ) : null}
                          </div>
                        ))}
                        {!round.matches.length ? <div className="text-xs text-zinc-500">No matches</div> : null}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {standingsGroups.length ? (
          <section className="border border-emerald-900/70 rounded-2xl p-5 bg-zinc-950/90 space-y-4">
            <h2 className="text-xl font-bold text-emerald-300">Live Standings</h2>
            <div className="grid xl:grid-cols-2 gap-4">
              {standingsGroups.map((group) => (
                <div key={`${group.group_name}-${group.board_id}`} className="border border-zinc-800 rounded-xl p-4 bg-zinc-900/60">
                  <div className="text-lg font-bold text-white">{group.group_name} - {group.board_id}</div>
                  <div className="text-xs text-zinc-400 mb-3">Qualify at {group.qualify_wins} wins</div>
                  <div className="space-y-1">
                    {group.rows.map((row) => (
                      <div key={`${group.group_name}-${row.id || row.name}`} className="text-sm flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className={row.qualified ? "text-emerald-300 font-semibold" : "text-zinc-200"}>{row.name}</span>
                          {row.qualified ? <span className="text-[10px] px-1.5 py-0.5 rounded border border-emerald-700 text-emerald-300">Q</span> : null}
                        </div>
                        <span className="text-zinc-300">W{row.wins} L{row.losses} P{row.played}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {standingsGroups.length ? (
          <section className="border border-fuchsia-900/70 rounded-2xl p-5 bg-zinc-950/90 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xl font-bold text-fuchsia-300">Playoffs</h2>
              <button
                className="px-4 py-2 rounded-lg border border-fuchsia-700 text-fuchsia-200 hover:bg-fuchsia-900/30 disabled:opacity-50"
                disabled={generatingPlayoffs || !activeSocialNightId}
                onClick={() => void handleGeneratePlayoffs()}
              >
                {generatingPlayoffs ? "Generating..." : "Generate Playoffs"}
              </button>
            </div>
            {playoffs ? (
              <div className="space-y-4">
                <div className="text-sm text-zinc-300">
                  Bracket size: {playoffs.size} | Qualifiers: {playoffs.qualifiers.length}
                </div>
                <div className="grid xl:grid-cols-2 gap-4">
                  {playoffs.rounds.map((round) => (
                    <div key={`round-${round.round}`} className="border border-zinc-800 rounded-xl p-4 bg-zinc-900/60">
                      <h3 className="text-lg font-bold text-fuchsia-200 mb-2">Round {round.round}</h3>
                      <div className="space-y-2">
                        {round.matches.map((match) => (
                          <div key={match.match_id} className="border border-zinc-800 rounded-md px-3 py-2 bg-black/30 text-sm">
                            <div>{match.a.name} vs {match.b.name}</div>
                            <div className="text-xs text-zinc-500 mt-1">Match: {match.match_id}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-sm text-zinc-500">No playoff bracket generated yet.</div>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}
