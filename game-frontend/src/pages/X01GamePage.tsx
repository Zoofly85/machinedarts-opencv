import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import ScoreCorrection from "../components/ScoreCorrection";
import GamePlayerCard from "../components/player/GamePlayerCard";
import GameHeader from "../components/game/GameHeader";
import { GameControlButton } from "../components/game/GameControl";
import DiagnosticsDebugButton from "../components/game/DiagnosticsDebugButton";
import type { LobbyState, PlayerConfig } from "../context/LobbyContext";
import { addDart, correctScore, deleteCorrectionImages } from "../services/correctionApi";
import { startGame as apiStartGame, getGameState as apiGetGameState, stopGame as apiStopGame, forceNextTurn as apiForceNextTurn } from "../services/gameApi";
import { useGameStateSync } from "../services/useGameStateSync";

const API_URL = "http://localhost:8000";

interface CheckoutSuggestion {
  target: string;
  field: string;
  number: number;
  remaining: number;
}

interface DartScore {
  score: number;
  multiplier: number;
  segment: string;
  zone: string;
  confidence: number;
}

interface LocationState extends Partial<LobbyState> {}

interface X01PlayerStateBackend {
  name: string;
  score: number;
  startingScore: number;
  hasIn: boolean;
  inMode: string;
  outMode: string;
  dartsThrown: number;
  totalScored: number;
  average: number;
  firstNineAverage: number;
  legsWon: number;
  setsWon: number;
  isBot?: boolean;
  botLevel?: number;
}

interface X01TurnState {
  darts: (DartScore | null)[];
  appliedScores: number[];
  scored: number;
  remaining: number;
  bust: boolean;
  finished: boolean;
  dartsUsed: number;
  scoreBefore: number;
  hasInBefore: boolean;
  hasInAfter: boolean;
  turnIndex?: number;
}

interface X01TurnHistoryEntry extends X01TurnState {
  playerIndex: number;
  turnIndex: number;
}

interface X01TeamState {
  teamId: number;
  teamName: string;
  playerIndices: number[];
  score: number;
  startingScore: number;
  legsWon: number;
  setsWon: number;
  teamColor?: string;
}

interface X01State {
  settings: {
    startScore: number;
    inMode: string;
    outMode: string;
    legsPerSet: number;
    setsToWin: number;
    freePlay?: boolean;
    gameVariant?: "standard" | "last_man_standing" | "team_play";
  };
  match: {
    currentSet: number;
    currentLeg: number;
    legWinner: number | null;
    setWinner: number | null;
    matchWinner: number | null;
  };
  lms?: {
    totalLegs: number;
    currentLeg: number;
    playerPoints: number[];
    legResults: number[][];
    finishOrder: number[];
    matchComplete: boolean;
  };
  teams?: X01TeamState[];
  currentPlayer: number | null;
  players: X01PlayerStateBackend[];
  currentTurn: X01TurnState;
  lastCompletedTurn: (DartScore | null)[];
  lastTurn: X01TurnHistoryEntry | null;
  turnHistory: X01TurnHistoryEntry[];
  winner: number | null;
  legWinner: number | null;
  setWinner: number | null;
  matchWinner: number | null;
}

function isInnerBull(dart: DartScore | null): boolean {
  if (!dart) {
    return false;
  }
  if (dart.zone === "inner_bull") {
    return true;
  }
  return dart.segment === "25" && Math.round(dart.score) === 50;
}

function isDouble(dart: DartScore | null): boolean {
  if (!dart) {
    return false;
  }
  if (isInnerBull(dart)) {
    return true;
  }
  return dart.zone === "double" || dart.multiplier === 2;
}

function isTriple(dart: DartScore | null): boolean {
  if (!dart) {
    return false;
  }
  return dart.zone === "triple" || dart.multiplier === 3;
}

function formatDartLabel(dart: DartScore | null): string {
  if (!dart) {
    return "--";
  }
  if (isInnerBull(dart)) {
    return "BULL";
  }
  // Check for outer bull by zone or segment
  if (dart.zone === "outer_bull" || (dart.segment === "25" && dart.score === 25)) {
    return "25";
  }
  if (isTriple(dart)) {
    return `T${dart.segment}`;
  }
  if (isDouble(dart)) {
    return dart.segment === "25" ? "BULL" : `D${dart.segment}`;
  }
  if (dart.segment === "25") {
    return "25";
  }
  if (dart.score === 0 || dart.zone === "miss") {
    return "MISS";
  }
  return dart.segment;
}

function formatAppliedScore(value: number): string {
  return value === 0 ? "0" : String(value);
}

