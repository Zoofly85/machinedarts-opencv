import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import ScoreCorrection from "../components/ScoreCorrection";
import GameDartBoxes from "../components/game/GameDartBoxes";
import GameHeader from "../components/game/GameHeader";
import { GameControlButton } from "../components/game/GameControl";
import GamePlayerCard from "../components/player/GamePlayerCard";
import type { LobbyState, PlayerConfig } from "../context/LobbyContext";
import { addDart, correctScore, deleteCorrectionImages } from "../services/correctionApi";
import { startGame as apiStartGame, getGameState as apiGetGameState, stopGame as apiStopGame, forceNextTurn as apiForceNextTurn } from "../services/gameApi";
import { useGameStateSync } from "../services/useGameStateSync";

interface DartScore {
  score: number;
  multiplier: number;
  segment: string;
  zone: string;
  confidence: number;
}

interface Bob27PlayerState {
  name: string;
  score: number;
  dartsThrown: number;
  hits: number;
  attempts: number;
  bestRound: number;
  roundsPlayed: number;
  perDoubleHits: Record<number, number>;
  perDoubleAttempts: Record<number, number>;
  isBot?: boolean;
  botLevel?: number;
}

interface Bob27State {
  mode: "bob27";
  settings: {
    includeBull: boolean;
    allowNegative: boolean;
  };
  currentTarget: number;
  currentTargetIndex: number;
  totalTargets: number;
  currentPlayer: number;
  players: Bob27PlayerState[];
  currentTurn: { darts: (DartScore | null)[] };
  lastTurn: (DartScore | null)[];
  turnHistory: Array<{
    playerIndex: number;
    target: number;
    darts: (DartScore | null)[];
    roundScore: number;
  }>;
  matchWinnerIndex: number | null;
}

interface LocationState extends Partial<LobbyState> {}

const defaultDarts: (DartScore | null)[] = [null, null, null];

