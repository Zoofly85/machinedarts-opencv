import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import ScoreCorrection from "../components/ScoreCorrection";
import GamePlayerCard from "../components/player/GamePlayerCard";
import GameDartBoxes from "../components/game/GameDartBoxes";
import GameHeader from "../components/game/GameHeader";
import { GameControlButton } from "../components/game/GameControl";
import type { LobbyState } from "../context/LobbyContext";
import { addDart, correctScore, deleteCorrectionImages } from "../services/correctionApi";
import { startGame as apiStartGame, getGameState as apiGetGameState, stopGame as apiStopGame, forceNextTurn as apiForceNextTurn } from "../services/gameApi";
import { useGameStateSync } from "../services/useGameStateSync";

interface LocationState extends Partial<LobbyState> {}

interface DartScore {
  score: number;
  multiplier: number;
  segment: string;
  zone: string;
  confidence: number;
}

interface AroundTheClockPlayerState {
  name: string;
  currentTarget: number;
  dartsThrown: number;
  hitsPerTarget: number[];
  finished: boolean;
  legsWon: number;
  setsWon: number;
  isBot?: boolean;
  botLevel?: number;
}

interface AroundTheClockState {
  mode: string;
  currentPlayer: number | null;
  players: AroundTheClockPlayerState[];
  currentTurn: {
    darts: (DartScore | null)[];
  };
  lastCompletedTurn: (DartScore | null)[];
  winner: number | null;
  match: {
    legsPerSet: number;
    setsToWin: number;
    currentSet: number;
    currentLeg: number;
    legWinner: number | null;
    setWinner: number | null;
    matchWinner: number | null;
  };
  stats?: Array<{
    darts: number;
    targetsHit: number;
    totalTargets: number;
    overallAccuracy: number;
    targetAccuracies: number[];
  }>;
}