const DartboardSVG = React.memo(({ className = "", size = 340 }: { className?: string; size?: number }) => {
  const segments = useMemo(() => Array.from({ length: 20 }), []);
  const ringColors = {
    singleDark: "#111111",
    singleLight: "#222222",
    doubleRed: "#d90429",
    doubleGreen: "#2ec27e",
    trebleRed: "#d90429",
    trebleGreen: "#2ec27e",
    bull: "#2ec27e",
    bullseye: "#d90429",
    white: "#f8fafc",
    black: "#0b0b0b",
  } as const;

  const R = {
    outer: 100,
    doubleOuter: 85,
    doubleInner: 79,
    singleOuter: 66,
    trebleOuter: 54,
    trebleInner: 47,
    singleInner: 34,
    bullOuter: 12.7,
    bullInner: 6.35,
  } as const;

  const order = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
  const seg = (Math.PI * 2) / 20;
  const rotationOffset = -Math.PI / 20;

  const Wedge = ({ r1, r2, a0, a1, fill }: { r1: number; r2: number; a0: number; a1: number; fill: string }) => {
    const toXY = (r: number, a: number) => [r * Math.cos(a), r * Math.sin(a)];
    const [x0, y0] = toXY(r1, a0);
    const [x1, y1] = toXY(r1, a1);
    const [x2, y2] = toXY(r2, a1);
    const [x3, y3] = toXY(r2, a0);
    const largeArc = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
    const sweep = 1;
    const d = [
      `M ${x0} ${y0}`,
      `A ${r1} ${r1} 0 ${largeArc} ${sweep} ${x1} ${y1}`,
      `L ${x2} ${y2}`,
      `A ${r2} ${r2} 0 ${largeArc} ${sweep ^ 1} ${x3} ${y3}`,
      "Z",
    ].join(" ");
    return <path d={d} fill={fill} />;
  };

  return (
    <svg className={className} viewBox="-110 -110 220 220" width={size} height={size}>
      <circle r={R.outer} fill={ringColors.black} />
      {segments.map((_, i) => {
        const a0 = rotationOffset - Math.PI / 2 + i * seg;
        const a1 = a0 + seg;
        const isLight = i % 2 === 0;
        return (
          <g key={`singles-${i}`}>
            <Wedge r1={R.bullOuter} r2={R.trebleInner} a0={a0} a1={a1} fill={isLight ? ringColors.singleLight : ringColors.singleDark} />
            <Wedge r1={R.trebleOuter} r2={R.doubleInner} a0={a0} a1={a1} fill={isLight ? ringColors.singleLight : ringColors.singleDark} />
          </g>
        );
      })}
      {segments.map((_, i) => {
        const a0 = rotationOffset - Math.PI / 2 + i * seg;
        const a1 = a0 + seg;
        const fill = i % 2 === 0 ? ringColors.doubleRed : ringColors.doubleGreen;
        return <Wedge key={`double-${i}`} r1={R.doubleInner} r2={R.doubleOuter} a0={a0} a1={a1} fill={fill} />;
      })}
      {segments.map((_, i) => {
        const a0 = rotationOffset - Math.PI / 2 + i * seg;
        const a1 = a0 + seg;
        const fill = i % 2 === 0 ? ringColors.trebleGreen : ringColors.trebleRed;
        return <Wedge key={`treble-${i}`} r1={R.trebleInner} r2={R.trebleOuter} a0={a0} a1={a1} fill={fill} />;
      })}
      <circle r={R.bullOuter} fill={ringColors.bull} />
      <circle r={R.bullInner} fill={ringColors.bullseye} />
      <circle r={R.outer} fill="none" stroke="#0b0b0b" strokeWidth={2} />
      {segments.map((_, i) => {
        const a = rotationOffset - Math.PI / 2 + i * seg + seg / 2;
        const r = 94;
        const x = r * Math.cos(a);
        const y = r * Math.sin(a);
        return (
          <text key={`n-${i}`} x={x} y={y + 3} textAnchor="middle" fontSize={8} fill={ringColors.white}>
            {order[i]}
          </text>
        );
      })}
    </svg>
  );
});

DartboardSVG.displayName = 'DartboardSVG';

// Memoized PlayerCard component to prevent unnecessary re-renders
const PlayerCard = React.memo(({
  player,
  index,
  isActive,
  isWinner,
  getDisplayName
}: {
  player: X01PlayerStateBackend;
  index: number;
  isActive: boolean;
  isWinner: boolean;
  getDisplayName: (index: number) => string;
}) => {
  const statusLabel = isWinner ? "Winner" : isActive ? "Throwing" : "Player";
  const variant = isWinner ? "winner" : isActive ? "active" : "default";

  return (
    <GamePlayerCard
      variant={variant}
      statusLabel={statusLabel}
      headerRight={<>Avg {player.average.toFixed(2)}</>}
      title={getDisplayName(index)}
      subtitle={
        <div className="flex items-center gap-2">
          <span>{player.startingScore}</span>
          <span>•</span>
          <span>
            In: {player.inMode === "straight" ? "Straight" : player.inMode === "double" ? "Double" : "Master"}
          </span>
          <span>•</span>
          <span>
            Out: {player.outMode === "straight" ? "Straight" : player.outMode === "double" ? "Double" : "Master"}
          </span>
        </div>
      }
      main={<div className="text-5xl font-extrabold text-red-500 tabular-nums">{player.score}</div>}
      stats={[
        { label: "Legs Won", value: player.legsWon || 0 },
        { label: "Sets Won", value: player.setsWon || 0, align: "right" },
        { label: "Average", value: player.average.toFixed(2) },
        { label: "Darts", value: player.dartsThrown, align: "right" },
      ]}
    />
  );
});

PlayerCard.displayName = 'PlayerCard';

