import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import GameHeader from "../components/game/GameHeader";
import { GameControlButton } from "../components/game/GameControl";
import GamePlayerCard from "../components/player/GamePlayerCard";
import GameDartBoxes from "../components/game/GameDartBoxes";
import ScoreCorrection from "../components/ScoreCorrection";
import DiagnosticsDebugButton from "../components/game/DiagnosticsDebugButton";
import type { LobbyState } from "../context/LobbyContext";
import { addDart, correctScore } from "../services/correctionApi";
import { startGame as apiStartGame, getGameState as apiGetGameState, stopGame as apiStopGame, forceNextTurn as apiForceNextTurn } from "../services/gameApi";
import { useGameStateSync } from "../services/useGameStateSync";

interface DartScore {
  score: number;
  multiplier: number;
  segment: string;
  zone: string;
  confidence: number;
}

interface OneTwoOnePlayerState {
  name: string;
  currentTarget: number;
  startingTarget: number;
  targetLimit: number | null;
  failurePolicy: string;
  outRule: string;
  attemptRemaining: number;
  visitsUsed: number;
  dartsThrown: number;
  busts: number;
  successes: number;
  failures: number;
  bestTargetReached: number;
  legsWon: number;
  setsWon: number;
  attemptHistory?: Array<{
    target: number;
    success: boolean;
    dartsUsed: number;
    busts?: number;
  }>;
  isBot?: boolean;
  botLevel?: number;
}

interface OneTwoOneState {
  mode: "one_two_one";
  players: OneTwoOnePlayerState[];
  currentPlayer: number;
  currentTurn: {
    darts: (DartScore | null)[];
    bust?: boolean;
    scored?: number;
  };
  lastCompletedTurn: (DartScore | null)[];
  lastTurn?: {
    darts: (DartScore | null)[];
    bust?: boolean;
    scored?: number;
  };
  winnerIndex: number | null;
  match: {
    currentSet: number;
    currentLeg: number;
    legsPerSet: number;
    setsToWin: number;
    legWinner: number | null;
    setWinner: number | null;
    matchWinner: number | null;
  };
}

interface LocationState extends Partial<LobbyState> {}

