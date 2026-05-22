import React, { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import ScoreCorrection from "../components/ScoreCorrection";
import GameHeader from "../components/game/GameHeader";
import { GameControlButton } from "../components/game/GameControl";
import type { LobbyState, CricketVariant, PlayerConfig } from "../context/LobbyContext";
import { addDart, correctScore, deleteCorrectionImages } from "../services/correctionApi";
import { startGame as apiStartGame, getGameState as apiGetGameState, stopGame as apiStopGame, forceNextTurn as apiForceNextTurn } from "../services/gameApi";
import { useGameStateSync } from "../services/useGameStateSync";
import { API_BASE_URL } from "../../services/api";

const API_URL = API_BASE_URL;

type Target = 20 | 19 | 18 | 17 | 16 | 15 | "BULL";

interface LocationState extends Partial<LobbyState> {}

interface DartScore {
  score: number;
  multiplier: number;
  segment: string;
  zone: string;
  confidence: number;
}

interface CricketPlayerState {
  name: string;
  score: number;
  marks: number[];
  legsWon: number;
  setsWon: number;
}

interface CricketState {
  mode: string;
  numbers: number[];
  currentPlayer: number | null;
  players: CricketPlayerState[];
  currentTurn: {
    darts: (DartScore | null)[];
  };
  lastCompletedTurn: (DartScore | null)[];
  winner?: number | null;
  match: {
    legsPerSet: number;
    setsToWin: number;
    currentSet: number;
    currentLeg: number;
    legWinner: number | null;
    setWinner: number | null;
    matchWinner: number | null;
  };
}

const targets: Target[] = [20, 19, 18, 17, 16, 15, "BULL"];

export default function CricketGamePage() {
  const navigate = useNavigate();
  const { state } = useLocation() as { state?: LocationState };
  const cricketVariant: CricketVariant = state?.cricket?.variant ?? "standard";
  const startingPlayer = Number(state?.startingPlayer ?? 0);

  const playerConfigs: PlayerConfig[] = useMemo(() => {
    const rawPlayers = state?.players;
    if (Array.isArray(rawPlayers) && rawPlayers.length > 0) {
      return rawPlayers.map((player, index) => ({
        name: player?.name?.trim() || `Player ${index + 1}`,
        isBot: Boolean(player?.isBot),
        botLevel: player?.botLevel,
        profileId: player?.profileId,
      }));
    }
    return [
      { name: "Player 1", isBot: false, profileId: undefined },
      { name: "Player 2", isBot: false, profileId: undefined },
    ];
  }, [state?.players]);

  const playerNames = useMemo(() => playerConfigs.map((player) => player.name || "Player"), [playerConfigs]);

  const [cricketState, setCricketState] = useState<CricketState | null>(null);
  const [dartScores, setDartScores] = useState<(DartScore | null)[]>([null, null, null]);
  const [dartCount, setDartCount] = useState(0);
  const [detectionState, setDetectionState] = useState<string>("no_movement");
  const [selectedDartIndex, setSelectedDartIndex] = useState(-1);
  const [isCorrectionModalOpen, setIsCorrectionModalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const hasNavigatedRef = useRef(false);
  const gameStartedRef = useRef(false);

  const defaultPlayers: CricketPlayerState[] = useMemo(
    () =>
      playerConfigs.map((player) => ({
        name: player.name,
        score: 0,
        marks: targets.map(() => 0),
        legsWon: 0,
        setsWon: 0,
      })),
    [playerConfigs]
  );

  const activePlayer = cricketState?.currentPlayer ?? 0;
  const displayedPlayers = cricketState?.players ?? defaultPlayers;
  const getDisplayName = (index: number) => {
    const base = displayedPlayers[index]?.name ?? playerConfigs[index]?.name ?? `Player ${index + 1}`;
    const isBot = (displayedPlayers[index] as any)?.isBot ?? playerConfigs[index]?.isBot ?? false;
    const botLevel = (displayedPlayers[index] as any)?.botLevel ?? playerConfigs[index]?.botLevel;
    if (!isBot) {
      return base;
    }
    return `${base}${botLevel ? ` (Bot L${botLevel})` : " (Bot)"}`;
  };

  const winnerIndex = typeof cricketState?.winner === "number" ? cricketState?.winner : null;
  const matchWinnerIndex =
    typeof cricketState?.match?.matchWinner === "number" ? cricketState.match.matchWinner : null;
  const getStarStyle = (playerIndex: number, targetIndex: number, starIndex: number) => {
    const playerMarks = displayedPlayers[playerIndex]?.marks?.[targetIndex] ?? 0;
    const allClosed = displayedPlayers.every((player) => (player.marks?.[targetIndex] ?? 0) >= 3);

    if (starIndex >= playerMarks) {
      return { fill: "none", stroke: "#3f3f46" };
    }

    if (allClosed) {
      return { fill: "#ffffff", stroke: "#ffffff" };
    }

    if (playerMarks >= 3) {
      return { fill: "#fbbf24", stroke: "#fbbf24" };
    }

    return { fill: "#d90429", stroke: "#d90429" };
  };

  const renderStars = (playerIndex: number, targetIndex: number) => (
    <div className="flex items-center gap-1">
      {[0, 1, 2].map((star) => {
        const { fill, stroke } = getStarStyle(playerIndex, targetIndex, star);
        return (
          <svg
            key={star}
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill={fill}
            stroke={stroke}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.8"
              d="M12 2l3.09 6.26 6.91 1.01-5 4.87 1.18 6.86L12 18.56 5.82 22 7 14.14l-5-4.87 6.91-1.01z"
            />
          </svg>
        );
      })}
    </div>
  );

  const fetchCricketState = useCallback(async () => {
    try {
      const data = await apiGetGameState<CricketState>("cricket");
      setCricketState(data);
      if (data.currentTurn?.darts) {
        setDartScores(data.currentTurn.darts);
      }
    } catch (err) {
      console.error("Error fetching cricket state:", err);
    }
  }, []);

  const startCricketGame = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    hasNavigatedRef.current = false;
    try {
      const data = await apiStartGame<CricketState>("cricket", {
        players: playerConfigs.map((player) => ({
          name: player.name,
          isBot: player.isBot,
          botLevel: player.isBot ? player.botLevel ?? 4 : undefined,
          profileId: player.profileId,
        })),
        mode: cricketVariant,
        startingPlayer,
        legsPerSet: state?.match?.legs ?? 1,
        setsToWin: state?.match?.sets ?? 1,
      });

      setCricketState(data ?? null);
      if (data?.currentTurn?.darts) {
        setDartScores(data.currentTurn.darts);
      } else {
        setDartScores([null, null, null]);
      }
      setDartCount(0);

      // Reset detection to clear dart count for new game
      await fetch(`${API_URL}/api/detection/reset`, { method: "POST" }).catch(() => undefined);
      await fetchCricketState();
    } catch (err) {
      console.error("Error starting cricket game:", err);
      setError(err instanceof Error ? err.message : "Failed to start cricket game");
    } finally {
      setIsLoading(false);
    }
  }, [playerConfigs, cricketVariant, fetchCricketState, startingPlayer, state?.match?.legs, state?.match?.sets]);

  const stopCricketGame = useCallback(async () => {
    try {
      await apiStopGame("cricket");
    } catch (err) {
      console.error("Error stopping cricket game:", err);
    }
  }, []);

  const handleAbort = useCallback(async () => {
    hasNavigatedRef.current = true;
    await stopCricketGame();
    navigate("/");
  }, [stopCricketGame, navigate]);

  const handleForceNextTurn = useCallback(async () => {
    try {
      const data = await apiForceNextTurn<CricketState>("cricket");
      if (data) {
        setCricketState(data);
        if (data?.currentTurn?.darts) {
          setDartScores(data.currentTurn.darts);
        }
      } else {
        await fetchCricketState();
      }
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to force next turn");
    }
  }, [fetchCricketState]);


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

  useEffect(() => {
    if (!gameStartedRef.current) {
      gameStartedRef.current = true;
      startCricketGame();
    }

    return () => {
      // Avoid stop/start churn in React Strict Mode.
    };
  }, [startCricketGame]);

  useGameStateSync({
    enabled: !hasNavigatedRef.current,
    refresh: fetchCricketState,
    onStatus: handleDetectionStatus,
    pollMs: 0,
    debounceMs: 120,
  });

  const refreshState = useCallback(async () => {
    await fetchCricketState();
  }, [fetchCricketState]);

  useEffect(() => {
    if (hasNavigatedRef.current) {
      return;
    }
    if (matchWinnerIndex === null || dartCount !== 0 || !cricketState) {
      return;
    }
    hasNavigatedRef.current = true;

    (async () => {
      const summary = cricketState;
      await stopCricketGame();
      navigate("/cricket/stats", {
        state: {
          summary,
          variant: cricketVariant,
          players: playerConfigs,
        },
      });
    })();
  }, [matchWinnerIndex, dartCount, cricketState, cricketVariant, playerConfigs, navigate, stopCricketGame]);

  const handleOpenCorrection = (index: number) => {
    setSelectedDartIndex(index);
    setIsCorrectionModalOpen(true);
  };

  const handleSaveCorrection = async (correction: {
    dartIndex: number;
    multiplier: number;
    segment: number;
    score: number;
  }) => {
    try {
      await correctScore(correction);
      await refreshState();
    } catch (err) {
      console.error("Error correcting score:", err);
      setError(err instanceof Error ? err.message : "Failed to correct score");
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
      await refreshState();
    } catch (err) {
      console.error("Error adding dart:", err);
      setError(err instanceof Error ? err.message : "Failed to add dart");
    }
  };

  const handleDeleteScore = async (dartIndex: number) => {
    try {
      await deleteCorrectionImages(dartIndex);
      await refreshState();
    } catch (err) {
      console.error("Error deleting training images:", err);
    }
  };

  const formatDartScore = (score: DartScore | null, playersForTurn: CricketPlayerState[]): string => {
    if (!score) {
      return "--";
    }

    if (score.score && score.score !== 0) {
      return String(score.score);
    }

    const segmentNumber = Number(score.segment);
    if (!Number.isNaN(segmentNumber)) {
      if (segmentNumber === 25) {
        if (score.multiplier === 2 || score.zone === "inner_bull") {
          return "BULL";
        }
        if (score.multiplier === 1 || score.zone === "outer_bull") {
          return score.multiplier === 1 ? "25" : "BULL";
        }
        return score.multiplier === 1 ? "25" : "BULL";
      }

      const multiplier = score.multiplier ?? 0;
      if (multiplier > 1) {
        return `${segmentNumber}x${multiplier}`;
      }

      if (multiplier === 1) {
        return String(segmentNumber);
      }

      const targetIndex = targets.indexOf(segmentNumber as Target);
      if (targetIndex >= 0) {
        const targetClosed = playersForTurn.every((player) => (player.marks?.[targetIndex] ?? 0) >= 3);
        if (targetClosed) {
          return `Closed ${segmentNumber}`;
        }
      }

      return String(segmentNumber);
    }

    return "Miss";
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

      <GameHeader
        title={
          <>
            Cricket <span className="text-red-500">Match</span>
          </>
        }
        meta={
          cricketState?.match ? (
            <>
              Set {cricketState.match.currentSet} • Leg {cricketState.match.currentLeg} • Best of{" "}
              {cricketState.match.setsToWin} {cricketState.match.setsToWin === 1 ? "Set" : "Sets"}
              {cricketState.match.legsPerSet > 1 && ` (${cricketState.match.legsPerSet} Legs)`}
            </>
          ) : null
        }
        right={
          <>
            {cricketState?.match?.matchWinner == null ? (
              <GameControlButton label="Next Turn" variant="primary" onClick={handleForceNextTurn} />
            ) : null}
            <GameControlButton label="Abort Game" variant="danger" onClick={handleAbort} />
          </>
        }
      />

      <main className="relative z-10 flex-1 px-4 md:px-10 pb-10">
        <div className="max-w-6xl mx-auto mt-6 space-y-6">
          {error && (
            <div className="rounded-xl border border-red-600/60 bg-red-600/10 px-4 py-3 text-sm text-red-200">
              {error}
            </div>
          )}
          {isLoading && (
            <div className="rounded-xl border border-white/10 bg-zinc-900/60 px-4 py-3 text-sm text-zinc-200">
              Initialising cricket match...
            </div>
          )}
          {cricketState?.match?.legWinner !== null && cricketState?.match?.legWinner !== undefined && !cricketState?.match?.matchWinner && (
            <div className="rounded-xl border border-emerald-500/60 bg-emerald-600/15 px-4 py-3 text-sm text-emerald-200 flex items-center justify-between">
              <span className="text-base font-semibold">{getDisplayName(cricketState.match.legWinner)} wins Leg {cricketState.match.currentLeg - 1}!</span>
              <span className="text-xs uppercase tracking-[0.25em] text-emerald-300">Starting next leg...</span>
            </div>
          )}
          {cricketState?.match?.setWinner !== null && cricketState?.match?.setWinner !== undefined && !cricketState?.match?.matchWinner && (
            <div className="rounded-xl border border-blue-500/60 bg-blue-600/15 px-4 py-3 text-sm text-blue-200 flex items-center justify-between">
              <span className="text-base font-semibold">{getDisplayName(cricketState.match.setWinner)} wins Set {cricketState.match.currentSet - 1}!</span>
              <span className="text-xs uppercase tracking-[0.25em] text-blue-300">Starting next set...</span>
            </div>
          )}
          {cricketState?.match?.matchWinner !== null && cricketState?.match?.matchWinner !== undefined && (
            <div className="rounded-xl border border-emerald-500/60 bg-emerald-600/15 px-4 py-3 text-sm text-emerald-200 flex items-center justify-between">
              <span className="text-base font-semibold">{getDisplayName(cricketState.match.matchWinner)} wins the Match!</span>
              <span className="text-xs uppercase tracking-[0.25em] text-emerald-300">
                {cricketState.match.setsToWin > 1 ? `${displayedPlayers[cricketState.match.matchWinner]?.setsWon ?? 0} Sets` : "Victory"}
              </span>
            </div>
          )}
          <div
            className="grid gap-2"
            style={{ gridTemplateColumns: `140px repeat(${displayedPlayers.length}, minmax(0, 1fr))` }}
          >
            <div className="text-xs uppercase tracking-[0.4em] text-zinc-500">Target</div>
            {displayedPlayers.map((player, index) => (
              <div
                key={`${player.name}-${index}`}
                className={`rounded-2xl border px-5 py-4 text-left transition ${
                  activePlayer === index
                    ? detectionState === "removing_darts"
                      ? "border-blue-500 bg-zinc-900/80 ring-2 ring-blue-500"
                      : detectionState === "partial_takeout"
                        ? "border-yellow-400 bg-zinc-900/80 ring-2 ring-yellow-400"
                        : "border-red-500 bg-zinc-900/80 ring-2 ring-red-500"
                    : "border-white/10 bg-zinc-900/50"
                }`}
              >
                <div className="flex items-end justify-between">
                  <div>
                    <div className="text-xs uppercase tracking-widest text-zinc-400">
                      {activePlayer === index ? "Throwing" : "Player"}
                    </div>
                    <div className="text-lg font-semibold text-white">{getDisplayName(index)}</div>
                    {cricketState?.match && (cricketState.match.setsToWin > 1 || cricketState.match.legsPerSet > 1) && (
                      <div className="text-xs text-zinc-500 mt-1">
                        {cricketState.match.setsToWin > 1 && (
                          <span>Sets: {player.setsWon}</span>
                        )}
                        {cricketState.match.setsToWin > 1 && cricketState.match.legsPerSet > 1 && (
                          <span className="mx-1">•</span>
                        )}
                        {cricketState.match.legsPerSet > 1 && (
                          <span>Legs: {player.legsWon}</span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="text-4xl font-extrabold text-red-500 tabular-nums">{player.score}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/40 overflow-hidden shadow-[0_18px_50px_rgba(0,0,0,0.35)]">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-separate [border-spacing:0]">
                <colgroup>
                  <col style={{ width: "140px" }} />
                  {displayedPlayers.map((_, idx) => (
                    <col key={`col-${idx}`} />
                  ))}
                </colgroup>
                <tbody>
                  {targets.map((target, targetIndex) => (
                    <tr key={String(target)} className="odd:bg-black/40 even:bg-black/30 border-b border-white/5">
                      <td className="sticky left-0 bg-inherit px-5 py-3 text-lg font-semibold text-white border-r border-white/10">
                        {target}
                      </td>
                      {displayedPlayers.map((player, playerIndex) => (
                        <td key={`${player.name}-${playerIndex}-${target}`} className="px-3 py-3 border-l border-white/10">
                          <div
                            className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition ${
                              activePlayer === playerIndex
                                ? "border-red-500 bg-zinc-900/70"
                                : "border-white/10 bg-zinc-900/40"
                            }`}
                          >
                            {renderStars(playerIndex, targetIndex)}
                            <span className="ml-3 text-xs text-zinc-400 tabular-nums">
                              {(player.marks?.[targetIndex] ?? 0)} / 3
                            </span>
                          </div>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="max-w-6xl mx-auto grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[0, 1, 2].map((index) => {
              const score = dartScores[index];
              const displayScore = formatDartScore(score, displayedPlayers);
              return (
                <button
                  key={index}
                  type="button"
                  onClick={() => handleOpenCorrection(index)}
                  className={`rounded-2xl border px-4 py-4 text-left transition ${
                    score
                      ? "border-red-600 bg-red-600/20 hover:bg-red-600/30"
                      : "border-white/10 bg-zinc-900/40 hover:border-red-500/60 hover:bg-zinc-900/60"
                  }`}
                  >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs uppercase tracking-widest text-zinc-400">Dart {index + 1}</div>
                      <div className="text-3xl font-bold text-white">{displayScore}</div>
                      {score && (
                        <div className="text-xs text-zinc-300 mt-1">
                          {score.zone !== "single" ? `${score.zone} ` : ""}
                          {score.segment}
                          {score.zone !== "single" && ` (${score.multiplier}x)`}
                        </div>
                      )}
                    </div>
                    <span className="text-xs text-zinc-500">Tap to adjust</span>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="mt-6 grid grid-cols-2 gap-4 text-xs">
            <div className="flex flex-col gap-1">
              <span className="text-zinc-500 uppercase tracking-wider">Turn Status</span>
              <span className="text-white font-semibold">
                {dartScores.filter(d => d !== null).length}/3 darts thrown
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

          <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400 mt-6">
            <span className="inline-flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="h-4 w-4" fill="#d90429" stroke="#d90429">
                <path d="M12 2l3.09 6.26 6.91 1.01-5 4.87 1.18 6.86L12 18.56 5.82 22 7 14.14l-5-4.87 6.91-1.01z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
              </svg>
              Target hit
            </span>
            <span className="inline-flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="h-4 w-4" fill="#fbbf24" stroke="#fbbf24">
                <path d="M12 2l3.09 6.26 6.91 1.01-5 4.87 1.18 6.86L12 18.56 5.82 22 7 14.14l-5-4.87 6.91-1.01z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
              </svg>
              Scoring
            </span>
            <span className="inline-flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="h-4 w-4" fill="#ffffff" stroke="#ffffff">
                <path d="M12 2l3.09 6.26 6.91 1.01-5 4.87 1.18 6.86L12 18.56 5.82 22 7 14.14l-5-4.87 6.91-1.01z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
              </svg>
              Closed
            </span>
            <span className="ml-auto text-zinc-500">Marks update automatically, use correction cards for overrides</span>
          </div>
        </div>
      </main>

      <ScoreCorrection
        isOpen={isCorrectionModalOpen}
        onClose={() => setIsCorrectionModalOpen(false)}
        dartIndex={selectedDartIndex}
        originalScore={selectedDartIndex >= 0 ? dartScores[selectedDartIndex] : null}
        onSaveCorrection={handleSaveCorrection}
        onDeleteImages={handleDeleteScore}
        onAddDart={handleAddDart}
      />
    </div>
  );
}
