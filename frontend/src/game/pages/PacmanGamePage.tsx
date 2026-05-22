import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { LobbyState } from "../context/LobbyContext";
import { startGame as apiStartGame, getGameState as apiGetGameState, stopGame as apiStopGame, forceNextTurn as apiForceNextTurn } from "../services/gameApi";
import { useGameStateSync } from "../services/useGameStateSync";
import ScoreCorrection from "../components/ScoreCorrection";
import GameRecalibrateButton from "../components/game/GameRecalibrateButton";
import { addDart, correctScore, deleteCorrectionImages } from "../services/correctionApi";

type DartResult = {
  playerIndex: number;
  score: number;
  targetKey: string;
  atePellet: boolean;
  lifeLost: boolean;
  rawScore?: {
    score?: number;
    multiplier?: number;
    segment?: string | number;
    zone?: string;
    confidence?: number;
  } | null;
};

type PacmanPlayerState = {
  name: string;
  score: number;
  lives: number;
  gameOver: boolean;
  pelletsRemaining: number;
  pelletsEaten: number;
  pellets: string[];
  lastPacmanTarget?: string | null;
};

type PacmanState = {
  mode: "pacman";
  settings: {
    livesPerPlayer: number;
    totalPellets: number;
    pelletKeys: string[];
  };
  players: PacmanPlayerState[];
  currentPlayer: number;
  currentTurn: {
    darts: (DartResult | null)[];
    scored: number;
    livesLost: number;
  };
  lastCompletedTurn: (DartResult | null)[];
  winnerIndex: number | null;
  match?: {
    matchWinner?: number | null;
  };
};

type LocationState = Partial<LobbyState>;

const SEGMENT_ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];

const BOARD = {
  cx: 250,
  cy: 250,
  rDoubleOuter: 220,
  rDoubleInner: 209.6,
  rTripleOuter: 138.5,
  rTripleInner: 128.1,
  rOuterBull: 20.6,
  rInnerBull: 8.2,
  rNumber: 238,
};

