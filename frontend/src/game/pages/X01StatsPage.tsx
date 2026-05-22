import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { PlayerConfig } from "../context/LobbyContext";
import { getFlavorConfig } from "../../config/productFlavor";
import { getClubControlConfig } from "../../modules/shared-domain/clubControlConfig";
import { submitBoardMatchResult } from "../../modules/club-board/services/boardQueue";
import { getClubKioskSession, markQueuedMatchResultPosted } from "../../modules/club-board/kioskSession";
import DartboardSVG from "../components/DartboardSVG";

interface DartScore {
  score: number;
  multiplier: number;
  segment: string;
  zone: string;
  confidence: number;
  boardX?: number | null;
  boardY?: number | null;
  boardDisplayX?: number | null;
  boardDisplayY?: number | null;
  boardRotationDeg?: number | null;
}

interface X01PlayerState {
  name: string;
  score: number;
  startingScore: number;
  legsWon: number;
  setsWon: number;
  isBot?: boolean;
  botLevel?: number;
}

interface X01Stats {
  dartsThrown: number;
  average: number;
  firstNineAverage: number;
  averageTo170: number;
  turnBuckets: Record<string, number>;
  checkoutAttempts: number;
  checkoutSuccesses: number;
  checkoutPercentage: number;
  totalScored: number;
  turnDarts?: DartScore[][];
}

