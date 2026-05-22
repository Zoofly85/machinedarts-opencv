import React from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Bot, CheckCircle2, Plus, RefreshCw, Swords, Trash2, Trophy, UserPlus } from "lucide-react";
import {
  createTournament,
  deleteTournament,
  getTournament,
  listTournaments,
  resolveTournamentBackground,
  setTournamentMatchReady,
  setTournamentMatchStatus,
  type Tournament,
  type TournamentMatch,
  type TournamentParticipant,
  type TournamentSettings,
} from "../services/tournamentsApi";
import { getPlayersCached, listImportedPlayerBots, getPlayerBotStatus, type PlayerBotStatus, type PlayerProfile } from "../services/playersApi";
import type { LobbyState, PlayerConfig } from "../context/LobbyContext";

const DEFAULT_SETTINGS: TournamentSettings = {
  startScore: 501,
  legsPerSet: 3,
  setsToWin: 1,
  inMode: "straight",
  outMode: "double",
};

function participantLabel(participant?: TournamentParticipant | null): string {
  if (!participant) return "TBD";
  if (participant.type === "ai_bot") return `${participant.name} (AI)`;
  if (participant.type === "player_bot") return `${participant.name} (PlayerBot)`;
  return participant.name;
}

function participantToPlayerConfig(participant: TournamentParticipant): PlayerConfig {
  if (participant.type === "ai_bot") {
    return {
      name: participant.name,
      isBot: true,
      botLevel: participant.botLevel || 4,
    };
  }
  if (participant.type === "player_bot") {
    return {
      name: `${participant.name} (Bot)`,
      isBot: false,
      isPlayerBot: true,
      botLevel: 4,
      sourcePlayerId: participant.sourcePlayerId || undefined,
    };
  }
  return {
    name: participant.name,
    isBot: false,
    profileId: participant.profileId || undefined,
  };
}

function isAutoReadyParticipant(participant?: TournamentParticipant | null): boolean {
  return participant?.type === "ai_bot" || participant?.type === "player_bot";
}

function buildLobbyState(players: PlayerConfig[], settings: TournamentSettings): Partial<LobbyState> {
  return {
    selectedGame: "x01",
    players,
    startingPlayer: 0,
    match: {
      sets: settings.setsToWin,
      legs: settings.legsPerSet,
      freePlay: false,
      bullOff: false,
    },
    x01: {
      startScore: settings.startScore,
      inMode: settings.inMode,
      outMode: settings.outMode,
      handicapEnabled: false,
      gameVariant: "standard",
      lmsTotalLegs: 3,
      teams: [],
    },
  };
}

