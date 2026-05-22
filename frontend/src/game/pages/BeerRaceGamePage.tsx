import React, { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import ScoreCorrection from "../components/ScoreCorrection";
import GamePlayerCard from "../components/player/GamePlayerCard";
import GameHeader from "../components/game/GameHeader";
import { GameControlButton, GameControlLink } from "../components/game/GameControl";
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

interface LocationState extends Partial<LobbyState> {}

interface BeerRacePlayerState {
  name: string;
  totalScored: number;
  dartsThrown: number;
  visits: number;
  bestVisit: number;
  ppr: number;
  targetScore: number;
  remaining: number;
  legsWon: number;
  setsWon: number;
  bucketCounts: {
    "40plus": number;
    "60plus": number;
    "80plus": number;
    "100plus": number;
    "120plus": number;
    "140plus": number;
    "170plus": number;
    "180": number;
  };
  finished: boolean;
  isBot?: boolean;
  botLevel?: number;
}

interface BeerRaceState {
  mode: "beer_race";
  targetScore: number;
  players: BeerRacePlayerState[];
  currentPlayer: number;
  currentTurn: {
    darts: (DartScore | null)[];
    scores: number[];
    turnTotal: number;
    remaining: number;
  };
  lastTurn: (DartScore | null)[];
  winnerIndex: number | null;
  legWinnerIndex: number | null;
  setWinnerIndex: number | null;
  matchWinnerIndex: number | null;
}

const BEER_FILL_MILESTONES = [0, 25, 50, 75, 100] as const;

const getReachedBeerMilestone = (fillPercentage: number) => {
  for (let i = BEER_FILL_MILESTONES.length - 1; i >= 0; i -= 1) {
    if (fillPercentage >= BEER_FILL_MILESTONES[i]) {
      return BEER_FILL_MILESTONES[i];
    }
  }
  return 0;
};

const BeerFillVideo = ({
  fillPercentage,
  playFullReplay,
  onWinnerReplayComplete,
  size = 220,
}: {
  fillPercentage: number;
  playFullReplay: boolean;
  onWinnerReplayComplete?: () => void;
  size?: number;
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastMilestoneRef = useRef<number | null>(null);
  const targetEndTimeRef = useRef<number | null>(null);
  const winnerPlayedRef = useRef(false);
  const winnerCompleteRef = useRef(false);
  const clampedFill = Math.min(100, Math.max(0, fillPercentage));

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const notifyWinnerComplete = () => {
      if (!playFullReplay || winnerCompleteRef.current) return;
      winnerCompleteRef.current = true;
      onWinnerReplayComplete?.();
    };

    const handleTimeUpdate = () => {
      const targetEnd = targetEndTimeRef.current;
      if (targetEnd === null) return;
      if (video.currentTime >= targetEnd - 0.03) {
        video.pause();
        video.currentTime = targetEnd;
        targetEndTimeRef.current = null;
        notifyWinnerComplete();
      }
    };

    const handleEnded = () => notifyWinnerComplete();

    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("ended", handleEnded);
    return () => {
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("ended", handleEnded);
    };
  }, [playFullReplay, onWinnerReplayComplete]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const playSegment = (startPercent: number, endPercent: number) => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) return;
      const startTime = (startPercent / 100) * video.duration;
      const endTime = (endPercent / 100) * video.duration;
      targetEndTimeRef.current = endTime;
      video.currentTime = startTime;
      void video.play().catch(() => {
        targetEndTimeRef.current = null;
        video.currentTime = endTime;
        if (playFullReplay) {
          window.setTimeout(() => onWinnerReplayComplete?.(), 1200);
        }
      });
    };

    const syncMilestone = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) return;

      if (playFullReplay && !winnerPlayedRef.current) {
        winnerPlayedRef.current = true;
        lastMilestoneRef.current = 100;
        playSegment(0, 100);
        return;
      }

      if (lastMilestoneRef.current === null) {
        const initialMilestone = getReachedBeerMilestone(clampedFill);
        lastMilestoneRef.current = initialMilestone;
        video.currentTime = (initialMilestone / 100) * video.duration;
        video.pause();
        return;
      }

      const reachedMilestone = getReachedBeerMilestone(clampedFill);
      if (reachedMilestone > lastMilestoneRef.current) {
        const previousMilestone = lastMilestoneRef.current;
        lastMilestoneRef.current = reachedMilestone;
        playSegment(previousMilestone, reachedMilestone);
      }
    };

    syncMilestone();
    video.addEventListener("loadedmetadata", syncMilestone);
    return () => video.removeEventListener("loadedmetadata", syncMilestone);
  }, [clampedFill, playFullReplay, onWinnerReplayComplete]);

  return (
    <div
      className="relative mx-auto overflow-hidden rounded-lg border border-amber-300/20 bg-black shadow-[0_0_32px_rgba(251,191,36,0.16)]"
      style={{ width: size, height: Math.round(size * 1.18) }}
    >
      <video
        ref={videoRef}
        className="h-full w-full object-cover"
        src="/media/beer.mp4"
        muted
        playsInline
        preload="metadata"
      >
        <track kind="captions" />
      </video>
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.16),transparent_18%,transparent_72%,rgba(255,255,255,0.08))]" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/55 to-transparent h-16" />
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-black/30 bg-black/70 px-3 py-1 text-xs font-bold tabular-nums text-amber-100">
        {Math.round(clampedFill)}%
      </div>
    </div>
  );
};

