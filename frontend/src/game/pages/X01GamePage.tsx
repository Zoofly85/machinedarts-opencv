import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Crown, Target, TrendingUp, Trophy } from "lucide-react";
import { getFlavorConfig } from "../../config/productFlavor";
import ScoreCorrection from "../components/ScoreCorrection";
import GameHeader from "../components/game/GameHeader";
import { GameControlButton } from "../components/game/GameControl";
import type { LobbyState, PlayerConfig } from "../context/LobbyContext";
import { addDart, correctScore, deleteCorrectionImages } from "../services/correctionApi";
import { startGame as apiStartGame, getGameState as apiGetGameState, stopGame as apiStopGame, forceNextTurn as apiForceNextTurn, undoTurn as apiUndoTurn } from "../services/gameApi";
import { recordTournamentMatchResult } from "../services/tournamentsApi";
import { useGameStateSync } from "../services/useGameStateSync";
import { computeCheckoutSuggestionsLocal } from "../services/x01CheckoutLocal";
import { API_BASE_URL } from "../../services/api";

const API_URL = API_BASE_URL;
const REPLAY_BOARD_INTRO_MS = 3000;
const REPLAY_PLAYER_FRAME_MAX_MS = 250;

interface DartScore {
  score: number;
  multiplier: number;
  segment: string;
  zone: string;
  confidence: number;
}

interface LocationState extends Partial<LobbyState> {
  tournamentMatch?: {
    tournamentId: string;
    matchId: string;
    participantIds: string[];
  };
}

interface ReplayFrame {
  dart_index: number;
  score_value: number;
  image: string;
  label?: string;
  ts_ms?: number;
}

interface ReplayPayload {
  boardFrames: ReplayFrame[];
  playerFrames: ReplayFrame[];
  playerCameraIndex: number | null;
}

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
  botTurnActive?: boolean;
  turnInputArmed?: boolean;
  turnInputReason?: "ready" | "bot_turn_active" | "bot_player_turn" | "match_complete" | string;
}

type GifMatchType = "exact_score" | "min_score" | "any_checkout" | "exact_checkout" | "min_checkout";

interface GifReactionRule {
  id: string;
  label: string;
  match_type: GifMatchType;
  score: number | null;
  gifs: string[];
}

interface GifReactionSettings {
  enabled: boolean;
  duration_ms: number;
  score_rules: GifReactionRule[];
  checkout_rules: GifReactionRule[];
  set_won_gifs: string[];
  match_won_gifs: string[];
}

interface ActiveGifReaction {
  src: string;
  label: string;
  isVideo: boolean;
}

const TEAM_COLOR_FALLBACKS = ["#ef4444", "#3b82f6", "#10b981", "#f59e0b"];

