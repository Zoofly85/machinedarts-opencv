import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  BarChart3,
  CalendarClock,
  List,
  RefreshCw,
  Clock3,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import Logo from '../components/Logo';

const API_URL = 'http://localhost:8000';

interface PlayerProfile {
  id: string;
  name: string;
  createdAt: string;
}

interface PlayerStatsResponse {
  player: PlayerProfile;
  history: HistoryRecord[];
}

interface HistoryRecord {
  gameMode: string;
  startedAt: string;
  finishedAt: string;
  darts: number;
  accuracy: number;
  won: boolean;
  corrections: number;
  summary?: Record<string, any>;
}

const formatDateTime = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown';
  }
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
};

const formatPercent = (value: number, fractionDigits = 1) =>
  Number.isFinite(value) ? `${(value * 100).toFixed(fractionDigits)}%` : '0%';

const isBotProfile = (profile: PlayerProfile) =>
  profile.name.toLowerCase().startsWith('bot level');

const summarizeX01 = (summary?: Record<string, any>) => {
  if (!summary || summary.mode !== 'x01') {
    return null;
  }
  const darts = Number(summary.darts ?? 0);
  const totalScore = Number(summary.score ?? 0);
  const average = darts ? (totalScore / darts) * 3 : 0;
  const firstNineDarts = Number(summary.firstNineDarts ?? 0);
  const firstNineScore = Number(summary.firstNineScore ?? 0);
  const firstNineAverage = firstNineDarts ? (firstNineScore / firstNineDarts) * 3 : 0;
  const pre170Darts = Number(summary.pre170Darts ?? 0);
  const pre170Score = Number(summary.pre170Score ?? 0);
  const averageTo170 = pre170Darts ? (pre170Score / pre170Darts) * 3 : 0;
  const checkoutAttempts = Number(summary.checkoutAttempts ?? 0);
  const checkoutSuccesses = Number(summary.checkoutSuccesses ?? 0);
  const checkoutPct = checkoutAttempts ? (checkoutSuccesses / checkoutAttempts) * 100 : 0;
  const visitBuckets = summary.visitBuckets ?? {};

  return {
    darts,
    totalScore,
    average,
    firstNineAverage,
    averageTo170,
    checkoutAttempts,
    checkoutSuccesses,
    checkoutPct,
    visitBuckets,
  };
};

const summarizeCricket = (summary?: Record<string, any>) => {
  if (!summary || summary.mode !== 'cricket') {
    return null;
  }
  const darts = Number(summary.darts ?? 0);
  const marks = Number(summary.marks ?? 0);
  const firstNineMarks = Number(summary.firstNineMarks ?? 0);
  const firstNineDarts = Math.min(Number(summary.firstNineDarts ?? 0) || 9, 9);
  const mpr = darts ? (marks / darts) * 3 : 0;
  const firstNineMpr = firstNineDarts ? (firstNineMarks / firstNineDarts) * 3 : 0;
  const bestTurnMarks = Number(summary.bestTurnMarks ?? 0);
  const bestScore = Number(summary.bestScore ?? 0);
  const markCounts: Record<string, number> = summary.markCounts ?? {};

  return {
    darts,
    marks,
    mpr,
    firstNineMpr,
    bestTurnMarks,
    bestScore,
    markCounts,
    points: Number(summary.points ?? 0),
  };
};

const summarizeTargetTrainer = (summary?: Record<string, any>) => {
  if (!summary || summary.mode !== 'target_trainer') {
    return null;
  }
  const hits = Number(summary.hits ?? summary.totalHits ?? 0);
  const requiredHits = Number(summary.requiredHits ?? summary.targetHits ?? hits);
  const darts = Number(summary.darts ?? summary.dartsThrown ?? 0);
  const accuracy = darts ? hits / darts : 0;
  const bestStreak = Number(summary.bestStreak ?? summary.bestRun ?? 0);
  const hitsPerTurn = Number(summary.hitsPerTurn ?? summary.hitsPerVisit ?? 0);
  const avgDartsPerHit =
    summary.avgDartsPerHit !== undefined
      ? Number(summary.avgDartsPerHit)
      : hits > 0
      ? darts / hits
      : 0;

  return {
    hits,
    requiredHits,
    darts,
    accuracy,
    bestStreak,
    hitsPerTurn,
    avgDartsPerHit,
  };
};

