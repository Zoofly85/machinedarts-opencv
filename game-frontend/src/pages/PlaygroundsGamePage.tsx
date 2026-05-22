import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { PlayerConfig } from "../context/LobbyContext";
import ScoreCorrection from "../components/ScoreCorrection";
import { subscribeDetection } from "../services/detectionSocket";

const API_URL = "http://localhost:8000";

type PlaygroundsState = {
  name?: string;
  start_score?: number;
  darts_per_turn: number;
  legs_per_set: number;
  sets_to_win: number;
  win_condition?: string;
  win_value?: number | null;
  round: number;
  current_player_index: number;
  status: "active" | "finished";
  winner_index: number | null;
  darts_thrown: number;
  pending_takeout?: boolean;
  turn_darts?: Array<{
    score: number;
    zone: string;
    segment: number;
    multiplier: number;
  }>;
  players: Array<{
    name: string;
    is_bot: boolean;
    bot_level?: number;
    score: number;
    legs_won: number;
    sets_won: number;
    busted: boolean;
    finished: boolean;
    zones_cleared?: number;
    zones?: string[];
    stats?: Record<string, unknown>;
  }>;
  game_stats?: Record<string, unknown>;
};

type PlaygroundsStartPayload = {
  scriptId: string;
  players: PlayerConfig[];
};

const BOT_ACCURACY: Record<number, number> = {
  1: 0.15,
  2: 0.2,
  3: 0.3,
  4: 0.4,
  5: 0.5,
  6: 0.6,
  7: 0.7,
  8: 0.8,
  9: 0.9,
};

const GOOD_DARTS = [
  { score: 60, zone: "triple", segment: 20, multiplier: 3 },
  { score: 57, zone: "triple", segment: 19, multiplier: 3 },
  { score: 50, zone: "inner_bull", segment: 0, multiplier: 1 },
  { score: 45, zone: "triple", segment: 15, multiplier: 3 },
  { score: 40, zone: "double", segment: 20, multiplier: 2 },
];
const BAD_DARTS = [
  { score: 0, zone: "miss", segment: 0, multiplier: 1 },
  { score: 1, zone: "single_inner", segment: 1, multiplier: 1 },
  { score: 5, zone: "single_inner", segment: 5, multiplier: 1 },
  { score: 12, zone: "double", segment: 6, multiplier: 2 },
  { score: 14, zone: "single_outer", segment: 14, multiplier: 1 },
  { score: 18, zone: "single_inner", segment: 18, multiplier: 1 },
  { score: 20, zone: "single_inner", segment: 20, multiplier: 1 },
  { score: 22, zone: "double", segment: 11, multiplier: 2 },
  { score: 26, zone: "double", segment: 13, multiplier: 2 },
  { score: 32, zone: "double", segment: 16, multiplier: 2 },
];

const ZONE_LABELS = [
  ...Array.from({ length: 20 }, (_, idx) => ({ key: `single_${idx + 1}`, label: `Single ${idx + 1}` })),
  { key: "double_any", label: "Any Double" },
  { key: "triple_any", label: "Any Triple" },
  { key: "outer_bull", label: "Outer Bull" },
  { key: "inner_bull", label: "Inner Bull" },
];

function simulateBotDart(botLevel?: number) {
  const level = Math.max(1, Math.min(9, Number(botLevel) || 3));
  const accuracy = BOT_ACCURACY[level] ?? 0.4;
  const pool = Math.random() < accuracy ? GOOD_DARTS : BAD_DARTS;
  return pool[Math.floor(Math.random() * pool.length)];
}