// Player Card Component
const PlayerCard = React.memo(({
  player,
  index,
  isActive,
  isWinner,
  playWinnerReplay,
  detectionState,
  onWinnerReplayComplete,
}: {
  player: BeerRacePlayerState;
  index: number;
  isActive: boolean;
  isWinner: boolean;
  playWinnerReplay: boolean;
  detectionState?: string;
  onWinnerReplayComplete?: () => void;
}) => {
  const totalScored = player?.totalScored || 0;
  const targetScore = player?.targetScore || 301;
  const fillPercentage = (totalScored / targetScore) * 100;
  const statusLabel = isWinner ? "Winner" : isActive ? "Throwing" : "Player";
  const variant = isWinner ? "winner" : isActive ? "active" : "default";

  return (
    <GamePlayerCard
      variant={variant}
      detectionState={detectionState}
      statusLabel={statusLabel}
      headerRight={<>PPR {(player?.ppr || 0).toFixed(2)}</>}
      title={
        <>
          {player?.name || "Player"}
          {player?.isBot && <span className="ml-2 text-xs text-zinc-400">(Bot L{player.botLevel})</span>}
        </>
      }
      subtitle={
        <div className="flex items-center gap-2">
          <span>Target: {targetScore}</span>
          <span>•</span>
          <span>Scored: {totalScored}</span>
          <span>•</span>
          <span>Remaining: {Math.max(0, targetScore - totalScored)}</span>
        </div>
      }
      main={
        <div className="relative flex w-full justify-center py-1">
          <BeerFillVideo
            fillPercentage={fillPercentage}
            playFullReplay={playWinnerReplay}
            onWinnerReplayComplete={onWinnerReplayComplete}
            size={310}
          />
          <div className="absolute left-0 top-1/2 -translate-y-1/2 text-5xl font-extrabold text-red-500 tabular-nums">
            {totalScored}
          </div>
        </div>
      }
      mainClassName="w-full"
      stats={[
        { label: "Legs Won", value: player?.legsWon || 0 },
        { label: "Sets Won", value: player?.setsWon || 0, align: "right" },
        { label: "PPR", value: (player?.ppr || 0).toFixed(2) },
        { label: "Darts", value: player?.dartsThrown || 0, align: "right" },
      ]}
    />
  );
});

PlayerCard.displayName = 'PlayerCard';

