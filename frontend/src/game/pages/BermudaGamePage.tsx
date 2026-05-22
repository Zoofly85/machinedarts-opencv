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

interface BermudaPlayerState {
  name: string;
  score: number;
  dartsThrown: number;
  perRoundScores: number[];
  legsWon?: number;
  setsWon?: number;
  isBot?: boolean;
  botLevel?: number;
}

interface BermudaState {
  mode: "bermuda";
  currentRound: number;
  totalRounds: number;
  currentTarget: string;
  currentPlayer: number;
  currentLeg: number;
  currentSet: number;
  legsPerSet: number;
  setsToWin: number;
  players: BermudaPlayerState[];
  currentTurn: { darts: (DartScore | null)[] };
  lastTurn: (DartScore | null)[];
  legWinnerIndex: number | null;
  turnHistory: Array<{
    playerIndex: number;
    roundIndex: number;
    target: string;
    darts: (DartScore | null)[];
    roundScore: number;
  }>;
  matchWinnerIndex: number | null;
}

interface LocationState extends Partial<LobbyState> {}

const defaultDarts: (DartScore | null)[] = [null, null, null];

export default function BermudaGamePage() {
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

  const [gameState, setGameState] = useState<BermudaState | null>(null);
  const [detectionState, setDetectionState] = useState<string>("no_movement");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isCorrectionOpen, setIsCorrectionOpen] = useState(false);
  const [selectedDartIndex, setSelectedDartIndex] = useState(-1);

  const currentDarts = gameState?.currentTurn?.darts ?? defaultDarts;
  const currentPlayerIndex = gameState?.currentPlayer ?? 0;
  const players = gameState?.players ?? [];
  const target = gameState?.currentTarget ?? "";
  const matchWinnerIndex = gameState?.matchWinnerIndex ?? null;
  const isMatchOver = matchWinnerIndex !== null && matchWinnerIndex !== undefined;

  const startGame = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const body = {
        players: playerConfigs,
        startingPlayer: Number(state?.startingPlayer ?? 0),
        mode: state?.bermuda?.mode ?? "legs_sets",
        legsPerSet: Number(state?.match?.legs ?? 1),
        setsToWin: Number(state?.match?.sets ?? 1),
      };
      const data = await apiStartGame<BermudaState>("bermuda", body);
      setGameState(data);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to start game");
    } finally {
      setIsLoading(false);
    }
  }, [playerConfigs, state?.startingPlayer, state?.bermuda?.mode, state?.match?.legs, state?.match?.sets]);

  const fetchState = useCallback(async () => {
    try {
      const data = await apiGetGameState<BermudaState>("bermuda");
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
      navigate("/bermuda/stats", { state: { summary: gameState, players: playerConfigs } });
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
        return await apiGetGameState<BermudaState>("bermuda");
      } catch {
        return gameState;
      }
    })();
    try {
      await apiStopGame("bermuda");
    } catch {
      /* ignore */
    }
    navigate("/bermuda/stats", { state: { summary, players: playerConfigs } });
  }, [gameState, navigate, playerConfigs]);

  const handleForceNextTurn = useCallback(async () => {
    try {
      const data = await apiForceNextTurn<BermudaState>("bermuda");
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
        title={<>Bermuda Triangle</>}
        subtitle={<>Round {gameState?.currentRound ?? 1} / {gameState?.totalRounds ?? 13}</>}
        meta={
          <>
            Target {target || "â€”"} â€¢ Leg {gameState?.currentLeg ?? 1}
            {gameState?.legsPerSet ? ` / ${gameState.legsPerSet}` : ""} â€¢ Set {gameState?.currentSet ?? 1}
            {gameState?.setsToWin ? ` / ${gameState.setsToWin}` : ""}
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
          {isLoading && <div className="rounded-xl border border-white/10 bg-zinc-900/60 px-4 py-3 text-sm text-zinc-200">Starting Bermuda...</div>}

          {gameState && gameState.legWinnerIndex !== null && gameState.matchWinnerIndex == null && (
            <div className="rounded-xl border border-emerald-500/60 bg-emerald-600/15 px-4 py-3 text-sm text-emerald-200">
              {players[gameState.legWinnerIndex]?.name || `Player ${gameState.legWinnerIndex + 1}`} wins Leg {gameState.currentLeg - 1}!
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {players.map((player, index) => {
              const isActive = !isMatchOver && index === currentPlayerIndex;
              const isWinner = isMatchOver && index === matchWinnerIndex;
              const statusLabel = isWinner ? "Winner" : isActive ? "Throwing" : "Player";
              const roundsPlayed = player.perRoundScores?.length ?? 0;
              const totalRounds = gameState?.totalRounds ?? 13;
              const averagePerRound = roundsPlayed > 0 ? (player.score / roundsPlayed).toFixed(1) : "0.0";

              return (
                <GamePlayerCard
                  key={player.name + index}
                  variant={isWinner ? "winner" : isActive ? "active" : "default"}
                  detectionState={detectionState}
                  statusLabel={statusLabel}
                  headerRight={<>Darts {player.dartsThrown ?? 0}</>}
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
                      <span>Rounds {roundsPlayed}/{totalRounds}</span>
                      <span>â€¢</span>
                      <span>Target {target || "â€”"}</span>
                    </div>
                  }
                  main={<div className="text-5xl font-extrabold text-emerald-400 tabular-nums">{player.score ?? 0}</div>}
                  stats={[
                    { label: "Legs Won", value: player.legsWon ?? 0 },
                    { label: "Sets Won", value: player.setsWon ?? 0, align: "right" },
                    { label: "Avg/Round", value: averagePerRound },
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
                  <div className="text-xs uppercase tracking-[0.3em] text-zinc-500">Target</div>
                  <div className="text-5xl font-extrabold text-red-500 tabular-nums">{target || "â€”"}</div>
                </div>
              </div>

              <GameDartBoxes
                boxes={[0, 1, 2].map((idx) => {
                  const dart = currentDarts[idx];
                  const label = dart
                    ? `${dart.multiplier === 3 ? "T" : dart.multiplier === 2 ? "D" : dart.multiplier === 1 ? "S" : ""}${dart.segment}`
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