export default function PlaygroundsGamePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const payload = location.state as PlaygroundsStartPayload | undefined;
  const [gameState, setGameState] = useState<PlaygroundsState | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionDartIndex, setCorrectionDartIndex] = useState(0);
  const [correctionOriginalScore, setCorrectionOriginalScore] = useState<{
    score: number;
    multiplier: number;
    segment: string;
    zone: string;
  } | null>(null);
  const gameStateRef = useRef<PlaygroundsState | null>(null);
  const currentPlayerRef = useRef<PlaygroundsState["players"][number] | null>(null);
  const awaitingTakeoutRef = useRef(false);

  const currentPlayer = useMemo(() => {
    if (!gameState) {
      return null;
    }
    return gameState.players[gameState.current_player_index] ?? null;
  }, [gameState]);

  const currentZones = useMemo(() => {
    if (!currentPlayer?.zones) {
      return new Set<string>();
    }
    return new Set(currentPlayer.zones);
  }, [currentPlayer]);

  const currentTurnDarts = useMemo(() => gameState?.turn_darts ?? [], [gameState]);

  const formatTurnLabel = (dart?: { score: number; zone: string; segment: number; multiplier: number }) => {
    if (!dart) {
      return "--";
    }
    if (dart.zone === "inner_bull" || (dart.segment === 25 && dart.multiplier === 2)) {
      return "BULL";
    }
    if (dart.zone === "outer_bull" || dart.segment === 25) {
      return "25";
    }
    if (dart.multiplier === 3 || dart.zone === "triple") {
      return `T${dart.segment}`;
    }
    if (dart.multiplier === 2 || dart.zone === "double") {
      return `D${dart.segment}`;
    }
    if (dart.score === 0 || dart.zone === "miss") {
      return "MISS";
    }
    return String(dart.segment);
  };

  useEffect(() => {
    gameStateRef.current = gameState;
    currentPlayerRef.current = currentPlayer;
    awaitingTakeoutRef.current = Boolean(gameState?.pending_takeout);
  }, [gameState, currentPlayer]);

  const startGame = useCallback(async () => {
    if (!payload?.scriptId || !payload.players?.length) {
      setStatus("Missing script or players. Start from the lobby.");
      return;
    }
    try {
      await fetch(`${API_URL}/api/detection/reset`, { method: "POST" }).catch(() => undefined);
      const response = await fetch(`${API_URL}/api/playgrounds/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          script_id: payload.scriptId,
          players: payload.players.map((player) => ({
            name: player.name || "Player",
            is_bot: Boolean(player.isBot),
            bot_level: player.botLevel ?? null,
          })),
        }),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || "Failed to start playground game.");
      }
      const data = await response.json();
      setGameState(data.state as PlaygroundsState);
      setStatus(null);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Failed to start playground game.");
    }
  }, [payload]);

  const advanceWithDart = useCallback(async (dart: { score: number; zone?: string; segment?: number; multiplier?: number }) => {
    try {
      const response = await fetch(`${API_URL}/api/playgrounds/advance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          score: dart.score,
          zone: dart.zone,
          segment: dart.segment,
          multiplier: dart.multiplier,
        }),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || "Failed to advance game.");
      }
      const data = await response.json();
      setGameState(data.state as PlaygroundsState);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Failed to advance game.");
    }
  }, []);

  const handleOpenCorrection = (index: number) => {
    setCorrectionDartIndex(index);
    const dart = currentTurnDarts[index];
    if (dart) {
      setCorrectionOriginalScore({
        score: dart.score,
        multiplier: dart.multiplier,
        segment: String(dart.segment || 0),
        zone: dart.zone || "miss",
      });
    } else {
      setCorrectionOriginalScore(null);
    }
    setCorrectionOpen(true);
  };

  const handleSaveCorrection = useCallback(
    async (correction: { dartIndex: number; multiplier: number; segment: number; score: number }) => {
      try {
        await fetch(`${API_URL}/api/correction/score`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(correction),
        });
        const response = await fetch(`${API_URL}/api/playgrounds/correct`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dartIndex: correction.dartIndex,
            score: correction.score,
            multiplier: correction.multiplier,
            segment: correction.segment,
            zone:
              correction.multiplier === 3
                ? "triple"
                : correction.multiplier === 2
                ? "double"
                : correction.segment === 25
                ? correction.multiplier === 2
                  ? "inner_bull"
                  : "outer_bull"
                : correction.score === 0
                ? "miss"
                : "single_inner",
          }),
        });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        const data = await response.json();
        setGameState(data.state as PlaygroundsState);
      } catch (err) {
        setStatus("Failed to save correction.");
      }
    },
    [setGameState]
  );

  const handleAddDart = useCallback(
    async (correction: { dartIndex: number; multiplier: number; segment: number; score: number }) => {
      try {
        await fetch(`${API_URL}/api/correction/add-dart`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(correction),
        });
        const response = await fetch(`${API_URL}/api/playgrounds/advance`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            score: correction.score,
            multiplier: correction.multiplier,
            segment: correction.segment,
            zone:
              correction.multiplier === 3
                ? "triple"
                : correction.multiplier === 2
                ? "double"
                : correction.segment === 25
                ? correction.multiplier === 2
                  ? "inner_bull"
                  : "outer_bull"
                : correction.score === 0
                ? "miss"
                : "single_inner",
          }),
        });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        const data = await response.json();
        setGameState(data.state as PlaygroundsState);
      } catch (err) {
        setStatus("Failed to add dart.");
      }
    },
    [setGameState]
  );

  const stopGame = useCallback(async () => {
    await fetch(`${API_URL}/api/playgrounds/stop`, { method: "POST" }).catch(() => undefined);
    navigate("/playgrounds", { state: { players: payload?.players } });
  }, [navigate, payload?.players]);

  useEffect(() => {
    startGame();
  }, [startGame]);

  useEffect(() => {
    if (!gameState || gameState.status !== "active") {
      return;
    }
    if (!currentPlayer || !currentPlayer.is_bot) {
      return;
    }
    if (awaitingTakeoutRef.current) {
      return;
    }
    const timer = setTimeout(() => {
      const dart = simulateBotDart(currentPlayer.bot_level);
      advanceWithDart(dart);
    }, 700);
    return () => clearTimeout(timer);
  }, [advanceWithDart, currentPlayer, gameState]);

  useEffect(() => {
    if (!payload) {
      return;
    }
    const unsubscribe = subscribeDetection(async (data) => {
      const liveState = gameStateRef.current;
      const livePlayer = currentPlayerRef.current;
      if (!liveState || liveState.status !== "active" || !livePlayer || livePlayer.is_bot) {
        return;
      }
      if (data.event === "darts_removed") {
        awaitingTakeoutRef.current = false;
        try {
          const response = await fetch(`${API_URL}/api/playgrounds/takeout`, { method: "POST" });
          if (response.ok) {
            const payload = await response.json();
            setGameState(payload.state as PlaygroundsState);
          }
        } catch (err) {
          setStatus("Failed to confirm takeout.");
        }
        return;
      }
      if (data.event !== "dart_detected") {
        return;
      }
      if (liveState.darts_thrown >= liveState.darts_per_turn - 1) {
        awaitingTakeoutRef.current = true;
      }
      try {
        const scoresResponse = await fetch(`${API_URL}/api/detection/scores`);
        const scoresData = await scoresResponse.json();
        const scores = Array.isArray(scoresData?.scores) ? scoresData.scores : [];
        const dartCount = typeof scoresData?.dart_count === "number" ? scoresData.dart_count : scores.length;
        const dartScore =
          scores.length > 0
            ? scores[Math.max(0, Math.min(scores.length - 1, dartCount - 1))]
            : null;
        if (dartScore && typeof dartScore.score === "number") {
          await advanceWithDart({
            score: dartScore.score,
            zone: dartScore.zone,
            segment: dartScore.segment,
            multiplier: dartScore.multiplier,
          });
        }
      } catch (err) {
        setStatus("Failed to read dart score.");
      }
    });
    return () => {
      unsubscribe();
    };
  }, [advanceWithDart, payload]);

  if (!payload) {
    return (
      <div className="min-h-screen w-full bg-black text-white flex items-center justify-center">
        Missing game data. Start from the lobby.
      </div>
    );
  }

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
          onClick={stopGame}
          className="px-4 py-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 transition-colors"
        >
          Exit
        </button>
        <div className="flex-1 text-center md:text-left">
          <h1 className="text-2xl font-extrabold tracking-wide">
            {gameState?.name || "Playground"} <span className="text-red-500">Live</span>
          </h1>
          <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">
            Round {gameState?.round ?? 1}
          </p>
        </div>
        <div className="text-right text-xs text-zinc-500">
          Darts: {gameState?.darts_thrown ?? 0}/{gameState?.darts_per_turn ?? 0}
        </div>
      </header>

      <main className="relative z-10 flex-1 px-6 md:px-10 pb-8">
        <div className="h-full w-full max-w-6xl mx-auto grid grid-cols-1 xl:grid-cols-[1fr_1.1fr] gap-6">
          <div className="bg-zinc-900/60 border border-white/10 rounded-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Current Player</p>
                <p className="text-lg font-semibold">{currentPlayer?.name || "Player"}</p>
              </div>
              <div className="text-right text-sm text-zinc-400">
                {currentPlayer?.is_bot ? `Bot L${currentPlayer.bot_level ?? "-"}` : "Human"}
              </div>
            </div>
            {typeof currentPlayer?.stats?.target_hint === "string" && currentPlayer.stats.target_hint.trim() && (
              <div className="rounded-xl bg-black/50 border border-white/10 p-4 text-sm text-zinc-200">
                <span className="text-zinc-400">Target: </span>
                {currentPlayer.stats.target_hint}
              </div>
            )}
            <div className="rounded-xl bg-black/50 border border-white/10 p-6">
              <p className="text-sm text-zinc-400">Start score</p>
              <p className="text-3xl font-semibold">{gameState?.start_score ?? "--"}</p>
            </div>
            <div className="rounded-xl bg-black/50 border border-white/10 p-6 space-y-2">
              <div className="flex items-center justify-between text-sm text-zinc-400">
                <span>Legs per set</span>
                <span className="text-white">{gameState?.legs_per_set ?? "--"}</span>
              </div>
              <div className="flex items-center justify-between text-sm text-zinc-400">
                <span>Sets to win</span>
                <span className="text-white">{gameState?.sets_to_win ?? "--"}</span>
              </div>
              <div className="flex items-center justify-between text-sm text-zinc-400">
                <span>Win rule</span>
                <span className="text-white">
                  {gameState?.win_condition ?? "--"}
                  {gameState?.win_value != null ? ` (${gameState.win_value})` : ""}
                </span>
              </div>
            </div>
            <div className="rounded-xl bg-black/50 border border-white/10 p-6">
              <div className="flex items-center justify-between text-xs uppercase tracking-[0.25em] text-zinc-500">
                <span>Darts</span>
                <span>Tap to correct</span>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 text-sm">
                {[0, 1, 2].map((index) => {
                  const dart = currentTurnDarts[index];
                  return (
                    <button
                      key={`turn-dart-${index}`}
                      type="button"
                      onClick={() => handleOpenCorrection(index)}
                      className={`rounded-lg border px-2 py-2 text-center transition ${
                        dart
                          ? "border-white/20 bg-white/5 text-white hover:border-red-500/60"
                          : "border-white/10 bg-black/30 text-zinc-400 hover:border-red-500/60"
                      }`}
                    >
                      <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">D{index + 1}</div>
                      <div className="text-lg font-semibold">{formatTurnLabel(dart)}</div>
                      {dart ? (
                        <div className="text-xs text-zinc-500">{dart.score}</div>
                      ) : (
                        <div className="text-xs text-zinc-500">Add</div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="rounded-xl bg-black/50 border border-white/10 p-6">
              <div className="flex items-center justify-between text-xs uppercase tracking-[0.25em] text-zinc-500">
                <span>Zones</span>
                <span>{currentZones.size}/25</span>
              </div>
              <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                {ZONE_LABELS.map((zone) => {
                  const isCleared = currentZones.has(zone.key);
                  return (
                    <div
                      key={zone.key}
                      className={`rounded-lg border px-2 py-1 ${
                        isCleared
                          ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-100"
                          : "border-white/10 bg-black/30 text-zinc-400"
                      }`}
                    >
                      {zone.label}
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 text-xs text-zinc-500">
                Cleared zones are highlighted. Remaining zones are dim.
              </div>
            </div>
            {status && <div className="text-sm text-zinc-400">{status}</div>}
            {gameState?.status === "finished" && gameState.winner_index !== null && (
              <div className="rounded-xl bg-red-600/20 border border-red-500/60 p-4">
                Winner: {gameState.players[gameState.winner_index]?.name || "Player"}
              </div>
            )}
          </div>

          <div className="bg-zinc-900/60 border border-white/10 rounded-2xl p-6 flex flex-col gap-4">
            <h2 className="text-lg font-semibold">Scores</h2>
            <div className="space-y-3">
              {gameState?.players.map((player, index) => {
                const isActive = gameState.current_player_index === index;
                return (
                  <div
                    key={`${player.name}-${index}`}
                    className={`flex items-center justify-between rounded-xl border px-4 py-3 ${
                      isActive ? "border-red-500/60 bg-red-500/10" : "border-white/10 bg-black/40"
                    }`}
                  >
                    <div>
                      <p className="text-sm font-semibold">{player.name}</p>
                      <p className="text-xs text-zinc-400">
                        {player.is_bot ? `Bot L${player.bot_level ?? "-"}` : "Player"}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-semibold">{player.score}</p>
                      <p className="text-xs text-zinc-500">
                        {player.finished ? "Finished" : player.busted ? "Busted" : "--"}
                      </p>
                      <p className="text-xs text-zinc-500">
                        Legs {player.legs_won} • Sets {player.sets_won}
                      </p>
                      {typeof player.zones_cleared === "number" && (
                        <p className="text-xs text-zinc-500">
                          Zones {player.zones_cleared}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </main>

      <ScoreCorrection
        isOpen={correctionOpen}
        onClose={() => setCorrectionOpen(false)}
        dartIndex={correctionDartIndex}
        originalScore={correctionOriginalScore}
        onSaveCorrection={handleSaveCorrection}
        onDeleteImages={(dartIndex) =>
          fetch(`${API_URL}/api/correction/delete-images`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dartIndex }),
          }).catch(() => undefined)
        }
        onAddDart={handleAddDart}
      />
    </div>
  );
}
