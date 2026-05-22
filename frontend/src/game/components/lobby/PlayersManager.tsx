import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Bot, RefreshCw, UserPlus, UserRound, XCircle } from "lucide-react";
import { useLobby, PlayerConfig } from "../../context/LobbyContext";
import {
  getPlayerBotStatus,
  getPlayersCached,
  listImportedPlayerBots,
  type PlayerBotStatus,
  type PlayerProfile,
} from "../../services/playersApi";
import { API_BASE_URL } from "../../../services/api";

const API_URL = API_BASE_URL;

interface BotStats {
  botLevel: number;
  profileId: string | null;
  gamesPlayed: number;
  ppr: number | null;
  average: number | null;
  pprTo170?: number | null;
  firstNinePpr?: number | null;
  checkoutPercentage?: number | null;
  checkoutAttempts?: number;
  checkoutSuccesses?: number;
  windowLegs?: number;
}

const playersEqual = (a: PlayerConfig[], b: PlayerConfig[]) => {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((player, index) => {
    const other = b[index];
    if (!other) {
      return false;
    }
    return (
      player.name === other.name &&
      player.isBot === other.isBot &&
      (player.botLevel ?? null) === (other.botLevel ?? null) &&
      (player.profileId ?? null) === (other.profileId ?? null) &&
      (player.isPlayerBot ?? false) === (other.isPlayerBot ?? false) &&
      (player.sourcePlayerId ?? null) === (other.sourcePlayerId ?? null)
    );
  });
};

