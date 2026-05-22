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
import { API_BASE_URL } from "../../services/api";

const API_URL = API_BASE_URL;

interface DartScore {
  score: number;
  multiplier: number;
  segment: string;
  zone: string;
  confidence: number;
}

interface TargetTrainerPlayerState {
  name: string;
  hits: number;
  requiredHits: number;
  dartsThrown: number;
  bestStreak?: number;
  currentStreak?: number;
  accuracy?: number;
  isBot?: boolean;
  botLevel?: number;
  legsWon?: number;
  setsWon?: number;
}

interface TargetTrainerState {
  mode: "target_trainer";
  settings: {
    targetType: "single" | "double" | "treble" | "outer_bull" | "inner_bull";
    targetNumber: number;
    requiredHits: number;
    allowClose: boolean;
    sharedTarget: boolean;
    legsPerSet?: number;
    setsToWin?: number;
  };
  currentPlayer: number;
  currentLeg?: number;
  currentSet?: number;
  players: TargetTrainerPlayerState[];
  currentTurn: { darts: (DartScore | null)[]; hitsThisTurn?: number };
  lastTurn?: { darts: (DartScore | null)[]; hitsThisTurn?: number; playerIndex?: number };
  winnerIndex?: number | null;
  legWinner?: number | null;
  setWinner?: number | null;
  matchWinner?: number | null;
}

interface LocationState extends Partial<LobbyState> {}

const defaultDarts: (DartScore | null)[] = [null, null, null];

const formatTargetLabel = (type: string, num: number) => {
  if (type.includes("bull")) return type === "inner_bull" ? "Inner Bull (50)" : "Outer Bull (25)";
  const prefix = type === "treble" ? "T" : type === "double" ? "D" : "S";
  return `${prefix}${num}`;
};