const AroundTheClockGamePage: React.FC = () => {
  const navigate = useNavigate();
  const { state } = useLocation() as { state?: LocationState };
  
  // Extract configuration from lobby state
  const gameMode = state?.aroundTheClock?.mode ?? "full";
  const gameOrder = state?.aroundTheClock?.order ?? "1-20-bull";
  const gameHitsRequired = state?.aroundTheClock?.hitsRequired ?? 1;
  const legsPerSet = Number(state?.match?.legs ?? 3);
  const setsToWin = Number(state?.match?.sets ?? 1);
  const startingPlayer = Number(state?.startingPlayer ?? 0);
  
  const playerConfigs = useMemo(() => {
    const rawPlayers = state?.players;
    if (Array.isArray(rawPlayers) && rawPlayers.length > 0) {
      return rawPlayers.map((player, index) => ({
        name: player?.name?.trim() || `Player ${index + 1}`,
        isBot: Boolean(player?.isBot),
        botLevel: player?.botLevel,
      }));
    }
    return [
      { name: "Player 1", isBot: false },
      { name: "Player 2", isBot: false },
    ];
  }, [state?.players]);

  const [atcState, setAtcState] = useState<AroundTheClockState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dartCount, setDartCount] = useState(0);
  const [detectionState, setDetectionState] = useState<string>("no_movement");
  const [isCorrectionModalOpen, setIsCorrectionModalOpen] = useState(false);
  const [selectedDartIndex, setSelectedDartIndex] = useState(-1);
  const gameStartedRef = useRef(false);
  const hasNavigatedRef = useRef(false);

  const fetchAtcState = useCallback(async () => {
    try {
      const data = await apiGetGameState<AroundTheClockState>("around_the_clock");
      setAtcState(data);
      setError(null);
    } catch (err) {
      console.error("Error fetching ATC state:", err);
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  const startAtcGame = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const requestBody = {
        players: playerConfigs.map((player, index) => ({
          name: player.name || `Player ${index + 1}`,
          isBot: player.isBot,
          botLevel: 'botLevel' in player ? player.botLevel : undefined,
        })),
        mode: gameMode,
        order: gameOrder,
        hitsRequired: gameHitsRequired,
        startingPlayer,
        legsPerSet,
        setsToWin,
      };

      const data = await apiStartGame<AroundTheClockState>("around_the_clock", requestBody);
      setAtcState(data);
    } catch (err) {
      console.error("Error starting ATC game:", err);
      setError(err instanceof Error ? err.message : "Failed to start game");
    } finally {
      setLoading(false);
    }
  }, [playerConfigs, gameMode, legsPerSet, setsToWin, fetchAtcState, startingPlayer]);

  useEffect(() => {
    // Only start the game once
    if (!gameStartedRef.current) {
      gameStartedRef.current = true;
      startAtcGame();
    }
  }, [startAtcGame]);

  const handleDetectionStatus = useCallback(
    ({ dartCount: nextDartCount, detectionState: nextDetectionState }: { dartCount?: number; detectionState?: string }) => {
      if (typeof nextDartCount === "number") {
        setDartCount(nextDartCount);
      }
      if (typeof nextDetectionState === "string") {
        setDetectionState(nextDetectionState);
      }
    },
    []
  );

  useGameStateSync({
    enabled: Boolean(atcState) && !hasNavigatedRef.current,
    refresh: fetchAtcState,
    onStatus: handleDetectionStatus,
    pollMs: 0,
    debounceMs: 120,
  });

  // Navigate to stats when match is complete
  useEffect(() => {
    if (hasNavigatedRef.current) {
      return;
    }
    
    if (!atcState) {
      return;
    }
    const matchWinner =
      typeof atcState.match?.matchWinner === "number" ? atcState.match.matchWinner : null;
    const isSingleLegMatch =
      (atcState.match?.legsPerSet ?? 1) <= 1 && (atcState.match?.setsToWin ?? 1) <= 1;
    const fallbackWinner =
      isSingleLegMatch && typeof atcState.winner === "number" ? atcState.winner : null;
    const winnerIndex = matchWinner ?? fallbackWinner;
    if (winnerIndex === null) {
      return;
    }
    
    // Only navigate after darts are removed
    if (dartCount !== 0) {
      return;
    }
    
    hasNavigatedRef.current = true;

    (async () => {
      const summary = atcState;
      await apiStopGame("around_the_clock").catch(() => undefined);
      navigate("/around-the-clock/stats", {
        state: {
          summary,
          players: playerConfigs,
        },
      });
    })();
  }, [atcState, dartCount, playerConfigs, navigate]);


  const handleCompleteTurn = async () => {
    try {
      const data = await apiForceNextTurn<AroundTheClockState>("around_the_clock");
      if (data) {
        setAtcState(data);
      } else {
        await fetchAtcState();
      }
    } catch (err) {
      console.error("Error completing turn:", err);
      setError(err instanceof Error ? err.message : "Error completing turn");
    }
  };

  const handleDartClick = (dartIndex: number) => {
    setSelectedDartIndex(dartIndex);
    setIsCorrectionModalOpen(true);
  };

  const handleCorrectionClose = () => {
    setIsCorrectionModalOpen(false);
    setSelectedDartIndex(-1);
  };

  const handleSaveCorrection = async (correction: {
    dartIndex: number;
    multiplier: number;
    segment: number;
    score: number;
  }) => {
    try {
      await correctScore(correction);
      await fetchAtcState();
      setIsCorrectionModalOpen(false);
      setSelectedDartIndex(-1);
    } catch (err) {
      console.error("Error saving correction:", err);
    }
  };
  const handleAddDart = async (correction: {
    dartIndex: number;
    multiplier: number;
    segment: number;
    score: number;
  }) => {
    try {
      await addDart(correction);
      await fetchAtcState();
      setIsCorrectionModalOpen(false);
      setSelectedDartIndex(-1);
    } catch (err) {
      console.error("Error adding dart:", err);
    }
  };


  const handleDeleteImages = async (dartIndex: number) => {
    try {
      await deleteCorrectionImages(dartIndex);
    } catch (err) {
      console.error("Error deleting images:", err);
    }
  };

  const handleStopGame = async () => {
    hasNavigatedRef.current = true;

    try {
      await apiStopGame("around_the_clock");
      navigate("/");
    } catch (err) {
      console.error("Error stopping game:", err);
    }
  };

  const getTargetDisplay = (target: number): string => {
    if (target > 20) return "Bull";
    return target.toString();
  };

  const getModeColor = (mode: string): string => {
    switch (mode) {
      case "full":
        return "text-emerald-400";
      case "single":
        return "text-blue-400";
      case "double":
        return "text-orange-400";
      case "triple":
        return "text-red-400";
      default:
        return "text-white";
    }
  };

  const getModeLabel = (mode: string): string => {
    return mode.charAt(0).toUpperCase() + mode.slice(1);
  };

  const calculateCurrentAccuracy = (player: AroundTheClockPlayerState): number => {
    // Calculate accuracy as: (targets_hit / total_darts) × 100%
    const targetsHit = player.hitsPerTarget.length;
    if (targetsHit === 0 || player.dartsThrown === 0) return 0;
    return (targetsHit / player.dartsThrown) * 100;
  };

  if (loading) {
    return (
      <div className="min-h-screen w-full bg-black text-white relative overflow-hidden flex items-center justify-center">
        <div
          className="pointer-events-none fixed inset-0 [background:
            radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
            radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.08),transparent_70%),
            radial-gradient(ellipse_at_bottom_left,rgba(255,255,255,0.06),transparent_70%),
            radial-gradient(ellipse_at_bottom_right,rgba(255,255,255,0.1),transparent_65%),
            linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95)_30%,rgba(255,255,255,0.04)_60%,rgba(0,0,0,1)_100%)
          ]"
        />
        <div className="relative z-10 text-white text-xl">Loading game...</div>
      </div>
    );
  }

  if (error || !atcState) {
    return (
      <div className="min-h-screen w-full bg-black text-white relative overflow-hidden flex items-center justify-center">
        <div
          className="pointer-events-none fixed inset-0 [background:
            radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
            radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.08),transparent_70%),
            radial-gradient(ellipse_at_bottom_left,rgba(255,255,255,0.06),transparent_70%),
            radial-gradient(ellipse_at_bottom_right,rgba(255,255,255,0.1),transparent_65%),
            linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95)_30%,rgba(255,255,255,0.04)_60%,rgba(0,0,0,1)_100%)
          ]"
        />
        <div className="relative z-10 text-center">
          <div className="text-red-400 text-xl mb-4">Error: {error || "No game state"}</div>
          <button
            onClick={() => navigate("/lobby")}
            className="px-4 py-2 rounded-lg bg-red-600/80 hover:bg-red-500/80 transition-colors"
          >
            Return to Lobby
          </button>
        </div>
      </div>
    );
  }

  const currentPlayer =
    atcState.currentPlayer !== null ? atcState.players[atcState.currentPlayer] : null;
  const { mode, match } = atcState;

  // Check for winners
  const legWinner = match.legWinner !== null ? atcState.players[match.legWinner] : null;
  const setWinner = match.setWinner !== null ? atcState.players[match.setWinner] : null;
  const matchWinner = match.matchWinner !== null ? atcState.players[match.matchWinner] : null;

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

      <GameHeader
        title={
          <>
            Around the Clock <span className="text-red-500">Live</span>
          </>
        }
        subtitle={
          <>
            Mode: <span className={getModeColor(mode)}>{getModeLabel(mode)}</span>
          </>
        }
        meta={
          match ? (
            <>
              Set {match.currentSet} • Leg {match.currentLeg}
              {match.setsToWin > 1 && ` • Best of ${match.setsToWin * 2 - 1} Sets`}
              {match.legsPerSet > 1 && ` • Best of ${match.legsPerSet * 2 - 1} Legs`}
            </>
          ) : null
        }
        right={
          <>
            <GameControlButton label="Next Turn" variant="primary" onClick={handleCompleteTurn} />
            <GameControlButton label="Abort Game" variant="danger" onClick={handleStopGame} />
          </>
        }
      />

      <main className="relative z-10 flex-1 px-4 md:px-10 pb-8">
        <div className="max-w-6xl mx-auto mt-6 space-y-6">

          {/* Winner Announcements */}
          {matchWinner && (
            <div className="rounded-xl border border-emerald-500/60 bg-emerald-600/15 px-4 py-3 text-sm text-emerald-200 flex items-center justify-between">
              <span className="text-base font-semibold">{matchWinner.name} wins the match!</span>
              <span className="text-xs uppercase tracking-[0.25em] text-emerald-300">Match Complete</span>
            </div>
          )}

          {setWinner && !matchWinner && (
            <div className="rounded-xl border border-emerald-500/60 bg-emerald-600/15 px-4 py-3 text-sm text-emerald-200 flex items-center justify-between">
              <span className="text-base font-semibold">{setWinner.name} wins Set {match.currentSet}!</span>
              <span className="text-xs uppercase tracking-[0.25em] text-emerald-300">Starting next set...</span>
            </div>
          )}

          {legWinner && !setWinner && !matchWinner && (
            <div className="rounded-xl border border-emerald-500/60 bg-emerald-600/15 px-4 py-3 text-sm text-emerald-200 flex items-center justify-between">
              <span className="text-base font-semibold">{legWinner.name} wins Leg {match.currentLeg}!</span>
              <span className="text-xs uppercase tracking-[0.25em] text-emerald-300">Starting next leg...</span>
            </div>
          )}

          {/* Players Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {atcState.players.map((player, idx) => {
              const isActive = atcState.currentPlayer === idx && !matchWinner;
              const isWinner = player.finished;
              const accuracy = calculateCurrentAccuracy(player);
              const statusLabel = isWinner ? "Winner" : isActive ? "Throwing" : "Player";

              return (
                <GamePlayerCard
                  key={idx}
                  variant={isWinner ? "winner" : isActive ? "active" : "default"}
                  detectionState={detectionState}
                  statusLabel={statusLabel}
                  headerRight={
                    match.setsToWin > 1 ? (
                      <>
                        Sets: {player.setsWon} • Legs: {player.legsWon}
                      </>
                    ) : null
                  }
                  title={
                    <div className="flex items-center gap-2">
                      {player.name}
                      {player.isBot && (
                        <span className="text-xs bg-purple-500/20 text-purple-400 px-2 py-0.5 rounded">
                          BOT{player.botLevel ? ` L${player.botLevel}` : ""}
                        </span>
                      )}
                    </div>
                  }
                  subtitle={<>Target {getTargetDisplay(player.currentTarget)}</>}
                  main={
                    <div className="text-6xl font-extrabold text-emerald-500 tabular-nums">
                      {getTargetDisplay(player.currentTarget)}
                    </div>
                  }
                  stats={[
                    { label: "Darts", value: player.dartsThrown },
                    { label: "Targets Hit", value: `${player.hitsPerTarget.length}/21`, align: "right" },
                    { label: "Accuracy", value: accuracy > 0 ? `${accuracy.toFixed(1)}%` : "—" },
                    {
                      label: "Progress",
                      value: `${Math.round((player.hitsPerTarget.length / 21) * 100)}%`,
                      align: "right",
                    },
                  ]}
                />
              );
            })}
          </div>

          {/* Current Turn Info */}
          {currentPlayer && !matchWinner && (
            <div className="rounded-2xl border border-white/10 bg-black/40 px-8 py-8">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <div className="text-xs uppercase tracking-[0.3em] text-zinc-500">Current Player</div>
                  <div className="text-2xl font-semibold text-white">{currentPlayer.name}</div>
                  {currentPlayer.isBot ? (
                    <div className="text-xs text-zinc-400">
                      Bot{currentPlayer.botLevel ? ` L${currentPlayer.botLevel}` : ""}
                    </div>
                  ) : null}
                </div>
                <div className="text-right">
                  <div className="text-xs uppercase tracking-[0.3em] text-zinc-500">Target</div>
                  <div className="text-5xl font-extrabold text-emerald-400 tabular-nums">
                    {getTargetDisplay(currentPlayer.currentTarget)}
                  </div>
                </div>
              </div>

              <GameDartBoxes
                boxes={[0, 1, 2].map((idx) => {
                  const dart = atcState.currentTurn.darts[idx];
                  const label = dart
                    ? `${dart.multiplier === 2 ? "D" : dart.multiplier === 3 ? "T" : ""}${dart.segment}`
                    : "No dart";
                  return {
                    key: `dart-${idx}`,
                    title: `Dart ${idx + 1}`,
                    main: label,
                    sub: dart ? <>Score {dart.score}</> : undefined,
                    filled: Boolean(dart),
                    onClick: () => handleDartClick(idx),
                  };
                })}
              />

              {/* Detection Status */}
              <div className="mt-6 grid grid-cols-2 gap-4 text-xs">
                <div className="flex flex-col gap-1">
                  <span className="text-zinc-500 uppercase tracking-wider">Turn Status</span>
                  <span className="text-white font-semibold">
                    {atcState.currentTurn.darts.filter(d => d !== null).length}/3 darts thrown
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-zinc-500 uppercase tracking-wider">Detection</span>
                  <span className="text-white font-semibold">
                    {dartCount > 0 ? `${dartCount} detected` : 'Ready'}
                  </span>
                </div>
                {detectionState === "removing_darts" && (
                  <div className="flex flex-col gap-1 col-span-2">
                    <span className="text-blue-400 uppercase tracking-wider font-semibold">
                      🔄 Removing darts...
                    </span>
                  </div>
                )}
                {detectionState === "partial_takeout" && (
                  <div className="flex flex-col gap-1 col-span-2">
                    <span className="text-yellow-400 uppercase tracking-wider font-semibold">
                      ⚠️ Partial takeout detected - Remove remaining darts
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Last Completed Turn */}
          {atcState.lastCompletedTurn.some((d) => d !== null) && (
            <div className="rounded-2xl border border-white/10 bg-zinc-900/60 px-6 py-5 shadow-[0_12px_50px_rgba(0,0,0,0.35)]">
              <div className="text-xs uppercase tracking-[0.3em] text-zinc-400 mb-3">
                Last Completed Turn
              </div>
              <GameDartBoxes
                boxes={[0, 1, 2].map((idx) => {
                  const dart = atcState.lastCompletedTurn[idx];
                  const label = dart
                    ? `${dart.multiplier === 2 ? "D" : dart.multiplier === 3 ? "T" : ""}${dart.segment}`
                    : "—";
                  return {
                    key: `last-dart-${idx}`,
                    title: `Dart ${idx + 1}`,
                    main: label,
                    sub: dart ? <>Score {dart.score}</> : undefined,
                    filled: Boolean(dart),
                  };
                })}
              />
            </div>
          )}
        </div>
      </main>

      {/* Score Correction Modal */}
      {isCorrectionModalOpen && atcState && (
        <ScoreCorrection
          isOpen={isCorrectionModalOpen}
          dartIndex={selectedDartIndex}
          originalScore={
            selectedDartIndex >= 0 && selectedDartIndex < atcState.currentTurn.darts.length
              ? atcState.currentTurn.darts[selectedDartIndex]
              : null
          }
          onClose={handleCorrectionClose}
          onSaveCorrection={handleSaveCorrection}
          onDeleteImages={handleDeleteImages}
          onAddDart={handleAddDart}
        />
      )}
    </div>
  );
};

export default AroundTheClockGamePage;