export default function MatchHistoryPage() {
  const navigate = useNavigate();
  const [players, setPlayers] = useState<PlayerProfile[]>([]);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [isLoadingPlayers, setIsLoadingPlayers] = useState<boolean>(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState<boolean>(false);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const loadPlayers = useCallback(async () => {
    setIsLoadingPlayers(true);
    setPlayerError(null);
    try {
      const response = await fetch(`${API_URL}/api/players`);
      if (!response.ok) {
        throw new Error('Failed to fetch players');
      }
      const data = await response.json();
      const nextPlayers: PlayerProfile[] = Array.isArray(data.players) ? data.players : [];
      const humanPlayers = nextPlayers.filter((profile) => !isBotProfile(profile));
      setPlayers(humanPlayers);
      if (!selectedPlayerId && humanPlayers.length > 0) {
        setSelectedPlayerId(humanPlayers[0].id);
      } else if (
        selectedPlayerId &&
        !humanPlayers.some((profile) => profile.id === selectedPlayerId)
      ) {
        setSelectedPlayerId(humanPlayers.length > 0 ? humanPlayers[0].id : null);
      }
    } catch (err) {
      console.error('Error loading players', err);
      setPlayerError('Unable to load player profiles.');
      setPlayers([]);
    } finally {
      setIsLoadingPlayers(false);
    }
  }, [selectedPlayerId]);

  useEffect(() => {
    loadPlayers();
  }, [loadPlayers]);

  const selectedPlayer = useMemo(
    () => players.find((player) => player.id === selectedPlayerId) ?? null,
    [players, selectedPlayerId]
  );

  const loadHistory = useCallback(
    async (playerId: string) => {
      setIsLoadingHistory(true);
      setHistoryError(null);
      try {
        const response = await fetch(`${API_URL}/api/players/${playerId}/stats`);
        if (!response.ok) {
          throw new Error('Failed to fetch history');
        }
        const data: PlayerStatsResponse = await response.json();
        const filteredHistory = Array.isArray(data.history)
          ? data.history.filter((record) => record && typeof record === 'object')
          : [];
        setHistory(filteredHistory);
      } catch (err) {
        console.error('Error loading player history', err);
        setHistoryError('Unable to load match history for this player right now.');
        setHistory([]);
      } finally {
        setIsLoadingHistory(false);
      }
    },
    []
  );

  useEffect(() => {
    if (selectedPlayerId) {
      loadHistory(selectedPlayerId);
    } else {
      setHistory([]);
    }
  }, [selectedPlayerId, loadHistory]);

  const historyCards = useMemo(() => history, [history]);

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden">
      <div
        className="pointer-events-none fixed inset-0 [background:
        radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
        radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.08),transparent_70%),
        radial-gradient(ellipse_at_bottom_left,rgba(255,255,255,0.06),transparent_70%),
        radial-gradient(ellipse_at_bottom_right,rgba(255,255,255,0.1),transparent_65%),
        linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95)_30%,rgba(255,255,255,0.04)_60%,rgba(0,0,0,1)_100%)
      ]"
      />

  <header className="relative z-10 w-full px-6 md:px-10 py-6 flex items-center justify-between">
        <Logo />
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate('/profile')}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-800/50 hover:bg-gray-700/50 transition-colors"
          >
            <BarChart3 size={18} />
            <span>Stats Dashboard</span>
          </button>
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-800/50 hover:bg-gray-700/50 transition-colors"
          >
            <ArrowLeft size={18} />
            <span>Home</span>
          </button>
        </div>
      </header>

      <main className="relative z-10 w-full px-6 md:px-10 py-8">
        <div className="max-w-7xl mx-auto">
          <div className="flex items-center gap-3 mb-6">
            <List className="h-8 w-8 text-blue-400" />
            <h1 className="text-3xl font-bold">Match History</h1>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6">
            <aside className="rounded-2xl border border-white/10 bg-black/40 p-5">
              <div className="flex items-center justify-between mb-4">
                <span className="text-xs uppercase tracking-[0.3em] text-gray-500">Players</span>
                <button
                  onClick={loadPlayers}
                  disabled={isLoadingPlayers}
                  className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-black/30 px-2 py-1 text-xs text-gray-300 hover:border-blue-500/60 hover:text-white transition disabled:opacity-50"
                >
                  <RefreshCw size={14} className={isLoadingPlayers ? 'animate-spin' : undefined} />
                  <span>Refresh</span>
                </button>
              </div>

              {playerError && (
                <div className="mb-3 rounded-lg border border-red-600 bg-red-900/30 px-3 py-2 text-xs text-red-200">
                  {playerError}
                </div>
              )}

              {isLoadingPlayers && players.length === 0 && (
                <div className="text-sm text-gray-400">Loading player profiles...</div>
              )}

              <div className="space-y-2">
                {players.map((player) => {
                  const isActive = player.id === selectedPlayerId;
                  return (
                    <button
                      key={player.id}
                      type="button"
                      onClick={() => setSelectedPlayerId(player.id)}
                      className={`w-full rounded-xl border px-4 py-3 text-left transition ${
                        isActive
                          ? 'border-blue-500/70 bg-blue-500/10 shadow-[0_0_20px_rgba(59,130,246,0.25)]'
                          : 'border-white/10 bg-black/30 hover:border-blue-500/50 hover:bg-black/40'
                      }`}
                    >
                      <div className="text-sm font-semibold text-white">{player.name}</div>
                      <div className="text-xs text-gray-500 mt-1">Joined {formatDateTime(player.createdAt)}</div>
                    </button>
                  );
                })}
              </div>

              {!isLoadingPlayers && players.length === 0 && (
                <p className="mt-4 text-xs text-gray-400">
                  Create a profile from the stats dashboard to start logging match history.
                </p>
              )}
            </aside>

            <section className="rounded-2xl border border-white/10 bg-black/40 p-6 lg:p-8 min-h-[540px]">
              {!selectedPlayer && players.length > 0 && (
                <div className="text-sm text-gray-400">Select a player to view recent matches.</div>
              )}

              {selectedPlayer && (
                <>
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-6">
                    <div>
                      <h2 className="text-2xl font-semibold text-white">{selectedPlayer.name}</h2>
                      <p className="text-sm text-gray-500">
                        Match history since {formatDateTime(selectedPlayer.createdAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-gray-500">
                      <CalendarClock size={16} />
                      <span>Most recent matches first</span>
                    </div>
                  </div>

                  {historyError && (
                    <div className="mb-4 rounded-lg border border-red-600 bg-red-900/30 px-4 py-3 text-sm text-red-200">
                      {historyError}
                    </div>
                  )}

                  {isLoadingHistory ? (
                    <div className="text-sm text-gray-400 flex items-center gap-2">
                      <Clock3 className="h-4 w-4 animate-spin" />
                      Loading match history...
                    </div>
                  ) : historyCards.length === 0 ? (
                    <div className="text-sm text-gray-400">
                      No recorded matches yet. Play some legs to populate this list.
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {historyCards.map((record, index) => {
                        const startedLabel = formatDateTime(record.startedAt);
                        const finishedLabel = formatDateTime(record.finishedAt);
                        const duration =
                          record.startedAt && record.finishedAt
                            ? Math.max(
                                0,
                                Math.round(
                                  (new Date(record.finishedAt).getTime() -
                                    new Date(record.startedAt).getTime()) /
                                    1000
                                )
                              )
                            : null;
                        const isExpanded = expandedIndex === index;

                        const x01Summary = summarizeX01(record.summary);
                        const cricketSummary = summarizeCricket(record.summary);
                        const targetSummary = summarizeTargetTrainer(record.summary);

                        return (
                          <div
                            key={`${record.finishedAt}-${index}`}
                            className="rounded-2xl border border-white/10 bg-black/30 overflow-hidden"
                          >
                            <button
                              type="button"
                              onClick={() => setExpandedIndex(isExpanded ? null : index)}
                              className="w-full px-6 py-4 flex flex-col gap-2 text-left hover:bg-black/40 transition"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <div className="text-xs uppercase tracking-[0.3em] text-gray-500">
                                    {record.gameMode.toUpperCase()}
                                  </div>
                                  <div className="text-sm text-gray-300">Completed {finishedLabel}</div>
                                  <div className="text-xs text-gray-500">Started {startedLabel}</div>
                                </div>
                                <div className="flex items-center gap-3">
                                  <div
                                    className={`text-sm font-semibold ${
                                      record.won ? 'text-emerald-400' : 'text-red-400'
                                    }`}
                                  >
                                    {record.won ? 'Won' : 'Lost'}
                                  </div>
                                  <div className="text-xs text-gray-400">
                                    Darts: {record.darts} · Accuracy {formatPercent(record.accuracy)}
                                  </div>
                                  <div className="text-xs text-gray-500">
                                    Corrections: {record.corrections}
                                  </div>
                                  {duration !== null && (
                                    <div className="text-xs text-gray-500">{duration}s</div>
                                  )}
                                  {isExpanded ? (
                                    <ChevronUp className="h-4 w-4 text-gray-400" />
                                  ) : (
                                    <ChevronDown className="h-4 w-4 text-gray-400" />
                                  )}
                                </div>
                              </div>
                            </button>

                            {isExpanded && (
                              <div className="px-6 pb-6">
                                {x01Summary && (
                                  <div className="space-y-3">
                                    <h3 className="text-sm font-semibold uppercase tracking-[0.3em] text-gray-400">
                                      X01 Leg Summary
                                    </h3>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-sm text-gray-300">
                                      <SummaryStat label="Total Scored" value={x01Summary.totalScore} />
                                      <SummaryStat
                                        label="Average"
                                        value={x01Summary.average.toFixed(2)}
                                      />
                                      <SummaryStat
                                        label="First 9 Average"
                                        value={x01Summary.firstNineAverage.toFixed(2)}
                                      />
                                      <SummaryStat
                                        label="Average to 170"
                                        value={x01Summary.averageTo170.toFixed(2)}
                                      />
                                      <SummaryStat
                                        label="Checkout %"
                                        value={`${x01Summary.checkoutPct.toFixed(1)}%`}
                                        secondary={`${x01Summary.checkoutSuccesses}/${x01Summary.checkoutAttempts}`}
                                      />
                                    </div>
                                    <div className="mt-4">
                                      <h4 className="text-xs uppercase tracking-[0.3em] text-gray-500 mb-2">
                                        Visit Buckets
                                      </h4>
                                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-xs text-gray-400">
                                        {['60plus', '80plus', '100plus', '120plus', '140plus', '170plus', '180'].map(
                                          (key) => (
                                            <div
                                              key={key}
                                              className="rounded-lg border border-white/10 bg-black/40 px-3 py-2"
                                            >
                                              <div className="text-[10px] uppercase tracking-[0.3em] text-gray-500">
                                                {key.replace('plus', '+').toUpperCase()}
                                              </div>
                                              <div className="text-sm text-white">
                                                {x01Summary.visitBuckets?.[key] ?? 0}
                                              </div>
                                            </div>
                                          )
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                )}

                                {cricketSummary && (
                                  <div className="space-y-3">
                                    <h3 className="text-sm font-semibold uppercase tracking-[0.3em] text-gray-400">
                                      Cricket Leg Summary
                                    </h3>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-sm text-gray-300">
                                      <SummaryStat label="Marks" value={cricketSummary.marks} />
                                      <SummaryStat
                                        label="MPR"
                                        value={cricketSummary.mpr.toFixed(2)}
                                      />
                                      <SummaryStat
                                        label="First 9 MPR"
                                        value={cricketSummary.firstNineMpr.toFixed(2)}
                                      />
                                      <SummaryStat label="Best Turn" value={cricketSummary.bestTurnMarks} />
                                      <SummaryStat label="Best Score" value={cricketSummary.bestScore} />
                                      <SummaryStat label="Points Scored" value={cricketSummary.points} />
                                    </div>
                                    <div className="mt-4">
                                      <h4 className="text-xs uppercase tracking-[0.3em] text-gray-500 mb-2">
                                        3+ Mark Visits
                                      </h4>
                                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-xs text-gray-400">
                                        {[3, 4, 5, 6, 7, 8, 9].map((marks) => (
                                          <div
                                            key={marks}
                                            className="rounded-lg border border-white/10 bg-black/40 px-3 py-2"
                                          >
                                            <div className="text-[10px] uppercase tracking-[0.3em] text-gray-500">
                                              {marks} Marks
                                            </div>
                                            <div className="text-sm text-white">
                                              {cricketSummary.markCounts?.[String(marks)] ?? 0}
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  </div>
                                )}

                                {targetSummary && (
                                  <div className="space-y-3">
                                    <h3 className="text-sm font-semibold uppercase tracking-[0.3em] text-gray-400">
                                      Target Trainer Summary
                                    </h3>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-sm text-gray-300">
                                      <SummaryStat label="Hits" value={`${targetSummary.hits}/${targetSummary.requiredHits}`} />
                                      <SummaryStat label="Darts Thrown" value={targetSummary.darts} />
                                      <SummaryStat
                                        label="Accuracy"
                                        value={formatPercent(targetSummary.accuracy, 1)}
                                      />
                                      <SummaryStat
                                        label="Avg Darts/Hit"
                                        value={targetSummary.avgDartsPerHit ? targetSummary.avgDartsPerHit.toFixed(2) : '—'}
                                      />
                                      <SummaryStat
                                        label="Hits/Turn"
                                        value={targetSummary.hitsPerTurn ? targetSummary.hitsPerTurn.toFixed(2) : '—'}
                                      />
                                      <SummaryStat label="Best Streak" value={targetSummary.bestStreak || '—'} />
                                    </div>
                                  </div>
                                )}

                                {!x01Summary && !cricketSummary && !targetSummary && (
                                  <div className="text-sm text-gray-400">
                                    No detailed statistics were stored for this match.
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
        </div>
      </main>

      <footer className="relative z-10 border-t border-white/10 py-6 text-center text-xs text-gray-500 mt-12">
        {new Date().getFullYear()} Machine Darts - Complete visibility into every leg.
      </footer>
    </div>
  );
}

function SummaryStat({ label, value, secondary }: { label: string; value: number | string; secondary?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-3">
      <div className="text-[10px] uppercase tracking-[0.3em] text-gray-500">{label}</div>
      <div className="text-lg font-semibold text-white mt-1">{value}</div>
      {secondary && <div className="text-[11px] text-gray-500 mt-1">{secondary}</div>}
    </div>
  );
}
