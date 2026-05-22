import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { LobbyState, PlayerConfig } from "../context/LobbyContext";
import { subscribeDetection } from "../services/detectionSocket";

const API_URL = "http://localhost:8000";
const BOARD_OUTER_UNITS = 17.0;
const MM_PER_UNIT = 10.0;
const INNER_BULL_MM = 15.9;
const OUTER_BULL_MM = 31.8;
const TRIPLE_INNER_MM = 99.0;
const TRIPLE_OUTER_MM = 107.0;
const DOUBLE_INNER_MM = 162.0;
const DOUBLE_OUTER_MM = 170.0;
const DARTBOARD_SEGMENTS = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];

type BullOffResult = {
  playerIndex: number;
  playerName: string;
  distanceMm: number;
  zone: string;
  score: number;
  position: { x: number; y: number } | null;
  rotationDeg?: number;
  mapped?: boolean;
  isBot: boolean;
};

const markerColors = ["#f97316", "#38bdf8", "#22c55e", "#e879f9", "#facc15", "#fb7185"];

const SIGMA_BY_LEVEL: Record<number, number> = {
  1: 5.0,
  2: 3.5,
  3: 2.5,
  4: 2.0,
  5: 1.6,
  6: 1.3,
  7: 1.0,
  8: 0.75,
  9: 0.5,
};

function rotatePlayers(players: PlayerConfig[], startIndex: number): PlayerConfig[] {
  if (!players.length) {
    return players;
  }
  const normalized = startIndex % players.length;
  return players.slice(normalized).concat(players.slice(0, normalized));
}

function deriveDistance(result: BullOffResult): number {
  if (Number.isFinite(result.distanceMm)) {
    return result.distanceMm;
  }
  if (result.zone === "inner_bull") {
    return 0;
  }
  if (result.zone === "outer_bull") {
    return OUTER_BULL_MM;
  }
  return 999;
}

function scorePointOnBoard(xMm: number, yMm: number) {
  const distanceMm = Math.hypot(xMm, yMm);
  if (distanceMm <= INNER_BULL_MM) {
    return { score: 50, zone: "inner_bull", segment: 0 };
  }
  if (distanceMm <= OUTER_BULL_MM) {
    return { score: 25, zone: "outer_bull", segment: 0 };
  }
  if (distanceMm > DOUBLE_OUTER_MM) {
    return { score: 0, zone: "miss", segment: 0 };
  }

  let angleDeg = (Math.atan2(yMm, xMm) * 180) / Math.PI;
  if (angleDeg < 0) {
    angleDeg += 360;
  }
  const angleFromTop = (angleDeg + 90) % 360;
  const segmentIndex = Math.floor(((angleFromTop + 9) % 360) / 18);
  const segment = DARTBOARD_SEGMENTS[segmentIndex] ?? 0;

  if (distanceMm <= TRIPLE_INNER_MM) {
    return { score: segment, zone: "single_inner", segment };
  }
  if (distanceMm <= TRIPLE_OUTER_MM) {
    return { score: segment * 3, zone: "triple", segment };
  }
  if (distanceMm <= DOUBLE_INNER_MM) {
    return { score: segment, zone: "single_outer", segment };
  }
  return { score: segment * 2, zone: "double", segment };
}

function simulateBotThrow(botLevel?: number) {
  const level = Math.max(1, Math.min(9, Number(botLevel) || 3));
  const sigmaUnits = SIGMA_BY_LEVEL[level] ?? 2.5;

  const u1 = Math.random() || 0.0001;
  const u2 = Math.random() || 0.0001;
  const mag = sigmaUnits * Math.sqrt(-2 * Math.log(u1));
  const xUnits = mag * Math.cos(2 * Math.PI * u2);
  const yUnits = mag * Math.sin(2 * Math.PI * u2);

  const distanceUnits = Math.hypot(xUnits, yUnits);
  const distanceMm = distanceUnits * MM_PER_UNIT;
  const scored = scorePointOnBoard(xUnits * MM_PER_UNIT, yUnits * MM_PER_UNIT);
  const position = {
    x: xUnits / BOARD_OUTER_UNITS,
    y: yUnits / BOARD_OUTER_UNITS,
  };
  return { distance: distanceMm, position, zone: scored.zone, score: scored.score };
}

