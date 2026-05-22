import React from "react";
import { useNavigate } from "react-router-dom";
import { Activity, Globe, PlusCircle, RefreshCw, Search, Signal, Target, Users } from "lucide-react";
import MatchFormatForm from "../components/lobby/MatchFormatForm";
import X01Options from "../components/lobby/X01Options";
import { LobbyStateProvider, defaultLobbyState, type LobbyState } from "../context/LobbyContext";
import {
  createLobby,
  ensureOnlinePlayer,
  getStoredSession,
  joinLobbyByCode,
  listOpenLobbies,
  setStoredSession,
  type OnlineGameSettings,
  type OnlineRoomSummary,
} from "../online/supabaseOnline";
import { getStoredOnlineSettings, setStoredOnlineSettings } from "../online/onlineSettings";
import { getPlayerStats, getPlayersCached, type PlayerProfile } from "../services/playersApi";

const DEFAULT_ONLINE_SETTINGS: OnlineGameSettings = {
  selectedGame: "x01",
  match: {
    sets: 1,
    legs: 3,
    freePlay: false,
    bullOff: false,
  },
  startingPlayer: 0,
  x01: {
    startScore: 501,
    inMode: "straight",
    outMode: "double",
    handicapEnabled: false,
    gameVariant: "standard",
    lmsTotalLegs: 3,
    teams: [],
  },
  playerSettings: [null, null],
};

function buildDefaultPlayerSetting(settings: OnlineGameSettings["x01"]) {
  return {
    startScore: settings.startScore,
    inMode: settings.inMode,
    outMode: settings.outMode,
  };
}

function buildOnlineLobbyState(settings: OnlineGameSettings, localPlayerName: string): LobbyState {
  const defaultPlayerSetting = buildDefaultPlayerSetting(settings.x01);
  const playerSettings = settings.playerSettings ?? [
    settings.x01.handicapEnabled ? defaultPlayerSetting : null,
    settings.x01.handicapEnabled ? defaultPlayerSetting : null,
  ];

  return {
    ...defaultLobbyState,
    selectedGame: "x01",
    match: {
      ...defaultLobbyState.match,
      sets: settings.match.sets,
      legs: settings.match.legs,
      freePlay: Boolean(settings.match.freePlay),
      bullOff: Boolean(settings.match.bullOff),
    },
    startingPlayer: settings.startingPlayer ?? 0,
    players: [
      {
        name: localPlayerName || "You",
        isBot: false,
        x01Settings: playerSettings[0] ?? undefined,
      },
      {
        name: "Online Opponent",
        isBot: false,
        x01Settings: playerSettings[1] ?? undefined,
      },
    ],
    x01: {
      ...defaultLobbyState.x01,
      startScore: settings.x01.startScore,
      inMode: settings.x01.inMode,
      outMode: settings.x01.outMode,
      handicapEnabled: Boolean(settings.x01.handicapEnabled),
      gameVariant: settings.x01.gameVariant ?? "standard",
      lmsTotalLegs: settings.x01.lmsTotalLegs ?? 3,
      teams: settings.x01.teams ?? [],
    },
  };
}

function mapLobbyStateToOnlineSettings(state: LobbyState): OnlineGameSettings {
  const defaultPlayerSetting = {
    startScore: state.x01.startScore,
    inMode: state.x01.inMode,
    outMode: state.x01.outMode,
  };
  return {
    selectedGame: "x01",
    match: {
      sets: state.match.sets,
      legs: state.match.legs,
      freePlay: Boolean(state.match.freePlay),
      bullOff: Boolean(state.match.bullOff),
    },
    startingPlayer: state.startingPlayer ?? 0,
    x01: {
      startScore: state.x01.startScore,
      inMode: state.x01.inMode,
      outMode: state.x01.outMode,
      handicapEnabled: state.x01.handicapEnabled,
      gameVariant: state.x01.gameVariant,
      lmsTotalLegs: state.x01.lmsTotalLegs,
      teams: state.x01.teams,
    },
    playerSettings: state.x01.handicapEnabled
      ? state.players.slice(0, 2).map((player) => player.x01Settings ?? defaultPlayerSetting)
      : [null, null],
  };
}

function shortInOutMode(mode: OnlineGameSettings["x01"]["inMode"]): string {
  if (mode === "double") return "DO";
  if (mode === "master") return "MO";
  return "SI";
}

function formatLobbyAverage(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value.toFixed(1) : "--";
}