export default function TargetTrainerGamePage() {
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
        isPlayerBot: player?.isPlayerBot,
        sourcePlayerId: player?.sourcePlayerId,
      }));
    }
    return [{ name: "Player 1", isBot: false }];
  }, [state?.players]);

  const targetType = state?.targetTrainer?.targetType ?? "treble";
  const targetNumber = state?.targetTrainer?.targetNumber ?? 20;
  const requiredHits = state?.targetTrainer?.requiredHits ?? 10;
  const allowClose = state?.targetTrainer?.allowClose ?? false;
  const sharedTarget = state?.targetTrainer?.sharedTarget ?? true;

  const [gameState, setGameState] = useState<TargetTrainerState | null>(null);
  const [detectionState, setDetectionState] = useState<string>("no_movement");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isCorrectionOpen, setIsCorrectionOpen] = useState(false);
  const [selectedDartIndex, setSelectedDartIndex] = useState(-1);
  const [backendAvailable, setBackendAvailable] = useState(true);

  const currentDarts = gameState?.currentTurn?.darts ?? defaultDarts;
  const players: TargetTrainerPlayerState[] =
    gameState?.players ??
    playerConfigs.map((player) => ({
      name: player.name,
      hits: 0,
      requiredHits,
      dartsThrown: 0,
      bestStreak: 0,
      accuracy: undefined,
      isBot: player.isBot,
      botLevel: player.botLevel,
      legsWon: 0,
      setsWon: 0,
    }));
  const currentPlayerIndex = gameState?.currentPlayer ?? 0;
  const winnerIndex = (gameState?.matchWinner ?? gameState?.winnerIndex ?? null) as number | null;
  const isMatchOver = winnerIndex !== null && winnerIndex !== undefined;

  const legsPerSet = gameState?.settings?.legsPerSet ?? Number(state?.match?.legs ?? 1);
  const setsToWin = gameState?.settings?.setsToWin ?? Number(state?.match?.sets ?? 1);
  const currentLeg = gameState?.currentLeg ?? 1;
  const currentSet = gameState?.currentSet ?? 1;

  const startGame = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const body = {
        players: playerConfigs,
        targetType,
        targetNumber,
        requiredHits,
        allowClose,
        sharedTarget,
        startingPlayer: Number(state?.startingPlayer ?? 0),
        legsPerSet: Number(state?.match?.legs ?? 1),
        setsToWin: Number(state?.match?.sets ?? 1),
      };
      try {
        const data = await apiStartGame<TargetTrainerState>("target-trainer", body);
        setGameState(data);
      } catch (startErr) {
        const msg = startErr instanceof Error ? startErr.message : String(startErr);
        if (msg.includes("404") || msg.includes("501")) {
          setBackendAvailable(false);
          throw new Error("Target Trainer backend endpoint is not available.");
        }
        throw startErr;
      }
      await fetch(`${API_URL}/api/detection/reset`, { method: "POST" }).catch(() => undefined);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to start game");
    } finally {
      setIsLoading(false);
    }
  }, [
    allowClose,
    playerConfigs,
    requiredHits,
    sharedTarget,
    state?.match?.legs,
    state?.match?.sets,
    state?.startingPlayer,
    targetNumber,
    targetType,
  ]);

  const fetchState = useCallback(async () => {
    if (!backendAvailable) {
      return;
    }
    try {
      const data = await apiGetGameState<TargetTrainerState>("target-trainer");
      setGameState(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("404") || msg.includes("501")) {
        setBackendAvailable(false);
        setError("Target Trainer backend endpoint is not available.");
        return;
      }
      console.error(err);
    }
  }, [backendAvailable]);

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
    if (gameState && gameState.matchWinner !== null && gameState.matchWinner !== undefined) {
      hasNavigatedRef.current = true;
      navigate("/target-trainer/stats", { state: { summary: gameState, players: playerConfigs } });
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
    [fetchState],
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
    [fetchState],
  );

  const handleDeleteImages = useCallback(
    async (dartIndex: number) => {
      try {
        await deleteCorrectionImages(dartIndex);
        await fetchState();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete images");
      }
    },
    [fetchState],
  );

  const handleForceNextTurn = useCallback(async () => {
    try {
      const data = await apiForceNextTurn<TargetTrainerState>("target-trainer");
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

  const handleAbort = useCallback(async () => {
    const summary = await (async () => {
      try {
        return await apiGetGameState<TargetTrainerState>("target-trainer");
      } catch {
        return gameState;
      }
    })();
    try {
      await apiStopGame("target-trainer");
    } catch {
      /* ignore */
    }
    navigate("/target-trainer/stats", { state: { summary, players: playerConfigs } });
  }, [gameState, navigate, playerConfigs]);

  const targetLabel = formatTargetLabel(targetType, targetNumber);

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
        title={<>Target Trainer</>}
        subtitle={
          <>
            Hit {targetLabel} â€¢ {requiredHits} hits required
          </>
        }
        meta={
          <>
            Allow close: {allowClose ? "On (0.5 credit)" : "Off"} â€¢ Shared target: {sharedTarget ? "Yes" : "Per-player"} â€¢ Set{" "}
            {currentSet} â€¢ Leg {currentLeg} â€¢ Legs/Set {legsPerSet} â€¢ Sets to Win {setsToWin}
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
          {error ? (
            <div className="rounded-xl border border-red-500/60 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>
          ) : null}
          {isLoading ? (
            <div className="rounded-xl border border-white/10 bg-zinc-900/60 px-4 py-3 text-sm text-zinc-200">
              Starting Target Trainer...
            </div>
          ) : null}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {players.map((player, index) => {
              const hitsLeft = Math.max(0, (player.requiredHits ?? requiredHits) - player.hits);
              const isWinner = isMatchOver && winnerIndex === index;
              const isActive = !isMatchOver && index === currentPlayerIndex;
              return (
                <GamePlayerCard
                  key={`${player.name}-${index}`}
                  variant={isWinner ? "winner" : isActive ? "active" : "default"}
                  detectionState={detectionState}
                  statusLabel={isWinner ? "Winner" : isActive ? "Throwing" : "Player"}
                  headerRight={player.isBot ? <>Bot{player.botLevel ? ` L${player.botLevel}` : ""}</> : undefined}
                  title={player.name}
                  subtitle={
                    <>
                      Target {targetLabel} â€¢ {player.hits}/{player.requiredHits ?? requiredHits} hits
                    </>
                  }
                  main={
                    <div>
                      <div className="text-6xl font-extrabold text-red-500 tabular-nums">{hitsLeft}</div>
                      <div className="text-sm text-zinc-400">Hits left</div>
                    </div>
                  }
                  stats={[
                    { label: "Legs Won", value: player.legsWon ?? 0 },
                    { label: "Sets Won", value: player.setsWon ?? 0, align: "right" },
                    { label: "Darts", value: player.dartsThrown },
                    {
                      label: "Accuracy",
                      value: player.accuracy !== undefined ? `${(player.accuracy * 100).toFixed(1)}%` : "â€”",
                      align: "right",
                    },
                  ]}
                />
              );
            })}
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/40 px-8 py-8">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <div className="text-xs uppercase tracking-[0.3em] text-zinc-500">Current Player</div>
                <div className="text-2xl font-semibold text-white">
                  {players[currentPlayerIndex]?.name || `Player ${currentPlayerIndex + 1}`}
                </div>
                {players[currentPlayerIndex]?.isBot ? (
                  <div className="text-xs text-zinc-400">
                    Bot{players[currentPlayerIndex]?.botLevel ? ` L${players[currentPlayerIndex]?.botLevel}` : ""}
                  </div>
                ) : null}
              </div>

              <div className="text-right">
                <div className="text-xs uppercase tracking-[0.3em] text-zinc-500">Target</div>
                <div className="text-5xl font-extrabold text-red-500 tabular-nums">{targetLabel}</div>
              </div>
            </div>

            <GameDartBoxes
              boxes={[0, 1, 2].map((idx) => {
                const dart = currentDarts[idx];
                const label = dart
                  ? `${dart.multiplier === 2 ? "D" : dart.multiplier === 3 ? "T" : ""}${
                      dart.segment === "25" ? "25" : dart.segment
                    }`
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