function polar(cx: number, cy: number, r: number, degrees: number): { x: number; y: number } {
  const rad = (degrees * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function wedgePath(startDeg: number, endDeg: number, rOuter: number, rInner: number): string {
  const p1 = polar(BOARD.cx, BOARD.cy, rOuter, startDeg);
  const p2 = polar(BOARD.cx, BOARD.cy, rOuter, endDeg);
  const p3 = polar(BOARD.cx, BOARD.cy, rInner, endDeg);
  const p4 = polar(BOARD.cx, BOARD.cy, rInner, startDeg);
  return `M ${p1.x} ${p1.y} A ${rOuter} ${rOuter} 0 0 1 ${p2.x} ${p2.y} L ${p3.x} ${p3.y} A ${rInner} ${rInner} 0 0 0 ${p4.x} ${p4.y} Z`;
}

function targetToPoint(targetKey: string): { x: number; y: number } | null {
  if (targetKey === "IB") return { x: BOARD.cx, y: BOARD.cy };
  if (targetKey === "OB") return { x: BOARD.cx, y: BOARD.cy - (BOARD.rOuterBull + BOARD.rInnerBull) / 2 };

  let ring = "";
  let seg = 0;
  if (targetKey.startsWith("SI") || targetKey.startsWith("SO")) {
    ring = targetKey.slice(0, 2);
    seg = Number(targetKey.slice(2));
  } else {
    ring = targetKey.charAt(0);
    seg = Number(targetKey.slice(1));
  }
  if (!Number.isFinite(seg) || seg < 1 || seg > 20) return null;
  const idx = SEGMENT_ORDER.indexOf(seg);
  if (idx < 0) return null;

  const angleDeg = -90 + idx * 18;
  let radius = 0;
  if (ring === "T") radius = (BOARD.rTripleInner + BOARD.rTripleOuter) / 2;
  else if (ring === "D") radius = (BOARD.rDoubleInner + BOARD.rDoubleOuter) / 2;
  else if (ring === "SI") radius = (BOARD.rOuterBull + BOARD.rTripleInner) / 2;
  else if (ring === "SO") radius = (BOARD.rTripleOuter + BOARD.rDoubleInner) / 2;
  else radius = (BOARD.rTripleOuter + BOARD.rDoubleInner) / 2;

  return polar(BOARD.cx, BOARD.cy, radius, angleDeg);
}

function MachinePacmanIcon({
  x,
  y,
  size = 40,
}: {
  x: number;
  y: number;
  size?: number;
}) {
  const s = size / 320;

  return (
    <g transform={`translate(${x} ${y}) scale(${s}) translate(-160 -160)`}>
      <defs>
        <radialGradient id="machinePacmanBody" cx="35%" cy="30%" r="80%">
          <stop offset="0%" stopColor="#ff5050" />
          <stop offset="42%" stopColor="#d00000" />
          <stop offset="78%" stopColor="#7a0000" />
          <stop offset="100%" stopColor="#0a0a0a" />
        </radialGradient>

        <radialGradient id="machinePacmanGloss" cx="30%" cy="25%" r="55%">
          <stop offset="0%" stopColor="rgba(255,255,255,0.35)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </radialGradient>

        <filter id="machinePacmanGlow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="12" result="blur1" />
          <feColorMatrix
            in="blur1"
            type="matrix"
            values="
              1 0 0 0 0
              0 0.18 0 0 0
              0 0 0.18 0 0
              0 0 0 1 0"
            result="redGlow"
          />
          <feMerge>
            <feMergeNode in="redGlow" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <g filter="url(#machinePacmanGlow)">
        <circle cx="160" cy="160" r="122" fill="rgba(255,0,0,0.16)" />

        <circle
          cx="160"
          cy="160"
          r="112"
          fill="url(#machinePacmanBody)"
          stroke="#ff2a2a"
          strokeWidth="8"
        />

        <ellipse
          cx="130"
          cy="120"
          rx="72"
          ry="56"
          fill="url(#machinePacmanGloss)"
          opacity="0.45"
        />

        <ellipse
          cx="165"
          cy="220"
          rx="72"
          ry="34"
          fill="rgba(0,0,0,0.28)"
        />

        <path
          d="M160 160 L262 94 A116 116 0 0 1 262 226 Z"
          fill="#020202"
        />

        <circle
          cx="108"
          cy="138"
          r="24"
          fill="#0a0a0a"
          stroke="#ff3333"
          strokeWidth="5"
        />

        <circle cx="108" cy="138" r="9" fill="#ff3b3b" />

        <path d="M150 106 L206 118 L164 146 Z" fill="#050505" />

        <path
          d="M96 202 H186"
          stroke="#050505"
          strokeWidth="14"
          strokeLinecap="round"
        />
        <path
          d="M110 182 V222 M132 182 V222 M154 182 V222 M176 182 V222"
          stroke="#ff3b3b"
          strokeWidth="5"
          strokeLinecap="round"
        />

        <path
          d="M92 108 Q108 72 144 60"
          stroke="#ff3131"
          strokeWidth="6"
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M94 238 Q120 262 156 266"
          stroke="#ff3131"
          strokeWidth="6"
          fill="none"
          strokeLinecap="round"
        />

        <path
          d="M106 84 Q122 76 136 74"
          stroke="rgba(255,255,255,0.18)"
          strokeWidth="6"
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M92 258 Q118 280 148 284"
          stroke="rgba(255,255,255,0.14)"
          strokeWidth="5"
          fill="none"
          strokeLinecap="round"
        />
      </g>
    </g>
  );
}

function PacmanBoard({ player }: { player: PacmanPlayerState | null }) {
  const pelletPoints = useMemo(() => {
    const points: Array<{ x: number; y: number; key: string }> = [];
    for (const key of player?.pellets ?? []) {
      const p = targetToPoint(key);
      if (p) points.push({ ...p, key });
    }
    return points;
  }, [player]);

  const pacmanPoint = useMemo(() => {
    const key = player?.lastPacmanTarget || "";
    return targetToPoint(key);
  }, [player?.lastPacmanTarget]);

  return (
    <svg
      viewBox="0 0 500 500"
      className="w-full mx-auto rounded-2xl border border-cyan-400/30 bg-black/70 shadow-[0_0_30px_rgba(34,211,238,0.12)]"
      style={{ width: "min(100%, calc(100vh - 260px))", maxWidth: 920 }}
    >
      <defs>
        <radialGradient id="boardGlow" cx="50%" cy="50%" r="65%">
          <stop offset="0%" stopColor="#0f172a" />
          <stop offset="100%" stopColor="#020617" />
        </radialGradient>
        <filter id="pelletGlow" x="-300%" y="-300%" width="700%" height="700%">
          <feGaussianBlur stdDeviation="2.2" result="blur" />
          <feColorMatrix
            in="blur"
            type="matrix"
            values="
              1 0 0 0 0
              0 1 0 0 0
              0 0 0 0 0
              0 0 0 1 0"
            result="glow"
          />
          <feMerge>
            <feMergeNode in="glow" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <circle cx={BOARD.cx} cy={BOARD.cy} r={BOARD.rDoubleOuter + 18} fill="url(#boardGlow)" />

      {Array.from({ length: 20 }).map((_, i) => {
        const start = -99 + i * 18;
        const end = start + 18;
        // Standard board parity:
        // - 20 segment single areas are dark (black)
        // - 20 segment double/triple are red
        const isLightSingle = i % 2 !== 0;
        const isRedRing = i % 2 === 0;

        return (
          <g key={`seg-${i}`}>
            <path d={wedgePath(start, end, BOARD.rDoubleInner, BOARD.rTripleOuter)} fill={isLightSingle ? "#f3e8d0" : "#121212"} stroke="#202020" strokeWidth="0.9" />
            <path d={wedgePath(start, end, BOARD.rTripleInner, BOARD.rOuterBull)} fill={isLightSingle ? "#f3e8d0" : "#121212"} stroke="#202020" strokeWidth="0.9" />
            <path d={wedgePath(start, end, BOARD.rDoubleOuter, BOARD.rDoubleInner)} fill={isRedRing ? "#d92f2f" : "#0f9f4a"} stroke="#202020" strokeWidth="0.9" />
            <path d={wedgePath(start, end, BOARD.rTripleOuter, BOARD.rTripleInner)} fill={isRedRing ? "#d92f2f" : "#0f9f4a"} stroke="#202020" strokeWidth="0.9" />
          </g>
        );
      })}

      <circle cx={BOARD.cx} cy={BOARD.cy} r={BOARD.rOuterBull} fill="#0f9f4a" stroke="#202020" strokeWidth="1" />
      <circle cx={BOARD.cx} cy={BOARD.cy} r={BOARD.rInnerBull} fill="#d92f2f" stroke="#202020" strokeWidth="1" />

      {SEGMENT_ORDER.map((num, i) => {
        const p = polar(BOARD.cx, BOARD.cy, BOARD.rNumber, -90 + i * 18);
        return (
          <text
            key={`num-${num}`}
            x={p.x}
            y={p.y}
            fill="#e5e7eb"
            fontSize="17"
            fontFamily="'Courier New', monospace"
            textAnchor="middle"
            dominantBaseline="middle"
            style={{ textShadow: "0 0 6px rgba(56,189,248,0.4)" }}
          >
            {num}
          </text>
        );
      })}

      {pelletPoints.map((p) => (
        <g key={p.key} filter="url(#pelletGlow)">
          <circle cx={p.x} cy={p.y} r="8.2" fill="rgba(253,224,71,0.24)" />
          <circle cx={p.x} cy={p.y} r="5.2" fill="#facc15" />
          <circle cx={p.x} cy={p.y} r="2.2" fill="#fff7b3" />
        </g>
      ))}

      {pacmanPoint && (
        <MachinePacmanIcon
          x={pacmanPoint.x}
          y={pacmanPoint.y}
          size={40}
        />
      )}
    </svg>
  );
}

export default function PacmanGamePage() {
  const navigate = useNavigate();
  const { state } = useLocation() as { state?: LocationState };
  const [gameState, setGameState] = useState<PacmanState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [selectedDartIndex, setSelectedDartIndex] = useState(-1);
  const startedRef = useRef(false);
  const navigatedRef = useRef(false);
  const statsMatchIdRef = useRef(`pacman-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

  const playerConfigs = useMemo(() => {
    const fromLobby = state?.players ?? [];
    if (!fromLobby.length) {
      return [{ name: "Player 1", isBot: false }, { name: "Player 2", isBot: false }];
    }
    return fromLobby.map((p, idx) => ({
      name: p?.name?.trim() || `Player ${idx + 1}`,
      isBot: Boolean(p?.isBot),
      botLevel: p?.botLevel,
    }));
  }, [state?.players]);

  const start = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiStartGame<PacmanState>("pacman", {
        players: playerConfigs,
        livesPerPlayer: Number(state?.pacman?.livesPerPlayer ?? 5),
        startingPlayer: Number(state?.startingPlayer ?? 0),
      });
      setGameState(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start PacDarts");
    } finally {
      setLoading(false);
    }
  }, [playerConfigs, state?.pacman?.livesPerPlayer, state?.startingPlayer]);

  const fetchState = useCallback(async () => {
    try {
      const data = await apiGetGameState<PacmanState>("pacman");
      setGameState(data);
    } catch {
      // ignore transient poll errors
    }
  }, []);

  useEffect(() => {
    if (!startedRef.current) {
      startedRef.current = true;
      void start();
    }
  }, [start]);

  useGameStateSync({
    enabled: Boolean(gameState) && !navigatedRef.current,
    refresh: fetchState,
    debounceMs: 120,
    pollMs: 0,
  });

  useEffect(() => {
    const winner = gameState?.match?.matchWinner ?? gameState?.winnerIndex;
    if (winner == null || navigatedRef.current) return;
    navigatedRef.current = true;
    navigate("/pacman/stats", {
      state: {
        ...gameState,
        _statsMatchId: statsMatchIdRef.current,
      },
    });
  }, [gameState, navigate]);

  const handleAbort = async () => {
    navigatedRef.current = true;
    await apiStopGame("pacman").catch(() => undefined);
    navigate("/lobby");
  };

  const handleForceTurn = async () => {
    try {
      const data = await apiForceNextTurn<PacmanState>("pacman");
      setGameState(data);
    } catch {
      // ignore
    }
  };

  const openCorrection = (dartIndex: number) => {
    setSelectedDartIndex(dartIndex);
    setCorrectionOpen(true);
  };

  const selectedOriginalScore = useMemo(() => {
    if (!gameState || selectedDartIndex < 0 || selectedDartIndex > 2) return null;
    const dart = gameState.currentTurn?.darts?.[selectedDartIndex];
    if (!dart?.rawScore) return null;
    const seg = String(dart.rawScore.segment ?? "0");
    return {
      score: Number(dart.rawScore.score ?? dart.score ?? 0),
      multiplier: Number(dart.rawScore.multiplier ?? 1),
      segment: seg,
      zone: String(dart.rawScore.zone ?? "single"),
    };
  }, [gameState, selectedDartIndex]);

  const handleSaveCorrection = async (correction: {
    dartIndex: number;
    multiplier: number;
    segment: number;
    score: number;
    zone?: "single_inner" | "single_outer" | "single" | "double" | "triple" | "outer_bull" | "inner_bull" | "miss";
  }) => {
    try {
      await correctScore(correction);
      await fetchState();
    } catch (err) {
      console.error("Failed to correct Pacman dart", err);
    } finally {
      setCorrectionOpen(false);
    }
  };

  const handleAddDart = async (correction: {
    dartIndex: number;
    multiplier: number;
    segment: number;
    score: number;
    zone?: "single_inner" | "single_outer" | "single" | "double" | "triple" | "outer_bull" | "inner_bull" | "miss";
  }) => {
    try {
      await addDart(correction);
      await fetchState();
    } catch (err) {
      console.error("Failed to add Pacman dart", err);
    } finally {
      setCorrectionOpen(false);
    }
  };

  if (loading) {
    return <div className="min-h-screen bg-[#03040b] text-cyan-200 flex items-center justify-center font-mono">Loading PacDarts mode...</div>;
  }
  if (error || !gameState) {
    return (
      <div className="min-h-screen bg-[#03040b] text-cyan-200 flex items-center justify-center font-mono">
        <div className="text-center">
          <p className="text-rose-400 text-lg mb-4">{error || "Failed to load game"}</p>
          <button onClick={() => navigate("/lobby")} className="px-4 py-2 rounded border border-cyan-400/40 bg-black/60 hover:bg-black/80">Lobby</button>
        </div>
      </div>
    );
  }

  const currentPlayer = gameState.players[gameState.currentPlayer] ?? null;

  return (
    <div
      className="min-h-screen text-cyan-100 p-4 md:p-6 font-mono"
      style={{
        background:
          "radial-gradient(1200px 700px at 20% -20%, rgba(34,211,238,0.16), transparent 50%), radial-gradient(1000px 600px at 120% 20%, rgba(34,197,94,0.14), transparent 45%), #02040a",
      }}
    >
      <div className="pointer-events-none fixed inset-0 opacity-20" style={{ backgroundImage: "repeating-linear-gradient(0deg, rgba(255,255,255,0.05) 0px, rgba(255,255,255,0.05) 1px, transparent 2px, transparent 4px)" }} />

      <div className="relative w-full max-w-[1760px] mx-auto space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-cyan-400/30 bg-black/50 p-4 shadow-[0_0_24px_rgba(34,211,238,0.15)]">
          <div>
            <h1 className="text-2xl font-bold tracking-wider" style={{ textShadow: "0 0 12px rgba(34,211,238,0.5)" }}>PACDARTS</h1>
            <p className="text-cyan-300/80 text-xs uppercase tracking-[0.2em]">Eat pellets with S/D/T/Bull. Empty hit costs 1 life.</p>
          </div>
          <div className="flex gap-2">
            <GameRecalibrateButton className="border-cyan-400/50 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-100" />
            <button onClick={handleForceTurn} className="px-3 py-2 rounded-lg border border-fuchsia-400/50 bg-fuchsia-500/10 hover:bg-fuchsia-500/20 text-sm">Force Next Turn</button>
            <button onClick={handleAbort} className="px-3 py-2 rounded-lg border border-rose-400/50 bg-rose-500/10 hover:bg-rose-500/20 text-sm">Abort</button>
          </div>
        </header>

        <section className="grid grid-cols-1 xl:grid-cols-[1.15fr_0.85fr] gap-4 items-start">
          <div className="rounded-2xl border border-cyan-400/30 bg-black/50 p-4 shadow-[0_0_22px_rgba(34,211,238,0.12)]">
            <h2 className="text-xs uppercase tracking-[0.24em] text-cyan-300/70 mb-3">
              Current Player Board: {currentPlayer?.name ?? "-"}
            </h2>
            <div className="flex justify-center">
              <PacmanBoard player={currentPlayer} />
            </div>
          </div>

          <div className="rounded-2xl border border-cyan-400/30 bg-black/50 p-5 space-y-4 shadow-[0_0_22px_rgba(34,211,238,0.12)] min-h-[620px]">
            <h2 className="text-xs uppercase tracking-[0.24em] text-cyan-300/70">Players</h2>
            {gameState.players.map((p, idx) => (
              <div
                key={`${p.name}-${idx}`}
                className={`rounded-xl border px-5 py-4 ${
                  idx === gameState.currentPlayer ? "border-emerald-400/70 bg-emerald-500/10" : "border-cyan-300/20 bg-black/40"
                }`}
              >
                <div className="flex items-center justify-between">
                  <p className="font-bold text-cyan-50 text-2xl tracking-wide">{p.name}</p>
                  <p className="text-emerald-300 font-extrabold text-4xl leading-none">{p.score}</p>
                </div>
                <div className="mt-3 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <span className="text-sm uppercase tracking-[0.24em] text-cyan-200/70">Lives</span>
                    <span className="text-yellow-300 text-2xl leading-none" aria-label={`Lives ${p.lives}`}>
                      {"★".repeat(Math.max(0, p.lives))}
                    </span>
                  </div>
                  <span className="text-base text-cyan-200/85">Pellets left: {p.pelletsRemaining}</span>
                </div>
                {p.gameOver && <div className="mt-3 text-base font-semibold text-rose-300">Game Over</div>}
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-cyan-400/30 bg-black/50 p-4 shadow-[0_0_22px_rgba(34,211,238,0.12)]">
          <h2 className="text-xs uppercase tracking-[0.24em] text-cyan-300/70 mb-3">Current Turn</h2>
          <div className="grid grid-cols-3 gap-3">
            {gameState.currentTurn.darts.map((dart, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => openCorrection(idx)}
                className="rounded-lg border border-cyan-300/20 bg-black/45 p-4 min-h-[108px] text-left hover:border-cyan-300/50 hover:bg-cyan-900/10 transition-colors"
              >
                <p className="text-sm text-cyan-300/70 mb-2">Dart {idx + 1}</p>
                {!dart ? (
                  <p className="text-cyan-300/40 text-lg">-</p>
                ) : (
                  <>
                    <p className="text-xl font-bold text-cyan-100">{dart.targetKey}</p>
                    <p className={`text-xl font-extrabold ${dart.atePellet ? "text-emerald-300" : "text-rose-300"}`}>
                      {dart.atePellet ? `+${dart.score}` : "-1 life"}
                    </p>
                  </>
                )}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-cyan-300/45 uppercase tracking-[0.18em]">Click a dart box to correct or add a missed dart.</p>
        </section>
      </div>

      <ScoreCorrection
        isOpen={correctionOpen}
        onClose={() => setCorrectionOpen(false)}
        dartIndex={selectedDartIndex}
        originalScore={selectedOriginalScore}
        onSaveCorrection={handleSaveCorrection}
        onDeleteImages={deleteCorrectionImages}
        onAddDart={handleAddDart}
      />
    </div>
  );
}