export default function Bob27GamePage() {
  const navigate = useNavigate();
  const { state } = useLocation() as { state?: LocationState };
  const hasNavigatedRef = useRef(false);
  const gameStartedRef = useRef(false);

  const playerConfigs: PlayerConfig[] = useMemo(() => {
    const raw = state?.players;
    if (Array.isArray(raw) && raw.length) {
      return raw.map((player, index) => ({
        name: player?.name?.trim() || `Player ${index + 1}`,
        isBot: Boolean(player?.isBot),
        botLevel: player?.botLevel,
        profileId: player?.profileId,
      }));
    }
    return [{ name: "Player 1", isBot: false }];
  }, [state?.players]);

  const includeBull = state?.bob27?.includeBull ?? true;
  const allowNegative = state?.bob27?.allowNegative ?? false;
  const legsToPlay = Number(state?.match?.legs ?? 1);

  const [gameState, setGameState] = useState<Bob27State | null>(null);
  const [detectionState, setDetectionState] = useState<string>("no_movement");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isCorrectionOpen, setIsCorrectionOpen] = useState(false);
  const [selectedDartIndex, setSelectedDartIndex] = useState(-1);

  const currentDarts = gameState?.currentTurn?.darts ?? defaultDarts;
  const players = gameState?.players ?? [];
  const currentPlayerIndex = gameState?.currentPlayer ?? 0;
  const targetNumber = gameState?.currentTarget ?? 1;
  const matchWinnerIndex = gameState?.matchWinnerIndex ?? null;
  const isMatchOver = matchWinnerIndex !== null && matchWinnerIndex !== undefined;

  const startGame = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const body = {
        players: playerConfigs,
        includeBull,
        allowNegative,
        startingPlayer: Number(state?.startingPlayer ?? 0),
        legs: legsToPlay,
      };
      const data = await apiStartGame<Bob27State>("bob27", body);
      setGameState(data);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to start game");
    } finally {
      setIsLoading(false);
    }
  }, [playerConfigs, includeBull, allowNegative, state?.startingPlayer]);

  const fetchState = useCallback(async () => {
    try {
      const data = await apiGetGameState<Bob27State>("bob27");
      setGameState(data);
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    if (!gameStartedRef.current) {
      gameStartedRef.current = true;
      startGame();
    }
  }, [startGame]);

  const handleDetectionStatus = useCallback(
    ({ detectionState: nextDetectionState }: { detectionState?: string }) => {
      if (typeof nextDetectionState === "string") {
        setDetectionState(nextDetectionState);
      }
    },
    []
  );

  useGameStateSync({
    refresh: fetchState,
    onStatus: handleDetectionStatus,
    pollMs: 0,
    debounceMs: 120,
  });

  useEffect(() => {
    if (hasNavigatedRef.current) return;
    if (gameState && gameState.matchWinnerIndex !== null && gameState.matchWinnerIndex !== undefined) {
      hasNavigatedRef.current = true;
      navigate("/bob27/stats", { state: { summary: gameState, players: playerConfigs } });
    }
  }, [gameState, navigate, playerConfigs]);

  const handleOpenCorrection = (index: number) => {
    setSelectedDartIndex(index);
    setIsCorrectionOpen(true);
  };

  const handleSaveCorrection = useCallback(
    async (correction: { dartIndex: number; multiplier: number; segment: number; score: number; bouncer?: boolean }) => {
      try {
        await correctScore(correction);
        await fetchState();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to correct score");
      }
    },
    [fetchState]
  );

  const handleAddDart = useCallback(
    async (correction: { dartIndex: number; multiplier: number; segment: number; score: number; bouncer?: boolean }) => {
      try {
        await addDart(correction);
        await fetchState();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to add dart");
      }
    },
    [fetchState]
  );

  const handleDeleteImages = useCallback(async (dartIndex: number) => {
    try {
      await deleteCorrectionImages(dartIndex);
      await fetchState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete images");
    }
  }, [fetchState]);


  const handleAbort = useCallback(async () => {
    const summary = await (async () => {
      try {
        return await apiGetGameState<Bob27State>("bob27");
      } catch {
        return gameState;
      }
    })();
    try {
      await apiStopGame("bob27");
    } catch {
      /* ignore */
    }
    navigate("/bob27/stats", { state: { summary, players: playerConfigs } });
  }, [gameState, navigate, playerConfigs]);

  const handleForceNextTurn = useCallback(async () => {
    try {
      const data = await apiForceNextTurn<Bob27State>("bob27");
      if (data) {
        setGameState(data);
      } else {
        await fetchState();
      }
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to force next turn");
    }
  }, [fetchState]);

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
        title={<>Bob&apos;s 27</>}
        subtitle={
          <>
            Target {gameState ? gameState.currentTargetIndex + 1 : 1}/
            {gameState?.totalTargets ?? (includeBull ? 21 : 20)} â€¢ D{targetNumber}
          </>
        }
        right={
          <>
            {!isMatchOver ? <GameControlButton label="Next Turn" variant="primary" onClick={handleForceNextTurn} /> : null}
            <GameControlButton label="Abort Game" variant="danger" onClick={handleAbort} />
          </>
        }
      />

      <main className="relative z-10 flex-1 px-4 md:px-10 pb-8">
        <div className="max-w-6xl mx-auto space-y-6">
          {error && <div className="rounded-xl border border-red-500/60 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>}
          {isLoading && <div className="rounded-xl border border-white/10 bg-zinc-900/60 px-4 py-3 text-sm text-zinc-200">Starting Bob&apos;s 27...</div>}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {players.map((player, index) => {
              const isActive = !isMatchOver && index === currentPlayerIndex;
              const isWinner = isMatchOver && index === matchWinnerIndex;
              const statusLabel = isWinner ? "Winner" : isActive ? "Throwing" : "Player";
              const hits = player.hits ?? 0;
              const attempts = player.attempts ?? 0;
              const accuracy = attempts > 0 ? `${Math.round((hits / attempts) * 100)}%` : "â€”";

              return (
                <GamePlayerCard
                  key={player.name + index}
                  variant={isWinner ? "winner" : isActive ? "active" : "default"}
                  detectionState={detectionState}
                  statusLabel={statusLabel}
                  headerRight={<>Acc {accuracy}</>}
                  title={
                    <>
                      {player.name}
                      {player.isBot && (
                        <span className="ml-2 text-xs text-zinc-400">
                          (Bot{player.botLevel ? ` L${player.botLevel}` : ""})
                        </span>
                      )}
                    </>
                  }
                  subtitle={
                    <div className="flex items-center gap-2">
                      <span>Target D{targetNumber}</span>
                      <span>â€¢</span>
                      <span>Best Round {player.bestRound ?? 0}</span>
                    </div>
                  }
                  main={<div className="text-5xl font-extrabold text-emerald-400 tabular-nums">{player.score ?? 0}</div>}
                  stats={[
                    { label: "Hits", value: hits },
                    { label: "Attempts", value: attempts, align: "right" },
                    { label: "Rounds", value: player.roundsPlayed ?? 0 },
                    { label: "Darts", value: player.dartsThrown ?? 0, align: "right" },
                  ]}
                />
              );
            })}
          </div>

          <div className="grid grid-cols-1 gap-6">
            <div className="rounded-2xl border border-white/10 bg-black/40 px-8 py-8">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <div className="text-xs uppercase tracking-[0.3em] text-zinc-500">Current Player</div>
                  <div className="text-2xl font-semibold text-white">{players[currentPlayerIndex]?.name || `Player ${currentPlayerIndex + 1}`}</div>
                  {players[currentPlayerIndex]?.isBot && (
                    <div className="text-xs text-zinc-400">Bot{players[currentPlayerIndex]?.botLevel ? ` L${players[currentPlayerIndex]?.botLevel}` : ""}</div>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-xs uppercase tracking-[0.3em] text-zinc-500">Target Double</div>
                  <div className="text-5xl font-extrabold text-red-500 tabular-nums">D{targetNumber}</div>
                </div>
              </div>

              <GameDartBoxes
                boxes={[0, 1, 2].map((idx) => {
                  const dart = currentDarts[idx];
                  const label = dart
                    ? `${dart.multiplier === 2 ? "D" : dart.multiplier === 3 ? "T" : ""}${dart.segment}`
                    : "No dart";
                  return {
                    key: `dart-${idx}`,
                    title: `Dart ${idx + 1}`,
                    main: label,
                    sub: dart ? <>Score {dart.score}</> : undefined,
                    filled: Boolean(dart),
                    onClick: () => handleOpenCorrection(idx),
                  };
                })}
              />
            </div>
          </div>
        </div>
      </main>

      <ScoreCorrection
        isOpen={isCorrectionOpen}
        onClose={() => setIsCorrectionOpen(false)}
        dartIndex={selectedDartIndex}
        originalScore={selectedDartIndex >= 0 ? currentDarts[selectedDartIndex] : null}
        onSaveCorrection={handleSaveCorrection}
        onDeleteImages={handleDeleteImages}
        onAddDart={handleAddDart}
      />
    </div>
  );
}