async function buildHostProfileSummary(profile: PlayerProfile | null): Promise<OnlineGameSettings["hostProfile"] | undefined> {
  if (!profile) {
    return undefined;
  }
  try {
    const stats = await getPlayerStats(profile.id);
    const x01Window = stats.modes?.x01?.windows?.["100"];
    const average = Number(x01Window?.averages?.ppr?.current ?? 0);
    return {
      name: profile.name,
      average: Number.isFinite(average) && average > 0 ? average : null,
      legs: Math.max(0, Number(x01Window?.legs ?? 0) || 0),
      window: 100,
    };
  } catch {
    return {
      name: profile.name,
      average: null,
      legs: 0,
      window: 100,
    };
  }
}

function OnlineX01SetupEditor({
  value,
  localPlayerName,
  onChange,
}: {
  value: OnlineGameSettings;
  localPlayerName: string;
  onChange: (state: LobbyState) => void;
}) {
  const initialState = React.useMemo(() => buildOnlineLobbyState(value, localPlayerName), [value, localPlayerName]);

  return (
    <LobbyStateProvider initialState={initialState} onStateChange={onChange}>
      <div className="space-y-4">
        <div className="rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-xs text-zinc-500">
          Host setup is copied to both PCs when the room is accepted. This now uses the same X01 option model as the local
          lobby, including per-player handicap for the two online seats.
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <MatchFormatForm />
          <X01Options />
        </div>
      </div>
    </LobbyStateProvider>
  );
}