export default function BullOffPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as LobbyState | undefined;
  const [roundIndex, setRoundIndex] = useState(1);
  const [orderStartIndex, setOrderStartIndex] = useState(0);
  const [currentThrowIndex, setCurrentThrowIndex] = useState(0);
  const [awaitingThrow, setAwaitingThrow] = useState(true);
  const [results, setResults] = useState<Record<number, BullOffResult>>({});
  const [winnerIndex, setWinnerIndex] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const players = useMemo(() => state?.players ?? [], [state]);
  const orderedPlayers = useMemo(() => rotatePlayers(players, orderStartIndex), [players, orderStartIndex]);
  const currentPlayer = orderedPlayers[currentThrowIndex];

  const currentResult = useMemo(() => {
    if (!currentPlayer) {
      return null;
    }
    return results[playerIndex(currentPlayer, players)] || null;
  }, [currentPlayer, players, results]);

  const resetDetection = useCallback(async () => {
    await fetch(`${API_URL}/api/detection/reset`, { method: "POST" }).catch(() => undefined);
  }, []);

  const startMatch = useCallback(
    (startingPlayer: number) => {
      if (!state) {
        navigate("/lobby");
        return;
      }
      const updatedState = { ...state, startingPlayer };
      switch (state.selectedGame) {
        case "x01":
          navigate("/x01", { state: updatedState });
          break;
        case "target_trainer":
          navigate("/target-trainer", { state: updatedState });
          break;
        case "cricket":
          navigate("/cricket", { state: updatedState });
          break;
        case "around_the_clock":
          navigate("/around-the-clock", { state: updatedState });
          break;
        case "beer_race":
          navigate("/beer-race", { state: updatedState });
          break;
        case "shanghai":
          navigate("/shanghai", { state: updatedState });
          break;
        case "bob27":
          navigate("/bob27", { state: updatedState });
          break;
        case "bermuda":
          navigate("/bermuda", { state: updatedState });
          break;
        case "one_two_one":
          navigate("/one-two-one", { state: updatedState });
          break;
        default:
          navigate("/game");
      }
    },
    [navigate, state]
  );

  const evaluateRound = useCallback(
    (nextResults: Record<number, BullOffResult>) => {
      if (!players.length) {
        return;
      }
      const allPlayersDone = players.every((_, index) => nextResults[index]);
      if (!allPlayersDone) {
        return;
      }
      const distances = players.map((_, index) => deriveDistance(nextResults[index]));
      const best = Math.min(...distances);
      const tied = distances
        .map((value, index) => ({ value, index }))
        .filter((item) => Math.abs(item.value - best) <= 0.1);

      if (tied.length === 1) {
        const winner = tied[0].index;
        setWinnerIndex(winner);
        setMessage(`Bull-off winner: ${players[winner].name || `Player ${winner + 1}`}`);
        return;
      }

      setMessage("Draw - prepare for another bull-off round.");
      setRoundIndex((prev) => prev + 1);
      setOrderStartIndex((prev) => (players.length ? (prev + 1) % players.length : 0));
      setCurrentThrowIndex(0);
      setResults({});
      setAwaitingThrow(true);
      resetDetection();
    },
    [players, resetDetection]
  );

  const handleRecordedResult = useCallback(
    (player: PlayerConfig, result: BullOffResult) => {
      const index = playerIndex(player, players);
      setAwaitingThrow(false);
      setResults((prev) => {
        const nextResults = { ...prev, [index]: result };
        evaluateRound(nextResults);
        return nextResults;
      });
    },
    [evaluateRound, players]
  );

  const handleNextThrow = useCallback(async () => {
    if (!players.length) {
      return;
    }
    const nextIndex = currentThrowIndex + 1;
    if (nextIndex >= orderedPlayers.length) {
      return;
    }
    setCurrentThrowIndex(nextIndex);
    setAwaitingThrow(true);
    setMessage(null);
    await resetDetection();
  }, [currentThrowIndex, orderedPlayers.length, players.length, resetDetection]);

  useEffect(() => {
    if (!state) {
      navigate("/lobby");
      return;
    }
    if (players.length <= 1) {
      startMatch(0);
      return;
    }
    resetDetection();
  }, [navigate, players.length, resetDetection, startMatch, state]);

  useEffect(() => {
    if (!currentPlayer || !awaitingThrow) {
      return;
    }
    if (!currentPlayer.isBot) {
      return;
    }
    const timer = setTimeout(() => {
      const simulated = simulateBotThrow(currentPlayer.botLevel);
      const result: BullOffResult = {
        playerIndex: playerIndex(currentPlayer, players),
        playerName: currentPlayer.name || `Player ${playerIndex(currentPlayer, players) + 1}`,
        distanceMm: simulated.distance,
        zone: simulated.zone,
        score: simulated.score,
        position: simulated.position,
        mapped: true,
        isBot: true,
      };
      handleRecordedResult(currentPlayer, result);
    }, 800);
    return () => clearTimeout(timer);
  }, [awaitingThrow, currentPlayer, handleRecordedResult, players]);

  useEffect(() => {
    if (!state) {
      return;
    }
    const unsubscribe = subscribeDetection(async (payload) => {
      if (payload.event === "darts_removed") {
        if (!awaitingThrow && winnerIndex === null && currentThrowIndex < orderedPlayers.length - 1) {
          await handleNextThrow();
        }
        return;
      }

      if (!awaitingThrow || !currentPlayer || currentPlayer.isBot) {
        return;
      }
      if (payload.event !== "dart_detected") {
        return;
      }

      try {
        const response = await fetch(`${API_URL}/api/detection/scores`);
        const data = await response.json();
        const score = Array.isArray(data?.scores) ? data.scores[0] : null;
        const position = Array.isArray(data?.positions) ? data.positions[0] : null;
        const result: BullOffResult = {
          playerIndex: playerIndex(currentPlayer, players),
          playerName: currentPlayer.name || `Player ${playerIndex(currentPlayer, players) + 1}`,
          distanceMm: typeof position?.distance_mm === "number" ? position.distance_mm : 999,
          zone: score?.zone || "miss",
          score: typeof score?.score === "number" ? score.score : 0,
          position: position && typeof position.x === "number" && typeof position.y === "number"
            ? { x: position.x, y: position.y }
            : null,
          rotationDeg: typeof position?.rotation_deg === "number" ? position.rotation_deg : 0,
          mapped: Boolean(position?.mapped),
          isBot: false,
        };
        handleRecordedResult(currentPlayer, result);
      } catch (err) {
        setMessage("Failed to read bull-off dart. Try again.");
      }
    });

    return () => {
      unsubscribe();
    };
  }, [awaitingThrow, currentPlayer, handleRecordedResult, players, state]);

  if (!state) {
    return null;
  }

  const orderedList = orderedPlayers.map((player) => ({
    ...player,
    index: playerIndex(player, players),
  }));

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

      <header className="relative z-10 w-full px-6 md:px-10 py-6 flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={() => navigate("/lobby")}
          className="px-4 py-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 transition-colors"
        >
          Back
        </button>
        <div className="flex-1 text-center md:text-left">
          <h1 className="text-2xl font-extrabold tracking-wide">
            Bull-off <span className="text-red-500">Start</span>
          </h1>
          <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">One dart each • closest to bull starts</p>
        </div>
      </header>

      <main className="relative z-10 flex-1 px-6 md:px-10 pb-8">
        <div className="h-full w-full max-w-6xl mx-auto grid grid-cols-1 xl:grid-cols-[1fr_1.1fr] gap-6">
          <div className="bg-zinc-900/60 border border-white/10 rounded-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Round {roundIndex}</p>
                <p className="text-lg font-semibold">{currentPlayer?.name || "Player"}</p>
              </div>
              {winnerIndex !== null && (
                <button
                  type="button"
                  onClick={() => startMatch(winnerIndex)}
                  className="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500"
                >
                  Start Match
                </button>
              )}
            </div>

            <div className="rounded-xl bg-black/50 border border-white/10 p-6 flex flex-col gap-4">
              <div className="text-xs uppercase tracking-[0.3em] text-zinc-500">Bull-off result</div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="rounded-xl bg-zinc-900/70 border border-white/10 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Score</p>
                  <p className="mt-2 text-3xl font-semibold">
                    {currentResult ? currentResult.score : "--"}
                  </p>
                  <p className="text-sm text-zinc-400">
                    {currentResult ? currentResult.zone.replace("_", " ") : "Waiting"}
                  </p>
                </div>
                <div className="rounded-xl bg-zinc-900/70 border border-white/10 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Distance</p>
                  <p className="mt-2 text-3xl font-semibold">
                    {currentResult && Number.isFinite(currentResult.distanceMm)
                      ? `${currentResult.distanceMm.toFixed(1)} mm`
                      : "--"}
                  </p>
                  <p className="text-sm text-zinc-400">Closest to bull wins</p>
                </div>
                <div className="rounded-xl bg-zinc-900/70 border border-white/10 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Status</p>
                  <p className="mt-2 text-xl font-semibold">
                    {winnerIndex !== null ? "Complete" : awaitingThrow ? "Throw now" : "Remove dart"}
                  </p>
                  <p className="text-sm text-zinc-400">
                    {winnerIndex !== null ? "Ready to start match" : awaitingThrow ? "Waiting for hit" : "Auto-advancing"}
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-2 text-sm text-zinc-300">
              {message && <p className="text-red-300">{message}</p>}
              {winnerIndex === null && currentPlayer && !currentPlayer.isBot && awaitingThrow && (
                <p>Throw now: {currentPlayer.name || "Player"}.</p>
              )}
              {winnerIndex === null && !awaitingThrow && (
                <p>Remove dart to continue. Next player will start automatically.</p>
              )}
            </div>

          </div>

          <div className="bg-zinc-900/60 border border-white/10 rounded-2xl p-6 flex flex-col gap-4">
            <h2 className="text-lg font-semibold">Bull-off Order</h2>
            <div className="space-y-3">
              {orderedList.map((player) => {
                const result = results[player.index];
                const isActive = currentPlayer && player.index === playerIndex(currentPlayer, players);
                const color = markerColors[player.index % markerColors.length];
                return (
                  <div
                    key={player.index}
                    className={`flex items-center justify-between rounded-xl border px-4 py-3 ${
                      isActive ? "border-red-500/60 bg-red-500/10" : "border-white/10 bg-black/40"
                    }`}
                  >
                    <div>
                      <p className="text-sm font-semibold" style={{ color }}>
                        {player.name || `Player ${player.index + 1}`}
                      </p>
                      <p className="text-xs text-zinc-400">
                        {player.isBot ? "Bot" : "Player"} {player.isBot && player.botLevel ? `L${player.botLevel}` : ""}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm">
                        {result ? `${result.score || 0} • ${result.zone}` : isActive ? "Throwing..." : "Pending"}
                      </p>
                      <p className="text-xs text-zinc-500">
                        {result ? `${deriveDistance(result).toFixed(1)} mm` : "--"}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function playerIndex(player: PlayerConfig, players: PlayerConfig[]) {
  return players.indexOf(player);
}