export default function OneTwoOneGamePage() {
  const navigate = useNavigate();
  const { state } = useLocation() as { state?: LocationState };
  const [gameState, setGameState] = useState<OneTwoOneState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionDartIndex, setCorrectionDartIndex] = useState(0);
  const [correctionOriginalScore, setCorrectionOriginalScore] = useState<DartScore | null>(null);
  const hasNavigatedRef = useRef(false);
  const gameStartedRef = useRef(false);

  const playerConfigs = useMemo(() => {
    if (state?.players && Array.isArray(state.players) && state.players.length) {
      return state.players.map((p, idx) => ({
        name: p.name || `Player ${idx + 1}`,
        isBot: Boolean(p.isBot),
        botLevel: p.botLevel,
        profileId: p.profileId,
      }));
    }
    return [
      { name: "Player 1", isBot: false },
      { name: "Player 2", isBot: false },
    ];
  }, [state?.players]);

  const config = state?.oneTwoOne ?? {
    startingTarget: 121,
    targetLimit: 130,
    failurePolicy: "stay",
    outRule: "double",
  };
  const legsPerSet = Number(state?.match?.legs ?? 1);
  const setsToWin = Number(state?.match?.sets ?? 1);

  const startGame = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body = {
        players: playerConfigs,
        startingTarget: config.startingTarget,
        targetLimit: config.targetLimit,
        failurePolicy: config.failurePolicy,
        outRule: config.outRule,
        startingPlayer: Number(state?.startingPlayer ?? 0),
        legsPerSet,
        setsToWin,
      };

      const data = await apiStartGame<OneTwoOneState>("one_two_one", body);
      setGameState(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start game");
    } finally {
      setLoading(false);
    }
  }, [playerConfigs, config, legsPerSet, setsToWin, state?.startingPlayer]);

  const fetchState = useCallback(async () => {
    try {
      const data = await apiGetGameState<OneTwoOneState>("one_two_one");
      setGameState(data);
    } catch (err) {
      console.error("Failed to fetch One Two One state", err);
    }
  }, [navigate]);

  useEffect(() => {
    if (!gameStartedRef.current) {
      gameStartedRef.current = true;
      startGame();
    }
  }, [startGame]);

  useGameStateSync({
    enabled: Boolean(gameState) && !hasNavigatedRef.current,
    refresh: fetchState,
    pollMs: 0,
    debounceMs: 120,
  });

  // Navigate to stats when winner detected
  useEffect(() => {
    if (!gameState) return;
    const winner = gameState.match?.matchWinner ?? gameState.winnerIndex;
    if (winner === null || winner === undefined) return;
    if (hasNavigatedRef.current) return;
    hasNavigatedRef.current = true;
    navigate("/one-two-one/stats", { state: gameState });
  }, [gameState, navigate]);

  const handleForceNextTurn = async () => {
    try {
      const data = await apiForceNextTurn<OneTwoOneState>("one_two_one");
      if (data) setGameState(data);
      else await fetchState();
    } catch (err) {
      console.error("Failed to complete turn", err);
    }
  };

  const handleAbort = async () => {
    hasNavigatedRef.current = true;
    await apiStopGame("one_two_one").catch(() => undefined);
    navigate("/lobby");
  };

  const handleFinishToStats = async () => {
    hasNavigatedRef.current = true;
    const latest = await (async () => {
      try {
        return await apiGetGameState<OneTwoOneState>("one_two_one");
      } catch {
        /* ignore */
      }
      return gameState;
    })();
    await apiStopGame("one_two_one").catch(() => undefined);
    navigate("/one-two-one/stats", { state: latest ?? gameState });
  };

  const openCorrection = (dartIndex: number, originalScore: DartScore | null) => {
    setCorrectionDartIndex(dartIndex);
    setCorrectionOriginalScore(originalScore);
    setCorrectionOpen(true);
  };

  const handleSaveCorrection = async (correction: { dartIndex: number; multiplier: number; segment: number; score: number }) => {
    try {
      await correctScore(correction);
      await fetchState();
    } catch (err) {
      console.error("Failed to correct score", err);
    } finally {
      setCorrectionOpen(false);
    }
  };

  const handleAddDart = async (correction: { dartIndex: number; multiplier: number; segment: number; score: number }) => {
    try {
      await addDart(correction);
      await fetchState();
    } catch (err) {
      console.error("Failed to add dart", err);
    } finally {
      setCorrectionOpen(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen w-full bg-black text-white flex items-center justify-center">
        <div className="text-center space-y-2">
          <div className="text-2xl font-bold">Starting One Two One...</div>
          <div className="text-sm text-zinc-400">3 visits to checkout, climb the ladder</div>
        </div>
      </div>
    );
  }

  if (error || !gameState) {
    return (
      <div className="min-h-screen w-full bg-black text-white flex items-center justify-center">
        <div className="text-center">
          <div className="text-2xl font-bold text-red-500 mb-4">Error</div>
          <div className="text-zinc-400">{error || "Failed to load game"}</div>
          <div className="mt-4">
            <GameControlButton label="Lobby" variant="danger" onClick={() => navigate("/lobby")} />
          </div>
        </div>
      </div>
    );
  }

  const currentPlayer = gameState.players[gameState.currentPlayer];
  const matchWinner = gameState.match.matchWinner ?? gameState.winnerIndex;
  const bustActive = Boolean(gameState.currentTurn?.bust) && matchWinner == null;

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden flex flex-col">
      <div className="pointer-events-none fixed inset-0 [background:radial-gradient(ellipse_at_top,rgba(220,38,38,0.18),transparent_55%),radial-gradient(ellipse_at_bottom_right,rgba(255,255,255,0.05),transparent_60%),linear-gradient(to_bottom,rgba(0,0,0,0.95),rgba(0,0,0,1))]" />

      <GameHeader
        title={
          <>One Two One <span className="text-red-500">Live</span></>
        }
        subtitle={
          <>
            Start {config.startingTarget} — Limit {config.targetLimit ?? "None"} — Fail {config.failurePolicy}
          </>
        }
        right={
          <>
            <DiagnosticsDebugButton game="one_two_one" />
            {!matchWinner && <GameControlButton label="Next Turn" variant="primary" onClick={handleForceNextTurn} />}
            {!matchWinner && <GameControlButton label="Finish & Stats" variant="neutral" onClick={handleFinishToStats} />}
            <GameControlButton label="Abort Game" variant="danger" onClick={handleAbort} />
          </>
        }
      />

      <main className="relative z-10 flex-1 px-6 md:px-10 pb-8">
        <div className="max-w-6xl mx-auto space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {gameState.players.map((player, idx) => {
              const isActive = idx === gameState.currentPlayer && !matchWinner;
              const isWinner = matchWinner === idx;
              return (
                <GamePlayerCard
                  key={idx}
                  variant={isWinner ? "winner" : isActive ? "active" : "default"}
                  statusLabel={isWinner ? "Winner" : isActive ? "Throwing" : "Player"}
                  headerRight={
                    <>
                      Target {player.currentTarget}
                    </>
                  }
                  title={
                    <div className="flex items-center gap-2">
                      {player.name}
                      {player.isBot && (
                        <span className="text-xs bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded">
                          BOT{player.botLevel ? ` L${player.botLevel}` : ""}
                        </span>
                      )}
                    </div>
                  }
                  subtitle={
                    <>
                      Remaining {player.attemptRemaining} · Visits {player.visitsUsed}/3
                    </>
                  }
                  main={
                    <div className="text-5xl font-extrabold text-red-500 tabular-nums">
                      {player.attemptRemaining}
                    </div>
                  }
                  stats={[
                    { label: "Best Target", value: player.bestTargetReached },
                    { label: "Successes", value: player.successes, align: "right" },
                    { label: "Busts", value: player.busts },
                    { label: "Failures", value: player.failures, align: "right" },
                  ]}
                />
              );
            })}
          </div>

          {!matchWinner && currentPlayer && (
            <div className="rounded-2xl border border-white/10 bg-black/40 px-6 py-6">
              <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
                <div>
                  <div className="text-xs uppercase tracking-[0.3em] text-zinc-500">Current Player</div>
                  <div className="text-xl font-semibold text-white">{currentPlayer.name}</div>
                  <div className="text-xs text-zinc-400">Target {currentPlayer.currentTarget}</div>
                </div>
                <div className="text-right">
                    <div className="text-xs uppercase tracking-[0.3em] text-zinc-500">Remaining</div>
                    <div className="text-4xl font-extrabold text-red-500 tabular-nums">{currentPlayer.attemptRemaining}</div>
                </div>
              </div>

              <GameDartBoxes
                boxes={[0, 1, 2].map((idx) => {
                  const dart = gameState.currentTurn.darts[idx];
                  const label = dart
                    ? `${dart.multiplier === 2 ? "D" : dart.multiplier === 3 ? "T" : ""}${dart.segment}`
                    : "No dart";
                  return {
                    key: `dart-${idx}`,
                    title: `Dart ${idx + 1}`,
                    main: label,
                    sub: dart ? `Score ${dart.score}` : undefined,
                    filled: Boolean(dart),
                    danger: bustActive,
                    onClick: () => openCorrection(idx, dart),
                  };
                })}
              />
            </div>
          )}

          {gameState.lastCompletedTurn.some((d) => d !== null) && (
            <div className="rounded-2xl border border-white/10 bg-zinc-900/60 px-6 py-5 shadow-[0_12px_50px_rgba(0,0,0,0.35)]">
              <div className="text-xs uppercase tracking-[0.3em] text-zinc-400 mb-3">Last Completed Turn</div>
              <GameDartBoxes
                boxes={[0, 1, 2].map((idx) => {
                  const dart = gameState.lastCompletedTurn[idx];
                  const label = dart
                    ? `${dart.multiplier === 2 ? "D" : dart.multiplier === 3 ? "T" : ""}${dart.segment}`
                    : "--";
                  return {
                    key: `last-${idx}`,
                    title: `Dart ${idx + 1}`,
                    main: label,
                    sub: dart ? `Score ${dart.score}` : undefined,
                    filled: Boolean(dart),
                  };
                })}
              />
            </div>
          )}
        </div>
      </main>

      <ScoreCorrection
        isOpen={correctionOpen}
        onClose={() => setCorrectionOpen(false)}
        dartIndex={correctionDartIndex}
        originalScore={correctionOriginalScore}
        onSaveCorrection={handleSaveCorrection}
        onDeleteImages={() => {}}
        onAddDart={handleAddDart}
      />
    </div>
  );
}