interface X01LegStatsEntry {
  setNumber?: number;
  legNumber?: number;
  winnerIndex?: number | null;
  winnerTeamId?: number | null;
  stats: X01Stats[];
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

interface X01SummaryState {
  mode: string;
  settings: {
    startScore: number;
    inMode: string;
    outMode: string;
    legsPerSet: number;
    setsToWin: number;
    gameVariant?: "standard" | "last_man_standing" | "team_play";
  };
  lms?: {
    totalLegs: number;
    playerPoints: number[];
    legResults: number[][];
  };
  match?: {
    currentSet?: number;
    currentLeg?: number;
    legWinner?: number | null;
    setWinner?: number | null;
    matchWinner?: number | null;
  };
  players: X01PlayerState[];
  teams?: X01TeamState[];
  currentTurn: {
    darts: (DartScore | null)[];
  };
  lastCompletedTurn: (DartScore | null)[];
  winner?: number | null;
  legWinner?: number | null;
  setWinner?: number | null;
  matchWinner?: number | null;
  stats?: X01Stats[];
  matchStats?: X01Stats[];
  legStats?: X01LegStatsEntry[];
}

interface StatsLocationState {
  summary?: X01SummaryState;
  players?: PlayerConfig[];
}

interface AdvancedStatsPlayerPayload {
  profileId: string;
  name: string;
}

interface HeatmapPlayerRow {
  name: string;
  darts: DartScore[];
}

function flattenTurnDarts(turnDarts: unknown): DartScore[] {
  if (!Array.isArray(turnDarts)) {
    return [];
  }
  const darts: DartScore[] = [];
  for (const turn of turnDarts) {
    if (!Array.isArray(turn)) {
      continue;
    }
    for (const dart of turn) {
      if (dart && typeof dart === "object") {
        darts.push(dart as DartScore);
      }
    }
  }
  return darts;
}

function getBoardCoordinate(dart: DartScore): { x: number; y: number } | null {
  const displayX = Number(dart.boardDisplayX);
  const displayY = Number(dart.boardDisplayY);
  const x = Number.isFinite(displayX) ? displayX : Number(dart.boardX);
  const y = Number.isFinite(displayY) ? displayY : Number(dart.boardY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return {
    x: Math.max(-1.25, Math.min(1.25, x)),
    y: Math.max(-1.25, Math.min(1.25, y)),
  };
}

function formatDartLabel(dart: DartScore): string {
  if (dart.zone === "inner_bull") return "BULL";
  if (dart.zone === "outer_bull") return "25";
  if (dart.zone === "miss" || Number(dart.score || 0) <= 0) return "Miss";
  if (Number(dart.multiplier) === 3) return `T${dart.segment}`;
  if (Number(dart.multiplier) === 2) return `D${dart.segment}`;
  return String(dart.segment || dart.score || "-");
}

function X01HeatmapModal({
  rows,
  selectedIndex,
  onSelect,
  onClose,
}: {
  rows: HeatmapPlayerRow[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onClose: () => void;
}) {
  const selected = rows[selectedIndex] ?? rows[0];
  const positioned = (selected?.darts ?? [])
    .map((dart, index) => ({ dart, index, point: getBoardCoordinate(dart) }))
    .filter((item): item is { dart: DartScore; index: number; point: { x: number; y: number } } => Boolean(item.point));
  const boardRadius = 85;

  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm px-4 py-6 overflow-y-auto">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-4">
          <div>
            <h2 className="text-xl font-extrabold text-white">Game Heatmap</h2>
            <p className="mt-1 text-sm text-zinc-400">
              {selected?.name ?? "Player"} - {positioned.length}/{selected?.darts.length ?? 0} darts with board coordinates
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-zinc-800/90 hover:bg-zinc-700 text-white transition-colors"
          >
            Close
          </button>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {rows.map((row, index) => {
            const count = row.darts.filter((dart) => getBoardCoordinate(dart)).length;
            return (
              <button
                key={`heatmap-player-${row.name}-${index}`}
                type="button"
                onClick={() => onSelect(index)}
                className={`px-3 py-2 rounded-lg border text-xs uppercase tracking-[0.2em] transition-colors ${
                  selectedIndex === index
                    ? "border-red-500/80 bg-red-600/20 text-red-100"
                    : "border-white/10 bg-zinc-900/70 text-zinc-300 hover:border-white/30"
                }`}
              >
                {row.name} ({count})
              </button>
            );
          })}
        </div>

        <div className="mt-6">
          <div className="relative mx-auto aspect-square w-full max-w-[820px]">
            <DartboardSVG className="absolute inset-0 h-full w-full" size={512} />
            <svg className="absolute inset-0 h-full w-full" viewBox="-110 -110 220 220" aria-label="Player dart heatmap">
              <defs>
                <radialGradient id="x01-heat-dot" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor="#fef08a" stopOpacity="0.95" />
                  <stop offset="45%" stopColor="#fb923c" stopOpacity="0.55" />
                  <stop offset="100%" stopColor="#ef4444" stopOpacity="0" />
                </radialGradient>
              </defs>
              {positioned.map(({ point, index }) => {
                const x = point.x * boardRadius;
                const y = point.y * boardRadius;
                return <circle key={`heat-${index}`} cx={x} cy={y} r={10} fill="url(#x01-heat-dot)" />;
              })}
              {positioned.map(({ point, dart, index }) => {
                const x = point.x * boardRadius;
                const y = point.y * boardRadius;
                return (
                  <g key={`dot-${index}`}>
                    <circle cx={x} cy={y} r={2.2} fill="#ffffff" stroke="#0f172a" strokeWidth={0.8} />
                    <title>{formatDartLabel(dart)}</title>
                  </g>
                );
              })}
            </svg>
          </div>
          {!positioned.length && (
            <div className="mx-auto mt-5 max-w-[820px] rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-center text-sm text-zinc-400">
              No coordinate data was captured for this player in this game.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function X01StatsPage() {
  const navigate = useNavigate();
  const { state } = useLocation() as { state?: StatsLocationState };
  const summary = state?.summary;
  const flavor = React.useMemo(() => getFlavorConfig(), []);
  const clubCfg = React.useMemo(() => getClubControlConfig(), []);
  const postedBoardResultRef = useRef(false);
  const [boardSubmitStatus, setBoardSubmitStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");

  const configPlayers: PlayerConfig[] | undefined = useMemo(() => {
    const raw = state?.players;
    return Array.isArray(raw) ? (raw as PlayerConfig[]) : undefined;
  }, [state?.players]);

  const playerRows = useMemo(() => summary?.players ?? [], [summary?.players]);
  const isTeamPlay = summary?.settings?.gameVariant === "team_play" && Array.isArray(summary?.teams) && summary.teams.length > 0;
  const nameWithBot = useCallback((player: X01PlayerState, index: number) => {
    const config = configPlayers?.[index];
    const isBotFromState = Boolean(config?.isBot || player.isBot);
    const botLevel = config?.botLevel ?? player.botLevel;
    if (!isBotFromState) {
      return player.name;
    }
    return `${player.name}${botLevel ? ` (Bot L${botLevel})` : " (Bot)"}`;
  }, [configPlayers]);

  const emptyStats = useMemo<X01Stats>(
    () => ({
      dartsThrown: 0,
      average: 0,
      firstNineAverage: 0,
      averageTo170: 0,
      turnBuckets: {},
      checkoutAttempts: 0,
      checkoutSuccesses: 0,
      checkoutPercentage: 0,
      totalScored: 0,
    }),
    []
  );

  const combineStats = useCallback((items: X01Stats[]): X01Stats => {
    const totalScored = items.reduce((sum, stats) => sum + Number(stats.totalScored || 0), 0);
    const dartsThrown = items.reduce((sum, stats) => sum + Number(stats.dartsThrown || 0), 0);
    const checkoutAttempts = items.reduce((sum, stats) => sum + Number(stats.checkoutAttempts || 0), 0);
    const checkoutSuccesses = items.reduce((sum, stats) => sum + Number(stats.checkoutSuccesses || 0), 0);
    const buckets: Record<string, number> = {};
    for (const stats of items) {
      for (const [key, value] of Object.entries(stats.turnBuckets || {})) {
        buckets[key] = (buckets[key] || 0) + Number(value || 0);
      }
    }
    return {
      dartsThrown,
      totalScored,
      average: dartsThrown > 0 ? (totalScored / dartsThrown) * 3 : 0,
      firstNineAverage: 0,
      averageTo170: 0,
      turnBuckets: buckets,
      checkoutAttempts,
      checkoutSuccesses,
      checkoutPercentage: checkoutAttempts > 0 ? (checkoutSuccesses / checkoutAttempts) * 100 : 0,
    };
  }, []);

  const advancedPlayers = useMemo<AdvancedStatsPlayerPayload[]>(() => {
    if (!configPlayers || !playerRows.length) {
      return [];
    }
    return configPlayers
      .map((playerConfig, index) => {
        if (!playerConfig?.profileId) {
          return null;
        }
        return {
          profileId: playerConfig.profileId,
          name: playerRows[index]?.name ?? playerConfig.name,
        };
      })
      .filter((item): item is AdvancedStatsPlayerPayload => Boolean(item?.profileId));
  }, [configPlayers, playerRows]);

  const fallbackStats = useMemo<X01Stats[]>(() => {
    if (!summary || !summary.players) {
      return [];
    }
    const turnHistory = Array.isArray((summary as any)?.turnHistory) ? (summary as any).turnHistory : [];
    return summary.players.map((_player, playerIndex) => {
      const playerTurns = turnHistory.filter((entry: any) => entry.playerIndex === playerIndex || entry[0] === playerIndex);

      let dartsThrown = 0;
      let totalScored = 0;
      const firstNineScores: number[] = [];
      let checkoutAttempts = 0;
      let checkoutSuccesses = 0;
      const turnBuckets: Record<string, number> = {
        "60plus": 0,
        "80plus": 0,
        "100plus": 0,
        "120plus": 0,
        "140plus": 0,
        "170plus": 0,
        "180": 0,
      };

      playerTurns.forEach((entry: any) => {
        const turn = entry.turnIndex !== undefined ? entry : entry[1];
        if (!turn) return;

        const dartsUsed = turn.dartsUsed || 0;
        const scored = turn.scored || 0;
        const appliedScores = turn.appliedScores || [];
        const scoreBefore = turn.scoreBefore || 0;
        const finished = turn.finished || false;

        dartsThrown += dartsUsed;
        totalScored += scored;

        if (firstNineScores.length < 9) {
          const remaining = 9 - firstNineScores.length;
          firstNineScores.push(...appliedScores.slice(0, Math.min(remaining, dartsUsed)));
        }

        const visitTotal = appliedScores.slice(0, dartsUsed).reduce((sum: number, score: number) => sum + score, 0);
        const bucketThresholds = [
          ["180", 180],
          ["170plus", 170],
          ["140plus", 140],
          ["120plus", 120],
          ["100plus", 100],
          ["80plus", 80],
          ["60plus", 60],
        ];

        for (const [key, threshold] of bucketThresholds) {
          if (visitTotal >= threshold) {
            turnBuckets[key as string] = (turnBuckets[key as string] || 0) + 1;
            break;
          }
        }

        if (scoreBefore <= 170) {
          checkoutAttempts++;
        }
        if (finished) {
          checkoutSuccesses++;
        }
      });

      const average = dartsThrown > 0 ? (totalScored / dartsThrown) * 3 : 0;
      const firstNineTotal = firstNineScores.reduce((sum, score) => sum + score, 0);
      const firstNineAverage = firstNineScores.length > 0 ? (firstNineTotal / firstNineScores.length) * 3 : 0;

      let remainingScore = summary.settings?.startScore || 501;
      let pre170Darts = 0;
      let pre170Score = 0;

      playerTurns.forEach((entry: any) => {
        const turn = entry.turnIndex !== undefined ? entry : entry[1];
        if (!turn || remainingScore <= 170) return;

        const appliedScores = turn.appliedScores || [];
        const dartsUsed = turn.dartsUsed || 0;

        for (let i = 0; i < dartsUsed && remainingScore > 170; i++) {
          pre170Darts++;
          pre170Score += appliedScores[i] || 0;
          remainingScore -= appliedScores[i] || 0;
        }
      });

      const averageTo170 = pre170Darts > 0 ? (pre170Score / pre170Darts) * 3 : 0;
      const checkoutPercentage = checkoutAttempts > 0 ? (checkoutSuccesses / checkoutAttempts) * 100 : 0;

      return {
        dartsThrown,
        average,
        firstNineAverage,
        averageTo170,
        turnBuckets,
        checkoutAttempts,
        checkoutSuccesses,
        checkoutPercentage,
        totalScored,
      };
    });
  }, [summary]);

  const matchStats = useMemo(() => {
    if (summary && Array.isArray(summary.matchStats) && summary.matchStats.length) {
      return summary.matchStats;
    }
    if (summary && Array.isArray(summary.stats) && summary.stats.length) {
      return summary.stats;
    }
    return fallbackStats;
  }, [summary, fallbackStats]);

  const legStatsOptions = useMemo<X01LegStatsEntry[]>(() => {
    if (summary && Array.isArray(summary.legStats) && summary.legStats.length) {
      return summary.legStats;
    }
    if (summary && Array.isArray(summary.stats) && summary.stats.length) {
      return [
        {
          setNumber: summary.match?.currentSet,
          legNumber: summary.match?.currentLeg,
          winnerIndex: summary.legWinner ?? summary.winner ?? null,
          stats: summary.stats,
        },
      ];
    }
    if (fallbackStats.length) {
      return [
        {
          setNumber: summary?.match?.currentSet,
          legNumber: summary?.match?.currentLeg,
          winnerIndex: summary?.legWinner ?? summary?.winner ?? null,
          stats: fallbackStats,
        },
      ];
    }
    return [];
  }, [summary, fallbackStats]);

  const hasLegStats = legStatsOptions.length > 0;

  const [selectedScope, setSelectedScope] = useState<"match" | number>("match");
  const [heatmapOpen, setHeatmapOpen] = useState(false);
  const [selectedHeatmapPlayer, setSelectedHeatmapPlayer] = useState(0);

  useEffect(() => {
    if (selectedScope !== "match" && (selectedScope < 0 || selectedScope >= legStatsOptions.length)) {
      setSelectedScope("match");
    }
  }, [selectedScope, legStatsOptions.length]);

  const statsForScope = useMemo(() => {
    if (selectedScope === "match") {
      return matchStats;
    }
    if (typeof selectedScope === "number") {
      const entry = legStatsOptions[selectedScope];
      return entry?.stats ?? matchStats;
    }
    return matchStats;
  }, [selectedScope, matchStats, legStatsOptions]);

  const scopedStatsAligned = useMemo(() => {
    if (!playerRows.length) {
      return [];
    }
    return playerRows.map((_, index) => {
      const stats = statsForScope[index];
      if (stats) {
        return stats;
      }
      return emptyStats;
    });
  }, [emptyStats, playerRows, statsForScope]);

  const displayRows = useMemo(() => {
    if (isTeamPlay) {
      return (summary?.teams ?? []).map((team) => ({
        id: team.teamId,
        name: team.teamName,
        setsWon: team.setsWon,
        legsWon: team.legsWon,
        color: team.teamColor,
        playerIndices: team.playerIndices,
      }));
    }
    return playerRows.map((player, index) => ({
      id: index,
      name: nameWithBot(player, index),
      setsWon: player.setsWon,
      legsWon: player.legsWon,
      color: undefined,
      playerIndices: [index],
    }));
  }, [isTeamPlay, nameWithBot, playerRows, summary?.teams]);

  const scopedDisplayStats = useMemo(() => {
    if (!isTeamPlay) {
      return scopedStatsAligned;
    }
    return displayRows.map((row) => {
      const stats = row.playerIndices
        .map((playerIndex) => scopedStatsAligned[playerIndex])
        .filter((item): item is X01Stats => Boolean(item));
      return stats.length ? combineStats(stats) : emptyStats;
    });
  }, [combineStats, displayRows, emptyStats, isTeamPlay, scopedStatsAligned]);

  const playerHeatmapDarts = useMemo<DartScore[][]>(() => {
    const fromStats = playerRows.map((_, index) => flattenTurnDarts(statsForScope[index]?.turnDarts));
    if (fromStats.some((darts) => darts.length > 0)) {
      return fromStats;
    }

    const turnHistory = Array.isArray((summary as any)?.turnHistory) ? (summary as any).turnHistory : [];
    return playerRows.map((_player, playerIndex) => {
      const darts: DartScore[] = [];
      for (const entry of turnHistory) {
        if (!entry || Number(entry.playerIndex) !== playerIndex || !Array.isArray(entry.darts)) {
          continue;
        }
        for (const dart of entry.darts) {
          if (dart && typeof dart === "object") {
            darts.push(dart as DartScore);
          }
        }
      }
      return darts;
    });
  }, [playerRows, statsForScope, summary]);

  const heatmapRows = useMemo<HeatmapPlayerRow[]>(() => {
    if (!isTeamPlay) {
      return displayRows.map((row) => ({
        name: row.name,
        darts: playerHeatmapDarts[row.playerIndices[0]] ?? [],
      }));
    }
    return displayRows.map((row) => ({
      name: row.name,
      darts: row.playerIndices.flatMap((playerIndex) => playerHeatmapDarts[playerIndex] ?? []),
    }));
  }, [displayRows, isTeamPlay, playerHeatmapDarts]);

  const heatmapCoordinateCount = useMemo(
    () => heatmapRows.reduce((sum, row) => sum + row.darts.filter((dart) => getBoardCoordinate(dart)).length, 0),
    [heatmapRows]
  );

  useEffect(() => {
    if (selectedHeatmapPlayer >= heatmapRows.length) {
      setSelectedHeatmapPlayer(0);
    }
  }, [heatmapRows.length, selectedHeatmapPlayer]);

  const cumulativeLegsWon = useMemo<number[]>(() => {
    const counts = Array.from({ length: playerRows.length }, () => 0);
    if (!counts.length) return counts;
    for (const leg of legStatsOptions) {
      const winnerIdx = typeof leg?.winnerIndex === "number" ? leg.winnerIndex : -1;
      if (winnerIdx >= 0 && winnerIdx < counts.length) {
        counts[winnerIdx] += 1;
      }
    }
    return counts;
  }, [playerRows.length, legStatsOptions]);

  const activeLegMeta = typeof selectedScope === "number" ? legStatsOptions[selectedScope] : undefined;

  const scopeButtonClasses = (isActive: boolean) =>
    `px-3 py-2 rounded-lg border text-xs uppercase tracking-[0.3em] transition-colors ${
      isActive
        ? "border-red-500/80 bg-red-600/20 text-red-200"
        : "border-white/10 bg-zinc-900/60 text-zinc-300 hover:border-white/30 hover:text-white"
    }`;

  const handleAdvancedStats = () => {
    navigate("/x01/stats/advanced", {
      state: {
        players: advancedPlayers,
      },
    });
  };

  useEffect(() => {
    if (!summary) {
      navigate("/", { replace: true });
    }
  }, [summary, navigate]);

  if (!summary) {
    return null;
  }

  const winnerIndex = typeof summary.matchWinner === "number" ? summary.matchWinner :
                      typeof summary.winner === "number" ? summary.winner : null;
  const isClubBoard = flavor.flavor === "club-board";

  useEffect(() => {
    if (!summary || winnerIndex === null || postedBoardResultRef.current) return;
    if (flavor.flavor !== "club-board") return;
    const session = getClubKioskSession();
    const queued = session?.queuedMatch;
    if (!queued || queued.resultPosted) return;
    if (!queued.socialNightId || !queued.matchId) return;

    const winnerName = String(
      isTeamPlay
        ? summary.teams?.find((team) => team.teamId === winnerIndex)?.teamName
        : summary.players[winnerIndex]?.name || ""
    ).trim().toLowerCase();
    const aName = String(queued.aName || "").trim().toLowerCase();
    const bName = String(queued.bName || "").trim().toLowerCase();
    const winner: "a" | "b" = winnerName && winnerName === bName ? "b" : "a";

    const aState = summary.players.find((p) => String(p.name || "").trim().toLowerCase() === aName);
    const bState = summary.players.find((p) => String(p.name || "").trim().toLowerCase() === bName);
    const scoreA = typeof aState?.score === "number" ? aState.score : undefined;
    const scoreB = typeof bState?.score === "number" ? bState.score : undefined;

    postedBoardResultRef.current = true;
    setBoardSubmitStatus("submitting");
    void submitBoardMatchResult({
      boardId: clubCfg.boardId,
      socialNightId: queued.socialNightId,
      matchId: queued.matchId,
      winner,
      scoreA,
      scoreB,
    }).then((ok) => {
      if (ok) {
        markQueuedMatchResultPosted();
        setBoardSubmitStatus("done");
      } else {
        postedBoardResultRef.current = false;
        setBoardSubmitStatus("error");
      }
    }).catch(() => {
      postedBoardResultRef.current = false;
      setBoardSubmitStatus("error");
    });
  }, [summary, winnerIndex, flavor.flavor, clubCfg.boardId, isTeamPlay]);

  useEffect(() => {
    if (!isClubBoard || boardSubmitStatus !== "done") return;
    const id = window.setTimeout(() => navigate("/kiosk"), 2500);
    return () => window.clearTimeout(id);
  }, [isClubBoard, boardSubmitStatus, navigate]);

  const winnerName =
    winnerIndex !== null
      ? isTeamPlay
        ? summary.teams?.find((team) => team.teamId === winnerIndex)?.teamName ?? `Team ${winnerIndex + 1}`
        : nameWithBot(summary.players[winnerIndex], winnerIndex)
      : null;

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

      <header className="relative z-10 w-full px-6 md:px-10 py-6 flex items-center justify-between border-b border-white/10">
        <h1 className="text-xl font-extrabold tracking-wide">
          X01 <span className="text-red-500">Match Stats</span>
        </h1>
        <div className="flex gap-3 flex-wrap justify-end">
          <button
            type="button"
            onClick={() => {
              setSelectedHeatmapPlayer((current) => Math.min(current, Math.max(0, heatmapRows.length - 1)));
              setHeatmapOpen(true);
            }}
            disabled={heatmapCoordinateCount <= 0}
            className="px-4 py-2 rounded-lg border border-amber-400/40 text-amber-100 bg-amber-500/10 hover:bg-amber-500/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Heatmap
          </button>
          <button
            type="button"
            onClick={handleAdvancedStats}
            className="px-4 py-2 rounded-lg border border-cyan-400/40 text-cyan-100 bg-cyan-500/10 hover:bg-cyan-500/20 transition-colors"
          >
            Advanced Stats
          </button>
          <button
            type="button"
            onClick={() => navigate(isClubBoard ? "/kiosk" : "/lobby")}
            className="px-4 py-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 transition-colors"
          >
            {isClubBoard ? "Back To Queue" : "New Match"}
          </button>
          <button
            type="button"
            onClick={() => navigate("/")}
            className="px-4 py-2 rounded-lg bg-red-600/80 hover:bg-red-500/80 transition-colors"
          >
            Home
          </button>
        </div>
      </header>

      <main className="relative z-10 flex-1 px-4 md:px-10 pb-10">
        <div className="max-w-6xl mx-auto mt-6 space-y-6">
          {isClubBoard && boardSubmitStatus !== "idle" && (
            <div
              className={`rounded-xl border px-4 py-3 text-sm ${
                boardSubmitStatus === "done"
                  ? "border-emerald-600/70 bg-emerald-600/10 text-emerald-200"
                  : boardSubmitStatus === "error"
                    ? "border-amber-600/70 bg-amber-600/10 text-amber-200"
                    : "border-cyan-600/70 bg-cyan-600/10 text-cyan-200"
              }`}
            >
              {boardSubmitStatus === "submitting" && "Submitting match result to social night..."}
              {boardSubmitStatus === "done" && "Result submitted. Returning to board queue..."}
              {boardSubmitStatus === "error" && "Could not submit result automatically. You can still continue from queue."}
            </div>
          )}
          {/* Match Info */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="rounded-xl border border-white/10 bg-black/40 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Game</p>
              <p className="text-lg font-bold text-white">{summary.settings.startScore}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/40 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Format</p>
              <p className="text-lg font-bold text-white">
                {summary.settings.setsToWin > 1 
                  ? `First to ${summary.settings.setsToWin}L` 
                  : `${summary.settings.legsPerSet} Legs`}
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/40 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">In</p>
              <p className="text-lg font-bold text-white">{summary.settings.inMode.toUpperCase()}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/40 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Out</p>
              <p className="text-lg font-bold text-white">{summary.settings.outMode.toUpperCase()}</p>
            </div>

          {/* Last Man Standing Results */}
          {summary.settings.gameVariant === "last_man_standing" && summary.lms && (
            <div className="rounded-xl border border-white/10 bg-zinc-900/60 p-6">
              <h2 className="text-xl font-bold mb-4 text-white">Last Man Standing Results</h2>
              
              {/* Final Standings */}
              <div className="space-y-2 mb-6">
                {summary.players
                  .map((player, idx) => ({ player, idx, points: summary.lms?.playerPoints[idx] || 0 }))
                  .sort((a, b) => b.points - a.points)
                  .map((item, rank) => (
                    <div 
                      key={item.idx} 
                      className={`flex items-center justify-between p-3 rounded ${
                        rank === 0 ? 'bg-yellow-900/30 border border-yellow-600/50' : 'bg-black/40'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-2xl font-bold text-zinc-500">#{rank + 1}</span>
                        <span className="font-semibold text-white">{item.player.name}</span>
                      </div>
                      <span className="text-xl font-bold text-emerald-400">
                        {item.points} pts
                      </span>
                    </div>
                  ))}
              </div>
              
              {/* Leg-by-Leg Breakdown */}
              <div className="mt-6">
                <h3 className="text-sm font-semibold mb-3 text-white">Leg Results</h3>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead>
                      <tr className="border-b border-white/10">
                        <th className="text-left p-2 text-zinc-400">Player</th>
                        {Array.from({ length: summary.lms.totalLegs }, (_, i) => (
                          <th key={i} className="text-center p-2 text-zinc-400">Leg {i + 1}</th>
                        ))}
                        <th className="text-right p-2 text-zinc-400">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.players.map((player, idx) => (
                        <tr key={idx} className="border-b border-white/5">
                          <td className="p-2 text-white">{player.name}</td>
                          {summary.lms?.legResults.map((legResult, legIdx) => {
                            const position = legResult[idx];
                            const points = position ? (7 - position) : 0;
                            return (
                              <td key={legIdx} className="text-center p-2 text-zinc-300">
                                {position ? (
                                  <span className="inline-block">
                                    #{position} <span className="text-emerald-400">({points}pts)</span>
                                  </span>
                                ) : '-'}
                              </td>
                            );
                          })}
                          <td className="text-right p-2 font-bold text-white">
                            {summary.lms?.playerPoints[idx] || 0}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
          </div>

          {winnerName && (
            <div className="rounded-2xl border border-emerald-500/60 bg-emerald-600/15 px-6 py-4">
              <p className="text-lg font-semibold text-emerald-200">{winnerName} wins the match!</p>
              <p className="text-xs uppercase tracking-[0.3em] text-emerald-300 mt-1">
                {summary.settings.startScore} · {summary.settings.inMode}/{summary.settings.outMode}
              </p>
            </div>
          )}

          {/* Match Score */}
          <div className="rounded-2xl border border-white/10 bg-black/40 overflow-hidden shadow-[0_18px_50px_rgba(0,0,0,0.35)]">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-separate [border-spacing:0]">
              <thead>
                <tr className="bg-black/60">
                  <th className="px-4 py-3 text-left text-xs uppercase tracking-[0.3em] text-zinc-500">{isTeamPlay ? "Team" : "Player"}</th>
                  <th className="px-4 py-3 text-center text-xs uppercase tracking-[0.3em] text-zinc-500">Sets Won</th>
                  <th className="px-4 py-3 text-center text-xs uppercase tracking-[0.3em] text-zinc-500">Legs Won</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((row, index) => (
                  <tr
                    key={'score-row-' + row.name + '-' + row.id}
                    className="border-t border-white/5 odd:bg-black/30 even:bg-black/40"
                  >
                    <td className="px-4 py-3 text-sm font-semibold text-white">
                      <span className="inline-flex items-center gap-2">
                        {row.color && (
                          <span className="h-3 w-3 rounded-full" style={{ backgroundColor: row.color }} />
                        )}
                        {row.name}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center text-lg font-bold text-red-500">
                      {row.setsWon}
                    </td>
                    <td className="px-4 py-3 text-center text-lg font-bold text-blue-400">
                      {isTeamPlay ? row.legsWon : cumulativeLegsWon[index] ?? row.legsWon}
                    </td>
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
          </div>

          {/* Stats Scope */}
          <div className="rounded-2xl border border-white/10 bg-black/40 px-6 py-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <h2 className="text-lg font-semibold text-white">Statistics Scope</h2>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={scopeButtonClasses(selectedScope === "match")}
                  onClick={() => setSelectedScope("match")}
                >
                  Match Totals
                </button>
                {legStatsOptions.map((leg, index) => {
                  const labelParts: string[] = [];
                  if (leg.setNumber) {
                    labelParts.push(`Set ${leg.setNumber}`);
                  }
                  labelParts.push(`Leg ${leg.legNumber ?? index + 1}`);
                  return (
                    <button
                      key={`leg-scope-${index}`}
                      type="button"
                      className={scopeButtonClasses(selectedScope === index)}
                      onClick={() => setSelectedScope(index)}
                    >
                      {labelParts.join(" · ")}
                    </button>
                  );
                })}
              </div>
            </div>
            {selectedScope === "match" ? (
              <p className="text-sm text-zinc-400">
                {hasLegStats
                  ? "Viewing cumulative match performance across all completed legs."
                  : "Per-leg breakdown is not available for this match, showing cumulative totals instead."}
              </p>
            ) : activeLegMeta ? (
              <div className="text-sm text-zinc-400 flex flex-wrap gap-3">
                <span>
                  Set {activeLegMeta.setNumber ?? 1}, Leg{" "}
                  {activeLegMeta.legNumber ?? (typeof selectedScope === "number" ? selectedScope + 1 : 1)}
                </span>
                {((isTeamPlay && typeof activeLegMeta.winnerTeamId === "number") ||
                  (!isTeamPlay && typeof activeLegMeta.winnerIndex === "number" &&
                    activeLegMeta.winnerIndex >= 0 &&
                    activeLegMeta.winnerIndex < playerRows.length)) && (
                    <span>
                      Winner:{" "}
                      <span className="text-white">
                        {isTeamPlay
                          ? summary.teams?.find((team) => team.teamId === activeLegMeta.winnerTeamId)?.teamName ?? `Team ${Number(activeLegMeta.winnerTeamId) + 1}`
                          : nameWithBot(playerRows[activeLegMeta.winnerIndex as number], activeLegMeta.winnerIndex as number)}
                      </span>
                    </span>
                  )}
              </div>
            ) : (
              <p className="text-sm text-zinc-400">No per-leg detail is available for this selection.</p>
            )}
          </div>

          {/* Statistics Table */}
          <div className="rounded-2xl border border-white/10 bg-black/40 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-separate [border-spacing:0]">
              <thead>
                <tr className="bg-black/60">
                  <th className="px-4 py-3 text-left text-xs uppercase tracking-[0.3em] text-zinc-500">Stat</th>
                  {displayRows.map((row) => (
                    <th
                      key={'stat-head-' + row.name + '-' + row.id}
                      className="px-4 py-3 text-right text-xs uppercase tracking-[0.3em] text-zinc-500"
                    >
                      {row.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="text-sm text-zinc-200">
                {[
                  { label: "Darts Thrown", accessor: (stats: X01Stats) => stats.dartsThrown },
                  { label: "Total Scored", accessor: (stats: X01Stats) => stats.totalScored },
                  {
                    label: "Average",
                    accessor: (stats: X01Stats) => stats.average.toFixed(2),
                  },
                  {
                    label: "First 9 Average",
                    accessor: (stats: X01Stats) => stats.firstNineAverage.toFixed(2),
                  },
                  {
                    label: "Average to 170",
                    accessor: (stats: X01Stats) => stats.averageTo170.toFixed(2),
                  },
                  {
                    label: "Checkout %",
                    accessor: (stats: X01Stats) => 
                      `${stats.checkoutPercentage.toFixed(1)}% (${stats.checkoutSuccesses}/${stats.checkoutAttempts})`,
                  },
                ].map((row) => (
                  <tr key={'stat-row-' + row.label} className="border-t border-white/5">
                    <td className="px-4 py-3 text-left text-zinc-400">{row.label}</td>
                    {scopedDisplayStats.map((stats, index) => (
                      <td key={'stat-val-' + row.label + '-' + index} className="px-4 py-3 text-right">
                        {row.accessor(stats) as React.ReactNode}
                      </td>
                    ))}
                  </tr>
                ))}
                
                {/* Visit Buckets */}
                <tr className="border-t border-white/10">
                  <td colSpan={displayRows.length + 1} className="px-4 py-2 text-left text-xs uppercase tracking-[0.3em] text-zinc-500 bg-black/40">
                    Visit Scores
                  </td>
                </tr>
                {["60+", "80+", "100+", "120+", "140+", "170+", "180"].map((bucket) => (
                  <tr key={'bucket-' + bucket} className="border-t border-white/5">
                    <td className="px-4 py-3 text-left text-zinc-400">{bucket}</td>
                    {scopedDisplayStats.map((stats, index) => (
                      <td key={'bucket-val-' + bucket + '-' + index} className="px-4 py-3 text-right">
                        {stats.turnBuckets?.[bucket.replace("+", "plus")] ?? 0}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
          </div>
        </div>
      </main>
      {heatmapOpen && (
        <X01HeatmapModal
          rows={heatmapRows}
          selectedIndex={Math.min(selectedHeatmapPlayer, Math.max(0, heatmapRows.length - 1))}
          onSelect={setSelectedHeatmapPlayer}
          onClose={() => setHeatmapOpen(false)}
        />
      )}
    </div>
  );
}
