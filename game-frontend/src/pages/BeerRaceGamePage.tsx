import React, { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import ScoreCorrection from "../components/ScoreCorrection";
import GamePlayerCard from "../components/player/GamePlayerCard";
import GameHeader from "../components/game/GameHeader";
import { GameControlButton, GameControlLink } from "../components/game/GameControl";
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

// Beer Mug SVG Component
const BeerMug = ({ fillPercentage, size = 96 }: { fillPercentage: number; size?: number }) => {
  const beerHeight = Math.min(100, Math.max(0, fillPercentage)) * 0.8;
  const showFoam = fillPercentage > 90;
  
  return (
    <svg viewBox="0 0 100 120" width={size} height={size * 1.2} className="mx-auto">
      <defs>
        <linearGradient id={`beerGradient-${size}`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#FBBF24" />
          <stop offset="100%" stopColor="#F59E0B" />
        </linearGradient>
      </defs>
      
      {/* Mug body */}
      <path 
        d="M20,20 L20,100 Q20,110 30,110 L70,110 Q80,110 80,100 L80,20 Z" 
        fill="#1a1a1a" 
        stroke="#666" 
        strokeWidth="2"
      />
      
      {/* Beer fill */}
      <rect 
        x="22" 
        y={100 - beerHeight} 
        width="56" 
        height={beerHeight} 
        fill={`url(#beerGradient-${size})`}
        className="transition-all duration-500 ease-out"
      />
      
      {/* Foam head */}
      {showFoam && (
        <>
          <ellipse 
            cx="50" 
            cy={100 - beerHeight} 
            rx="28" 
            ry="5" 
            fill="#FFF" 
            opacity="0.9"
          />
          <ellipse 
            cx="50" 
            cy={100 - beerHeight - 3} 
            rx="24" 
            ry="4" 
            fill="#FFF" 
            opacity="0.7"
            className="animate-pulse"
          />
        </>
      )}
      
      {/* Handle */}
      <path 
        d="M80,40 Q95,40 95,60 Q95,80 80,80" 
        fill="none" 
        stroke="#666" 
        strokeWidth="3"
      />
      
      {/* Percentage text */}
      <text 
        x="50" 
        y="115" 
        textAnchor="middle" 
        fontSize="10" 
        fill="#999"
        fontWeight="bold"
      >
        {Math.round(fillPercentage)}%
      </text>
    </svg>
  );
};

// Player Card Component
const PlayerCard = React.memo(({
  player,
  index,
  isActive,
  isWinner,
}: {
  player: BeerRacePlayerState;
  index: number;
  isActive: boolean;
  isWinner: boolean;
}) => {
  const totalScored = player?.totalScored || 0;
  const targetScore = player?.targetScore || 301;
  const fillPercentage = (totalScored / targetScore) * 100;
  const statusLabel = isWinner ? "Winner" : isActive ? "Throwing" : "Player";
  const variant = isWinner ? "winner" : isActive ? "active" : "default";

  return (
    <GamePlayerCard
      variant={variant}
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
      main={<div className="text-5xl font-extrabold text-red-500 tabular-nums">{totalScored}</div>}
      mainRight={<BeerMug fillPercentage={fillPercentage} size={220} />}
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
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionDartIndex, setCorrectionDartIndex] = useState(0);
  const [correctionOriginalScore, setCorrectionOriginalScore] = useState<DartScore | null>(null);
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

  // Navigate to stats page when match is complete
  useEffect(() => {
    if (!gameState) return;
    if (hasNavigatedRef.current) return;
    
    const matchWinnerIndex = gameState.matchWinnerIndex;
    if (matchWinnerIndex !== null && matchWinnerIndex !== undefined) {
      hasNavigatedRef.current = true;
      // Stop polling
        
      // Navigate to stats page
      navigate("/beer-race/stats", {
        state: gameState,
      });
    }
  }, [gameState, navigate, lobbyState]);

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

  useGameStateSync({
    enabled: Boolean(gameState) && !hasNavigatedRef.current,
    refresh: fetchState,
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
            <DiagnosticsDebugButton game="beer_race" />
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
              isWinner={index === gameState.winnerIndex}
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