export default function BeerRaceGamePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const lobbyState = location.state as LocationState | null;
  
  const [gameState, setGameState] = useState<BeerRaceState | null>(null);
  const [detectionState, setDetectionState] = useState<string>("no_movement");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionDartIndex, setCorrectionDartIndex] = useState(0);
  const [correctionOriginalScore, setCorrectionOriginalScore] = useState<DartScore | null>(null);
  const [winnerReplayComplete, setWinnerReplayComplete] = useState(false);
  const gameStartedRef = useRef(false);
  const hasNavigatedRef = useRef(false);

  // Start game
  useEffect(() => {
    const startGame = async () => {
      if (!lobbyState) {
        setError("No lobby configuration found");
        setIsLoading(false);
        return;
      }

      try {
        // Extract values from lobbyState like X01 does
        const legsPerSet = Number(lobbyState.match?.legs ?? 1);
        const setsToWin = Number(lobbyState.match?.sets ?? 1);
        
        const requestBody = {
          players: lobbyState.players?.map((player, index) => ({
            name: player.name || `Player ${index + 1}`,
            isBot: player.isBot,
            botLevel: player.botLevel,
            profileId: player.profileId,
          })) || [],
          targetScore: lobbyState.beerRace?.targetScore || 301,
          startingPlayer: Number(lobbyState.startingPlayer ?? 0),
          legsPerSet,
          setsToWin,
        };
        
        console.log("🍺 Frontend sending:", requestBody);
        console.log("🍺 lobbyState.match:", lobbyState.match);
        console.log("🍺 legsPerSet:", legsPerSet, "setsToWin:", setsToWin);
        
        const data = await apiStartGame<BeerRaceState>("beer_race", requestBody);
        setGameState(data);
        setIsLoading(false);
        
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to start game");
        setIsLoading(false);
      }
    };

    if (!gameStartedRef.current) {
      gameStartedRef.current = true;
      startGame();
    }
  }, [lobbyState]);

  const matchWinnerIndex = gameState?.matchWinnerIndex ?? null;
  const isWaitingForWinnerReplay = matchWinnerIndex !== null && !winnerReplayComplete;

  useEffect(() => {
    if (matchWinnerIndex === null) {
      setWinnerReplayComplete(false);
    }
  }, [matchWinnerIndex]);

  // Navigate to stats page after the winner beer replay has completed.
  useEffect(() => {
    if (!gameState) return;
    if (hasNavigatedRef.current) return;

    if (matchWinnerIndex !== null && winnerReplayComplete) {
      hasNavigatedRef.current = true;
      navigate("/beer-race/stats", {
        state: gameState,
      });
    }
  }, [gameState, matchWinnerIndex, navigate, winnerReplayComplete]);

  useEffect(() => {
    if (matchWinnerIndex === null || winnerReplayComplete) return;
    const fallback = window.setTimeout(() => {
      setWinnerReplayComplete(true);
    }, 12000);
    return () => window.clearTimeout(fallback);
  }, [matchWinnerIndex, winnerReplayComplete]);

  const fetchState = useCallback(async () => {
    try {
      const data = await apiGetGameState<BeerRaceState>("beer_race");
      if (data.mode === "beer_race") {
        setGameState(data);
      }
    } catch (err) {
      console.error("State sync error:", err);
    }
  }, []);

  const handleDetectionStatus = useCallback(
    ({ detectionState: nextDetectionState }: { detectionState?: string }) => {
      if (typeof nextDetectionState === "string") {
        setDetectionState(nextDetectionState);
      }
    },
    []
  );

  useGameStateSync({
    enabled: Boolean(gameState) && !hasNavigatedRef.current && !isWaitingForWinnerReplay,
    refresh: fetchState,
    onStatus: handleDetectionStatus,
    pollMs: 0,
    debounceMs: 120,
  });


  const handleAbort = useCallback(async () => {
    const summary = await (async () => {
      try {
        return await apiGetGameState<BeerRaceState>("beer_race");
      } catch {
        return gameState;
      }
    })();

    try {
      await apiStopGame("beer_race");
    } catch {
      /* ignore */
    }
    navigate("/beer-race/stats", { state: summary ?? gameState });
  }, [gameState, navigate]);

  const refreshState = fetchState;

  const handleCompleteTurn = async () => {
    try {
      const data = await apiForceNextTurn<BeerRaceState>("beer_race");
      if (data) {
        setGameState(data);
      } else {
        await refreshState();
      }
    } catch (err) {
      console.error("Failed to complete turn:", err);
    }
  };

  const handleCorrectScore = async (correction: {
    dartIndex: number;
    multiplier: number;
    segment: number;
    score: number;
  }) => {
    try {
      await correctScore(correction);
      await refreshState();
    } catch (err) {
      console.error("Failed to correct score:", err);
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
      console.error("Failed to add dart:", err);
    }
  };

  const openCorrection = (dartIndex: number, originalScore: DartScore | null) => {
    setCorrectionDartIndex(dartIndex);
    setCorrectionOriginalScore(originalScore);
    setCorrectionOpen(true);
  };

  const handleEndGame = () => {
    navigate("/beer-race/stats", { state: gameState });
  };

  if (isLoading) {
    return (
      <div className="min-h-screen w-full bg-black text-white flex items-center justify-center">
        <div className="text-center">
          <div className="text-2xl font-bold mb-4">Starting Beer Race...</div>
          <div className="text-zinc-400">🍺 Preparing your mugs</div>
        </div>
      </div>
    );
  }

  if (error || !gameState) {
    return (
      <div className="min-h-screen w-full bg-black text-white flex items-center justify-center">
        <div className="text-center">
          <div className="text-2xl font-bold mb-4 text-red-500">Error</div>
          <div className="text-zinc-400">{error || "Failed to load game"}</div>
          <div className="mt-6 flex justify-center">
            <GameControlLink to="/lobby" label="Lobby" variant="danger" />
          </div>
        </div>
      </div>
    );
  }

  // Safety check - ensure gameState has required properties
  if (!gameState || !gameState.players || !Array.isArray(gameState.players)) {
    return (
      <div className="min-h-screen w-full bg-black text-white flex items-center justify-center">
        <div className="text-center">
          <div className="text-2xl font-bold mb-4">Loading game...</div>
          <div className="text-zinc-400">🍺 Preparing Beer Race</div>
        </div>
      </div>
    );
  }

  const currentPlayer = gameState.players?.[gameState.currentPlayer];
  const isGameOver = gameState.matchWinnerIndex !== null;

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden">
      {/* Background */}
      <div className="pointer-events-none fixed inset-0 [background:radial-gradient(ellipse_at_top,rgba(220,38,38,0.15),transparent_50%),linear-gradient(to_bottom,rgba(0,0,0,0.95),rgba(0,0,0,1))]" />

      {/* Header */}
      <GameHeader
        title={
          <>
            Beer <span className="text-red-500">Race</span>
          </>
        }
        subtitle={<>Target {gameState.targetScore}</>}
        right={
          <>
            {!isGameOver ? <GameControlButton label="Next Turn" variant="primary" onClick={handleCompleteTurn} /> : null}
            <GameControlButton label="Abort Game" variant="danger" onClick={handleAbort} />
          </>
        }
      />

      {/* Main Content */}
      <main className="relative z-10 px-6 py-6 max-w-7xl mx-auto">
        {/* Player Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-6">
          {gameState.players?.map((player, index) => (
            <PlayerCard
              key={index}
              player={player}
              index={index}
              isActive={index === gameState.currentPlayer && !isGameOver}
              isWinner={index === gameState.winnerIndex || index === matchWinnerIndex}
              playWinnerReplay={index === matchWinnerIndex && isWaitingForWinnerReplay}
              detectionState={detectionState}
              onWinnerReplayComplete={
                index === matchWinnerIndex ? () => setWinnerReplayComplete(true) : undefined
              }
            />
          )) || <div className="text-zinc-400">Loading players...</div>}
        </div>

        {/* Current Turn Display */}
        {!isGameOver && currentPlayer && gameState.currentTurn && (
          <div className="bg-zinc-900/60 border border-white/10 rounded-2xl p-6 mb-6">
            <div className="text-center mb-4">
              <div className="text-sm text-zinc-400">Current Player</div>
              <div className="text-2xl font-bold text-white">{currentPlayer?.name || "Player"}</div>
            </div>

            {/* Dart Slots */}
            <div className="flex justify-center gap-4 mb-4">
              {[0, 1, 2].map((dartIndex) => {
                const dart = gameState.currentTurn?.darts?.[dartIndex];
                const score = gameState.currentTurn?.scores?.[dartIndex] || 0;
                
                return (
                  <button
                    key={dartIndex}
                    onClick={() => openCorrection(dartIndex, dart)}
                    className="w-20 h-20 sm:w-24 sm:h-24 rounded-xl border-2 border-white/20 bg-black/40 hover:bg-black/60 transition flex flex-col items-center justify-center"
                  >
                    <div className="text-xs text-zinc-500 mb-1">Dart {dartIndex + 1}</div>
                    <div className="text-2xl font-bold text-white">
                      {dart ? score : "--"}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Turn Total */}
            <div className="text-center mb-4">
              <div className="text-sm text-zinc-400">Turn Total</div>
              <div className="text-4xl font-extrabold text-white">
                {gameState.currentTurn?.turnTotal || 0}
              </div>
            </div>

          </div>
        )}

        {/* Game Over */}
        {isGameOver && gameState.winnerIndex !== null && (
          <div className="bg-emerald-900/40 border border-emerald-500/50 rounded-2xl p-8 text-center">
            <div className="text-6xl mb-4">🏆</div>
            <div className="text-3xl font-extrabold text-emerald-400 mb-2">
              {gameState.players[gameState.winnerIndex].name} Wins!
            </div>
            <div className="text-zinc-400 mb-6">
              Final Score: {gameState.players[gameState.winnerIndex].totalScored}
            </div>
            <button
              onClick={handleEndGame}
              className="px-8 py-3 bg-emerald-600 hover:bg-emerald-700 rounded-lg font-semibold transition"
            >
              View Stats
            </button>
          </div>
        )}
      </main>

      {/* Score Correction Modal */}
      <ScoreCorrection
        isOpen={correctionOpen}
        onClose={() => setCorrectionOpen(false)}
        dartIndex={correctionDartIndex}
        originalScore={correctionOriginalScore}
        onSaveCorrection={handleCorrectScore}
        onDeleteImages={() => {}}
        onAddDart={handleAddDart}
      />
    </div>
  );
}