export default function X01GamePage() {
  const navigate = useNavigate();
  const { state } = useLocation() as { state?: LocationState };

  const startScoreValue = Number(state?.x01?.startScore ?? 501);
  const startScore = Number.isFinite(startScoreValue) && startScoreValue > 0 ? startScoreValue : 501;
  const startingPlayer = Number(state?.startingPlayer ?? 0);
  const inMode = (state?.x01?.inMode ?? "straight").toLowerCase();
  const outMode = (state?.x01?.outMode ?? "double").toLowerCase();
  const legsPerSet = Number(state?.match?.legs ?? 3);
  const setsToWin = Number(state?.match?.sets ?? 1);
  const freePlay = Boolean(state?.match?.freePlay);
  const gameVariant = state?.x01?.gameVariant ?? "standard";
  const lmsTotalLegs = Number(state?.x01?.lmsTotalLegs ?? 3);
  const teams = state?.x01?.teams ?? [];

  const playerConfigs: PlayerConfig[] = useMemo(() => {
    const rawPlayers = state?.players;
    if (Array.isArray(rawPlayers) && rawPlayers.length > 0) {
      return rawPlayers.map((player, index) => ({
        name: player?.name?.trim() || `Player ${index + 1}`,
        isBot: Boolean(player?.isBot),
        botLevel: player?.botLevel,
        profileId: player?.profileId,
        x01Settings: player?.x01Settings,
      }));
    }
    return [
      { name: "Player 1", isBot: false, profileId: undefined },
      { name: "Player 2", isBot: false, profileId: undefined },
    ];
  }, [state?.players]);

  const [x01State, setX01State] = useState<X01State | null>(null);
  const [dartCount, setDartCount] = useState(0);
  const [detectionState, setDetectionState] = useState<string>("no_movement");
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isCorrectionModalOpen, setIsCorrectionModalOpen] = useState(false);
  const [selectedDartIndex, setSelectedDartIndex] = useState(-1);
  const [checkoutSuggestions, setCheckoutSuggestions] = useState<(string | null)[]>([null, null, null]);
  const [showCelebration, setShowCelebration] = useState(false);
  const [celebrationType, setCelebrationType] = useState<'leg' | 'match'>('leg');
  const [pendingCelebrationWinner, setPendingCelebrationWinner] = useState<number | null>(null);
  const celebrationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasNavigatedRef = useRef(false);
  const gameStartedRef = useRef(false);
  const lastWinnerRef = useRef<number | null>(null);
  const isStoppingRef = useRef(false);

  const fetchX01State = useCallback(async () => {
    // Don't fetch if we're stopping/navigating
    if (isStoppingRef.current || hasNavigatedRef.current) {
      return null;
    }
    
    try {
      const data = await apiGetGameState<X01State>("x01");
      setX01State(data);
      return data;
    } catch (err) {
      console.error("Error fetching X01 state:", err);
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Failed to fetch X01 state");
      }
      return null;
    }
  }, []);

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

  const fetchCheckoutSuggestions = useCallback(async (playerIndex: number, remaining: number, dartsThrown: number) => {
    if (remaining > 170 || remaining <= 0) {
      setCheckoutSuggestions([null, null, null]);
      return;
    }

    try {
      // Fetch suggestions only for darts that haven't been thrown yet
      const suggestions: (string | null)[] = [null, null, null];
      let currentRemaining = remaining;

      for (let i = dartsThrown; i < 3; i++) {
        if (currentRemaining <= 0 || currentRemaining > 170) {
          suggestions[i] = null;
          continue;
        }

        const response = await fetch(
          `${API_URL}/api/x01/checkout-suggestion?player_index=${playerIndex}&remaining=${currentRemaining}&out_mode=${outMode}`
        );
        
        if (!response.ok) {
          suggestions[i] = null;
          continue;
        }

        const data: CheckoutSuggestion = await response.json();
        suggestions[i] = data.target;

        // Calculate what would remain after hitting this target
        const targetScore = data.field === "T" ? data.number * 3 :
                           data.field === "D" ? data.number * 2 :
                           data.number;
        currentRemaining -= targetScore;
      }

      setCheckoutSuggestions(suggestions);
    } catch (err) {
      console.error("Error fetching checkout suggestions:", err);
      setCheckoutSuggestions([null, null, null]);
    }
  }, [outMode]);

  const startX01Game = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const requestBody: any = {
        players: playerConfigs.map((player, index) => ({
          name: player.name || `Player ${index + 1}`,
          isBot: player.isBot,
          botLevel: player.botLevel,
          profileId: player.profileId,
          x01Settings: player.x01Settings,
        })),
        startScore,
        inMode,
        outMode,
        startingPlayer,
        legsPerSet,
        setsToWin,
        freePlay,
        gameVariant,
        lmsTotalLegs,
      };

      // Add teams if in team play mode
      if (gameVariant === "team_play" && teams.length > 0) {
        requestBody.teams = teams.map(team => ({
          teamId: team.teamId,
          teamName: team.teamName,
          playerIndices: team.playerIndices,
        }));
      }

      const data = await apiStartGame<X01State>("x01", requestBody);
      setX01State(data);
      
      // Reset detection to clear dart count for new game
      await fetch(`${API_URL}/api/detection/reset`, { method: "POST" }).catch(() => undefined);
      setDartCount(0);
    } catch (err) {
      console.error("Error starting X01 game:", err);
      setError(err instanceof Error ? err.message : "Failed to start X01 game");
    } finally {
      setIsLoading(false);
    }
  }, [playerConfigs, startScore, startingPlayer, inMode, outMode, legsPerSet, setsToWin, gameVariant, lmsTotalLegs, teams, fetchX01State]);

  const stopX01Game = useCallback(async () => {
    try {
      await apiStopGame("x01");
    } catch (err) {
      console.error("Error stopping X01 game:", err);
    }
  }, []);

  useEffect(() => {
    // Only start the game once
    if (!gameStartedRef.current) {
      gameStartedRef.current = true;
      startX01Game();
    }

    // Cleanup only on actual unmount (not in Strict Mode double-render)
    return () => {
      // Don't stop the game here - it will be stopped by navigation effect or abort button
      // Stopping here causes issues in React Strict Mode
    };
  }, [startX01Game]);

  useGameStateSync({
    refresh: fetchX01State,
    onStatus: handleDetectionStatus,
    pollMs: 0,
    debounceMs: 120,
  });

  // Navigate to stats page when match is complete
  useEffect(() => {
    if (hasNavigatedRef.current || isStoppingRef.current) {
      return;
    }
    const matchWinner = x01State?.matchWinner ?? x01State?.match?.matchWinner;
    // Changed: Remove dartCount check so celebration triggers immediately when winner detected
    if (matchWinner === null || matchWinner === undefined || !x01State) {
      return;
    }
    // Only navigate after darts are removed
    if (dartCount !== 0) {
      return;
    }
    hasNavigatedRef.current = true;
    isStoppingRef.current = true;
    const summary = x01State;
    
    (async () => {
      await stopX01Game();
      navigate("/x01/stats", {
        state: {
          summary,
          players: playerConfigs,
        },
      });
    })();
  }, [x01State, dartCount, playerConfigs, navigate, stopX01Game]);

  const handleOpenCorrection = useCallback((index: number) => {
    setSelectedDartIndex(index);
    setIsCorrectionModalOpen(true);
  }, []);

  const handleSaveCorrection = useCallback(
    async (correction: { dartIndex: number; multiplier: number; segment: number; score: number }) => {
      try {
        await correctScore(correction);
        await fetchX01State();
      } catch (err) {
        console.error("Error correcting score:", err);
        setError(err instanceof Error ? err.message : "Failed to correct score");
      }
    },
    [fetchX01State]
  );
  const handleAddDart = useCallback(
    async (correction: { dartIndex: number; multiplier: number; segment: number; score: number }) => {
      try {
        await addDart(correction);
        await fetchX01State();
      } catch (err) {
        console.error("Error adding dart:", err);
        setError(err instanceof Error ? err.message : "Failed to add dart");
      }
    },
    [fetchX01State]
  );


  const handleDeleteScore = useCallback(
    async (dartIndex: number) => {
      try {
        await deleteCorrectionImages(dartIndex);
        await fetchX01State();
      } catch (err) {
        console.error("Error deleting training images:", err);
      }
    },
    [fetchX01State]
  );


  const handleAbort = useCallback(async () => {
    isStoppingRef.current = true;
    hasNavigatedRef.current = true;

    await stopX01Game();
    navigate("/");
  }, [stopX01Game, navigate]);

  const handleFinishToStats = useCallback(async () => {
    if (isStoppingRef.current || hasNavigatedRef.current) return;
    isStoppingRef.current = true;
    hasNavigatedRef.current = true;

    let summary = x01State;
    if (!summary) {
      try {
        await fetchX01State();
        summary = x01State;
      } catch {
        /* ignore */
      }
    }
    await stopX01Game();
    navigate("/x01/stats", {
      state: {
        summary,
        players: playerConfigs,
      },
    });
  }, [fetchX01State, navigate, playerConfigs, stopX01Game, x01State]);


  const handleForceNextTurn = useCallback(async () => {
    try {
      await apiForceNextTurn<X01State>("x01");
      setInfoMessage("Turn completed - moved to next player");
      setTimeout(() => setInfoMessage(""), 2000);
    } catch (err) {
      console.error("Failed to force next turn:", err);
      setError("Failed to force next turn");
    }
  }, []);
  const currentPlayerIndex = x01State?.currentPlayer ?? 0;
  const fallbackPlayers = useMemo<X01PlayerStateBackend[]>(
    () =>
      playerConfigs.map((player) => {
        const playerStartScore = player.x01Settings?.startScore || startScore;
        const playerInMode = player.x01Settings?.inMode || inMode;
        const playerOutMode = player.x01Settings?.outMode || outMode;
        return {
          name: player.name,
          score: playerStartScore,
          startingScore: playerStartScore,
          hasIn: playerInMode === "straight",
          inMode: playerInMode,
          outMode: playerOutMode,
          dartsThrown: 0,
          totalScored: 0,
          average: 0,
          firstNineAverage: 0,
          legsWon: 0,
          setsWon: 0,
          isBot: player.isBot,
          botLevel: player.botLevel,
        };
      }),
    [playerConfigs, startScore, inMode, outMode]
  );

  const players: X01PlayerStateBackend[] = x01State?.players ?? fallbackPlayers;

  const getDisplayName = useCallback(
    (index: number) => {
      const player = players[index];
      const config = playerConfigs[index];
      const name = player?.name || config?.name || `Player ${index + 1}`;
      const isBot = player?.isBot ?? config?.isBot ?? false;
      const botLevel = player?.botLevel ?? config?.botLevel;
      if (!isBot) {
        return name;
      }
      return `${name}${botLevel ? ` (Bot L${botLevel})` : " (Bot)"}`;
    },
    [players, playerConfigs]
  );

  const currentTurn = x01State?.currentTurn;
  const currentDartScores = currentTurn?.darts ?? [null, null, null];
  const appliedScores = currentTurn?.appliedScores ?? [0, 0, 0];
  const winnerIndex = x01State?.winner ?? null;
  const playerScore = players[currentPlayerIndex]?.score ?? startScore;
  const bustActive = currentTurn?.bust && winnerIndex === null && dartCount > 0;
  const bustHighlightIndex = useMemo(() => {
    if (!currentTurn?.bust || !currentTurn?.darts) {
      return null;
    }
    for (let i = currentTurn.darts.length - 1; i >= 0; i -= 1) {
      if (currentTurn.darts[i]) {
        return i;
      }
    }
    return null;
  }, [currentTurn]);

  useEffect(() => () => {
    if (celebrationTimeoutRef.current) {
      clearTimeout(celebrationTimeoutRef.current);
    }
  }, []);
  const winHighlightIndex = useMemo(() => {
    if (!currentTurn?.finished || currentTurn.bust || !currentTurn?.darts) {
      return null;
    }
    for (let i = currentTurn.darts.length - 1; i >= 0; i -= 1) {
      if (currentTurn.darts[i]) {
        return i;
      }
    }
    return null;
  }, [currentTurn]);
  const celebrationWinnerIndex = winnerIndex ?? pendingCelebrationWinner;

  // Fetch checkout suggestions when current player's score changes
  useEffect(() => {
    if (!x01State || winnerIndex !== null) {
      setCheckoutSuggestions([null, null, null]);
      return;
    }

    const currentPlayerIndex = x01State.currentPlayer ?? 0;
    const currentPlayer = x01State.players[currentPlayerIndex];
    if (!currentPlayer) {
      return;
    }

    // Use the remaining score from current turn if available, otherwise use player score
    const remaining = x01State.currentTurn?.remaining ?? currentPlayer.score;
    
    // Count how many darts have been thrown in current turn
    const dartsThrown = x01State.currentTurn?.darts?.filter(d => d !== null).length ?? 0;
    
    fetchCheckoutSuggestions(currentPlayerIndex, remaining, dartsThrown);
  }, [x01State, winnerIndex, fetchCheckoutSuggestions]);

  const earlyWinRef = useRef(false);
  useEffect(() => {
    if (!x01State) {
      return;
    }
    const finished = Boolean(x01State.currentTurn?.finished);
    const legWinnerKnown =
      x01State.legWinner !== null ||
      x01State.matchWinner !== null ||
      x01State.match?.legWinner !== null ||
      x01State.match?.matchWinner !== null;
    if (finished && !earlyWinRef.current && !legWinnerKnown) {
      earlyWinRef.current = true;
      const winningIndex = x01State.currentPlayer ?? currentPlayerIndex ?? null;
      if (winningIndex !== null) {
        setPendingCelebrationWinner(winningIndex);
      }
      setCelebrationType('leg');
      setShowCelebration(true);
      if (celebrationTimeoutRef.current) {
        clearTimeout(celebrationTimeoutRef.current);
      }
      celebrationTimeoutRef.current = setTimeout(() => {
        setShowCelebration(false);
      }, 2000);
    } else if (!finished) {
      earlyWinRef.current = false;
      if (pendingCelebrationWinner !== null && winnerIndex === null) {
        setPendingCelebrationWinner(null);
      }
    }
  }, [x01State, currentPlayerIndex, pendingCelebrationWinner, winnerIndex]);

  // Trigger celebration when a winner is detected
  useEffect(() => {
    if (!x01State) return;
    
    const legWinner = x01State.legWinner ?? x01State.match?.legWinner;
    const matchWinner = x01State.matchWinner ?? x01State.match?.matchWinner;
    
    // Check if there's a new leg winner (either different player or transitioning from no winner to a winner)
    const hasNewWinner = legWinner !== null && legWinner !== undefined &&
                         (lastWinnerRef.current === null || legWinner !== lastWinnerRef.current);
    
    if (hasNewWinner) {
      lastWinnerRef.current = legWinner;
      
      // Determine if it's a match win or just a leg win
      if (matchWinner !== null && matchWinner !== undefined) {
        setCelebrationType('match');
      } else {
        setCelebrationType('leg');
      }
      
      setPendingCelebrationWinner(null);
      setShowCelebration(true);
      
      // Auto-hide celebration after duration
      const duration = matchWinner !== null ? 5000 : 3000;
      if (celebrationTimeoutRef.current) {
        clearTimeout(celebrationTimeoutRef.current);
      }
      celebrationTimeoutRef.current = setTimeout(() => {
        setShowCelebration(false);
      }, duration);
    }
    
    // Reset winner ref when starting new leg
    if (legWinner === null || legWinner === undefined) {
      lastWinnerRef.current = null;
    }
  }, [x01State]);

  const recentHistory = useMemo(() => {
    if (!x01State?.turnHistory) {
      return [] as X01TurnHistoryEntry[];
    }
    return [...x01State.turnHistory].slice(-8).reverse();
  }, [x01State?.turnHistory]);

  const lastTurn = x01State?.lastTurn ?? null;

  const requiresIn = useMemo(() => {
    const player = players[currentPlayerIndex];
    if (!player) {
      return false;
    }
    if (inMode === "straight") {
      return false;
    }
    return !player.hasIn;
  }, [players, currentPlayerIndex, inMode]);

  // Memoize confetti count for celebration
  const confettiCount = useMemo(() => celebrationType === 'match' ? 100 : 50, [celebrationType]);
  const effectiveFreePlay = Boolean(x01State?.settings?.freePlay ?? freePlay);

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
            X01 Match <span className="text-red-500">Live</span>
          </>
        }
        subtitle={<>Start {startScore} • In {inMode} • Out {outMode}</>}
        meta={
          effectiveFreePlay
            ? <>Free Play</>
            : x01State?.match ? (
                <>
                  Set {x01State.match.currentSet} • Leg {x01State.match.currentLeg}
                  {setsToWin > 1 && ` • Best of ${setsToWin * 2 - 1} Sets`}
                  {legsPerSet > 1 && ` • Best of ${legsPerSet * 2 - 1} Legs`}
                </>
              ) : null
        }
        right={
          <>
            <DiagnosticsDebugButton game="x01" />
            <GameControlButton
              label="Next Turn"
              variant="primary"
              onClick={handleForceNextTurn}
              title="Force complete turn and move to next player"
            />
            <GameControlButton
              label="Finish & Stats"
              variant="neutral"
              onClick={handleFinishToStats}
              title="End free play and view stats"
            />
            <GameControlButton label="Abort Game" variant="danger" onClick={handleAbort} />
          </>
        }
      />

      {/* Last Man Standing Scoreboard */}
      {x01State?.settings.gameVariant === "last_man_standing" && x01State.lms && (
        <div className="relative z-10 px-4 md:px-10 mt-4">
          <div className="max-w-6xl mx-auto bg-zinc-900/60 border border-white/10 rounded-xl p-4">
            <h3 className="text-sm font-semibold mb-3 text-white">
              Last Man Standing - Leg {x01State.lms.currentLeg} of {x01State.lms.totalLegs}
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
              {players.map((player, idx) => {
                const points = x01State.lms?.playerPoints[idx] || 0;
                const hasFinished = x01State.lms?.finishOrder.includes(idx) || false;
                const position = hasFinished && x01State.lms ? x01State.lms.finishOrder.indexOf(idx) + 1 : null;
                
                return (
                  <div 
                    key={idx} 
                    className={`bg-black/40 rounded p-3 border ${
                      hasFinished ? 'border-emerald-500/50' : 'border-white/5'
                    }`}
                  >
                    <div className="text-xs text-zinc-500 truncate">{player.name}</div>
                    <div className="text-lg font-bold text-white mt-1">
                      {points} pts
                    </div>
                    {position && (
                      <div className="text-xs text-emerald-400 mt-1">
                        #{position} this leg
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Team Play Scoreboard */}
      {x01State?.settings.gameVariant === "team_play" && x01State.teams && x01State.teams.length > 0 && (
        <div className="relative z-10 px-4 md:px-10 mt-4">
          <div className="max-w-6xl mx-auto bg-zinc-900/60 border border-white/10 rounded-xl p-4">
            <h3 className="text-sm font-semibold mb-3 text-white">
              Team Scores
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {x01State.teams.map((team) => {
                // Map hex color to Tailwind classes
                const getTeamColorClasses = (hexColor: string) => {
                  const colorMap: Record<string, string> = {
                    '#ef4444': 'bg-red-500/20 border-red-500/50',
                    '#3b82f6': 'bg-blue-500/20 border-blue-500/50',
                    '#10b981': 'bg-green-500/20 border-green-500/50',
                    '#f59e0b': 'bg-amber-500/20 border-amber-500/50',
                  };
                  return colorMap[hexColor] || 'bg-zinc-500/20 border-zinc-500/50';
                };
                
                const teamColor = getTeamColorClasses(team.teamColor || '#ef4444');
                
                return (
                  <div
                    key={team.teamId}
                    className={`rounded-lg p-4 border-2 ${teamColor}`}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="text-base font-bold text-white">{team.teamName}</div>
                      <div className="text-2xl font-extrabold text-white tabular-nums">{team.score}</div>
                    </div>
                    <div className="space-y-1">
                      {team.playerIndices.map((playerIdx) => {
                        const player = players[playerIdx];
                        const isCurrentPlayer = currentPlayerIndex === playerIdx;
                        return (
                          <div
                            key={playerIdx}
                            className={`text-xs px-2 py-1 rounded ${
                              isCurrentPlayer
                                ? 'bg-white/20 text-white font-semibold'
                                : 'text-zinc-400'
                            }`}
                          >
                            {player?.name || `Player ${playerIdx + 1}`}
                            {isCurrentPlayer && ' 🎯'}
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-3 pt-3 border-t border-white/10 flex justify-between text-xs text-zinc-400">
                      <span>Legs: {team.legsWon}</span>
                      <span>Sets: {team.setsWon}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <main className="relative z-10 flex-1 px-4 md:px-10 pb-6">
        <div className="max-w-7xl mx-auto mt-4 space-y-8">
          {error && (
            <div className="rounded-xl border border-red-500/60 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {error}
            </div>
          )}
          {isLoading && (
            <div className="rounded-xl border border-white/10 bg-zinc-900/60 px-4 py-3 text-sm text-zinc-200">
              Initialising X01 match...
            </div>
          )}
          {infoMessage && !error && (
            <div className="rounded-xl border border-white/10 bg-zinc-900/60 px-4 py-3 text-sm text-zinc-200">
              {infoMessage}
            </div>
          )}
          {x01State?.matchWinner !== null && x01State?.matchWinner !== undefined && (
            <div className="rounded-xl border border-emerald-500/60 bg-emerald-600/15 px-4 py-3 text-sm text-emerald-200 flex items-center justify-between">
              <span className="text-base font-semibold">{getDisplayName(x01State.matchWinner)} wins the match!</span>
              <span className="text-xs uppercase tracking-[0.25em] text-emerald-300">Match Complete</span>
            </div>
          )}
          {x01State?.setWinner !== null && x01State?.setWinner !== undefined && x01State?.matchWinner === null && (
            <div className="rounded-xl border border-blue-500/60 bg-blue-600/15 px-4 py-3 text-sm text-blue-200 flex items-center justify-between">
              <span className="text-base font-semibold">{getDisplayName(x01State.setWinner)} wins Set {x01State.match.currentSet - 1}!</span>
              <span className="text-xs uppercase tracking-[0.25em] text-blue-300">Starting next set...</span>
            </div>
          )}
          {winnerIndex !== null && x01State?.setWinner === null && x01State?.matchWinner === null && (
            <div className="rounded-xl border border-emerald-500/60 bg-emerald-600/15 px-4 py-3 text-sm text-emerald-200 flex items-center justify-between">
              <span className="text-base font-semibold">{getDisplayName(winnerIndex)} wins Leg {x01State?.match.currentLeg}!</span>
              <span className="text-xs uppercase tracking-[0.25em] text-emerald-300">Starting next leg...</span>
            </div>
          )}
          {pendingCelebrationWinner !== null && winnerIndex === null && x01State?.setWinner === null && x01State?.matchWinner === null && (
            <div className="rounded-xl border border-emerald-500/60 bg-emerald-600/15 px-4 py-3 text-sm text-emerald-200 flex items-center justify-between">
              <span className="text-base font-semibold">{getDisplayName(pendingCelebrationWinner)} checks out!</span>
              <span className="text-xs uppercase tracking-[0.25em] text-emerald-300">Awaiting confirmation...</span>
            </div>
          )}

          {/* Only show individual player cards if NOT in team play mode */}
          {x01State?.settings.gameVariant !== "team_play" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              {players.map((player, index) => (
                <PlayerCard
                  key={player.name + index}
                  player={player}
                  index={index}
                  isActive={winnerIndex === null && currentPlayerIndex === index}
                  isWinner={winnerIndex === index}
                  getDisplayName={getDisplayName}
                />
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_0.8fr] gap-6">
            <div className="rounded-2xl border border-white/10 bg-black/40 px-10 py-10">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <div className="text-sm uppercase tracking-[0.3em] text-zinc-500 mb-2">Current Player</div>
                  <div className="text-2xl font-semibold text-white">{getDisplayName(currentPlayerIndex)}</div>
                </div>
                <div className="text-right">
                  <div className="text-sm uppercase tracking-[0.3em] text-zinc-500 mb-2">Turn Total</div>
                  <div className="text-5xl font-extrabold text-emerald-500 tabular-nums">
                    {currentTurn?.scored ?? 0}
                  </div>
                </div>
              </div>
              {currentTurn?.bust && winnerIndex === null && (
                <div className="mt-3 rounded-lg border border-red-500/40 bg-red-600/10 px-3 py-2 text-xs text-red-200">
                  Bust! Remove the darts to reset and continue.
                </div>
              )}
              {requiresIn && (
                <div className="mt-3 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-200">
                  Needs a {inMode === "double" ? "double" : "double or triple"} to start scoring
                </div>
              )}
              <div className="mt-10 grid grid-cols-1 sm:grid-cols-3 gap-8">
                {[0, 1, 2].map((index) => {
                  const score = currentDartScores[index];
                  const applied = appliedScores[index] ?? 0;
                  const suggestion = checkoutSuggestions[index];
                  const disabled = winnerIndex !== null;
                  const isBustCause = bustActive && bustHighlightIndex === index;
                  const isWinningDart = !currentTurn?.bust && currentTurn?.finished && winHighlightIndex === index;
                  
                  // Show suggestion if no dart thrown yet and suggestion exists
                  const showSuggestion = !score && suggestion && winnerIndex === null;
                  
                  return (
                    <button
                      key={`dart-${index}`}
                      type="button"
                      onClick={() => handleOpenCorrection(index)}
                      disabled={disabled}
                      className={`rounded-2xl border px-8 py-8 text-left transition ${
                        disabled
                          ? "border-white/10 bg-zinc-900/40 text-zinc-500 cursor-not-allowed"
                          : "border-red-500/40 bg-red-600/10 hover:border-red-500/80 hover:bg-red-600/20"
                      } ${
                        isBustCause
                          ? "border-red-500 bg-red-600/30 text-white animate-pulse"
                          : isWinningDart
                          ? "border-emerald-500 bg-emerald-600/30 text-white animate-pulse"
                          : ""
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-base uppercase tracking-[0.25em] text-zinc-400 mb-3">Dart {index + 1}</div>
                          {showSuggestion ? (
                            <div className="text-5xl font-semibold text-blue-400/60">[{suggestion}]</div>
                          ) : score ? (
                            <div className="text-5xl font-semibold text-white">{formatDartLabel(score)}</div>
                          ) : (
                            <div className="text-lg text-zinc-500">No dart - Click to add</div>
                          )}
                          {score && <div className="text-base text-zinc-400 mt-3">Counted {formatAppliedScore(applied)}</div>}
                        </div>
                        {score && <span className="text-xs text-zinc-500">Edit</span>}
                      </div>
                    </button>
                  );
                })}
              </div>
              <div className="mt-10 grid grid-cols-2 gap-8 text-base">
                <div className="flex flex-col gap-1">
                  <span className="text-zinc-500 uppercase tracking-wider">Turn Status</span>
                  <span className="text-white font-semibold">
                    {currentTurn?.darts.filter(d => d !== null).length || 0}/3 darts thrown
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
                {currentTurn?.finished && !currentTurn?.bust && (
                  <div className="flex flex-col gap-1 col-span-2">
                    <span className="text-emerald-400 uppercase tracking-wider font-semibold">
                      ✓ Checkout Complete
                    </span>
                  </div>
                )}
                {currentTurn?.bust && (
                  <div className="flex flex-col gap-1 col-span-2">
                    <span className="text-red-400 uppercase tracking-wider font-semibold">
                      ✗ Bust - Remove darts to continue
                    </span>
                  </div>
                )}
              </div>
            </div>

          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[1fr_1fr] gap-8">
            <div className="rounded-2xl border border-white/10 bg-black/40 px-10 py-8">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-semibold text-white">Last Turn</h2>
                <span className="text-sm text-zinc-500">
                  {lastTurn ? `Turn ${lastTurn.turnIndex}` : "Awaiting throws"}
                </span>
              </div>
              {lastTurn ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between text-base text-zinc-400">
                    <span>{getDisplayName(lastTurn.playerIndex)}</span>
                    <span className="text-white font-semibold">
                      {lastTurn.bust ? "Bust" : `Scored ${lastTurn.scored}`}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
                    {lastTurn.darts.map((dart, index) => (
                      <div
                        key={`last-${index}`}
                        className="rounded-xl border border-white/10 bg-zinc-900/60 px-5 py-5"
                      >
                        <div className="text-sm uppercase tracking-[0.25em] text-zinc-500 mb-2">Dart {index + 1}</div>
                        <div className="text-3xl font-semibold text-white mt-1">{formatDartLabel(dart)}</div>
                        <div className="text-base text-zinc-400 mt-3">Counted {formatAppliedScore(lastTurn.appliedScores[index])}</div>
                      </div>
                    ))}
                  </div>
                  <div className="text-xs text-zinc-500">
                    Remaining: {lastTurn.remaining} ? {lastTurn.bust ? "Score reset" : `Next player ${getDisplayName((lastTurn.playerIndex + 1) % players.length)}`}
                  </div>
                </div>
              ) : (
                <div className="text-sm text-zinc-500">No completed turns yet.</div>
              )}
            </div>

            <div className="rounded-2xl border border-white/10 bg-black/40 px-10 py-8 overflow-hidden">
              <h2 className="text-xl font-semibold text-white mb-6">Recent Turns</h2>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] border-separate [border-spacing:0] text-base">
                  <thead>
                    <tr className="text-sm uppercase tracking-[0.25em] text-zinc-500">
                      <th className="px-4 py-3 text-left">#</th>
                      <th className="px-4 py-3 text-left">Player</th>
                      <th className="px-4 py-3 text-left">Scored</th>
                      <th className="px-4 py-3 text-left">Remaining</th>
                      <th className="px-4 py-3 text-left">Notes</th>
                    </tr>
                  </thead>
                  <tbody className="text-zinc-300">
                    {recentHistory.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-4 py-4 text-center text-sm text-zinc-500">
                          Turns will appear here after the first round.
                        </td>
                      </tr>
                    )}
                    {recentHistory.map((turn) => (
                      <tr key={`history-${turn.turnIndex}`} className="border-t border-white/5">
                        <td className="px-4 py-3 text-zinc-500">{turn.turnIndex}</td>
                        <td className="px-4 py-3">{getDisplayName(turn.playerIndex)}</td>
                        <td className="px-4 py-3 text-white font-semibold">{turn.bust ? "Bust" : turn.scored}</td>
                        <td className="px-4 py-3 text-white font-semibold">{turn.remaining}</td>
                        <td className="px-4 py-3 text-sm text-zinc-400">
                          {turn.bust
                            ? "Bust"
                            : turn.finished
                            ? `Checkout in ${turn.dartsUsed} darts`
                            : `Throws ${turn.appliedScores.filter((score, idx) => idx < turn.dartsUsed).join(", ")}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Win Celebration */}
      {showCelebration && (
        <div className="fixed inset-0 pointer-events-none z-50 overflow-hidden">
          {/* Confetti particles */}
          {Array.from({ length: confettiCount }).map((_, i) => {
            const delay = Math.random() * 0.5;
            const duration = 2 + Math.random() * 2;
            const left = Math.random() * 100;
            const colors = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
            const color = colors[Math.floor(Math.random() * colors.length)];
            
            return (
              <div
                key={i}
                className="absolute w-2 h-2 rounded-full animate-confetti"
                style={{
                  left: `${left}%`,
                  top: '-10px',
                  backgroundColor: color,
                  animationDelay: `${delay}s`,
                  animationDuration: `${duration}s`,
                }}
              />
            );
          })}
          
          {/* Winner announcement */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div
              className="bg-gradient-to-r from-emerald-600/90 to-green-600/90 backdrop-blur-sm px-12 py-8 rounded-3xl border-4 border-emerald-400 shadow-2xl animate-bounce-in"
              style={{ animationDuration: '0.6s' }}
            >
              <div className="text-center">
                <div className="text-6xl mb-4">🏆</div>
                <div className="text-4xl font-extrabold text-white mb-2">
                  {celebrationType === 'match' ? 'MATCH WON!' : 'LEG WON!'}
                </div>
                <div className="text-2xl font-semibold text-emerald-100">
                  {celebrationWinnerIndex !== null ? getDisplayName(celebrationWinnerIndex) : ""}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <ScoreCorrection
        isOpen={isCorrectionModalOpen}
        onClose={() => setIsCorrectionModalOpen(false)}
        dartIndex={selectedDartIndex}
        originalScore={selectedDartIndex >= 0 ? currentDartScores[selectedDartIndex] : null}
        onSaveCorrection={handleSaveCorrection}
        onDeleteImages={handleDeleteScore}
        onAddDart={handleAddDart}
      />
      
      <style dangerouslySetInnerHTML={{__html: `
        @keyframes confetti {
          0% {
            transform: translateY(0) rotate(0deg);
            opacity: 1;
          }
          100% {
            transform: translateY(100vh) rotate(720deg);
            opacity: 0;
          }
        }
        
        @keyframes bounce-in {
          0% {
            transform: scale(0) rotate(-10deg);
            opacity: 0;
          }
          50% {
            transform: scale(1.1) rotate(5deg);
          }
          100% {
            transform: scale(1) rotate(0deg);
            opacity: 1;
          }
        }
        
        .animate-confetti {
          animation: confetti linear forwards;
        }
        
        .animate-bounce-in {
          animation: bounce-in ease-out forwards;
        }
      `}} />
    </div>
  );
}