export default function TournamentsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const isCreateMode = location.pathname.endsWith("/create");
  const selectedId = searchParams.get("id");
  const [tournaments, setTournaments] = React.useState<Tournament[]>([]);
  const [selected, setSelected] = React.useState<Tournament | null>(null);
  const [profiles, setProfiles] = React.useState<PlayerProfile[]>([]);
  const [playerBots, setPlayerBots] = React.useState<PlayerBotStatus[]>([]);
  const [name, setName] = React.useState("Local Knockout");
  const [settings, setSettings] = React.useState<TournamentSettings>(DEFAULT_SETTINGS);
  const [draftParticipants, setDraftParticipants] = React.useState<Array<Partial<TournamentParticipant>>>([]);
  const [guestName, setGuestName] = React.useState("");
  const [aiLevel, setAiLevel] = React.useState(4);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [watchMatch, setWatchMatch] = React.useState<TournamentMatch | null>(null);

  const participantsById = React.useMemo(() => {
    const map = new Map<string, TournamentParticipant>();
    selected?.participants?.forEach((participant) => map.set(participant.id, participant));
    return map;
  }, [selected]);

  const activeMatches = React.useMemo(() => (
    selected?.matches?.filter((match) => match.status === "active") || []
  ), [selected]);

  const loadAll = React.useCallback(async () => {
    setMessage("");
    const [nextTournaments, nextProfiles] = await Promise.all([
      listTournaments(),
      getPlayersCached({ force: true }),
    ]);
    setTournaments(nextTournaments);
    setProfiles(nextProfiles);
    const botRows = await Promise.all(
      nextProfiles.map(async (profile) => {
        try {
          return await getPlayerBotStatus(profile.id);
        } catch {
          return null;
        }
      }),
    );
    let importedBots: PlayerBotStatus[] = [];
    try {
      importedBots = await listImportedPlayerBots();
    } catch {
      importedBots = [];
    }
    setPlayerBots([...botRows.filter((row): row is PlayerBotStatus => row !== null), ...importedBots].filter((bot) => bot.isUnlocked));
    if (isCreateMode) {
      setSelected(null);
    } else if (selectedId) {
      setSelected(await getTournament(selectedId));
    } else if (nextTournaments[0]) {
      setSelected(nextTournaments[0]);
      setSearchParams({ id: nextTournaments[0].id });
    }
  }, [isCreateMode, selectedId, setSearchParams]);

  React.useEffect(() => {
    loadAll().catch((err) => setMessage(err instanceof Error ? err.message : String(err)));
  }, [loadAll]);

  const addProfile = React.useCallback((profile: PlayerProfile) => {
    setDraftParticipants((prev) => {
      if (prev.some((item) => item.profileId === profile.id)) return prev;
      return [...prev, { name: profile.name, type: "profile", profileId: profile.id }];
    });
  }, []);

  const addGuest = React.useCallback(() => {
    const trimmed = guestName.trim();
    if (!trimmed) return;
    setDraftParticipants((prev) => [...prev, { name: trimmed, type: "guest" }]);
    setGuestName("");
  }, [guestName]);

  const addAiBot = React.useCallback(() => {
    setDraftParticipants((prev) => [...prev, { name: `AI Bot L${aiLevel}`, type: "ai_bot", botLevel: aiLevel }]);
  }, [aiLevel]);

  const addPlayerBot = React.useCallback((bot: PlayerBotStatus) => {
    setDraftParticipants((prev) => {
      if (prev.some((item) => item.sourcePlayerId === bot.playerId)) return prev;
      return [...prev, { name: bot.playerName, type: "player_bot", sourcePlayerId: bot.playerId }];
    });
  }, []);

  const handleCreate = React.useCallback(async () => {
    setBusy(true);
    setMessage("");
    try {
      const tournament = await createTournament({ name, participants: draftParticipants, settings });
      setDraftParticipants([]);
      setSelected(tournament);
      setTournaments((prev) => [tournament, ...prev.filter((item) => item.id !== tournament.id)]);
      navigate(`/tournaments?id=${encodeURIComponent(tournament.id)}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [draftParticipants, name, navigate, settings]);

  const handleDelete = React.useCallback(async (tournamentId: string) => {
    if (!window.confirm("Delete this tournament?")) return;
    setBusy(true);
    try {
      await deleteTournament(tournamentId);
      const remaining = tournaments.filter((item) => item.id !== tournamentId);
      const nextSelected = remaining[0] || null;
      setTournaments(remaining);
      setSelected(nextSelected);
      setSearchParams(nextSelected ? { id: nextSelected.id } : {});
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [setSearchParams, tournaments]);

  const handleStartMatch = React.useCallback(async (match: TournamentMatch) => {
    if (!selected) return;
    const playerA = match.playerAId ? participantsById.get(match.playerAId) : null;
    const playerB = match.playerBId ? participantsById.get(match.playerBId) : null;
    if (!playerA || !playerB) return;
    const nextTournament = await setTournamentMatchStatus(selected.id, match.id, "active");
    setSelected(nextTournament);
    setTournaments((prev) => prev.map((item) => item.id === nextTournament.id ? nextTournament : item));
    const players = [participantToPlayerConfig(playerA), participantToPlayerConfig(playerB)];
    navigate("/x01", {
      state: {
        ...buildLobbyState(players, selected.settings || DEFAULT_SETTINGS),
        tournamentMatch: {
          tournamentId: selected.id,
          matchId: match.id,
          participantIds: [playerA.id, playerB.id],
        },
      },
    });
  }, [navigate, participantsById, selected]);

  React.useEffect(() => {
    if (!selected) return;
    const hasBackgroundMatch = selected.matches.some((match) => {
      if (match.status !== "pending") return false;
      const playerA = match.playerAId ? participantsById.get(match.playerAId) : null;
      const playerB = match.playerBId ? participantsById.get(match.playerBId) : null;
      return Boolean(playerA && playerB && isAutoReadyParticipant(playerA) && isAutoReadyParticipant(playerB));
    });
    if (!hasBackgroundMatch) return;
    const timer = window.setTimeout(() => {
      resolveTournamentBackground(selected.id)
        .then(({ tournament, resolved }) => {
          if (resolved <= 0) return;
          setSelected(tournament);
          setTournaments((prev) => prev.map((item) => item.id === tournament.id ? tournament : item));
          setMessage(`${resolved} bot match${resolved === 1 ? "" : "es"} finished in the background.`);
        })
        .catch((err) => setMessage(err instanceof Error ? err.message : String(err)));
    }, 600);
    return () => window.clearTimeout(timer);
  }, [participantsById, selected]);

  const handleReady = React.useCallback(async (match: TournamentMatch, participant: TournamentParticipant, ready: boolean) => {
    if (!selected) return;
    setBusy(true);
    setMessage("");
    try {
      const tournament = await setTournamentMatchReady({
        tournamentId: selected.id,
        matchId: match.id,
        participantId: participant.id,
        ready,
      });
      setSelected(tournament);
      setTournaments((prev) => prev.map((item) => item.id === tournament.id ? tournament : item));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [selected]);

  const rounds = React.useMemo(() => {
    const map = new Map<number, TournamentMatch[]>();
    selected?.matches?.forEach((match) => {
      const rows = map.get(match.round) || [];
      rows.push(match);
      map.set(match.round, rows);
    });
    return Array.from(map.entries())
      .sort(([a], [b]) => a - b)
      .map(([round, matches]) => [round, matches.sort((a, b) => a.position - b.position)] as const);
  }, [selected]);

  const winner = selected?.winnerId ? participantsById.get(selected.winnerId) : null;

  if (isCreateMode) {
    return (
      <div className="min-h-screen w-full bg-black text-white relative overflow-hidden">
        <div className="pointer-events-none fixed inset-0 [background:radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),linear-gradient(135deg,rgba(30,64,175,0.16),rgba(0,0,0,0.96)_42%,rgba(127,29,29,0.16)_100%)]" />
        <header className="relative z-10 w-full px-6 md:px-10 py-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-extrabold tracking-wide">Create Tournament</h1>
            <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Local knockout setup</p>
          </div>
          <button type="button" onClick={() => navigate("/tournaments")} className="rounded-lg bg-zinc-800/80 px-4 py-2 text-sm hover:bg-zinc-700/80">Back</button>
        </header>

        <main className="relative z-10 w-full max-w-6xl mx-auto px-6 md:px-10 pb-10 grid gap-6 lg:grid-cols-[420px_1fr]">
          <section className="rounded-2xl border border-white/10 bg-zinc-950/70 p-5 self-start">
            <h2 className="text-lg font-semibold flex items-center gap-2"><Plus className="h-5 w-5" /> Create Knockout</h2>
            {message && <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">{message}</div>}
            <div className="mt-4 space-y-3">
              <input value={name} onChange={(event) => setName(event.target.value)} className="w-full rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-sm outline-none focus:border-blue-500" />
              <div className="grid grid-cols-3 gap-2">
                <label className="text-xs text-zinc-400">X01
                  <input type="number" value={settings.startScore} onChange={(event) => setSettings((prev) => ({ ...prev, startScore: Number(event.target.value) || 501 }))} className="mt-1 w-full rounded-lg border border-white/10 bg-black/50 px-2 py-2 text-sm text-white" />
                </label>
                <label className="text-xs text-zinc-400">Best Legs
                  <input type="number" value={settings.legsPerSet} min={1} onChange={(event) => setSettings((prev) => ({ ...prev, legsPerSet: Math.max(1, Number(event.target.value) || 1) }))} className="mt-1 w-full rounded-lg border border-white/10 bg-black/50 px-2 py-2 text-sm text-white" />
                </label>
                <label className="text-xs text-zinc-400">Sets
                  <input type="number" value={settings.setsToWin} min={1} onChange={(event) => setSettings((prev) => ({ ...prev, setsToWin: Math.max(1, Number(event.target.value) || 1) }))} className="mt-1 w-full rounded-lg border border-white/10 bg-black/50 px-2 py-2 text-sm text-white" />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <select value={settings.inMode} onChange={(event) => setSettings((prev) => ({ ...prev, inMode: event.target.value as TournamentSettings["inMode"] }))} className="rounded-lg border border-white/10 bg-black/50 px-2 py-2 text-sm">
                  <option value="straight">Straight In</option>
                  <option value="double">Double In</option>
                  <option value="master">Master In</option>
                </select>
                <select value={settings.outMode} onChange={(event) => setSettings((prev) => ({ ...prev, outMode: event.target.value as TournamentSettings["outMode"] }))} className="rounded-lg border border-white/10 bg-black/50 px-2 py-2 text-sm">
                  <option value="straight">Straight Out</option>
                  <option value="double">Double Out</option>
                  <option value="master">Master Out</option>
                </select>
              </div>
              <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Participants ({draftParticipants.length})</div>
                <div className="space-y-1 max-h-52 overflow-auto pr-1">
                  {draftParticipants.map((participant, index) => (
                    <div key={`${participant.name}-${index}`} className="flex items-center justify-between rounded-lg bg-white/5 px-2 py-1 text-sm">
                      <span>{participant.name}</span>
                      <button type="button" onClick={() => setDraftParticipants((prev) => prev.filter((_, idx) => idx !== index))} className="text-zinc-500 hover:text-red-300">Remove</button>
                    </div>
                  ))}
                  {draftParticipants.length === 0 && <div className="text-sm text-zinc-500">Add at least two players.</div>}
                </div>
              </div>
              <div className="flex gap-2">
                <input value={guestName} onChange={(event) => setGuestName(event.target.value)} placeholder="Guest name" className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-sm" />
                <button type="button" onClick={addGuest} className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold hover:bg-blue-500"><UserPlus className="h-4 w-4" /></button>
              </div>
              <div className="flex gap-2">
                <select value={aiLevel} onChange={(event) => setAiLevel(Number(event.target.value))} className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-sm">
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((level) => <option key={level} value={level}>AI Bot Level {level}</option>)}
                </select>
                <button type="button" onClick={addAiBot} className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold hover:bg-blue-500"><Bot className="h-4 w-4" /></button>
              </div>
              <button type="button" disabled={busy || draftParticipants.length < 2} onClick={handleCreate} className="w-full rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold hover:bg-emerald-500 disabled:opacity-50">Create Bracket</button>
            </div>
          </section>

          <section className="grid gap-6 md:grid-cols-2 self-start">
            <div className="rounded-2xl border border-white/10 bg-zinc-950/70 p-5">
              <h2 className="text-sm font-semibold uppercase tracking-[0.22em] text-zinc-400">Add Profiles</h2>
              <div className="mt-3 space-y-2 max-h-[34rem] overflow-auto pr-1">
                {profiles.map((profile) => (
                  <button key={profile.id} type="button" onClick={() => addProfile(profile)} className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-left text-sm hover:bg-white/10">{profile.name}</button>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-zinc-950/70 p-5">
              <h2 className="text-sm font-semibold uppercase tracking-[0.22em] text-zinc-400">Add PlayerBots</h2>
              <div className="mt-3 space-y-2 max-h-[34rem] overflow-auto pr-1">
                {playerBots.map((bot) => (
                  <button key={bot.playerId} type="button" onClick={() => addPlayerBot(bot)} className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-left text-sm hover:bg-white/10">{bot.playerName} <span className="text-zinc-500">PPR {(bot.ppr ?? 0).toFixed(1)}</span></button>
                ))}
                {playerBots.length === 0 && <div className="text-sm text-zinc-500">No unlocked PlayerBots yet.</div>}
              </div>
            </div>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden">
      <div className="pointer-events-none fixed inset-0 [background:radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),linear-gradient(135deg,rgba(30,64,175,0.16),rgba(0,0,0,0.96)_42%,rgba(127,29,29,0.16)_100%)]" />
      <header className="relative z-10 w-full px-6 md:px-10 py-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-wide">Local Tournaments</h1>
          <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Knockout bracket v1</p>
        </div>
        <button type="button" onClick={() => navigate("/game")} className="rounded-lg bg-zinc-800/80 px-4 py-2 text-sm hover:bg-zinc-700/80">Back</button>
      </header>

      <main className="relative z-10 w-full max-w-6xl mx-auto px-6 md:px-10 pb-10">
        {watchMatch && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
            <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-zinc-950 p-5 shadow-2xl">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-bold">Background Match</h2>
                <button type="button" onClick={() => setWatchMatch(null)} className="rounded-lg bg-white/10 px-3 py-1 text-sm hover:bg-white/15">Close</button>
              </div>
              <div className="mt-4 space-y-2 text-sm text-zinc-300">
                {(watchMatch.backgroundLog || ["This bot match was resolved in the background."]).map((line, index) => (
                  <div key={`${line}-${index}`} className="rounded-lg bg-white/5 px-3 py-2">{line}</div>
                ))}
              </div>
            </div>
          </div>
        )}
        <aside className="hidden">
          <section className="rounded-2xl border border-white/10 bg-zinc-950/70 p-5">
            <h2 className="text-lg font-semibold flex items-center gap-2"><Plus className="h-5 w-5" /> Create Knockout</h2>
            <div className="mt-4 space-y-3">
              <input value={name} onChange={(event) => setName(event.target.value)} className="w-full rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-sm outline-none focus:border-blue-500" />
              <div className="grid grid-cols-3 gap-2">
                <label className="text-xs text-zinc-400">X01
                  <input type="number" value={settings.startScore} onChange={(event) => setSettings((prev) => ({ ...prev, startScore: Number(event.target.value) || 501 }))} className="mt-1 w-full rounded-lg border border-white/10 bg-black/50 px-2 py-2 text-sm text-white" />
                </label>
                <label className="text-xs text-zinc-400">Best Legs
                  <input type="number" value={settings.legsPerSet} min={1} onChange={(event) => setSettings((prev) => ({ ...prev, legsPerSet: Math.max(1, Number(event.target.value) || 1) }))} className="mt-1 w-full rounded-lg border border-white/10 bg-black/50 px-2 py-2 text-sm text-white" />
                </label>
                <label className="text-xs text-zinc-400">Sets
                  <input type="number" value={settings.setsToWin} min={1} onChange={(event) => setSettings((prev) => ({ ...prev, setsToWin: Math.max(1, Number(event.target.value) || 1) }))} className="mt-1 w-full rounded-lg border border-white/10 bg-black/50 px-2 py-2 text-sm text-white" />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <select value={settings.inMode} onChange={(event) => setSettings((prev) => ({ ...prev, inMode: event.target.value as TournamentSettings["inMode"] }))} className="rounded-lg border border-white/10 bg-black/50 px-2 py-2 text-sm">
                  <option value="straight">Straight In</option>
                  <option value="double">Double In</option>
                  <option value="master">Master In</option>
                </select>
                <select value={settings.outMode} onChange={(event) => setSettings((prev) => ({ ...prev, outMode: event.target.value as TournamentSettings["outMode"] }))} className="rounded-lg border border-white/10 bg-black/50 px-2 py-2 text-sm">
                  <option value="straight">Straight Out</option>
                  <option value="double">Double Out</option>
                  <option value="master">Master Out</option>
                </select>
              </div>
              <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Participants ({draftParticipants.length})</div>
                <div className="space-y-1 max-h-40 overflow-auto pr-1">
                  {draftParticipants.map((participant, index) => (
                    <div key={`${participant.name}-${index}`} className="flex items-center justify-between rounded-lg bg-white/5 px-2 py-1 text-sm">
                      <span>{participant.name}</span>
                      <button type="button" onClick={() => setDraftParticipants((prev) => prev.filter((_, idx) => idx !== index))} className="text-zinc-500 hover:text-red-300">Remove</button>
                    </div>
                  ))}
                  {draftParticipants.length === 0 && <div className="text-sm text-zinc-500">Add at least two players.</div>}
                </div>
              </div>
              <div className="flex gap-2">
                <input value={guestName} onChange={(event) => setGuestName(event.target.value)} placeholder="Guest name" className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-sm" />
                <button type="button" onClick={addGuest} className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold hover:bg-blue-500"><UserPlus className="h-4 w-4" /></button>
              </div>
              <div className="flex gap-2">
                <select value={aiLevel} onChange={(event) => setAiLevel(Number(event.target.value))} className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-sm">
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((level) => <option key={level} value={level}>AI Bot Level {level}</option>)}
                </select>
                <button type="button" onClick={addAiBot} className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold hover:bg-blue-500"><Bot className="h-4 w-4" /></button>
              </div>
              <button type="button" disabled={busy || draftParticipants.length < 2} onClick={handleCreate} className="w-full rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold hover:bg-emerald-500 disabled:opacity-50">Create Bracket</button>
            </div>
          </section>

          <section className="rounded-2xl border border-white/10 bg-zinc-950/70 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-[0.22em] text-zinc-400">Add Profiles</h2>
            <div className="mt-3 space-y-2 max-h-56 overflow-auto pr-1">
              {profiles.map((profile) => (
                <button key={profile.id} type="button" onClick={() => addProfile(profile)} className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-left text-sm hover:bg-white/10">{profile.name}</button>
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-white/10 bg-zinc-950/70 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-[0.22em] text-zinc-400">Add PlayerBots</h2>
            <div className="mt-3 space-y-2 max-h-56 overflow-auto pr-1">
              {playerBots.map((bot) => (
                <button key={bot.playerId} type="button" onClick={() => addPlayerBot(bot)} className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-left text-sm hover:bg-white/10">{bot.playerName} <span className="text-zinc-500">PPR {(bot.ppr ?? 0).toFixed(1)}</span></button>
              ))}
              {playerBots.length === 0 && <div className="text-sm text-zinc-500">No unlocked PlayerBots yet.</div>}
            </div>
          </section>
        </aside>

        <section className="space-y-4">
          {message && <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">{message}</div>}
          <div className="rounded-2xl border border-white/10 bg-zinc-950/70 p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-xl font-bold">{selected?.name || "No tournament selected"}</h2>
                <p className="text-sm text-zinc-500">{selected ? `${selected.participants.length} participants | ${selected.status}` : "Create or select a tournament."}</p>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => navigate("/tournaments/create")} className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100 hover:bg-emerald-500/20"><Plus className="h-4 w-4" /> New Tournament</button>
                <button type="button" onClick={() => void loadAll()} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm hover:bg-white/10"><RefreshCw className="h-4 w-4" /> Refresh</button>
                {selected && <button type="button" onClick={() => void handleDelete(selected.id)} className="inline-flex items-center gap-2 rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-100 hover:bg-red-500/20"><Trash2 className="h-4 w-4" /> Delete</button>}
              </div>
            </div>
            {winner && (
              <div className="mt-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-emerald-100">
                <Trophy className="inline h-5 w-5 mr-2" /> Tournament winner: <strong>{winner.name}</strong>
              </div>
            )}
            {selected && activeMatches.length > 0 && (
              <div className="mt-4 rounded-xl border border-blue-500/40 bg-blue-500/10 px-4 py-3 text-sm text-blue-100">
                {activeMatches.length === 1 ? "One match is active. Resume it from the bracket if you leave the game." : `${activeMatches.length} matches are active. Resume the match you need from the bracket.`}
              </div>
            )}
          </div>

          {!selected ? (
            <div className="rounded-2xl border border-white/10 bg-zinc-950/70 p-8 text-center text-zinc-500">
              No tournament selected.
              <div className="mt-4">
                <button type="button" onClick={() => navigate("/tournaments/create")} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500">Create Tournament</button>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-white/10 bg-zinc-950/70 p-5">
              <div className="flex gap-4 min-w-max">
                {rounds.map(([round, matches]) => (
                  <div key={round} className="w-72 shrink-0">
                    <h3 className="mb-3 text-sm font-bold uppercase tracking-[0.22em] text-zinc-400">Round {round}</h3>
                    <div className="space-y-3">
                      {matches.map((match) => {
                        const playerA = match.playerAId ? participantsById.get(match.playerAId) : null;
                        const playerB = match.playerBId ? participantsById.get(match.playerBId) : null;
                        const readyIds = new Set(match.readyParticipantIds || []);
                        const playerAReady = isAutoReadyParticipant(playerA) || Boolean(playerA && readyIds.has(playerA.id));
                        const playerBReady = isAutoReadyParticipant(playerB) || Boolean(playerB && readyIds.has(playerB.id));
                        const bothReady = Boolean(playerA && playerB && playerAReady && playerBReady);
                        const autoMatch = Boolean(playerA && playerB && isAutoReadyParticipant(playerA) && isAutoReadyParticipant(playerB));
                        const canStart = match.status === "pending" && bothReady && !autoMatch;
                        return (
                          <div key={match.id} className={`rounded-xl border p-3 ${match.status === "complete" ? "border-emerald-500/30 bg-emerald-500/5" : match.status === "active" ? "border-blue-500/40 bg-blue-500/10" : "border-white/10 bg-black/30"}`}>
                            <div className={`rounded-lg px-3 py-2 text-sm ${match.winnerId === match.playerAId ? "bg-emerald-500/15 text-emerald-100" : "bg-white/5"}`}>
                              <div className="flex items-center justify-between gap-2">
                                <span>{participantLabel(playerA)}</span>
                                {playerAReady && playerA && <CheckCircle2 className="h-4 w-4 text-emerald-300" />}
                              </div>
                            </div>
                            <div className="py-1 text-center text-xs text-zinc-600">vs</div>
                            <div className={`rounded-lg px-3 py-2 text-sm ${match.winnerId === match.playerBId ? "bg-emerald-500/15 text-emerald-100" : "bg-white/5"}`}>
                              <div className="flex items-center justify-between gap-2">
                                <span>{participantLabel(playerB)}</span>
                                {playerBReady && playerB && <CheckCircle2 className="h-4 w-4 text-emerald-300" />}
                              </div>
                            </div>
                            {match.status === "pending" && playerA && playerB && (
                              <div className="mt-3 grid grid-cols-2 gap-2">
                                {[playerA, playerB].map((participant) => {
                                  const autoReady = isAutoReadyParticipant(participant);
                                  const isReady = autoReady || readyIds.has(participant.id);
                                  return (
                                    autoReady ? (
                                      <div key={participant.id} className="rounded-lg bg-emerald-600/70 px-2 py-1.5 text-center text-xs font-semibold text-white">
                                        Auto
                                      </div>
                                    ) : (
                                      <button
                                        key={participant.id}
                                        type="button"
                                        disabled={busy}
                                        onClick={() => void handleReady(match, participant, !isReady)}
                                        className={`rounded-lg px-2 py-1.5 text-xs font-semibold transition ${isReady ? "bg-emerald-600/80 text-white" : "bg-white/10 text-zinc-300 hover:bg-white/15"} disabled:opacity-70`}
                                      >
                                        {isReady ? "Ready" : "Mark Ready"}
                                      </button>
                                    )
                                  );
                                })}
                              </div>
                            )}
                            <div className="mt-3 flex items-center justify-between gap-2">
                              <span className="text-xs uppercase tracking-[0.18em] text-zinc-500">
                                {autoMatch && match.status === "pending" ? "background" : match.status === "pending" && playerA && playerB && !bothReady ? "waiting ready" : match.status}
                              </span>
                              {match.background && (
                                <button type="button" onClick={() => setWatchMatch(match)} className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold hover:bg-white/10">Watch</button>
                              )}
                              {canStart && (
                                <button type="button" onClick={() => void handleStartMatch(match)} className="inline-flex items-center gap-1 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-bold hover:bg-red-500">
                                  <Swords className="h-3.5 w-3.5" /> Start
                                </button>
                              )}
                              {match.status === "active" && (
                                <button type="button" onClick={() => void handleStartMatch(match)} className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-bold hover:bg-blue-500">Resume</button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <section className="rounded-2xl border border-white/10 bg-zinc-950/70 p-5">
            <h3 className="text-sm font-semibold uppercase tracking-[0.22em] text-zinc-400">Recent Tournaments</h3>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {tournaments.map((tournament) => (
                <button key={tournament.id} type="button" onClick={() => { setSelected(tournament); setSearchParams({ id: tournament.id }); }} className="rounded-xl border border-white/10 bg-white/5 px-3 py-3 text-left hover:bg-white/10">
                  <div className="font-semibold">{tournament.name}</div>
                  <div className="text-xs text-zinc-500">{tournament.participants.length} players | {tournament.status}</div>
                </button>
              ))}
            </div>
          </section>
        </section>
      </main>
    </div>
  );
}