export default function PlayersManager() {
  const { state, dispatch } = useLobby();
  const [newPlayer, setNewPlayer] = useState("");
  const [profiles, setProfiles] = useState<PlayerProfile[]>([]);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [isLoadingProfiles, setIsLoadingProfiles] = useState(false);
  const [botStats, setBotStats] = useState<Map<number, BotStats>>(new Map());
  const [playerBots, setPlayerBots] = useState<PlayerBotStatus[]>([]);
  const [selectedProfileToAdd, setSelectedProfileToAdd] = useState<string>("");
  const [selectedPlayerBotToAdd, setSelectedPlayerBotToAdd] = useState<string>("");
  const [hasAppliedDefaultProfile, setHasAppliedDefaultProfile] = useState(false);
  const defaultProfileId = useMemo(() => {
    try {
      return localStorage.getItem("defaultProfileId");
    } catch {
      return null;
    }
  }, []);

  const nextBotIndex = useMemo(() => {
    const existing = state.players
      .filter((player) => player.isBot)
      .map((player) => player.name)
      .map((name) => {
        const match = name.match(/Bot (\d+)/);
        return match ? Number(match[1]) : 0;
      });
    const max = existing.length ? Math.max(...existing) : 0;
    return max + 1;
  }, [state.players]);

  const profilesById = useMemo(() => {
    const map = new Map<string, PlayerProfile>();
    profiles.forEach((profile) => {
      map.set(profile.id, profile);
    });
    return map;
  }, [profiles]);

  // Fetch bot statistics
  const fetchBotStats = useCallback(async (botLevel: number) => {
    try {
      const response = await fetch(`${API_URL}/api/bots/${botLevel}/stats`);
      if (response.ok) {
        const data: BotStats = await response.json();
        setBotStats((prev) => new Map(prev).set(botLevel, data));
      }
    } catch (error) {
      console.error(`Failed to fetch stats for bot level ${botLevel}:`, error);
    }
  }, []);

  // Fetch stats for all bot players when they change
  useEffect(() => {
    const botLevels = new Set<number>();
    state.players.forEach((player) => {
      if (player.isBot && player.botLevel) {
        botLevels.add(player.botLevel);
      }
    });
    
    botLevels.forEach((level) => {
      if (!botStats.has(level)) {
        fetchBotStats(level);
      }
    });
  }, [state.players, botStats, fetchBotStats]);

  const mapWithProfileNormalization = useCallback(
    (players: PlayerConfig[]) => {
      const assigned = new Set<string>();
      return players.map((player) => {
        let nextProfileId = player.profileId ?? undefined;

        if (player.isBot) {
          nextProfileId = undefined;
        } else {
          if (nextProfileId && (!profilesById.has(nextProfileId) || assigned.has(nextProfileId))) {
            nextProfileId = undefined;
          }
        }

        if (nextProfileId) {
          assigned.add(nextProfileId);
        }

        if (nextProfileId !== player.profileId) {
          return { ...player, profileId: nextProfileId };
        }
        return player;
      });
    },
    [profilesById]
  );

  const updatePlayers = useCallback(
    (players: PlayerConfig[]) => {
      const normalized = mapWithProfileNormalization(players);
      const fallback = mapWithProfileNormalization([{ name: "Player 1", isBot: false }])[0];
      const sanitized = normalized.length > 0 ? normalized : [fallback];

      if (playersEqual(sanitized, state.players)) {
        return;
      }

      dispatch({ type: "SET_PLAYERS", players: sanitized });
    },
    [dispatch, mapWithProfileNormalization, state.players]
  );

  const fetchProfiles = useCallback(async () => {
    setIsLoadingProfiles(true);
    setProfilesError(null);
    try {
      const list = await getPlayersCached();
      setProfiles(list as PlayerProfile[]);
    } catch (err) {
      console.error("Error loading profiles", err);
      setProfiles([]);
      setProfilesError("Unable to load saved player profiles.");
    } finally {
      setIsLoadingProfiles(false);
    }
  }, []);

  const fetchPlayerBots = useCallback(async () => {
    try {
      const playerList = await getPlayersCached();
      
      // Fetch bot status for each player
      const botStatuses = await Promise.all(
        playerList.map(async (player) => {
          try {
            return await getPlayerBotStatus(player.id);
          } catch (error) {
            console.error(`Failed to fetch bot status for ${player.name}:`, error);
          }
          return null;
        })
      );

      let importedBots: PlayerBotStatus[] = [];
      try {
        importedBots = await listImportedPlayerBots();
      } catch (error) {
        console.error("Failed to fetch imported player bots:", error);
      }

      const validBots = botStatuses.filter((bot): bot is PlayerBotStatus => bot !== null);
      setPlayerBots([...validBots, ...importedBots]);
    } catch (err) {
      console.error("Error loading player bots", err);
      setPlayerBots([]);
    } finally {
    }
  }, []);

  useEffect(() => {
    fetchProfiles();
    fetchPlayerBots();
  }, [fetchProfiles, fetchPlayerBots]);

  useEffect(() => {
    if (!profiles.length) {
      return;
    }
    const normalized = mapWithProfileNormalization(state.players);
    if (!playersEqual(normalized, state.players)) {
      dispatch({ type: "SET_PLAYERS", players: normalized });
    }
  }, [dispatch, mapWithProfileNormalization, profiles.length, state.players]);

  // Auto-assign default profile once when the lobby opens. After that, user edits win.
  useEffect(() => {
    if (hasAppliedDefaultProfile || !defaultProfileId || !profiles.length) return;
    const defaultProfile = profiles.find((p) => p.id === defaultProfileId);
    if (!defaultProfile) {
      setHasAppliedDefaultProfile(true);
      return;
    }
    if (!state.players.length) {
      updatePlayers([{ name: defaultProfile.name, isBot: false, profileId: defaultProfile.id }]);
      setHasAppliedDefaultProfile(true);
      return;
    }
    const first = state.players[0];
    if (first.profileId === defaultProfile.id) {
      setHasAppliedDefaultProfile(true);
      return;
    }
    const updated = [
      { ...first, name: defaultProfile.name, isBot: false, botLevel: undefined, profileId: defaultProfile.id },
      ...state.players.slice(1),
    ];
    updatePlayers(updated);
    setHasAppliedDefaultProfile(true);
  }, [defaultProfileId, hasAppliedDefaultProfile, profiles, state.players, updatePlayers]);

  const removePlayer = useCallback(
    (index: number) => {
      if (state.players.length <= 1) {
        updatePlayers([{ name: "Guest 1", isBot: false, profileId: undefined }]);
        return;
      }
      const next = state.players.filter((_, i) => i !== index);
      updatePlayers(next);
    },
    [state.players, updatePlayers]
  );

  const addPlayer = useCallback(() => {
    const trimmed = newPlayer.trim();
    if (!trimmed) {
      return;
    }
    updatePlayers([
      ...state.players,
      { name: trimmed, isBot: false, profileId: undefined },
    ]);
    setNewPlayer("");
  }, [newPlayer, state.players, updatePlayers]);

  const addBot = useCallback(() => {
    const botName = `Bot ${nextBotIndex}`;
    updatePlayers([...state.players, { name: botName, isBot: true, botLevel: 4 }]);
  }, [nextBotIndex, state.players, updatePlayers]);

  const addPlayerBot = useCallback(() => {
    const playerId = selectedPlayerBotToAdd || undefined;
    if (!playerId) return;
    const playerBot = playerBots.find((bot) => bot.playerId === playerId);
    if (!playerBot || !playerBot.isUnlocked) return;
    const alreadyUsed = state.players.some((p) => p.sourcePlayerId === playerId);
    if (alreadyUsed) return;
    updatePlayers([
      ...state.players,
      {
        name: `${playerBot.playerName} (Bot)`,
        isBot: false,
        isPlayerBot: true,
        sourcePlayerId: playerBot.playerId,
      },
    ]);
    setSelectedPlayerBotToAdd("");
  }, [playerBots, selectedPlayerBotToAdd, state.players, updatePlayers]);

  const addProfilePlayer = useCallback(() => {
    const profileId = selectedProfileToAdd || undefined;
    if (!profileId) return;
    const profile = profilesById.get(profileId);
    if (!profile) return;
    // Prevent duplicate assignment of same profile
    const alreadyUsed = state.players.some((p) => p.profileId === profileId);
    if (alreadyUsed) return;
    updatePlayers([...state.players, { name: profile.name, isBot: false, profileId }]);
    setSelectedProfileToAdd("");
  }, [profilesById, selectedProfileToAdd, state.players, updatePlayers]);


  const updatePlayer = useCallback(
    (index: number, patch: Partial<PlayerConfig>) => {
      updatePlayers(
        state.players.map((player, i) => {
          if (i !== index) {
            return player;
          }
          const nextIsBot = patch.isBot !== undefined ? patch.isBot : player.isBot;
          let nextBotLevel =
            patch.botLevel !== undefined
              ? patch.botLevel
              : player.botLevel;

          if (patch.isBot === false) {
            nextBotLevel = undefined;
          } else if (patch.isBot === true && (nextBotLevel === undefined || nextBotLevel === null)) {
            nextBotLevel = 4;
          }

          return {
            ...player,
            ...patch,
            isBot: nextIsBot,
            botLevel: nextIsBot ? nextBotLevel ?? 4 : undefined,
          };
        })
      );
    },
    [state.players, updatePlayers]
  );

  const otherAssignedProfiles = useMemo(() => {
    return state.players.map((_, index) => {
      const ids = new Set<string>();
      state.players.forEach((player, i) => {
        if (i !== index && player.profileId) {
          ids.add(player.profileId);
        }
      });
      return ids;
    });
  }, [state.players]);

  return (
    <div className="bg-zinc-900/60 border border-white/10 rounded-2xl p-6 h-full">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold tracking-wide text-white">Players</h2>
        <button
          type="button"
          onClick={fetchProfiles}
          className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 text-xs font-semibold text-zinc-300 transition hover:border-red-500 hover:text-white disabled:opacity-60"
          disabled={isLoadingProfiles}
        >
          <RefreshCw
            className={isLoadingProfiles ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"}
          />
          Refresh Profiles
        </button>
      </div>

      {profilesError && (
        <div className="mb-3 rounded-lg border border-red-600/60 bg-red-600/10 px-3 py-2 text-xs text-red-200">
          {profilesError}
        </div>
      )}

      {!profilesError && !isLoadingProfiles && profiles.length === 0 && (
        <p className="mb-3 text-xs text-zinc-500">
          Create player profiles on the Profiles page to track long-term stats.
        </p>
      )}

      <div className="space-y-4">
        <ul className="space-y-2">
          {state.players.map((player, index) => {
            const selectedProfile = player.profileId
              ? profilesById.get(player.profileId)
              : undefined;
            const selectedPlayerBot = player.sourcePlayerId
              ? playerBots.find((bot) => bot.playerId === player.sourcePlayerId)
              : undefined;
            return (
            <li
              key={`player-slot-${index}`}
              className="rounded-lg bg-black/40 px-3 py-3 space-y-3 border border-white/10"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1">
                  <label className="text-[11px] uppercase tracking-[0.3em] text-zinc-500 block mb-1">
                    Player {index + 1}
                  </label>
                  {selectedProfile ? (
                    <div className="text-lg font-semibold text-white">
                      {selectedProfile.name}
                    </div>
                  ) : (
                    <input
                      type="text"
                      value={player.name}
                      onChange={(event) => updatePlayer(index, { name: event.target.value })}
                      className="w-full rounded-md border border-white/10 bg-black/60 px-3 py-2 text-sm text-white focus:border-red-500 focus:outline-none"
                    />
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => removePlayer(index)}
                  className="text-zinc-500 hover:text-red-400"
                  aria-label={`Remove ${player.name}`}
                >
                  <XCircle className="h-5 w-5" />
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-zinc-400">Type</label>
                  <select
                    value={player.isPlayerBot ? "player-bot" : player.isBot ? "bot" : "human"}
                    onChange={(event) => {
                      const value = event.target.value;
                      updatePlayer(index, {
                        isBot: value === "bot",
                        isPlayerBot: value === "player-bot",
                        botLevel: value === "bot" ? player.botLevel ?? 4 : undefined,
                        sourcePlayerId: value === "player-bot" ? player.sourcePlayerId : undefined,
                      });
                    }}
                    className="rounded-md border border-white/10 bg-black/60 px-2 py-1 text-sm text-white focus:border-red-500 focus:outline-none"
                  >
                    <option value="human">Human</option>
                    <option value="bot">AI Bot</option>
                    <option value="player-bot">Player Bot</option>
                  </select>
                </div>
                {player.isPlayerBot ? (
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2 flex-1">
                    <label className="text-xs text-zinc-400">Select Player Bot</label>
                    <select
                      value={player.sourcePlayerId ?? ""}
                      onChange={(event) =>
                        updatePlayer(index, {
                          sourcePlayerId: event.target.value ? event.target.value : undefined,
                          name: event.target.value
                            ? `${playerBots.find(b => b.playerId === event.target.value)?.playerName} (Bot)`
                            : player.name,
                        })
                      }
                      className="rounded-md border border-white/10 bg-black/60 px-2 py-1 text-xs sm:text-sm text-white focus:border-red-500 focus:outline-none"
                      style={{ color: 'white' }}
                    >
                      <option value="" style={{ color: 'white' }}>Select a player bot...</option>
                      {playerBots
                        .filter((bot) => !bot.playerName.startsWith('Bot Level '))
                        .map((bot) => (
                          <option
                            key={bot.playerId}
                            value={bot.playerId}
                            disabled={!bot.isUnlocked}
                            style={{
                              color: bot.isUnlocked ? 'white' : '#999',
                              textDecoration: bot.isUnlocked ? 'none' : 'line-through',
                              backgroundColor: '#1a1a1a'
                            }}
                          >
                            {bot.isUnlocked
                              ? `🎯 ${bot.playerName}`
                              : `🔒 ${bot.playerName} - ${bot.completedLegs}/${bot.unlockWinsRequired ?? 5} wins (${Math.round(bot.progressPercentage)}%)`}
                          </option>
                        ))}
                      {playerBots.length === 0 && (
                        <option disabled style={{ color: '#999' }}>No player bots available</option>
                      )}
                    </select>
                    {selectedPlayerBot && (
                      <div className="text-xs text-zinc-400 mt-1">
                        {selectedPlayerBot.ppr !== null && selectedPlayerBot.ppr !== undefined ? (
                          <div className="space-y-1">
                            <div className="text-emerald-400 font-semibold">
                              Last {selectedPlayerBot.windowLegs ?? selectedPlayerBot.wonLegPoolSize ?? 50} won legs
                            </div>
                            <div>PPR: {(selectedPlayerBot.ppr ?? 0).toFixed(2)}</div>
                            <div>PPR to 170: {(selectedPlayerBot.pprTo170 ?? 0).toFixed(2)}</div>
                            <div>First 9 PPR: {(selectedPlayerBot.firstNinePpr ?? 0).toFixed(2)}</div>
                            <div>
                              Checkout: {(selectedPlayerBot.checkoutPercentage ?? 0).toFixed(2)}%
                              {" "}
                              ({selectedPlayerBot.checkoutSuccesses ?? 0}/{selectedPlayerBot.checkoutAttempts ?? 0})
                            </div>
                          </div>
                        ) : (
                          <span className="text-zinc-500 italic">No won-leg stats yet</span>
                        )}
                      </div>
                    )}
                  </div>
                ) : player.isBot ? (
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-zinc-400">Level</label>
                      <select
                        value={player.botLevel ?? 4}
                        onChange={(event) => {
                          const newLevel = Number(event.target.value);
                          updatePlayer(index, { botLevel: newLevel });
                          // Fetch stats for the new level if not already loaded
                          if (!botStats.has(newLevel)) {
                            fetchBotStats(newLevel);
                          }
                        }}
                        className="rounded-md border border-white/10 bg-black/60 px-2 py-1 text-sm text-white focus:border-red-500 focus:outline-none"
                      >
                        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((level) => (
                          <option value={level} key={level}>
                            Level {level}
                          </option>
                        ))}
                      </select>
                    </div>
                    {player.botLevel && botStats.has(player.botLevel) && (
                      <div className="text-xs text-zinc-400">
                        {botStats.get(player.botLevel)!.ppr !== null ? (
                          <div className="space-y-1">
                            <div className="text-emerald-400 font-semibold">
                              Last {botStats.get(player.botLevel)!.windowLegs ?? 50} legs
                            </div>
                            <div>PPR: {botStats.get(player.botLevel)!.ppr?.toFixed(2)}</div>
                            <div>PPR to 170: {(botStats.get(player.botLevel)!.pprTo170 ?? 0).toFixed(2)}</div>
                            <div>First 9 PPR: {(botStats.get(player.botLevel)!.firstNinePpr ?? 0).toFixed(2)}</div>
                            <div>
                              Checkout: {(botStats.get(player.botLevel)!.checkoutPercentage ?? 0).toFixed(2)}%
                              {" "}
                              ({botStats.get(player.botLevel)!.checkoutSuccesses ?? 0}/{botStats.get(player.botLevel)!.checkoutAttempts ?? 0})
                            </div>
                          </div>
                        ) : (
                          <span className="text-zinc-500 italic">No games yet</span>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                    <label className="text-xs text-zinc-400">Profile</label>
                    <select
                      value={player.profileId ?? ""}
                      onChange={(event) => {
                        const nextProfileId = event.target.value
                          ? event.target.value
                          : undefined;
                        const profile = nextProfileId
                          ? profilesById.get(nextProfileId)
                          : undefined;
                        updatePlayer(index, {
                          profileId: nextProfileId,
                          name: profile ? profile.name : `Guest ${index + 1}`,
                        });
                      }}
                      className="rounded-md border border-white/10 bg-black/60 px-2 py-1 text-xs sm:text-sm text-white focus:border-red-500 focus:outline-none"
                    >
                      <option value="">
                        {profiles.length
                          ? "No Profile (stats disabled)"
                          : "No profiles available"}
                      </option>
                      {profiles
                        .filter((profile) => !profile.name.startsWith('Bot Level '))
                        .map((profile) => {
                          const inUse = otherAssignedProfiles[index].has(profile.id);
                          return (
                            <option key={profile.id} value={profile.id} disabled={inUse}>
                              {profile.name}
                              {inUse ? " (in use)" : ""}
                            </option>
                          );
                        })}
                    </select>
                  </div>
                )}
              </div>
              </li>
            );
          })}
        </ul>
        <div className="rounded-lg border border-white/10 bg-black/20 p-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-white">Add players</h3>
            <span className="text-xs text-zinc-500">{state.players.length} selected</span>
          </div>
          <div className="grid gap-2 lg:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
              <input
                type="text"
                placeholder="Guest name"
                value={newPlayer}
                onChange={(event) => setNewPlayer(event.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white focus:border-red-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={addPlayer}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-500"
              >
                <UserPlus className="h-4 w-4" />
                Add Guest
              </button>
            </div>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
              <select
                value={selectedProfileToAdd}
                onChange={(event) => setSelectedProfileToAdd(event.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white focus:border-red-500 focus:outline-none"
              >
                <option value="">Saved profile...</option>
                {profiles
                  .filter((profile) => !profile.name.startsWith('Bot Level '))
                  .filter((profile) => !state.players.some((p) => p.profileId === profile.id))
                  .map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                onClick={addProfilePlayer}
                disabled={!selectedProfileToAdd}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-500 disabled:opacity-60"
              >
                <UserRound className="h-4 w-4" />
                Add Profile
              </button>
            </div>
            <button
              type="button"
              onClick={addBot}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-500/40 bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-500"
            >
              <Bot className="h-4 w-4" />
              Add AI Bot
            </button>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
              <select
                value={selectedPlayerBotToAdd}
                onChange={(event) => setSelectedPlayerBotToAdd(event.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white focus:border-red-500 focus:outline-none"
              >
                <option value="">Player-bot...</option>
                {playerBots
                  .filter((bot) => !bot.playerName.startsWith('Bot Level '))
                  .filter((bot) => !state.players.some((p) => p.sourcePlayerId === bot.playerId))
                  .map((bot) => (
                    <option key={bot.playerId} value={bot.playerId} disabled={!bot.isUnlocked}>
                      {bot.isUnlocked
                        ? bot.playerName
                        : `${bot.playerName} - ${bot.completedLegs}/${bot.unlockWinsRequired ?? 5} wins`}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                onClick={addPlayerBot}
                disabled={!selectedPlayerBotToAdd}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-500 disabled:opacity-60"
              >
                <Bot className="h-4 w-4" />
                Add Player-Bot
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
