import React, { useMemo } from "react";
import { useLobby, InOutMode, TeamConfig } from "../../context/LobbyContext";

const presetScores = [301, 401, 501, 601, 701];
const inOutModes: Array<{ value: InOutMode; label: string }> = [
  { value: "straight", label: "Straight" },
  { value: "double", label: "Double" },
  { value: "master", label: "Master" },
];

const X01Options = React.memo(() => {
  const { state, dispatch } = useLobby();
  const { x01, players } = state;
  

  const activePreset = useMemo(() => {
    return presetScores.includes(x01.startScore) ? x01.startScore : null;
  }, [x01.startScore]);

  const handlePresetClick = (score: number) => {
    dispatch({ type: "SET_X01", payload: { startScore: score } });
  };

  const handleCustomChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = Math.max(101, Number(event.target.value) || 101);
    dispatch({ type: "SET_X01", payload: { startScore: value } });
  };

  const handleInModeChange = (mode: InOutMode) => {
    dispatch({ type: "SET_X01", payload: { inMode: mode } });
  };

  const handleOutModeChange = (mode: InOutMode) => {
    dispatch({ type: "SET_X01", payload: { outMode: mode } });
  };

  const handleHandicapToggle = () => {
    const newHandicapEnabled = !x01.handicapEnabled;
    dispatch({ type: "SET_X01", payload: { handicapEnabled: newHandicapEnabled } });
    
    if (newHandicapEnabled) {
      // Initialize player settings with global settings when enabling handicap
      players.forEach((_, index) => {
        dispatch({
          type: "SET_PLAYER_X01_SETTINGS",
          playerIndex: index,
          settings: {
            startScore: x01.startScore,
            inMode: x01.inMode,
            outMode: x01.outMode,
          },
        });
      });
    } else {
      // Clear player settings when disabling handicap
      players.forEach((_, index) => {
        dispatch({
          type: "SET_PLAYER_X01_SETTINGS",
          playerIndex: index,
          settings: undefined,
        });
      });
    }
  };

  const handlePlayerScoreChange = (playerIndex: number, score: number) => {
    const player = players[playerIndex];
    dispatch({
      type: "SET_PLAYER_X01_SETTINGS",
      playerIndex,
      settings: {
        ...player.x01Settings,
        startScore: score,
        inMode: player.x01Settings?.inMode || x01.inMode,
        outMode: player.x01Settings?.outMode || x01.outMode,
      },
    });
  };

  const handlePlayerInModeChange = (playerIndex: number, mode: InOutMode) => {
    const player = players[playerIndex];
    dispatch({
      type: "SET_PLAYER_X01_SETTINGS",
      playerIndex,
      settings: {
        ...player.x01Settings,
        startScore: player.x01Settings?.startScore || x01.startScore,
        inMode: mode,
        outMode: player.x01Settings?.outMode || x01.outMode,
      },
    });
  };

  const handlePlayerOutModeChange = (playerIndex: number, mode: InOutMode) => {
    const player = players[playerIndex];
    dispatch({
      type: "SET_PLAYER_X01_SETTINGS",
      playerIndex,
      settings: {
        ...player.x01Settings,
        startScore: player.x01Settings?.startScore || x01.startScore,
        inMode: player.x01Settings?.inMode || x01.inMode,
        outMode: mode,
      },
    });
  };

  return (
    <div className="bg-zinc-900/60 border border-white/10 rounded-2xl p-6 h-full">
      <h2 className="text-lg font-semibold mb-4 tracking-wide text-white">X01 Options</h2>
      
      {/* Handicap Toggle */}
      <div className="mb-6 pb-6 border-b border-white/10">
        <label className="flex items-center justify-between gap-3 cursor-pointer">
          <span className="text-sm font-medium text-zinc-300">Per-Player Handicap Settings</span>
          <button
            type="button"
            role="switch"
            aria-checked={x01.handicapEnabled}
            onClick={handleHandicapToggle}
            className={`relative inline-flex h-7 w-12 items-center rounded-full transition ${
              x01.handicapEnabled ? "bg-red-600" : "bg-zinc-700"
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${
                x01.handicapEnabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </label>
        {x01.handicapEnabled && (
          <p className="mt-2 text-xs text-zinc-500">
            Each player can have individual starting scores and in/out modes
          </p>
        )}
      </div>

      {/* Game Variant Selection */}
      <div className="mb-6 pb-6 border-b border-white/10">
        <h3 className="text-sm uppercase tracking-widest text-zinc-400 mb-3">Game Variant</h3>
        <select
          value={String(x01.gameVariant || "standard")}
          onChange={(e) => {
            const value = e.target.value;
            if (value === "standard") {
              dispatch({ type: "SET_X01", payload: { gameVariant: "standard" as const, teams: [] } });
            } else if (value === "last_man_standing" && players.length >= 3) {
              dispatch({ type: "SET_X01", payload: { gameVariant: "last_man_standing" as const, teams: [] } });
            } else if (value === "team_play" && players.length >= 4) {
              dispatch({ type: "SET_X01", payload: { gameVariant: "team_play" as const } });
            }
          }}
          className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-white focus:border-red-500 focus:outline-none"
        >
          <option value="standard">Standard</option>
          <option value="last_man_standing" disabled={players.length < 3}>Last Man Standing (3+ players)</option>
          <option value="team_play" disabled={players.length < 4}>Team Play (4+ players)</option>
        </select>
        {x01.gameVariant === "last_man_standing" && (
          <p className="mt-2 text-xs text-zinc-500">
            Players compete across multiple legs. Points awarded by finish position: 1st=6pts, 2nd=5pts, 3rd=4pts, 4th=3pts, 5th=2pts, 6th=1pt
          </p>
        )}
        {x01.gameVariant === "team_play" && (
          <div className="mt-2">
            <p className="text-xs text-zinc-500">
              Players form teams and share a common score. Teams alternate turns. First team to checkout wins!
            </p>
          </div>
        )}
      </div>

      {/* Last Man Standing Options */}
      {x01.gameVariant === "last_man_standing" && (
        <div className="mb-6 pb-6 border-b border-white/10">
          <h3 className="text-sm uppercase tracking-widest text-zinc-400 mb-3">
            Last Man Standing Settings
          </h3>
          <div>
            <label className="text-xs text-zinc-500 block mb-2">
              Total Legs
            </label>
            <input
              type="number"
              min={1}
              max={10}
              value={x01.lmsTotalLegs}
              onChange={(e) => dispatch({ 
                type: "SET_X01", 
                payload: { lmsTotalLegs: Math.max(1, Math.min(10, Number(e.target.value) || 3)) }
              })}
              className="w-20 rounded px-3 py-2 bg-black/50 border border-white/10 text-white focus:outline-none focus:border-red-500"
            />
            <p className="text-xs text-zinc-500 mt-2">
              Number of legs to play. Highest total points wins.
            </p>
          </div>
        </div>
      )}

      {/* Team Play Options */}
      {String(x01.gameVariant) === "team_play" && (
        <div className="mb-6 pb-6 border-b border-white/10">
          <h3 className="text-sm uppercase tracking-widest text-zinc-400 mb-3">
            Team Formation
          </h3>
          
          {/* Team creation buttons */}
          <div className="mb-4 flex gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => {
                // Auto-create 2v2 teams
                const numTeams = players.length === 6 ? 3 : 2;
                const playersPerTeam = Math.floor(players.length / numTeams);
                const teamColors = ["#ef4444", "#3b82f6", "#10b981", "#f59e0b"];
                const teamNames = ["Team Red", "Team Blue", "Team Green", "Team Yellow"];
                
                const newTeams: TeamConfig[] = [];
                for (let i = 0; i < numTeams; i++) {
                  const playerIndices: number[] = [];
                  for (let j = 0; j < playersPerTeam; j++) {
                    const playerIndex = i * playersPerTeam + j;
                    if (playerIndex < players.length) {
                      playerIndices.push(playerIndex);
                    }
                  }
                  newTeams.push({
                    teamId: i,
                    teamName: teamNames[i],
                    playerIndices,
                    teamColor: teamColors[i],
                  });
                }
                dispatch({ type: "SET_X01_TEAMS", teams: newTeams });
              }}
              className="rounded-lg px-4 py-2 text-sm font-semibold bg-red-600 text-white hover:bg-red-700 transition"
            >
              Auto-Create Teams
            </button>
            <button
              type="button"
              onClick={() => {
                const teamColors = ["#ef4444", "#3b82f6", "#10b981", "#f59e0b"];
                const teamNames = ["Team Red", "Team Blue", "Team Green", "Team Yellow"];
                const newTeamId = x01.teams.length;
                dispatch({
                  type: "ADD_X01_TEAM",
                  team: {
                    teamId: newTeamId,
                    teamName: teamNames[newTeamId % teamNames.length],
                    playerIndices: [],
                    teamColor: teamColors[newTeamId % teamColors.length],
                  },
                });
              }}
              className="rounded-lg px-4 py-2 text-sm font-semibold bg-zinc-700 text-white hover:bg-zinc-600 transition"
            >
              + Add Empty Team
            </button>
          </div>

          {/* Available players to assign */}
          {x01.teams.length > 0 && (
            <div className="mb-4">
              <h4 className="text-xs uppercase tracking-widest text-zinc-500 mb-2">
                Available Players (click to add to team)
              </h4>
              <div className="flex flex-wrap gap-2">
                {players.map((player, index) => {
                  const isAssigned = x01.teams.some(team => team.playerIndices.includes(index));
                  if (isAssigned) return null;
                  return (
                    <span
                      key={index}
                      className="text-xs bg-zinc-700 hover:bg-zinc-600 px-3 py-1.5 rounded cursor-help transition"
                      title="Click a team below to add this player"
                    >
                      {player.name}
                    </span>
                  );
                })}
                {players.every((_, index) => x01.teams.some(team => team.playerIndices.includes(index))) && (
                  <span className="text-xs text-zinc-500 italic">All players assigned</span>
                )}
              </div>
            </div>
          )}

          {/* Display teams */}
          {x01.teams.length > 0 && (
            <div className="space-y-3">
              {x01.teams.map((team) => (
                <div
                  key={team.teamId}
                  className="bg-black/40 rounded-lg p-3 border border-white/10"
                  style={{ borderLeftColor: team.teamColor, borderLeftWidth: "4px" }}
                >
                  <div className="flex items-center justify-between mb-2">
                    <input
                      type="text"
                      value={team.teamName}
                      onChange={(e) =>
                        dispatch({
                          type: "UPDATE_X01_TEAM",
                          teamId: team.teamId,
                          updates: { teamName: e.target.value },
                        })
                      }
                      className="bg-transparent text-white font-semibold text-sm focus:outline-none border-b border-transparent focus:border-white/30 transition"
                    />
                    <button
                      type="button"
                      onClick={() => dispatch({ type: "REMOVE_X01_TEAM", teamId: team.teamId })}
                      className="text-red-400 hover:text-red-300 text-xs"
                    >
                      Remove Team
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2 mb-2">
                    {team.playerIndices.map((playerIndex) => (
                      <span
                        key={playerIndex}
                        className="text-xs bg-white/10 px-2 py-1 rounded flex items-center gap-1 group"
                      >
                        {players[playerIndex]?.name || `Player ${playerIndex + 1}`}
                        <button
                          type="button"
                          onClick={() => {
                            const newIndices = team.playerIndices.filter(i => i !== playerIndex);
                            dispatch({
                              type: "UPDATE_X01_TEAM",
                              teamId: team.teamId,
                              updates: { playerIndices: newIndices },
                            });
                          }}
                          className="text-red-400 hover:text-red-300 opacity-0 group-hover:opacity-100 transition"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    {team.playerIndices.length === 0 && (
                      <span className="text-xs text-zinc-500 italic">No players assigned</span>
                    )}
                  </div>
                  {/* Add player dropdown */}
                  <div className="mt-2 pt-2 border-t border-white/10">
                    <label className="text-xs text-zinc-500 block mb-1">Add Player:</label>
                    <select
                      onChange={(e) => {
                        const playerIndex = parseInt(e.target.value);
                        if (!isNaN(playerIndex) && !team.playerIndices.includes(playerIndex)) {
                          dispatch({
                            type: "UPDATE_X01_TEAM",
                            teamId: team.teamId,
                            updates: { playerIndices: [...team.playerIndices, playerIndex] },
                          });
                        }
                        e.target.value = "";
                      }}
                      className="w-full text-sm bg-zinc-800 text-white border border-white/20 rounded px-3 py-2 focus:outline-none focus:border-red-500 cursor-pointer"
                      defaultValue=""
                    >
                      <option value="" disabled>Select a player to add...</option>
                    {players.map((player, index) => {
                      const isAssigned = x01.teams.some(t => t.playerIndices.includes(index));
                      if (isAssigned) return null;
                      return (
                        <option key={index} value={index}>
                          {player.name}
                        </option>
                      );
                    })}
                    </select>
                  </div>
                </div>
              ))}
            </div>
          )}

          {x01.teams.length === 0 && (
            <div className="bg-zinc-800/50 border border-zinc-700 rounded-lg p-4 mt-2">
              <p className="text-sm text-zinc-300 font-semibold mb-2">How to set up teams:</p>
              <ol className="text-xs text-zinc-400 space-y-1 list-decimal list-inside">
                <li><strong>Quick setup:</strong> Click "Auto-Create Teams" to automatically distribute players</li>
                <li><strong>Manual setup:</strong> Click "+ Add Empty Team" to create teams, then use the dropdown in each team card to add players</li>
              </ol>
            </div>
          )}
        </div>
      )}

      {!x01.handicapEnabled ? (
        // Global settings (current behavior)
        <div className="space-y-6">
          <section>
            <h3 className="text-sm uppercase tracking-widest text-zinc-400">Starting Score</h3>
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3">
              <select
                value={activePreset ?? "custom"}
                onChange={(e) => {
                  if (e.target.value === "custom") return;
                  handlePresetClick(Number(e.target.value));
                }}
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-white focus:border-red-500 focus:outline-none"
              >
                {presetScores.map((score) => (
                  <option key={score} value={score}>{score}</option>
                ))}
                <option value="custom">Custom</option>
              </select>
              <input
                type="number"
                min={101}
                value={x01.startScore}
                onChange={handleCustomChange}
                className="w-full sm:w-28 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-white focus:border-red-500 focus:outline-none"
              />
            </div>
          </section>

          <section className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <h3 className="text-sm uppercase tracking-widest text-zinc-400">In Mode</h3>
              <select
                value={x01.inMode}
                onChange={(e) => handleInModeChange(e.target.value as InOutMode)}
                className="mt-3 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-white focus:border-red-500 focus:outline-none"
              >
                {inOutModes.map((mode) => (
                  <option key={mode.value} value={mode.value}>{mode.label}</option>
                ))}
              </select>
            </div>
            <div>
              <h3 className="text-sm uppercase tracking-widest text-zinc-400">Out Mode</h3>
              <select
                value={x01.outMode}
                onChange={(e) => handleOutModeChange(e.target.value as InOutMode)}
                className="mt-3 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-white focus:border-red-500 focus:outline-none"
              >
                {inOutModes.map((mode) => (
                  <option key={mode.value} value={mode.value}>{mode.label}</option>
                ))}
              </select>
            </div>
          </section>
        </div>
      ) : (
        // Per-player settings
        <div className="space-y-4">
          {players.map((player, index) => {
            const playerSettings = player.x01Settings || {
              startScore: x01.startScore,
              inMode: x01.inMode,
              outMode: x01.outMode,
            };
            
            return (
              <div key={index} className="bg-black/30 rounded-lg p-4 border border-white/5">
                <h3 className="text-sm font-semibold text-white mb-3">
                  {player.name || `Player ${index + 1}`}
                </h3>
                
                <div className="space-y-3">
                  {/* Starting Score */}
                  <div>
                    <label className="text-xs uppercase tracking-widest text-zinc-500 block mb-2">
                      Starting Score
                    </label>
                    <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2">
                      <select
                        value={presetScores.includes(playerSettings.startScore) ? playerSettings.startScore : "custom"}
                        onChange={(e) => {
                          if (e.target.value === "custom") return;
                          handlePlayerScoreChange(index, Number(e.target.value));
                        }}
                        className="w-full rounded px-3 py-2 text-xs bg-black/50 border border-white/10 text-white focus:outline-none focus:border-red-500"
                      >
                        {presetScores.map((score) => (
                          <option key={score} value={score}>{score}</option>
                        ))}
                        <option value="custom">Custom</option>
                      </select>
                      <input
                        type="number"
                        min={101}
                        value={playerSettings.startScore}
                        onChange={(e) => handlePlayerScoreChange(index, Math.max(101, Number(e.target.value) || 101))}
                        className="w-full sm:w-24 rounded px-2 py-2 text-xs bg-black/50 border border-white/10 text-white focus:outline-none focus:border-red-500"
                      />
                    </div>
                  </div>

                  {/* In/Out Modes */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs uppercase tracking-widest text-zinc-500 block mb-2">In Mode</label>
                      <select
                        value={playerSettings.inMode}
                        onChange={(e) => handlePlayerInModeChange(index, e.target.value as InOutMode)}
                        className="w-full rounded px-2 py-2 text-xs bg-black/50 border border-white/10 text-white focus:outline-none focus:border-red-500"
                      >
                        {inOutModes.map((mode) => (
                          <option key={mode.value} value={mode.value}>{mode.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-widest text-zinc-500 block mb-2">Out Mode</label>
                      <select
                        value={playerSettings.outMode}
                        onChange={(e) => handlePlayerOutModeChange(index, e.target.value as InOutMode)}
                        className="w-full rounded px-2 py-2 text-xs bg-black/50 border border-white/10 text-white focus:outline-none focus:border-red-500"
                      >
                        {inOutModes.map((mode) => (
                          <option key={mode.value} value={mode.value}>{mode.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

X01Options.displayName = 'X01Options';

export default X01Options;