export default function OnlinePage() {
  const navigate = useNavigate();
  const storedSession = React.useMemo(() => getStoredSession(), []);
  const [playerProfiles, setPlayerProfiles] = React.useState<PlayerProfile[]>([]);
  const [loadingProfiles, setLoadingProfiles] = React.useState(false);
  const [roomCode, setRoomCode] = React.useState("");
  const [openLobbies, setOpenLobbies] = React.useState<OnlineRoomSummary[]>([]);
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [lastSession, setLastSession] = React.useState(storedSession);
  const [gameSettings, setGameSettings] = React.useState<OnlineGameSettings>(() => {
    const stored = getStoredOnlineSettings();
    return stored ?? DEFAULT_ONLINE_SETTINGS;
  });
  const [selectedProfileId, setSelectedProfileId] = React.useState<string>(() => {
    const fromSession = storedSession?.profileId?.trim();
    if (fromSession) {
      return fromSession;
    }
    const fromDefault = localStorage.getItem("defaultProfileId")?.trim();
    return fromDefault || "";
  });

  const normalizedCode = roomCode.trim().toUpperCase();
  const selectedProfile = React.useMemo(
    () => playerProfiles.find((profile) => profile.id === selectedProfileId) ?? null,
    [playerProfiles, selectedProfileId],
  );
  const handleLobbySetupChange = React.useCallback((nextState: LobbyState) => {
    const nextSettings = mapLobbyStateToOnlineSettings(nextState);
    setGameSettings((current) =>
      JSON.stringify(current) === JSON.stringify(nextSettings) ? current : nextSettings,
    );
  }, []);

  React.useEffect(() => {
    setStoredOnlineSettings(gameSettings);
  }, [gameSettings]);

  const refreshOpenLobbies = React.useCallback(async () => {
    setIsRefreshing(true);
    setError(null);
    try {
      const rooms = await listOpenLobbies();
      setOpenLobbies(rooms);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load open lobbies");
      setOpenLobbies([]);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    void refreshOpenLobbies();
  }, [refreshOpenLobbies]);

  React.useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshOpenLobbies();
    }, 5000);
    return () => {
      window.clearInterval(timer);
    };
  }, [refreshOpenLobbies]);

  React.useEffect(() => {
    let cancelled = false;
    setLoadingProfiles(true);
    void getPlayersCached()
      .then((profiles) => {
        if (cancelled) {
          return;
        }
        setPlayerProfiles(profiles);
        setSelectedProfileId((current) => {
          if (current && profiles.some((profile) => profile.id === current)) {
            return current;
          }
          const defaultProfileId = localStorage.getItem("defaultProfileId")?.trim();
          if (defaultProfileId && profiles.some((profile) => profile.id === defaultProfileId)) {
            return defaultProfileId;
          }
          return "";
        });
      })
      .catch(() => {
        if (!cancelled) {
          setPlayerProfiles([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingProfiles(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const buildLobbyQuery = React.useCallback(
    (mode: "create" | "join", room: string, playerId: string, playerName: string, profileId?: string) =>
      `/online/lobby?mode=${mode}&room=${room}&playerId=${playerId}&playerName=${encodeURIComponent(playerName)}${
        profileId ? `&profileId=${encodeURIComponent(profileId)}` : ""
      }`,
    [],
  );

  const persistAndNavigate = React.useCallback(
    (
      mode: "create" | "join",
      room: string,
      playerId: string,
      playerName: string,
      profileId?: string,
    ) => {
      setStoredSession(room, playerId, playerName, profileId);
      setLastSession({ room, playerId, playerName, profileId });
      navigate(buildLobbyQuery(mode, room, playerId, playerName, profileId));
    },
    [buildLobbyQuery, navigate],
  );

  const handleCreate = async () => {
    setError(null);
    try {
      const player = await ensureOnlinePlayer(selectedProfile?.name);
      const hostProfile = await buildHostProfileSummary(selectedProfile);
      const settings = {
        ...gameSettings,
        hostProfile,
      };
      const room = await createLobby(player.playerId, settings);
      persistAndNavigate("create", room.code, player.playerId, player.playerName, selectedProfile?.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create room");
    }
  };

  const handleJoin = async () => {
    if (!normalizedCode) return;
    setError(null);
    try {
      const player = await ensureOnlinePlayer(selectedProfile?.name);
      const room = await joinLobbyByCode(normalizedCode, player.playerId);
      persistAndNavigate("join", room.code, player.playerId, player.playerName, selectedProfile?.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join room");
    }
  };

  const handleJoinOpenLobby = async (lobby: OnlineRoomSummary) => {
    setRoomCode(lobby.code);
    setError(null);
    try {
      const player = await ensureOnlinePlayer(selectedProfile?.name);
      const room = await joinLobbyByCode(lobby.code, player.playerId);
      persistAndNavigate("join", room.code, player.playerId, player.playerName, selectedProfile?.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join room");
    }
  };

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden flex flex-col">
      <div
        className="pointer-events-none fixed inset-0 [background:
          radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
          radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.08),transparent_70%),
          radial-gradient(ellipse_at_bottom_left,rgba(255,255,255,0.06),transparent_70%),
          radial-gradient(ellipse_at_bottom_right,rgba(255,255,255,0.1),transparent_65%),
          linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95)_30%,rgba(255,255,255,0.04)_60%,rgba(0,0,0,1)_100%)
        ]"
      />

      <header className="relative z-10 w-full px-6 md:px-10 py-6 flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={() => navigate("/")}
          className="px-4 py-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 transition-colors"
        >
          Back
        </button>
        <div className="flex-1 text-center md:text-left">
          <h1 className="text-2xl font-extrabold tracking-wide">
            Online <span className="text-red-500">Play</span>
          </h1>
          <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Create / Join / Compete</p>
        </div>
      </header>

      <main className="relative z-10 flex-1 px-6 md:px-10 pb-8">
        <div className="h-full w-full max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-[1.2fr_0.8fr] gap-6">
          <section className="rounded-2xl border border-white/10 bg-zinc-900/55 p-6 backdrop-blur">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-3">
                <Globe className="h-6 w-6 text-red-400" />
                <h2 className="text-xl font-bold">Open Lobbies</h2>
              </div>
              <button
                type="button"
                onClick={() => void refreshOpenLobbies()}
                className="inline-flex items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm hover:bg-white/20 transition-colors"
              >
                <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>
            <p className="text-zinc-300 text-sm mb-4">Join players who are already waiting for an opponent.</p>
            {error ? (
              <div className="mb-4 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {error}
              </div>
            ) : null}
            <div className="space-y-3 max-h-[420px] overflow-auto pr-1">
              {openLobbies.length === 0 ? (
                <div className="rounded-xl border border-white/10 bg-black/25 px-4 py-4 text-sm text-zinc-400">
                  No open lobbies right now. Create one to start.
                </div>
              ) : null}
              {openLobbies.map((lobby) => (
                <div key={lobby.code} className="rounded-xl border border-white/10 bg-black/25 px-4 py-4">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Host</p>
                      <p className="mt-1 truncate text-base font-semibold text-white">{lobby.host_name}</p>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-green-400">
                      <Signal className="h-4 w-4 shrink-0" />
                      <span>{lobby.pingMs ?? 0}ms</span>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
                      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-zinc-500">
                        <Target className="h-3.5 w-3.5" />
                        Game
                      </div>
                      <div className="mt-1 text-sm font-semibold text-white">{lobby.startScore}</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
                      <div className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">Match</div>
                      <div className="mt-1 text-sm font-semibold text-white">
                        Set {lobby.sets} / Legs {lobby.legs}
                      </div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
                      <div className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">In / Out</div>
                      <div className="mt-1 text-sm font-semibold text-white">
                        {shortInOutMode(lobby.inMode)} / {shortInOutMode(lobby.outMode)}
                      </div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
                      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-zinc-500">
                        <Activity className="h-3.5 w-3.5" />
                        Avg
                      </div>
                      <div className="mt-1 text-sm font-semibold text-white">
                        {lobby.hostProfile ? (
                          <>
                            {formatLobbyAverage(lobby.hostProfile.average)}
                            <span className="ml-1 text-xs font-normal text-zinc-500">
                              / {lobby.hostProfile.legs}/{lobby.hostProfile.window} legs
                            </span>
                          </>
                        ) : (
                          <span className="text-xs font-normal text-zinc-500">No profile avg</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-3">
                    <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                      Room {lobby.code} / {lobby.player_count}/{lobby.max_players} / {lobby.region}
                    </p>
                    <button
                      type="button"
                      onClick={() => void handleJoinOpenLobby(lobby)}
                      className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold hover:bg-red-500 transition-colors"
                    >
                      Join
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <div className="space-y-6">
            {lastSession ? (
              <section className="rounded-2xl border border-white/10 bg-zinc-900/55 p-6 backdrop-blur">
                <div className="flex items-center gap-3 mb-4">
                  <Globe className="h-6 w-6 text-red-400" />
                  <h2 className="text-xl font-bold">Resume Lobby</h2>
                </div>
                <p className="text-zinc-300 text-sm mb-4">
                  Reconnect to your last online room: <span className="font-semibold text-white">{lastSession.room}</span>
                </p>
                <button
                  type="button"
                  onClick={() =>
                    navigate(buildLobbyQuery("join", lastSession.room, lastSession.playerId, lastSession.playerName, lastSession.profileId))
                  }
                  className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-zinc-700 px-4 py-3 font-semibold hover:bg-zinc-600 transition-colors"
                >
                  Reconnect
                </button>
              </section>
            ) : null}

            <section className="rounded-2xl border border-white/10 bg-zinc-900/55 p-6 backdrop-blur">
              <div className="flex items-center gap-3 mb-4">
                <Users className="h-6 w-6 text-red-400" />
                <h2 className="text-xl font-bold">Your Setup</h2>
              </div>
              <p className="text-zinc-300 text-sm mb-5">
                Pick the local player profile for this PC and the X01 rules the host should create with.
              </p>

              <div className="space-y-4">
                <div>
                  <label className="block text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Player Profile</label>
                  <select
                    value={selectedProfileId}
                    onChange={(event) => setSelectedProfileId(event.target.value)}
                    className="w-full rounded-xl bg-black/45 border border-white/15 px-4 py-3 text-white"
                  >
                    <option value="">{loadingProfiles ? "Loading profiles..." : "Guest / no linked profile"}</option>
                    {playerProfiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </select>
                  <p className="mt-2 text-xs text-zinc-500">
                    {selectedProfile
                      ? `Online stats on this PC will use ${selectedProfile.name}.`
                      : "This PC will still play online, but no local profile will be attached to the match stats."}
                  </p>
                </div>

                <div>
                  <label className="block text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Game Type</label>
                  <div className="w-full rounded-xl bg-black/45 border border-white/15 px-4 py-3 text-white">X01</div>
                </div>

                <OnlineX01SetupEditor
                  value={gameSettings}
                  localPlayerName={selectedProfile?.name || "You"}
                  onChange={handleLobbySetupChange}
                />
              </div>
            </section>

            <section className="rounded-2xl border border-white/10 bg-zinc-900/55 p-6 backdrop-blur">
              <div className="flex items-center gap-3 mb-4">
                <PlusCircle className="h-6 w-6 text-red-400" />
                <h2 className="text-xl font-bold">Create Lobby</h2>
              </div>
              <p className="text-zinc-300 text-sm mb-6">Create a room and wait in the open lobby list for an opponent.</p>
              <button
                type="button"
                onClick={() => void handleCreate()}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-3 font-semibold hover:bg-red-500 transition-colors"
              >
                <Users className="h-5 w-5" />
                Create Room
              </button>
            </section>

            <section className="rounded-2xl border border-white/10 bg-zinc-900/55 p-6 backdrop-blur">
              <div className="flex items-center gap-3 mb-4">
                <Search className="h-6 w-6 text-red-400" />
                <h2 className="text-xl font-bold">Join by Code</h2>
              </div>
              <p className="text-zinc-300 text-sm mb-4">Private room fallback if you share direct codes.</p>
              <input
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value)}
                maxLength={10}
                placeholder="ROOM CODE"
                className="w-full rounded-xl bg-black/45 border border-white/15 px-4 py-3 text-white placeholder:text-zinc-500 uppercase tracking-[0.2em] text-sm mb-4"
              />
              <button
                type="button"
                onClick={() => void handleJoin()}
                disabled={!normalizedCode}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-3 font-semibold hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Globe className="h-5 w-5" />
                Join Room
              </button>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