function resolveTeamColor(team: Pick<X01TeamState, "teamId" | "teamName" | "teamColor">): string {
  const name = team.teamName.toLowerCase();
  if (name.includes("blue")) return "#3b82f6";
  if (name.includes("green")) return "#10b981";
  if (name.includes("yellow")) return "#f59e0b";
  if (name.includes("red")) return "#ef4444";
  if (team.teamColor && /^#[0-9a-f]{6}$/i.test(team.teamColor)) return team.teamColor;
  return TEAM_COLOR_FALLBACKS[Math.abs(team.teamId) % TEAM_COLOR_FALLBACKS.length];
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

function dartScoreFromEvent(data: Record<string, any>, scoreValue: number): DartScore {
  const raw = data?.score && typeof data.score === "object" ? data.score : {};
  const rawSegment = raw.segment ?? data?.segment ?? (scoreValue > 0 ? scoreValue : 0);
  const multiplier = Math.max(0, Math.trunc(Number(raw.multiplier ?? data?.multiplier ?? 1) || 1));
  const segment = String(rawSegment ?? "0");
  const zone = String(raw.zone ?? data?.zone ?? (scoreValue <= 0 ? "miss" : multiplier === 3 ? "triple" : multiplier === 2 ? "double" : "single"));
  return {
    score: Math.trunc(Number(raw.score ?? data?.score_value ?? scoreValue) || 0),
    multiplier,
    segment,
    zone,
    confidence: Number(raw.confidence ?? data?.confidence ?? 1) || 1,
  };
}

function pickRandomItem<T>(items: T[]): T | null {
  if (!items.length) return null;
  return items[Math.floor(Math.random() * items.length)] ?? null;
}

function gifFileUrl(filePath: string): string {
  return `${API_URL}/api/gif-reactions/files/content?path=${encodeURIComponent(filePath)}`;
}

function isVideoReaction(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".mp4") || lower.endsWith(".webm");
}

function ruleMatches(rule: GifReactionRule, value: number, checkout: boolean): boolean {
  const score = Number(rule.score ?? 0);
  if (rule.match_type === "any_checkout") return checkout;
  if (rule.match_type === "exact_score") return !checkout && value === score;
  if (rule.match_type === "min_score") return !checkout && value >= score;
  if (rule.match_type === "exact_checkout") return checkout && value === score;
  if (rule.match_type === "min_checkout") return checkout && value >= score;
  return false;
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
    doubleInner: 80,
    trebleOuter: 53.5,
    trebleInner: 49,
    bullOuter: 7.95,
    bullInner: 3.175,
  } as const;

  const order = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
  const seg = (Math.PI * 2) / 20;
  const boardStart = -Math.PI / 2 - seg / 2;

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
        const a0 = boardStart + i * seg;
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
        const a0 = boardStart + i * seg;
        const a1 = a0 + seg;
        const fill = i % 2 === 0 ? ringColors.doubleRed : ringColors.doubleGreen;
        return <Wedge key={`double-${i}`} r1={R.doubleInner} r2={R.doubleOuter} a0={a0} a1={a1} fill={fill} />;
      })}
      {segments.map((_, i) => {
        const a0 = boardStart + i * seg;
        const a1 = a0 + seg;
        const fill = i % 2 === 0 ? ringColors.trebleGreen : ringColors.trebleRed;
        return <Wedge key={`treble-${i}`} r1={R.trebleInner} r2={R.trebleOuter} a0={a0} a1={a1} fill={fill} />;
      })}
      <circle r={R.bullOuter} fill={ringColors.bull} />
      <circle r={R.bullInner} fill={ringColors.bullseye} />
      <circle r={R.outer} fill="none" stroke="#0b0b0b" strokeWidth={2} />
      {segments.map((_, i) => {
        const a = boardStart + i * seg + seg / 2;
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

type ChalkVisit = {
  scored: number;
  left: number;
};

const ChalkboardPlayerCard = React.memo(({
  player,
  index,
  isActive,
  isWinner,
  detectionState,
  getDisplayName,
  visits,
  legAverage,
  legDarts,
  teamColor,
}: {
  player: X01PlayerStateBackend;
  index: number;
  isActive: boolean;
  isWinner: boolean;
  detectionState?: string;
  getDisplayName: (index: number) => string;
  visits: ChalkVisit[];
  legAverage: number | null;
  legDarts: number;
  teamColor?: string;
}) => {
  const badge = isWinner ? "Winner" : isActive ? "Throwing" : "Waiting";
  const activeTeamStyle =
    isActive && teamColor
      ? {
          borderColor: teamColor,
          boxShadow: `0 0 0 1px ${teamColor}99, 0 0 38px ${teamColor}88, 0 0 90px ${teamColor}33`,
        }
      : undefined;

  return (
    <div className={`relative overflow-hidden rounded-[24px] border p-5 min-h-[320px] ${
      isWinner
        ? "border-emerald-500/70 bg-emerald-950/10 shadow-[0_0_0_1px_rgba(16,185,129,0.25),0_0_28px_rgba(16,185,129,0.28)]"
        : isActive
        ? detectionState === "removing_darts"
          ? "border-blue-500 bg-blue-950/20 ring-2 ring-blue-500/55 shadow-[0_0_0_1px_rgba(59,130,246,0.4),0_0_36px_rgba(59,130,246,0.45),0_0_80px_rgba(59,130,246,0.2)]"
          : detectionState === "partial_takeout"
            ? "border-yellow-400 bg-yellow-950/20 ring-2 ring-yellow-400/55 shadow-[0_0_0_1px_rgba(250,204,21,0.4),0_0_36px_rgba(250,204,21,0.45),0_0_80px_rgba(250,204,21,0.2)]"
          : "border-red-500 bg-red-950/20 ring-2 ring-red-500/55 shadow-[0_0_0_1px_rgba(239,68,68,0.4),0_0_36px_rgba(239,68,68,0.45),0_0_80px_rgba(239,68,68,0.2)]"
        : "border-white/10 bg-black/40 shadow-xl"
    }`} style={activeTeamStyle}>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.08),transparent_30%),radial-gradient(circle_at_bottom_right,rgba(255,0,0,0.08),transparent_35%)]" />

      <div className="relative flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.26em] text-zinc-500">Player</div>
          <div className="mt-1 text-xl font-bold text-white">{getDisplayName(index)}</div>
        </div>
        <div className={`rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] ${
          isWinner
            ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
            : isActive
            ? detectionState === "removing_darts"
              ? "bg-blue-500/15 text-blue-300 border border-blue-500/30"
              : detectionState === "partial_takeout"
                ? "bg-yellow-400/15 text-yellow-300 border border-yellow-400/30"
                : "bg-red-500/15 text-red-300 border border-red-500/30"
            : "bg-white/5 text-zinc-300 border border-white/10"
        }`}>
          {badge}
        </div>
      </div>

      <div className="relative mt-4 grid grid-cols-[0.75fr_1.25fr] gap-3 h-[calc(100%-52px)]">
        <div className="order-2 rounded-2xl border border-white/10 bg-zinc-900/70 p-3.5 flex flex-col">
          <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-[0.2em] text-zinc-400">
            <span className="flex items-center gap-1">
              <Target className="h-3.5 w-3.5" />
              Chalkboard
            </span>
            <span>Last 5</span>
          </div>
          <div className="rounded-xl border border-white/10 bg-[#1a1f1c] overflow-hidden flex-1">
            <div className="grid grid-cols-2 text-[10px] uppercase tracking-[0.2em] text-zinc-400 bg-black/20">
              <div className="px-3 py-2 border-r border-white/10">Scored</div>
              <div className="px-3 py-2">Left</div>
            </div>
            {Array.from({ length: 5 }).map((_, i) => {
              const visit = visits[i];
              return (
                <div key={i} className="grid grid-cols-2 border-t border-white/10">
                  <div className="px-3 py-2.5 text-[1.35rem] leading-tight tabular-nums text-zinc-100 border-r border-white/10">{visit ? visit.scored : "-"}</div>
                  <div className="px-3 py-2.5 text-right text-[1.35rem] leading-tight tabular-nums text-zinc-100">{visit ? visit.left : "-"}</div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="order-1 flex flex-col h-full">
          <div className="rounded-2xl border border-white/10 bg-zinc-900/75 px-4 py-4 flex-1 flex flex-col justify-between min-h-[190px]">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Remaining</div>
            <div className="text-8xl font-black leading-none text-white tabular-nums">{player.score}</div>
            <div className="text-lg text-zinc-100 space-y-1.5">
              <div className="flex items-center gap-1">
                <TrendingUp className="h-5 w-5" />
                <span>Match Avg {player.average.toFixed(2)}</span>
              </div>
              <div className="pl-6">Leg Avg {legAverage !== null ? legAverage.toFixed(2) : "--"}</div>
              <div className="pl-6">Leg Darts {legDarts}</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 mt-3">
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="flex items-center gap-1 text-zinc-400 text-[10px] uppercase tracking-[0.2em]">
                <Trophy className="h-3.5 w-3.5" />
                Legs
              </div>
              <div className="mt-1 text-3xl font-bold text-white tabular-nums">{player.legsWon}</div>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="flex items-center gap-1 text-zinc-400 text-[10px] uppercase tracking-[0.2em]">
                <Crown className="h-3.5 w-3.5" />
                Sets
              </div>
              <div className="mt-1 text-3xl font-bold text-white tabular-nums">{player.setsWon}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

ChalkboardPlayerCard.displayName = "ChalkboardPlayerCard";

const TeamChalkboardCard = React.memo(({
  team,
  players,
  currentPlayerIndex,
  isActive,
  isWinner,
  detectionState,
  visits,
  average,
  darts,
}: {
  team: X01TeamState;
  players: X01PlayerStateBackend[];
  currentPlayerIndex: number;
  isActive: boolean;
  isWinner: boolean;
  detectionState?: string;
  visits: ChalkVisit[];
  average: number | null;
  darts: number;
}) => {
  const teamColor = resolveTeamColor(team);
  const activeBorderStyle =
    isActive || isWinner
      ? {
          borderColor: teamColor,
          boxShadow: `0 0 0 1px ${teamColor}cc, 0 0 34px ${teamColor}aa, 0 0 82px ${teamColor}55`,
        }
      : {
          borderColor: `${teamColor}66`,
          boxShadow: `0 0 0 1px ${teamColor}22`,
        };
  const badge = isWinner ? "Winner" : isActive ? "Throwing" : "Waiting";
  const activePlayerName =
    team.playerIndices.includes(currentPlayerIndex)
      ? players[currentPlayerIndex]?.name || `Player ${currentPlayerIndex + 1}`
      : null;

  return (
    <div
      className={`relative overflow-hidden rounded-[24px] border p-5 min-h-[340px] bg-black/45 transition ${
        isActive
          ? detectionState === "removing_darts"
            ? "bg-blue-950/15 ring-2"
            : detectionState === "partial_takeout"
              ? "bg-yellow-950/15 ring-2"
              : "ring-2"
          : ""
      }`}
      style={{
        ...activeBorderStyle,
        ...(isActive || isWinner ? ({ "--tw-ring-color": `${teamColor}88` } as React.CSSProperties) : {}),
      }}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-35"
        style={{
          background: `radial-gradient(circle at top left, ${teamColor}55, transparent 34%), radial-gradient(circle at bottom right, ${teamColor}22, transparent 38%)`,
        }}
      />
      <div className="relative flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.26em] text-zinc-500">Team</div>
          <div className="mt-1 flex items-center gap-2 text-xl font-bold text-white">
            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: teamColor }} />
            <span className="truncate">{team.teamName}</span>
          </div>
          {activePlayerName && (
            <div className="mt-2 text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: teamColor }}>
              {activePlayerName} up
            </div>
          )}
        </div>
        <div className="text-right">
          <div className="text-6xl font-black leading-none text-white tabular-nums">{team.score}</div>
          <div className="mt-2 rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-200 border-white/15 bg-white/5">
            {badge}
          </div>
        </div>
      </div>

      <div className="relative mt-5 grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="rounded-2xl border border-white/10 bg-zinc-950/70 p-4">
          <div className="mb-3 flex items-center justify-between text-[11px] uppercase tracking-[0.2em] text-zinc-400">
            <span className="flex items-center gap-1">
              <Target className="h-3.5 w-3.5" />
              Chalkboard
            </span>
            <span>Last 5</span>
          </div>
          <div className="rounded-xl border border-white/10 bg-[#1a1f1c] overflow-hidden">
            <div className="grid grid-cols-2 text-[10px] uppercase tracking-[0.2em] text-zinc-400 bg-black/20">
              <div className="px-3 py-2 border-r border-white/10">Scored</div>
              <div className="px-3 py-2 text-right">Left</div>
            </div>
            {Array.from({ length: 5 }).map((_, i) => {
              const visit = visits[i];
              return (
                <div key={i} className="grid grid-cols-2 border-t border-white/10">
                  <div className="px-3 py-2.5 text-[1.35rem] leading-tight tabular-nums text-zinc-100 border-r border-white/10">{visit ? visit.scored : "-"}</div>
                  <div className="px-3 py-2.5 text-right text-[1.35rem] leading-tight tabular-nums text-zinc-100">{visit ? visit.left : "-"}</div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col justify-between gap-4">
          <div className="rounded-2xl border border-white/10 bg-zinc-950/70 p-4">
            <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Members</div>
            <div className="mt-3 flex flex-col gap-2">
              {team.playerIndices.map((playerIdx) => {
                const isCurrent = playerIdx === currentPlayerIndex;
                return (
                  <span
                    key={playerIdx}
                    className={`rounded-lg px-3 py-2 text-base font-bold leading-tight ${
                      isCurrent ? "text-white" : "text-zinc-200 bg-white/5"
                    }`}
                    style={isCurrent ? { backgroundColor: `${teamColor}55`, boxShadow: `0 0 18px ${teamColor}55` } : undefined}
                  >
                    {players[playerIdx]?.name || `Player ${playerIdx + 1}`}
                  </span>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="text-zinc-400 text-[10px] uppercase tracking-[0.2em]">Legs</div>
              <div className="mt-1 text-3xl font-bold text-white tabular-nums">{team.legsWon}</div>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="text-zinc-400 text-[10px] uppercase tracking-[0.2em]">Sets</div>
              <div className="mt-1 text-3xl font-bold text-white tabular-nums">{team.setsWon}</div>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="text-zinc-400 text-[10px] uppercase tracking-[0.2em]">Avg</div>
              <div className="mt-1 text-2xl font-bold text-white tabular-nums">{average !== null ? average.toFixed(2) : "--"}</div>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="text-zinc-400 text-[10px] uppercase tracking-[0.2em]">Darts</div>
              <div className="mt-1 text-2xl font-bold text-white tabular-nums">{darts}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

TeamChalkboardCard.displayName = "TeamChalkboardCard";

export default function X01GamePage() {
  const navigate = useNavigate();
  const { state } = useLocation() as { state?: LocationState };
  const flavor = getFlavorConfig();
  const isClubBoard = flavor.flavor === "club-board";

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
  const tournamentMatch = state?.tournamentMatch;

  const playerConfigs: PlayerConfig[] = useMemo(() => {
    const rawPlayers = state?.players;
    if (Array.isArray(rawPlayers) && rawPlayers.length > 0) {
      return rawPlayers.map((player, index) => ({
        name: player?.name?.trim() || `Player ${index + 1}`,
        isBot: Boolean(player?.isBot),
        isPlayerBot: Boolean(player?.isPlayerBot),
        sourcePlayerId: player?.sourcePlayerId,
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
  const [gameInitialized, setGameInitialized] = useState(false);
  const [isCorrectionModalOpen, setIsCorrectionModalOpen] = useState(false);
  const [selectedDartIndex, setSelectedDartIndex] = useState(-1);
  const [checkoutSuggestions, setCheckoutSuggestions] = useState<(string | null)[]>([null, null, null]);
  const [showCelebration, setShowCelebration] = useState(false);
  const [celebrationType, setCelebrationType] = useState<'leg' | 'match'>('leg');
  const [pendingCelebrationWinner, setPendingCelebrationWinner] = useState<number | null>(null);
  const [replayOpen, setReplayOpen] = useState(false);
  const [replayFrames, setReplayFrames] = useState<ReplayFrame[]>([]);
  const [replayPlayerFrames, setReplayPlayerFrames] = useState<ReplayFrame[]>([]);
  const [replayPlayerCameraIndex, setReplayPlayerCameraIndex] = useState<number | null>(null);
  const [replayIndex, setReplayIndex] = useState(0);
  const [replayAwaitingDecision, setReplayAwaitingDecision] = useState(false);
  const [replayCameraIndex, setReplayCameraIndex] = useState<number>(0);
  const [replayEnabled, setReplayEnabled] = useState<boolean>(true);
  const [replayShowInGame, setReplayShowInGame] = useState<boolean>(true);
  const [replayTurnTriggerScore, setReplayTurnTriggerScore] = useState<number>(100);
  const [replayCheckoutTriggerScore, setReplayCheckoutTriggerScore] = useState<number>(100);
  const [replayAutosaveEnabled, setReplayAutosaveEnabled] = useState<boolean>(false);
  const [gifReactionSettings, setGifReactionSettings] = useState<GifReactionSettings | null>(null);
  const [activeGifReaction, setActiveGifReaction] = useState<ActiveGifReaction | null>(null);
  const celebrationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gifReactionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gifReactionSettingsRef = useRef<GifReactionSettings | null>(null);
  const gifReactionLastKeyRef = useRef("");
  const replayCooldownRef = useRef(0);
  const replayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const replayPendingFramesRef = useRef<ReplayPayload | null>(null);
  const replayPendingRef = useRef(false);
  const replayQueuedAtRef = useRef(0);
  const replayCameraIndexRef = useRef(0);
  const replayTurnTriggerScoreRef = useRef(100);
  const replayCheckoutTriggerScoreRef = useRef(100);
  const replayKindRef = useRef<"score" | "checkout">("score");
  const replayEnabledRef = useRef(true);
  const replayShowInGameRef = useRef(true);
  const replayAutosaveEnabledRef = useRef(false);
  const replayMinScoreRef = useRef(100);
  const replayLastCheckoutKeyRef = useRef("");
  const detectionStateRef = useRef<string>("no_movement");

  useEffect(() => {
    replayCameraIndexRef.current = replayCameraIndex;
  }, [replayCameraIndex]);

  useEffect(() => {
    replayEnabledRef.current = replayEnabled;
  }, [replayEnabled]);

  useEffect(() => {
    replayShowInGameRef.current = replayShowInGame;
  }, [replayShowInGame]);

  useEffect(() => {
    replayAutosaveEnabledRef.current = replayAutosaveEnabled;
  }, [replayAutosaveEnabled]);

  useEffect(() => {
    gifReactionSettingsRef.current = gifReactionSettings;
  }, [gifReactionSettings]);

  useEffect(() => {
    replayTurnTriggerScoreRef.current = replayTurnTriggerScore;
  }, [replayTurnTriggerScore]);

  useEffect(() => {
    replayCheckoutTriggerScoreRef.current = replayCheckoutTriggerScore;
  }, [replayCheckoutTriggerScore]);

  const getReplayQuery = (options: { autosave?: boolean } = {}) => {
    const cam = Math.max(0, Math.min(2, Math.trunc(Number(replayCameraIndexRef.current) || 0)));
    const minScore = Math.max(0, Math.min(180, Math.trunc(Number(replayMinScoreRef.current) || 100)));
    const autosave = options.autosave === true ? 1 : 0;
    return `min_score=${minScore}&camera_index=${cam}&replay_type=${encodeURIComponent(replayKindRef.current)}&autosave=${autosave}`;
  };
  const lastDartCountRef = useRef(0);
  const x01StateRef = useRef<X01State | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${API_URL}/api/settings/detection`);
        if (!res.ok) return;
        const payload = await res.json();
        if (cancelled) return;
        const turnScore = Math.max(
          40,
          Math.min(180, Math.trunc(Number(payload?.settings?.replay_turn_min_score ?? 100) || 100)),
        );
        const checkoutScore = Math.max(
          40,
          Math.min(170, Math.trunc(Number(payload?.settings?.replay_checkout_min_score ?? 100) || 100)),
        );
        setReplayEnabled(Boolean(payload?.settings?.replay_enabled ?? true));
        setReplayShowInGame(Boolean(payload?.settings?.replay_show_in_game ?? true));
        setReplayAutosaveEnabled(Boolean(payload?.settings?.replay_autosave_enabled ?? false));
        setReplayTurnTriggerScore(turnScore);
        setReplayCheckoutTriggerScore(checkoutScore);
        replayMinScoreRef.current = turnScore;
      } catch {
        // Keep defaults if settings endpoint is temporarily unavailable.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${API_URL}/api/gif-reactions/settings`);
        if (!res.ok) return;
        const payload = await res.json();
        if (!cancelled) {
          setGifReactionSettings(payload?.settings ?? null);
        }
      } catch {
        // GIF reactions are optional; keep the game silent if settings are unavailable.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const hasNavigatedRef = useRef(false);
  const gameStartedRef = useRef(false);
  const lastWinnerRef = useRef<number | null>(null);
  const isStoppingRef = useRef(false);

  useEffect(() => {
    x01StateRef.current = x01State;
  }, [x01State]);

  useEffect(() => {
    return () => {
      if (gifReactionTimeoutRef.current) {
        clearTimeout(gifReactionTimeoutRef.current);
        gifReactionTimeoutRef.current = null;
      }
    };
  }, []);

  const isBotTurn = (state: X01State | null): boolean => {
    if (!state || typeof state.currentPlayer !== "number") {
      return false;
    }
    return Boolean(state.players?.[state.currentPlayer]?.isBot);
  };

  const applyOptimisticDartScore = useCallback((data: Record<string, any>) => {
    const scoreValue = Math.trunc(Number(data?.score_value ?? data?.score?.score ?? 0) || 0);
    const eventDartIndex = Math.trunc(Number(data?.dart_index ?? 0) || 0);
    setX01State((prev) => {
      if (!prev?.currentTurn || isBotTurn(prev) || prev.turnInputArmed === false) {
        return prev;
      }

      const existingDarts = Array.isArray(prev.currentTurn.darts)
        ? prev.currentTurn.darts
        : [null, null, null];
      const existingApplied = Array.isArray(prev.currentTurn.appliedScores)
        ? prev.currentTurn.appliedScores
        : [0, 0, 0];
      const slot =
        eventDartIndex >= 1 && eventDartIndex <= 3
          ? eventDartIndex - 1
          : existingDarts.findIndex((dart) => dart === null);
      if (slot < 0 || slot > 2) {
        return prev;
      }

      const alreadyHasSameScore =
        existingDarts[slot] !== null && Number(existingApplied[slot] ?? 0) === scoreValue;
      if (alreadyHasSameScore) {
        return prev;
      }

      const darts = [existingDarts[0] ?? null, existingDarts[1] ?? null, existingDarts[2] ?? null];
      const appliedScores = [
        Number(existingApplied[0] ?? 0),
        Number(existingApplied[1] ?? 0),
        Number(existingApplied[2] ?? 0),
      ];
      darts[slot] = dartScoreFromEvent(data, scoreValue);
      appliedScores[slot] = scoreValue;

      const scored = appliedScores.reduce((sum, value, idx) => sum + (darts[idx] ? Number(value || 0) : 0), 0);
      const scoreBefore = Number(
        prev.currentTurn.scoreBefore ??
          (typeof prev.currentPlayer === "number" ? prev.players?.[prev.currentPlayer]?.score : undefined) ??
          prev.settings.startScore ??
          startScore
      );
      const dartsUsed = darts.filter((dart) => dart !== null).length;
      const next: X01State = {
        ...prev,
        currentTurn: {
          ...prev.currentTurn,
          darts,
          appliedScores,
          scored,
          remaining: scoreBefore - scored,
          dartsUsed,
        },
      };
      x01StateRef.current = next;
      return next;
    });
  }, [startScore]);

  const parseReplayPayload = (
    replay: any,
    queuedAtMs: number,
    allowStale = false
  ): ReplayPayload | null => {
    if (!replay?.ready || !Array.isArray(replay.frames) || replay.frames.length === 0) {
      return null;
    }
    // Ignore stale cached replay from an older turn (common source of bot-triggered popups).
    const capturedAtMs = Number(replay?.captured_at_ms ?? 0);
    if (!allowStale && Number.isFinite(capturedAtMs) && capturedAtMs > 0 && capturedAtMs + 300 < queuedAtMs) {
      return null;
    }
    const boardFrames = replay.frames
      .filter((f: any) => typeof f?.image === "string" && f.image.length > 0)
      .map((f: any) => ({
        dart_index: Number(f.dart_index ?? 0),
        score_value: Number(f.score_value ?? 0),
        image: String(f.image),
        label: typeof f.label === "string" ? f.label : undefined,
        ts_ms: Number(f.ts_ms ?? 0) || undefined,
      }));
    const playerReplay = replay?.player_replay;
    const playerFrames = Array.isArray(playerReplay?.frames)
      ? playerReplay.frames
          .filter((f: any) => typeof f?.image === "string" && f.image.length > 0)
          .map((f: any) => ({
            dart_index: Number(f.dart_index ?? 0),
            score_value: Number(f.score_value ?? 0),
            image: String(f.image),
            label: typeof f.label === "string" ? f.label : undefined,
            ts_ms: Number(f.ts_ms ?? 0) || undefined,
          }))
      : [];
    const rawPlayerCameraIndex = Number(playerReplay?.camera_index);
    return {
      boardFrames,
      playerFrames,
      playerCameraIndex: Number.isFinite(rawPlayerCameraIndex) && rawPlayerCameraIndex >= 0 ? rawPlayerCameraIndex : null,
    };
  };

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
        lastDartCountRef.current = nextDartCount;
        // Start replay only after takeout resets dart count.
        if (
          replayEnabledRef.current &&
          replayPendingRef.current &&
          nextDartCount === 0 &&
          nextDetectionState === "no_movement" &&
          Date.now() - replayQueuedAtRef.current >= 1200
        ) {
          const openReplayIfReady = (payload: ReplayPayload) => {
            if (!payload.boardFrames.length) return;
            if (!replayShowInGameRef.current) {
              replayPendingRef.current = false;
              replayPendingFramesRef.current = null;
              return;
            }
            setReplayFrames(payload.boardFrames);
            setReplayPlayerFrames(payload.playerFrames);
            setReplayPlayerCameraIndex(payload.playerCameraIndex);
            setReplayIndex(0);
            setReplayAwaitingDecision(false);
            setReplayOpen(true);
            replayPendingRef.current = false;
            replayPendingFramesRef.current = null;
          };

          void (async () => {
            try {
              const res = await fetch(`${API_URL}/api/replay/highlight/latest?${getReplayQuery({ autosave: true })}`);
              if (res.ok) {
                const payload = await res.json();
                const replay = payload?.replay;
                const parsedReplay = parseReplayPayload(replay, replayQueuedAtRef.current);
                if (parsedReplay && parsedReplay.boardFrames.length >= 2) {
                  openReplayIfReady(parsedReplay);
                  return;
                }
              }
            } catch {
              // Keep replay feature silent on transient failures.
            }
            if (replayPendingFramesRef.current && replayPendingFramesRef.current.boardFrames.length > 0) {
              openReplayIfReady(replayPendingFramesRef.current);
            }
          })();
        }
      }
      if (typeof nextDetectionState === "string") {
        detectionStateRef.current = nextDetectionState;
        setDetectionState(nextDetectionState);
      }
    },
    []
  );

  const triggerGifReactionForState = useCallback((nextState: X01State) => {
    const settings = gifReactionSettingsRef.current;
    if (!settings?.enabled) return;
    const lastTurn = nextState.lastTurn;
    if (!lastTurn) return;

    const turnKey = `${Number(lastTurn.playerIndex ?? -1)}:${Number(lastTurn.turnIndex ?? -1)}:${Number(lastTurn.scored ?? 0)}:${Boolean(lastTurn.finished)}`;
    const turnScore = Number(lastTurn.scored ?? 0) || 0;
    const checkout = Boolean(lastTurn.finished) && !Boolean(lastTurn.bust);

    let reactionLabel = "";
    let candidates: string[] = [];
    let reactionKey = "";

    const hasMatchWinner =
      (nextState.matchWinner !== null && nextState.matchWinner !== undefined) ||
      (nextState.match?.matchWinner !== null && nextState.match?.matchWinner !== undefined);
    const hasSetWinner =
      (nextState.setWinner !== null && nextState.setWinner !== undefined) ||
      (nextState.match?.setWinner !== null && nextState.match?.setWinner !== undefined);

    if (hasMatchWinner && settings.match_won_gifs?.length) {
      candidates = settings.match_won_gifs ?? [];
      reactionLabel = "Match Won";
      reactionKey = `match:${turnKey}`;
    } else if (hasSetWinner && settings.set_won_gifs?.length) {
      candidates = settings.set_won_gifs ?? [];
      reactionLabel = "Set Won";
      reactionKey = `set:${turnKey}`;
    } else if (checkout) {
      const sorted = [...(settings.checkout_rules ?? [])].sort((a, b) => {
        const rank = (rule: GifReactionRule) =>
          rule.match_type === "exact_checkout" ? 0 : rule.match_type === "min_checkout" ? 1 : 2;
        const rankDiff = rank(a) - rank(b);
        if (rankDiff !== 0) return rankDiff;
        return Number(b.score ?? 0) - Number(a.score ?? 0);
      });
      const matched = sorted.find((rule) => rule.gifs?.length && ruleMatches(rule, turnScore, true));
      if (matched) {
        candidates = matched.gifs;
        reactionLabel = matched.label;
        reactionKey = `checkout:${matched.id}:${turnKey}`;
      }
    } else {
      const sorted = [...(settings.score_rules ?? [])].sort((a, b) => {
        const rankDiff = (a.match_type === "exact_score" ? 0 : 1) - (b.match_type === "exact_score" ? 0 : 1);
        if (rankDiff !== 0) return rankDiff;
        return Number(b.score ?? 0) - Number(a.score ?? 0);
      });
      const matched = sorted.find((rule) => rule.gifs?.length && ruleMatches(rule, turnScore, false));
      if (matched) {
        candidates = matched.gifs;
        reactionLabel = matched.label;
        reactionKey = `score:${matched.id}:${turnKey}`;
      }
    }

    const selected = pickRandomItem(candidates);
    if (!selected || !reactionKey || gifReactionLastKeyRef.current === reactionKey) return;
    gifReactionLastKeyRef.current = reactionKey;
    if (gifReactionTimeoutRef.current) {
      clearTimeout(gifReactionTimeoutRef.current);
    }
    setActiveGifReaction({
      src: gifFileUrl(selected),
      label: reactionLabel,
      isVideo: isVideoReaction(selected),
    });
    gifReactionTimeoutRef.current = setTimeout(() => {
      setActiveGifReaction(null);
      gifReactionTimeoutRef.current = null;
    }, Math.max(500, Math.min(10000, Number(settings.duration_ms ?? 1800) || 1800)));
  }, []);

  const handleGameSyncEvent = useCallback((data: Record<string, any>) => {
    if (data?.event === "dart_score") {
      applyOptimisticDartScore(data);
      if (!replayEnabledRef.current) {
        return true;
      }
      const liveState = x01StateRef.current;
      if (isBotTurn(liveState) || liveState?.turnInputArmed === false) {
        return true;
      }
      const scoreValue = Number(
        data?.score_value ??
          data?.corrected_score_value ??
          data?.score?.score ??
          0
      );
      const now = Date.now();
      const currentTurnTotal = Number(liveState?.currentTurn?.scored ?? 0) || 0;
      const projectedTurnTotal = currentTurnTotal + scoreValue;
      // Queue replay on turn-total threshold, not single-dart score.
      const turnTrigger = Math.max(0, Number(replayTurnTriggerScoreRef.current) || 100);
      if (projectedTurnTotal >= turnTrigger && now - replayCooldownRef.current > 3000) {
        replayCooldownRef.current = now;
        replayPendingRef.current = true;
        replayQueuedAtRef.current = Date.now();
        replayMinScoreRef.current = turnTrigger;
        replayKindRef.current = "score";
        void (async () => {
          try {
            const res = await fetch(`${API_URL}/api/replay/highlight/latest?${getReplayQuery({ autosave: false })}`);
            if (!res.ok) {
              return;
            }
            const payload = await res.json();
            const replay = payload?.replay;
            const parsedReplay = parseReplayPayload(replay, replayQueuedAtRef.current);
            if ((parsedReplay?.boardFrames.length ?? 0) > 0) {
              replayPendingFramesRef.current = parsedReplay;
            }
          } catch {
            // Keep replay feature silent on transient failures.
          }
        })();
      }
      return true;
    }
    if (data?.event === "x01_state_updated" && data?.state) {
      const nextState = data.state as X01State;
      setX01State(nextState);
      triggerGifReactionForState(nextState);
      const source = String(data?.source ?? "");
      const botTurn = isBotTurn(nextState);
      if (botTurn || source.startsWith("bot_")) {
        return true;
      }
      if (!replayEnabledRef.current) {
        return true;
      }
      const turnTrigger = Math.max(0, Number(replayTurnTriggerScoreRef.current) || 100);
      const checkoutTrigger = Math.max(0, Number(replayCheckoutTriggerScoreRef.current) || 100);
      const allowStaleReplay = source === "dart_score_corrected";
      const boardAlreadyClear =
        lastDartCountRef.current === 0 && detectionStateRef.current === "no_movement";
      const lastTurn = nextState?.lastTurn;
      const checkoutScore = Number(lastTurn?.scored ?? 0) || 0;
      const isCheckoutTurn = Boolean(lastTurn?.finished) && !Boolean(lastTurn?.bust);
      const checkoutReplayQualified = isCheckoutTurn && checkoutScore >= checkoutTrigger;
      if (checkoutReplayQualified) {
        const checkoutKey = `${Number(lastTurn?.playerIndex ?? -1)}:${Number(lastTurn?.turnIndex ?? -1)}:${checkoutScore}`;
        if (replayLastCheckoutKeyRef.current !== checkoutKey) {
          replayLastCheckoutKeyRef.current = checkoutKey;
          replayPendingRef.current = true;
          replayQueuedAtRef.current = Date.now();
          replayMinScoreRef.current = checkoutTrigger;
          replayKindRef.current = "checkout";
          void (async () => {
            try {
              const res = await fetch(`${API_URL}/api/replay/highlight/latest?${getReplayQuery({ autosave: boardAlreadyClear })}`);
              if (!res.ok) {
                return;
              }
              const payload = await res.json();
              const replay = payload?.replay;
              const parsedReplay = parseReplayPayload(replay, replayQueuedAtRef.current, allowStaleReplay);
              if (parsedReplay && parsedReplay.boardFrames.length > 0) {
                if (allowStaleReplay && boardAlreadyClear && replayShowInGameRef.current) {
                  setReplayFrames(parsedReplay.boardFrames);
                  setReplayPlayerFrames(parsedReplay.playerFrames);
                  setReplayPlayerCameraIndex(parsedReplay.playerCameraIndex);
                  setReplayIndex(0);
                  setReplayAwaitingDecision(false);
                  setReplayOpen(true);
                  replayPendingRef.current = false;
                  replayPendingFramesRef.current = null;
                } else {
                  replayPendingFramesRef.current = parsedReplay;
                }
              }
            } catch {
              // Keep replay feature silent on transient failures.
            }
          })();
        }
      }
      // Backup replay queue trigger from authoritative game state updates.
      const darts = Array.isArray(nextState?.currentTurn?.darts) ? nextState.currentTurn.darts : [];
      const turnTotal =
        Number(nextState?.currentTurn?.scored ?? 0) ||
        darts.reduce((sum: number, d: any) => sum + Number(d?.score ?? 0), 0);
      if (!checkoutReplayQualified && turnTotal >= turnTrigger) {
        if (!replayPendingRef.current) {
          replayPendingRef.current = true;
          replayQueuedAtRef.current = Date.now();
        }
        replayMinScoreRef.current = turnTrigger;
        replayKindRef.current = "score";
        // Refresh pending replay frames as the turn evolves (dart 2/3).
        void (async () => {
          try {
            const res = await fetch(`${API_URL}/api/replay/highlight/latest?${getReplayQuery({ autosave: boardAlreadyClear })}`);
            if (!res.ok) {
              return;
            }
            const payload = await res.json();
            const replay = payload?.replay;
            const parsedReplay = parseReplayPayload(replay, replayQueuedAtRef.current, allowStaleReplay);
            if (parsedReplay && parsedReplay.boardFrames.length > 0) {
              if (allowStaleReplay && boardAlreadyClear && replayShowInGameRef.current) {
                setReplayFrames(parsedReplay.boardFrames);
                setReplayPlayerFrames(parsedReplay.playerFrames);
                setReplayPlayerCameraIndex(parsedReplay.playerCameraIndex);
                setReplayIndex(0);
                setReplayAwaitingDecision(false);
                setReplayOpen(true);
                replayPendingRef.current = false;
                replayPendingFramesRef.current = null;
              } else {
                replayPendingFramesRef.current = parsedReplay;
              }
            }
          } catch {
            // Keep replay feature silent on transient failures.
          }
        })();
      }
      return true;
    }
    return false;
  }, [applyOptimisticDartScore, triggerGifReactionForState]);

  const startX01Game = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setGameInitialized(false);
    try {
      const requestBody: any = {
        players: playerConfigs.map((player, index) => ({
          name: player.name || `Player ${index + 1}`,
          isBot: player.isBot,
          isPlayerBot: player.isPlayerBot,
          sourcePlayerId: player.sourcePlayerId,
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
        analyticsSource: "local",
      };

      // Add teams if in team play mode
      if (gameVariant === "team_play" && teams.length > 0) {
        requestBody.teams = teams.map(team => ({
          teamId: team.teamId,
          teamName: team.teamName,
          playerIndices: team.playerIndices,
          teamColor: team.teamColor,
        }));
      }

      const data = await apiStartGame<X01State>("x01", requestBody);
      setX01State(data);
      setGameInitialized(true);
      
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
    if (gameStartedRef.current) {
      return;
    }
    gameStartedRef.current = true;

    (async () => {
      try {
        // Resume active match on refresh instead of starting a new one.
        const existing = await apiGetGameState<X01State>("x01");
        if (existing) {
          setX01State(existing);
          setGameInitialized(true);
          return;
        }
      } catch {
        // No active game (or fetch failed) -> start from lobby config.
      }
      await startX01Game();
    })();

    return () => {
      // Don't stop the game here - it will be stopped by navigation effect or abort button
      // Stopping here causes issues in React Strict Mode
    };
  }, [startX01Game]);

  useGameStateSync({
    enabled: gameInitialized,
    refresh: fetchX01State,
    onStatus: handleDetectionStatus,
    onEvent: handleGameSyncEvent,
    pollMs: 0,
    debounceMs: 120,
  });

  // Navigate to stats page when match is complete
  useEffect(() => {
    if (!gameInitialized) {
      return;
    }
    if (hasNavigatedRef.current || isStoppingRef.current) {
      return;
    }
    const matchWinner = x01State?.matchWinner ?? x01State?.match?.matchWinner;
    // Changed: Remove dartCount check so celebration triggers immediately when winner detected
    if (matchWinner === null || matchWinner === undefined || !x01State) {
      return;
    }
    const winnerIndex = Number(matchWinner);
    const winnerIsBot =
      Number.isFinite(winnerIndex) &&
      winnerIndex >= 0 &&
      winnerIndex < (x01State.players?.length ?? 0) &&
      Boolean(x01State.players?.[winnerIndex]?.isBot);

    // For human winners, keep the existing "wait for dart takeout" behavior.
    // For bot winners, dart counter can be non-zero from residual movement,
    // so allow immediate navigation to stats.
    if (!winnerIsBot && dartCount !== 0) {
      return;
    }
    hasNavigatedRef.current = true;
    isStoppingRef.current = true;
    const summary = x01State;
    
    (async () => {
      await stopX01Game();
      if (tournamentMatch) {
        const participantIds = Array.isArray(tournamentMatch.participantIds) ? tournamentMatch.participantIds : [];
        const winnerParticipantId = participantIds[winnerIndex];
        if (winnerParticipantId) {
          try {
            await recordTournamentMatchResult({
              tournamentId: tournamentMatch.tournamentId,
              matchId: tournamentMatch.matchId,
              winnerId: winnerParticipantId,
              legsA: summary.players?.[0]?.legsWon ?? null,
              legsB: summary.players?.[1]?.legsWon ?? null,
            });
          } catch (err) {
            console.error("Failed to record tournament match result:", err);
          }
        }
        navigate(`/tournaments?id=${encodeURIComponent(tournamentMatch.tournamentId)}`);
        return;
      }
      navigate("/x01/stats", {
        state: {
          summary,
          players: playerConfigs,
        },
      });
    })();
  }, [gameInitialized, x01State, dartCount, playerConfigs, navigate, stopX01Game, tournamentMatch]);

  const handleOpenCorrection = useCallback((index: number) => {
    setSelectedDartIndex(index);
    setIsCorrectionModalOpen(true);
  }, []);

  const handleSaveCorrection = useCallback(
    async (correction: { dartIndex: number; multiplier: number; segment: number; score: number; bouncer?: boolean }) => {
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
    async (correction: { dartIndex: number; multiplier: number; segment: number; score: number; bouncer?: boolean }) => {
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
      const data = await apiForceNextTurn<X01State>("x01");
      if (data) {
        setX01State(data);
      } else {
        await fetchX01State();
      }
      setInfoMessage("Turn completed - moved to next player");
      setTimeout(() => setInfoMessage(""), 2000);
    } catch (err) {
      console.error("Failed to force next turn:", err);
      setError("Failed to force next turn");
    }
  }, [fetchX01State]);

  const handleUndoTurn = useCallback(async () => {
    try {
      const data = await apiUndoTurn<X01State>("x01");
      if (data) {
        setX01State(data);
      } else {
        await fetchX01State();
      }
      setInfoMessage("Last turn undone");
      setTimeout(() => setInfoMessage(""), 2000);
    } catch (err) {
      console.error("Failed to undo turn:", err);
      setError(err instanceof Error ? err.message : "Failed to undo turn");
    }
  }, [fetchX01State]);
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
  const getPlayerTeam = useCallback(
    (playerIndex: number) =>
      x01State?.teams?.find((team) => team.playerIndices.includes(playerIndex)) ?? null,
    [x01State?.teams]
  );
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

  const getTeamDisplayName = useCallback(
    (teamId: number | null | undefined) => {
      if (teamId === null || teamId === undefined) {
        return "";
      }
      return x01State?.teams?.find((candidate) => candidate.teamId === teamId)?.teamName ?? `Team ${teamId + 1}`;
    },
    [x01State?.teams]
  );

  const getPlayerWinnerDisplayName = useCallback(
    (index: number | null | undefined) => {
      if (index === null || index === undefined) {
        return "";
      }
      if (x01State?.settings.gameVariant === "team_play") {
        const playerTeam = getPlayerTeam(index);
        if (playerTeam) {
          return playerTeam.teamName;
        }
      }
      return getDisplayName(index);
    },
    [getDisplayName, getPlayerTeam, x01State?.settings.gameVariant]
  );

  const currentTurn = x01State?.currentTurn;
  const turnInputArmed = Boolean(x01State?.turnInputArmed ?? true);
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
    if (replayTimerRef.current) {
      clearTimeout(replayTimerRef.current);
      replayTimerRef.current = null;
    }
  }, []);

  const currentPlayerReplayFrame = useMemo(() => {
    if (!replayPlayerFrames.length) {
      return null;
    }
    const index = Math.max(0, Math.min(replayIndex, replayPlayerFrames.length - 1));
    return replayPlayerFrames[index] ?? null;
  }, [replayIndex, replayPlayerFrames]);

  const currentBoardReplayFrame = useMemo(() => {
    if (!replayFrames.length) {
      return null;
    }
    if (!replayPlayerFrames.length) {
      const index = Math.max(0, Math.min(replayIndex, replayFrames.length - 1));
      return replayFrames[index] ?? null;
    }
    const playerTs = Number(currentPlayerReplayFrame?.ts_ms ?? 0);
    let selected = replayFrames[0] ?? null;
    for (const frame of replayFrames) {
      const frameTs = Number(frame?.ts_ms ?? 0);
      if (frameTs <= playerTs) {
        selected = frame;
      } else {
        break;
      }
    }
    return selected;
  }, [currentPlayerReplayFrame, replayFrames, replayIndex, replayPlayerFrames.length]);

  const replayUsesSmoothPlayerTimeline = replayPlayerFrames.length > 0;

  useEffect(() => {
    if (!replayOpen || replayAwaitingDecision || replayFrames.length === 0) {
      if (replayTimerRef.current) {
        clearTimeout(replayTimerRef.current);
        replayTimerRef.current = null;
      }
      return;
    }

    const timelineLength = replayUsesSmoothPlayerTimeline ? replayPlayerFrames.length : replayFrames.length;
    const isLastFrame = replayIndex >= timelineLength - 1;
    const currentFrame = replayUsesSmoothPlayerTimeline ? currentPlayerReplayFrame : replayFrames[replayIndex];
    const nextFrame = replayUsesSmoothPlayerTimeline
      ? replayPlayerFrames[Math.min(replayIndex + 1, replayPlayerFrames.length - 1)]
      : replayFrames[Math.min(replayIndex + 1, replayFrames.length - 1)];
    const currentFrameMs = replayUsesSmoothPlayerTimeline
      ? Math.max(16, Math.min(REPLAY_PLAYER_FRAME_MAX_MS, Number(nextFrame?.ts_ms ?? 0) - Number(currentFrame?.ts_ms ?? 0) || 33))
      : (replayIndex === 0 && Number(currentFrame?.dart_index ?? -1) === 0 ? 3000 : 2000);

    if (isLastFrame) {
      if (replayAutosaveEnabledRef.current) {
        replayTimerRef.current = setTimeout(() => {
          setReplayOpen(false);
          setReplayAwaitingDecision(false);
          setReplayFrames([]);
          setReplayPlayerFrames([]);
          setReplayPlayerCameraIndex(null);
          setReplayIndex(0);
        }, currentFrameMs + 2000);
        return () => {
          if (replayTimerRef.current) {
            clearTimeout(replayTimerRef.current);
            replayTimerRef.current = null;
          }
        };
      }
      replayTimerRef.current = setTimeout(() => {
        setReplayAwaitingDecision(true);
      }, currentFrameMs);
      return () => {
        if (replayTimerRef.current) {
          clearTimeout(replayTimerRef.current);
          replayTimerRef.current = null;
        }
      };
    }

    if (replayTimerRef.current) {
      clearTimeout(replayTimerRef.current);
    }
    replayTimerRef.current = setTimeout(() => {
      setReplayIndex((prev) => Math.min(prev + 1, timelineLength - 1));
    }, currentFrameMs);
    return () => {
      if (replayTimerRef.current) {
        clearTimeout(replayTimerRef.current);
        replayTimerRef.current = null;
      }
    };
  }, [
    currentPlayerReplayFrame,
    replayAwaitingDecision,
    replayFrames,
    replayIndex,
    replayOpen,
    replayPlayerFrames,
    replayUsesSmoothPlayerTimeline,
  ]);

  const closeReplayModal = useCallback(() => {
    setReplayOpen(false);
    setReplayAwaitingDecision(false);
    setReplayFrames([]);
    setReplayPlayerFrames([]);
    setReplayPlayerCameraIndex(null);
    setReplayIndex(0);
  }, []);

  const replayDownloadFilename = useCallback(() => {
    const total = replayFrames
      .filter((frame) => Number(frame?.dart_index ?? 0) > 0)
      .reduce((sum, frame) => sum + Math.max(0, Number(frame?.score_value ?? 0) || 0), 0);
    const score = Math.max(0, Math.min(180, Math.trunc(total || replayMinScoreRef.current || 0)));
    return `highlight_replay_${replayKindRef.current}_${score}_${Date.now()}.mp4`;
  }, [replayFrames]);

  const handleDownloadReplay = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/replay/highlight/latest.mp4?${getReplayQuery()}`);
      if (!res.ok) {
        throw new Error("Replay video not available");
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const headerName = res.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/i)?.[1];
      a.download = headerName || replayDownloadFilename();
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      closeReplayModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to download replay");
    }
  }, [closeReplayModal, replayDownloadFilename]);
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

  const checkoutContext = useMemo(() => {
    if (!x01State || winnerIndex !== null) {
      return null;
    }

    const currentIndex = x01State.currentPlayer ?? 0;
    const currentPlayer = x01State.players[currentIndex];
    if (!currentPlayer) {
      return null;
    }

    const currentTurnState = x01State.currentTurn;
    const turnDarts = currentTurnState?.darts ?? [];
    const turnApplied = currentTurnState?.appliedScores ?? [];
    const scoreBefore = Number(currentTurnState?.scoreBefore ?? currentPlayer.score ?? 0);
    const appliedTotal = turnApplied.reduce((acc, v) => acc + Number(v || 0), 0);
    const remaining = Math.max(0, scoreBefore - appliedTotal);
    const dartsThrown = turnDarts.filter((d) => d !== null).length;

    return {
      remaining,
      dartsThrown,
    };
  }, [x01State, winnerIndex]);

  // Compute checkout suggestions locally (no API polling).
  useEffect(() => {
    if (!checkoutContext) {
      setCheckoutSuggestions([null, null, null]);
      return;
    }

    const { remaining, dartsThrown } = checkoutContext;
    setCheckoutSuggestions(computeCheckoutSuggestionsLocal(remaining, dartsThrown, outMode));
  }, [checkoutContext, outMode]);

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

  const playerVisits = useMemo(() => {
    const visitsByPlayer: ChalkVisit[][] = Array.from({ length: players.length }, () => []);
    if (!x01State?.turnHistory?.length) {
      return visitsByPlayer;
    }
    for (let i = x01State.turnHistory.length - 1; i >= 0; i -= 1) {
      const visit = x01State.turnHistory[i];
      const playerIndex = Number(visit.playerIndex);
      if (!Number.isInteger(playerIndex) || playerIndex < 0 || playerIndex >= visitsByPlayer.length) {
        continue;
      }
      if (visitsByPlayer[playerIndex].length >= 5) {
        continue;
      }
      visitsByPlayer[playerIndex].push({
        scored: Number(visit.scored ?? 0),
        left: Number(visit.remaining ?? 0),
      });
    }
    for (let i = 0; i < visitsByPlayer.length; i += 1) {
      visitsByPlayer[i].reverse();
    }
    return visitsByPlayer;
  }, [x01State?.turnHistory, players.length]);

  const teamVisits = useMemo(() => {
    const teamsForView = x01State?.teams ?? [];
    const visitsByTeam: Record<number, ChalkVisit[]> = {};
    for (const team of teamsForView) {
      visitsByTeam[team.teamId] = [];
    }
    if (!x01State?.turnHistory?.length) {
      return visitsByTeam;
    }
    for (let i = x01State.turnHistory.length - 1; i >= 0; i -= 1) {
      const visit = x01State.turnHistory[i];
      const playerIndex = Number(visit.playerIndex);
      const team = teamsForView.find((candidate) => candidate.playerIndices.includes(playerIndex));
      if (!team || visitsByTeam[team.teamId].length >= 5) {
        continue;
      }
      visitsByTeam[team.teamId].push({
        scored: Number(visit.scored ?? 0),
        left: Number(visit.remaining ?? 0),
      });
    }
    for (const team of teamsForView) {
      visitsByTeam[team.teamId].reverse();
    }
    return visitsByTeam;
  }, [x01State?.teams, x01State?.turnHistory]);

  const legAverages = useMemo(() => {
    const totals = Array.from({ length: players.length }, () => 0);
    const darts = Array.from({ length: players.length }, () => 0);
    const history = x01State?.turnHistory ?? [];
    for (const turn of history) {
      const playerIndex = Number(turn.playerIndex);
      if (!Number.isInteger(playerIndex) || playerIndex < 0 || playerIndex >= players.length) {
        continue;
      }
      totals[playerIndex] += Number(turn.scored ?? 0);
      const dartsUsed = Number.isFinite(Number(turn.dartsUsed))
        ? Number(turn.dartsUsed)
        : (Array.isArray(turn.appliedScores) ? turn.appliedScores.length : 0);
      darts[playerIndex] += Math.max(0, Math.min(3, dartsUsed));
    }
    return totals.map((total, i) => (darts[i] > 0 ? (total / darts[i]) * 3 : null));
  }, [x01State?.turnHistory, players.length]);

  const legDartsByPlayer = useMemo(() => {
    const darts = Array.from({ length: players.length }, () => 0);
    const history = x01State?.turnHistory ?? [];
    for (const turn of history) {
      const playerIndex = Number(turn.playerIndex);
      if (!Number.isInteger(playerIndex) || playerIndex < 0 || playerIndex >= players.length) {
        continue;
      }
      const dartsUsed = Number.isFinite(Number(turn.dartsUsed))
        ? Number(turn.dartsUsed)
        : (Array.isArray(turn.appliedScores) ? turn.appliedScores.length : 0);
      darts[playerIndex] += Math.max(0, Math.min(3, dartsUsed));
    }
    return darts;
  }, [x01State?.turnHistory, players.length]);

  const teamLegStats = useMemo(() => {
    const teamsForView = x01State?.teams ?? [];
    const statsByTeam: Record<number, { average: number | null; darts: number }> = {};
    for (const team of teamsForView) {
      let total = 0;
      let darts = 0;
      for (const playerIndex of team.playerIndices) {
        const playerDarts = legDartsByPlayer[playerIndex] ?? 0;
        const playerAverage = legAverages[playerIndex];
        darts += playerDarts;
        if (playerAverage !== null && playerDarts > 0) {
          total += (playerAverage / 3) * playerDarts;
        }
      }
      statsByTeam[team.teamId] = {
        average: darts > 0 ? (total / darts) * 3 : null,
        darts,
      };
    }
    return statsByTeam;
  }, [legAverages, legDartsByPlayer, x01State?.teams]);


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
        subtitle={<>Start {startScore} | In {inMode} | Out {outMode}</>}
        meta={
          effectiveFreePlay
            ? <>Free Play</>
            : x01State?.match ? (
                <>
                  Set {x01State.match.currentSet} | Leg {x01State.match.currentLeg}
                  {setsToWin > 1 && ` | Best of ${setsToWin * 2 - 1} Sets`}
                  {legsPerSet > 1 && ` | Best of ${legsPerSet * 2 - 1} Legs`}
                </>
              ) : null
        }
        right={
          <>
            <GameControlButton
              label="Next Turn"
              variant="primary"
              onClick={handleForceNextTurn}
              title="Force complete turn and move to next player"
            />
            <GameControlButton
              label="Undo Turn"
              variant="neutral"
              onClick={handleUndoTurn}
              title="Undo the last committed turn"
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

      {replayOpen && replayFrames.length > 0 && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/75 px-4">
          <div className={`w-full rounded-2xl border border-white/15 bg-zinc-950 p-4 md:p-6 ${
            replayPlayerFrames.length > 0 ? "max-w-3xl" : "max-w-4xl"
          }`}>
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm uppercase tracking-[0.22em] text-zinc-300">
                Instant Replay (Turn {replayTurnTriggerScore}+ / Checkout {replayCheckoutTriggerScore}+)
              </div>
              <div className="flex items-center gap-3">
                <label className="text-[11px] uppercase tracking-[0.18em] text-zinc-400">
                  Replay Cam
                </label>
                <select
                  value={replayCameraIndex}
                  onChange={(e) => setReplayCameraIndex(Math.max(0, Math.min(2, Number(e.target.value) || 0)))}
                  className="rounded-md border border-white/20 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
                >
                  <option value={0}>Cam 0</option>
                  <option value={1}>Cam 1</option>
                  <option value={2}>Cam 2</option>
                </select>
                {replayPlayerFrames.length > 0 && (
                  <div className="text-[11px] uppercase tracking-[0.18em] text-cyan-300">
                    Player Cam {replayPlayerCameraIndex ?? "?"}
                  </div>
                )}
                <button
                  type="button"
                  className="rounded-md border border-white/20 px-3 py-1 text-xs text-zinc-200 hover:bg-white/10"
                  onClick={closeReplayModal}
                >
                  Close
                </button>
              </div>
            </div>
            <div className={`grid items-start ${replayPlayerFrames.length > 0 ? "gap-2" : "gap-4"}`}>
              <div className={`relative overflow-hidden rounded-xl border border-white/10 bg-black ${
                replayPlayerFrames.length > 0 ? "w-full" : "mx-auto w-full max-w-3xl"
              }`}>
                <img
                  src={`data:image/jpeg;base64,${currentBoardReplayFrame?.image ?? replayFrames[Math.max(0, Math.min(replayIndex, replayFrames.length - 1))]?.image ?? ""}`}
                  alt="board replay"
                  className={`w-full object-contain ${replayPlayerFrames.length > 0 ? "max-h-[42vh]" : "max-h-[70vh]"}`}
                />
                <div className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-1 text-xs text-white">
                  {Number(currentBoardReplayFrame?.dart_index ?? 0) === 0
                    ? "Board Clear"
                    : `Dart ${currentBoardReplayFrame?.dart_index} • Score ${currentBoardReplayFrame?.score_value}`}
                </div>
              </div>
              {replayPlayerFrames.length > 0 && (
                <div className="relative overflow-hidden rounded-xl border border-cyan-500/20 bg-black">
                  <img
                    src={`data:image/jpeg;base64,${currentPlayerReplayFrame?.image ?? replayPlayerFrames[Math.min(replayIndex, replayPlayerFrames.length - 1)]?.image ?? ""}`}
                    alt="player replay"
                    className="max-h-[42vh] w-full object-contain"
                  />
                  <div className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-1 text-xs text-white">
                    {Number(currentPlayerReplayFrame?.dart_index ?? 0) === 0
                      ? "Player Ready"
                      : `Throw ${currentPlayerReplayFrame?.dart_index}`}
                  </div>
                </div>
              )}
            </div>
            <div className="mt-4 flex items-center gap-2">
              {replayAwaitingDecision ? (
                <>
                  <button
                    type="button"
                    className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500"
                    onClick={handleDownloadReplay}
                  >
                    Save Replay
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-white/20 px-4 py-2 text-sm font-semibold text-zinc-100 hover:bg-white/10"
                    onClick={closeReplayModal}
                  >
                    Continue
                  </button>
                </>
              ) : (
                <div className="text-xs text-zinc-400">
                  {replayAutosaveEnabled ? "Playing replay... auto-save enabled (auto-close in 2s)." : "Playing replay..."}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

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

      <main className="relative z-10 flex-1 px-4 md:px-10 pb-6">
        <div className="max-w-[92rem] mx-auto mt-4 space-y-8">
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
              <span className="text-base font-semibold">{getTeamDisplayName(x01State.matchWinner)} wins the match!</span>
              <span className="text-xs uppercase tracking-[0.25em] text-emerald-300">Match Complete</span>
            </div>
          )}
          {x01State?.setWinner !== null && x01State?.setWinner !== undefined && x01State?.matchWinner === null && (
            <div className="rounded-xl border border-blue-500/60 bg-blue-600/15 px-4 py-3 text-sm text-blue-200 flex items-center justify-between">
              <span className="text-base font-semibold">{getTeamDisplayName(x01State.setWinner)} wins Set {x01State.match.currentSet - 1}!</span>
              <span className="text-xs uppercase tracking-[0.25em] text-blue-300">Starting next set...</span>
            </div>
          )}
          {winnerIndex !== null && x01State?.setWinner === null && x01State?.matchWinner === null && (
            <div className="rounded-xl border border-emerald-500/60 bg-emerald-600/15 px-4 py-3 text-sm text-emerald-200 flex items-center justify-between">
              <span className="text-base font-semibold">{getPlayerWinnerDisplayName(winnerIndex)} wins Leg {x01State?.match.currentLeg}!</span>
              <span className="text-xs uppercase tracking-[0.25em] text-emerald-300">Starting next leg...</span>
            </div>
          )}
          {pendingCelebrationWinner !== null && winnerIndex === null && x01State?.setWinner === null && x01State?.matchWinner === null && (
            <div className="rounded-xl border border-emerald-500/60 bg-emerald-600/15 px-4 py-3 text-sm text-emerald-200 flex items-center justify-between">
              <span className="text-base font-semibold">{getPlayerWinnerDisplayName(pendingCelebrationWinner)} checks out!</span>
              <span className="text-xs uppercase tracking-[0.25em] text-emerald-300">Awaiting confirmation...</span>
            </div>
          )}

          {x01State?.settings.gameVariant === "team_play" && x01State.teams && x01State.teams.length > 0 ? (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              {x01State.teams.map((team) => {
                const isActiveTeam = winnerIndex === null && team.playerIndices.includes(currentPlayerIndex);
                const isWinnerTeam =
                  x01State.matchWinner === team.teamId ||
                  x01State.setWinner === team.teamId ||
                  (winnerIndex !== null && team.playerIndices.includes(winnerIndex));
                const stats = teamLegStats[team.teamId] ?? { average: null, darts: 0 };
                return (
                  <TeamChalkboardCard
                    key={team.teamId}
                    team={team}
                    players={players}
                    currentPlayerIndex={currentPlayerIndex}
                    isActive={isActiveTeam}
                    isWinner={isWinnerTeam}
                    detectionState={detectionState}
                    visits={teamVisits[team.teamId] ?? []}
                    average={stats.average}
                    darts={stats.darts}
                  />
                );
              })}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              {players.map((player, index) => (
                <ChalkboardPlayerCard
                  key={player.name + index}
                  player={player}
                  index={index}
                  isActive={winnerIndex === null && currentPlayerIndex === index}
                  isWinner={winnerIndex === index}
                  detectionState={detectionState}
                  getDisplayName={getDisplayName}
                  visits={playerVisits[index] ?? []}
                  legAverage={legAverages[index] ?? null}
                  legDarts={legDartsByPlayer[index] ?? 0}
                />
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 gap-6">
            <div className="rounded-2xl border border-white/10 bg-black/40 px-8 py-7">
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
              <div className={`mt-6 grid grid-cols-1 gap-5 ${isClubBoard ? "sm:grid-cols-1 lg:grid-cols-3" : "sm:grid-cols-3"} `}>
                {[0, 1, 2].map((index) => {
                  const score = currentDartScores[index];
                  const applied = appliedScores[index] ?? 0;
                  const suggestion = checkoutSuggestions[index];
                  const disabled = winnerIndex !== null || !turnInputArmed;
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
                      className={`rounded-2xl border ${isClubBoard ? "min-h-[200px] px-9 py-8" : "px-6 py-6"} text-left transition ${
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
                          <div className="text-sm uppercase tracking-[0.25em] text-zinc-400 mb-2">Dart {index + 1}</div>
                          {showSuggestion ? (
                            <div className="text-4xl font-semibold text-blue-400/60">[{suggestion}]</div>
                          ) : score ? (
                            <div className="text-4xl font-semibold text-white">{formatDartLabel(score)}</div>
                          ) : (
                            <div className={`${isClubBoard ? "text-xl" : "text-base"} text-zinc-500`}>No dart - Click to add</div>
                          )}
                          {score && <div className={`${isClubBoard ? "text-base" : "text-sm"} text-zinc-400 mt-2`}>Counted {formatAppliedScore(applied)}</div>}
                        </div>
                        {score && <span className="text-xs text-zinc-500">Edit</span>}
                      </div>
                    </button>
                  );
                })}
              </div>
              <div className="mt-6 grid grid-cols-3 gap-6 text-base">
                <div className="flex flex-col gap-1">
                  <span className="text-zinc-500 uppercase tracking-wider">Turn Status</span>
                  <span className="text-white font-semibold">
                    {currentTurn?.darts.filter(d => d !== null).length || 0}/3 darts thrown
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-zinc-500 uppercase tracking-wider">Detection</span>
                  <span className="text-white font-semibold">
                    {!turnInputArmed
                      ? "Waiting turn sync..."
                      : dartCount > 0
                      ? `${dartCount} detected`
                      : "Ready"}
                  </span>
                </div>
                <div className="flex flex-col gap-1 items-start sm:items-end">
                  <span className="text-zinc-500 uppercase tracking-wider">Turn Total</span>
                  <span className="text-4xl leading-none font-extrabold text-emerald-500 tabular-nums">
                    {currentTurn?.scored ?? 0}
                  </span>
                </div>
                {detectionState === "removing_darts" && (
                  <div className="flex flex-col gap-1 col-span-3">
                    <span className="text-blue-400 uppercase tracking-wider font-semibold">
                      Removing darts...
                    </span>
                  </div>
                )}
                {detectionState === "partial_takeout" && (
                  <div className="flex flex-col gap-1 col-span-3">
                    <span className="text-yellow-400 uppercase tracking-wider font-semibold">
                      Partial takeout detected - Remove remaining darts
                    </span>
                  </div>
                )}
                {currentTurn?.finished && !currentTurn?.bust && (
                  <div className="flex flex-col gap-1 col-span-3">
                    <span className="text-emerald-400 uppercase tracking-wider font-semibold">
                      Checkout Complete
                    </span>
                  </div>
                )}
                {currentTurn?.bust && (
                  <div className="flex flex-col gap-1 col-span-3">
                    <span className="text-red-400 uppercase tracking-wider font-semibold">
                      Bust - Remove darts to continue
                    </span>
                  </div>
                )}
              </div>
            </div>

          </div>
        </div>
      </main>

      {activeGifReaction && (
        <div className="pointer-events-none fixed inset-0 z-[55] flex items-center justify-center bg-black/35 px-4">
          <div className="max-w-[min(78vw,760px)] overflow-hidden rounded-2xl border border-cyan-300/35 bg-black/70 shadow-2xl shadow-cyan-500/20">
            {activeGifReaction.isVideo ? (
              <video
                src={activeGifReaction.src}
                autoPlay
                muted
                loop
                playsInline
                className="max-h-[68vh] w-full object-contain"
              />
            ) : (
              <img
                src={activeGifReaction.src}
                alt={activeGifReaction.label}
                className="max-h-[68vh] w-full object-contain"
              />
            )}
            <div className="border-t border-white/10 bg-black/80 px-5 py-3 text-center text-sm font-semibold uppercase tracking-[0.28em] text-cyan-100">
              {activeGifReaction.label}
            </div>
          </div>
        </div>
      )}

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
                <div className="text-3xl mb-4 font-bold tracking-[0.2em] text-emerald-100">WIN</div>
                <div className="text-4xl font-extrabold text-white mb-2">
                  {celebrationType === 'match' ? 'MATCH WON!' : 'LEG WON!'}
                </div>
                <div className="text-2xl font-semibold text-emerald-100">
                  {celebrationWinnerIndex !== null ? getPlayerWinnerDisplayName(celebrationWinnerIndex) : ""}
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




