import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, BarChart3, List, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import Logo from '../components/Logo';
import { getPlayersCached, invalidatePlayersCache, renamePlayerProfile, type PlayerProfile } from '../services/playersApi';
import { API_BASE_URL } from "../../services/api";

const API_URL = API_BASE_URL;

type ModeKey = 'x01' | 'cricket' | 'around_the_clock';
type WindowKey = '10' | '100' | '1000' | '5000' | 'all';

interface MetricTriple {
  current: number;
  previous: number;
  best: number;
}

interface X01WindowStats {
  legs: number;
  legsWon: number;
  averages: {
    ppr: MetricTriple;
    pprTo170: MetricTriple;
    firstNine: MetricTriple;
  };
  checkout: {
    attempts: number;
    successes: number;
    percentage: MetricTriple;
  };
  buckets: {
    total: Record<string, number>;
    perLeg: Record<string, number>;
  };
}

interface CricketWindowStats {
  legs: number;
  legsWon: number;
  averages: {
    mpr: MetricTriple;
    firstNineMpr: MetricTriple;
    score: MetricTriple;
  };
  marks: {
    total: Record<string, number>;
    perLeg: Record<string, number>;
  };
}

interface AroundTheClockWindowStats {
  legs: number;
  legsWon: number;
  averages: {
    accuracy: MetricTriple;
    targetsPerLeg: MetricTriple;
    dartsPerTarget: MetricTriple;
  };
  numberAccuracy?: Record<string, number>;
}

interface AroundTheClockModeSummary {
  overall: AroundTheClockWindowStats;
  windows: Record<string, AroundTheClockWindowStats>;
  modes?: {
    single: { windows: Record<string, AroundTheClockWindowStats> };
    double: { windows: Record<string, AroundTheClockWindowStats> };
    triple: { windows: Record<string, AroundTheClockWindowStats> };
    full: { windows: Record<string, AroundTheClockWindowStats> };
  };
}

interface ModeSummary<T> {
  overall: T;
  windows: Record<string, T>;
}

interface PlayerStatsResponse {
  player: PlayerProfile;
  history: Array<Record<string, unknown>>;
  modes: {
    x01: ModeSummary<X01WindowStats>;
    cricket: ModeSummary<CricketWindowStats>;
    around_the_clock: AroundTheClockModeSummary;
  };
}

const MODES: { key: ModeKey; label: string }[] = [
  { key: 'x01', label: 'X01' },
  { key: 'cricket', label: 'Cricket' },
  { key: 'around_the_clock', label: 'Around the Clock' },
];

const WINDOW_ORDER: WindowKey[] = ['10', '100', '1000', '5000', 'all'];
const WINDOW_LABELS: Record<WindowKey, string> = {
  '10': 'Last 10',
  '100': 'Last 100',
  '1000': 'Last 1000',
  '5000': 'Last 5000',
  all: 'All Legs',
};

const X01_BUCKET_LABELS: { key: string; label: string }[] = [
  { key: '40plus', label: '40+' },
  { key: '60plus', label: '60+' },
  { key: '80plus', label: '80+' },
  { key: '100plus', label: '100+' },
  { key: '120plus', label: '120+' },
  { key: '140plus', label: '140+' },
  { key: '170plus', label: '170+' },
  { key: '180', label: '180' },
];

const CRICKET_MARK_LABELS: { key: string; label: string }[] = [
  { key: '3', label: '3 Marks' },
  { key: '4', label: '4 Marks' },
  { key: '5', label: '5 Marks' },
  { key: '6', label: '6 Marks' },
  { key: '7', label: '7 Marks' },
  { key: '8', label: '8 Marks' },
  { key: '9', label: '9 Marks' },
];

const formatNumber = (value: number, fractionDigits = 2) =>
  Number.isFinite(value) ? value.toFixed(fractionDigits) : '0.00';

const formatPercent = (value: number) =>
  Number.isFinite(value) ? `${value.toFixed(2)}%` : '0.00%';

const formatDate = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown';
  }
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

export default function ProfilePage() {
  const navigate = useNavigate();
  const [players, setPlayers] = useState<PlayerProfile[]>([]);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [playerStats, setPlayerStats] = useState<PlayerStatsResponse | null>(null);
  const [isLoadingPlayers, setIsLoadingPlayers] = useState(false);
  const [loadingStats, setLoadingStats] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [newProfileName, setNewProfileName] = useState('');
  const [isCreatingProfile, setIsCreatingProfile] = useState(false);
  const [createProfileError, setCreateProfileError] = useState<string | null>(null);
  const [deletingPlayerId, setDeletingPlayerId] = useState<string | null>(null);
  const [renamingPlayerId, setRenamingPlayerId] = useState<string | null>(null);
  const [activeMode, setActiveMode] = useState<ModeKey>('x01');
  const [selectedWindow, setSelectedWindow] = useState<Record<ModeKey, WindowKey>>({
    x01: '10',
    cricket: '10',
    around_the_clock: '10',
  });
  const [atcGameMode, setAtcGameMode] = useState<'all' | 'single' | 'double' | 'triple' | 'full'>('all');
  const [defaultProfileId, setDefaultProfileId] = useState<string | null>(() => {
    try {
      return localStorage.getItem('defaultProfileId');
    } catch {
      return null;
    }
  });

  const loadPlayers = useCallback(async () => {
    setIsLoadingPlayers(true);
    setPlayerError(null);
    try {
      const nextPlayers = await getPlayersCached();
      setPlayers(nextPlayers);
    } catch (err) {
      console.error('Error loading players', err);
      setPlayerError('Unable to load player profiles.');
      setPlayers([]);
    } finally {
      setIsLoadingPlayers(false);
    }
  }, []);

  const handleToggleDefaultProfile = useCallback(
    (id: string) => {
      try {
        if (defaultProfileId === id) {
          localStorage.removeItem('defaultProfileId');
          setDefaultProfileId(null);
        } else {
          localStorage.setItem('defaultProfileId', id);
          setDefaultProfileId(id);
        }
      } catch {
        /* ignore */
      }
    },
    [defaultProfileId]
  );

  const handleCreateProfile = useCallback(async () => {
    const trimmed = newProfileName.trim();
    if (!trimmed) {
      setCreateProfileError('Enter a name to create a profile.');
      return;
    }

    setIsCreatingProfile(true);
    setCreateProfileError(null);
    try {
      const response = await fetch(`${API_URL}/api/players`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: trimmed }),
      });

      if (!response.ok) {
        let message = 'Failed to create profile.';
        try {
          const errorBody = await response.json();
          if (typeof errorBody?.detail === 'string') {
            message = errorBody.detail;
          }
        } catch {
          // ignore parse errors
        }
        throw new Error(message);
      }

      const data = await response.json();
      const createdPlayer: PlayerProfile | undefined = data?.player;
      setNewProfileName('');
      if (createdPlayer?.id) {
        invalidatePlayersCache();
        setSelectedPlayerId(createdPlayer.id);
        setPlayers((prev) => {
          const updated = [...prev, createdPlayer];
          return updated.sort((a, b) => a.name.localeCompare(b.name));
        });
      }
      await loadPlayers();
    } catch (err) {
      console.error('Error creating profile', err);
      setCreateProfileError(err instanceof Error ? err.message : 'Failed to create profile.');
    } finally {
      setIsCreatingProfile(false);
    }
  }, [newProfileName, loadPlayers]);

  const handleDeletePlayer = useCallback(
    async (playerId: string, playerName: string) => {
      if (
        !window.confirm(
          `Delete profile "${playerName}"?\n\nThis removes their tracked accuracy and leg stats.`
        )
      ) {
        return;
      }

      setDeletingPlayerId(playerId);
      try {
        const response = await fetch(`${API_URL}/api/players/${playerId}`, {
          method: 'DELETE',
        });
        if (!response.ok) {
          const errorBody = await response.json().catch(() => ({}));
          throw new Error(errorBody?.detail || 'Failed to delete profile.');
        }

        if (selectedPlayerId === playerId) {
          setSelectedPlayerId(null);
          setPlayerStats(null);
        }
        if (defaultProfileId === playerId) {
          try {
            localStorage.removeItem('defaultProfileId');
          } catch {
            /* ignore */
          }
          setDefaultProfileId(null);
        }

        invalidatePlayersCache();
        await loadPlayers();
      } catch (err: any) {
        const message = err instanceof Error ? err.message : 'Failed to delete profile.';
        window.alert(message);
      } finally {
        setDeletingPlayerId((current) => (current === playerId ? null : current));
      }
    },
    [loadPlayers, selectedPlayerId]
  );

  useEffect(() => {
    loadPlayers();
  }, [loadPlayers]);

  // If all players were removed, clear the selection so the UI doesn't hold a stale id.
  useEffect(() => {
    if (players.length === 0 && selectedPlayerId !== null) {
      setSelectedPlayerId(null);
      setPlayerStats(null);
    }
  }, [players.length, selectedPlayerId]);

  useEffect(() => {
    if (players.length > 0 && !selectedPlayerId) {
      setSelectedPlayerId(players[0].id);
    } else if (players.length === 0) {
      setSelectedPlayerId(null);
      setPlayerStats(null);
    }
  }, [players, selectedPlayerId]);

  // Auto-select stored default profile when available
  useEffect(() => {
    if (!defaultProfileId || selectedPlayerId) {
      return;
    }
    const exists = players.some((p) => p.id === defaultProfileId);
    if (exists) {
      setSelectedPlayerId(defaultProfileId);
    }
  }, [defaultProfileId, players, selectedPlayerId]);

  const fetchPlayerStats = useCallback(async (playerId: string) => {
    setLoadingStats(true);
    setStatsError(null);
    try {
      const response = await fetch(`${API_URL}/api/players/${playerId}/stats`);
      if (!response.ok) {
        throw new Error('Failed to fetch player stats');
      }
      const data: PlayerStatsResponse = await response.json();
      setPlayerStats(data);
    } catch (err) {
      console.error('Error loading player stats', err);
      setStatsError('Unable to load statistics for this player right now.');
      setPlayerStats(null);
    } finally {
      setLoadingStats(false);
    }
  }, []);

  const handleRenamePlayer = useCallback(
    async (player: PlayerProfile) => {
      const nextName = window.prompt('Rename profile', player.name)?.trim();
      if (!nextName || nextName === player.name) {
        return;
      }
      setRenamingPlayerId(player.id);
      try {
        const renamed = await renamePlayerProfile(player.id, nextName);
        setPlayers((prev) =>
          prev
            .map((row) => (row.id === renamed.id ? renamed : row))
            .sort((a, b) => a.name.localeCompare(b.name))
        );
        if (selectedPlayerId === player.id) {
          await fetchPlayerStats(player.id);
        }
      } catch (err) {
        window.alert(err instanceof Error ? err.message : 'Failed to rename profile.');
      } finally {
        setRenamingPlayerId((current) => (current === player.id ? null : current));
      }
    },
    [fetchPlayerStats, selectedPlayerId]
  );

  useEffect(() => {
    if (selectedPlayerId) {
      fetchPlayerStats(selectedPlayerId);
    }
  }, [selectedPlayerId, fetchPlayerStats]);

  const selectedPlayer = useMemo(
    () => players.find((player) => player.id === selectedPlayerId) || null,
    [players, selectedPlayerId]
  );

  const advancedPlayersPayload = useMemo(() => {
    if (!selectedPlayerId || !selectedPlayer) {
      return null;
    }
    return [
      {
        profileId: selectedPlayerId,
        name: selectedPlayer.name,
      },
    ];
  }, [selectedPlayerId, selectedPlayer]);

  const handleAdvancedStats = useCallback(() => {
    if (!advancedPlayersPayload) {
      return;
    }
    navigate('/x01/stats/advanced', {
      state: {
        players: advancedPlayersPayload,
      },
    });
  }, [advancedPlayersPayload, navigate]);

  const x01Summary = playerStats?.modes.x01 ?? null;
  const cricketSummary = playerStats?.modes.cricket ?? null;
  const atcSummary = playerStats?.modes.around_the_clock ?? null;

  const x01WindowKey = selectedWindow.x01;
  const cricketWindowKey = selectedWindow.cricket;
  const atcWindowKey = selectedWindow.around_the_clock;

  const x01WindowStats: X01WindowStats | null =
    x01Summary?.windows?.[x01WindowKey] ?? x01Summary?.overall ?? null;

  const cricketWindowStats: CricketWindowStats | null =
    cricketSummary?.windows?.[cricketWindowKey] ?? cricketSummary?.overall ?? null;

  const atcWindowStats: AroundTheClockWindowStats | null =
    atcGameMode === 'all'
      ? atcSummary?.windows?.[atcWindowKey] ?? atcSummary?.overall ?? null
      : atcSummary?.modes?.[atcGameMode]?.windows?.[atcWindowKey] ?? null;

  const currentWindowKey = activeMode === 'x01' ? x01WindowKey : activeMode === 'cricket' ? cricketWindowKey : atcWindowKey;
  const overallStats =
    activeMode === 'x01' ? x01Summary?.overall ?? null : activeMode === 'cricket' ? cricketSummary?.overall ?? null : atcSummary?.overall ?? null;

  const handleWindowChange = (mode: ModeKey, key: WindowKey) => {
    setSelectedWindow((prev) => ({ ...prev, [mode]: key }));
  };

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden">
      <div
        className="pointer-events-none fixed inset-0 [background:
        radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
        radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.08),transparent_70%),
        radial-gradient(ellipse_at_bottom_left,rgba(255,255,255,0.06),transparent_70%),
        radial-gradient(ellipse_at_bottom_right,rgba(255,255,255,0.1),transparent_65%),
        linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95) 30%,rgba(255,255,255,0.04) 60%,rgba(0,0,0,1) 100%)
      ]"
      />

      <header className="relative z-10 w-full px-6 md:px-10 py-6 flex items-center justify-between">
        <Logo />
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate('/profile/history')}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-800/50 hover:bg-gray-700/50 transition-colors"
          >
            <List size={18} />
            <span>Match History</span>
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
            <BarChart3 className="h-8 w-8 text-blue-400" />
            <h1 className="text-3xl font-bold">Profiles &amp; Stats</h1>
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

              <div className="mb-4 space-y-2">
                <label className="text-[11px] uppercase tracking-[0.3em] text-gray-500">
                  Create Profile
                </label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    value={newProfileName}
                    onChange={(event) => {
                      setNewProfileName(event.target.value);
                      if (createProfileError) {
                        setCreateProfileError(null);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !isCreatingProfile) {
                        event.preventDefault();
                        handleCreateProfile();
                      }
                    }}
                    placeholder="Player name"
                    className="flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none pointer-events-auto"
                  />
                  <button
                    type="button"
                    onClick={handleCreateProfile}
                    disabled={isCreatingProfile}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60"
                  >
                    {isCreatingProfile ? 'Creating...' : 'Create'}
                  </button>
                </div>
                {createProfileError && (
                  <div className="rounded-lg border border-red-500/70 bg-red-600/10 px-3 py-2 text-xs text-red-200">
                    {createProfileError}
                  </div>
                )}
              </div>

              {playerError && (
                <div className="mb-3 rounded-lg border border-red-600 bg-red-900/30 px-3 py-2 text-xs text-red-200">
                  {playerError}
                </div>
              )}

              {isLoadingPlayers && players.length === 0 && (
                <div className="text-sm text-gray-400">Loading profiles...</div>
              )}

              <div className="space-y-2">
                {players.map((player) => {
                  const isActive = player.id === selectedPlayerId;
                  const isDeleting = deletingPlayerId === player.id;
                  const isRenaming = renamingPlayerId === player.id;
                  return (
                    <div
                      key={player.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedPlayerId(player.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedPlayerId(player.id);
                        }
                      }}
                      className={`flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border px-3 py-3 transition ${
                        isActive
                          ? 'border-blue-500/70 bg-blue-500/10 shadow-[0_0_20px_rgba(59,130,246,0.25)]'
                          : 'border-white/10 bg-black/30 hover:border-blue-500/50 hover:bg-black/40'
                      } cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500/50`}
                    >
                      <div className="flex-1 min-w-0 text-left">
                        <div className="text-sm font-semibold text-white">{player.name}</div>
                        <div className="text-xs text-gray-500 mt-1">
                          Joined {formatDate(player.createdAt)}
                        </div>
                      </div>
                      <div
                        className="flex w-full sm:w-auto flex-wrap items-center gap-2 sm:justify-end"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {defaultProfileId === player.id && (
                          <span className="rounded-md border border-green-500/50 bg-green-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-green-200">
                            Default
                          </span>
                        )}
                        <label className="inline-flex items-center gap-2 text-xs font-semibold text-zinc-200">
                          <span>Default</span>
                          <button
                            type="button"
                            onClick={() => handleToggleDefaultProfile(player.id)}
                            className={`relative h-5 w-9 rounded-full border transition ${
                              defaultProfileId === player.id
                                ? 'border-emerald-400/70 bg-emerald-500/70'
                                : 'border-white/20 bg-white/10'
                            }`}
                            aria-pressed={defaultProfileId === player.id}
                          >
                            <span
                              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${
                                defaultProfileId === player.id ? 'left-4' : 'left-0.5'
                              }`}
                            />
                          </button>
                        </label>
                        <button
                          type="button"
                          onClick={() => handleRenamePlayer(player)}
                          disabled={isRenaming}
                          className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-blue-500/50 bg-blue-500/10 px-2 py-1 text-xs font-semibold text-blue-100 transition hover:bg-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Pencil size={14} />
                          {isRenaming ? 'Renaming' : 'Rename'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeletePlayer(player.id, player.name)}
                          disabled={isDeleting}
                          className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-red-500/50 bg-red-500/10 px-2 py-1 text-xs font-semibold text-red-100 transition hover:bg-red-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Trash2 size={14} />
                          {isDeleting ? 'Removing' : 'Remove'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {!isLoadingPlayers && players.length === 0 && (
                <p className="mt-4 text-xs text-gray-400">
                  Create a player from the practice or match setup screens to start tracking stats.
                </p>
              )}
            </aside>

            <section className="rounded-2xl border border-white/10 bg-black/40 p-6 lg:p-8 min-h-[480px]">
              {loadingStats && (
                <div className="text-sm text-gray-400">Loading player statistics...</div>
              )}
              {statsError && (
                <div className="mb-4 rounded-lg border border-red-600 bg-red-900/30 px-4 py-3 text-sm text-red-200">
                  {statsError}
                </div>
              )}
              {!loadingStats && !playerStats && !statsError && (
                <div className="text-sm text-gray-400">
                  Select a player to view performance dashboards.
                </div>
              )}

              {playerStats && selectedPlayer && (
                <>
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
                    <div>
                      <h2 className="text-2xl font-semibold text-white">{selectedPlayer.name}</h2>
                      <p className="text-sm text-gray-500">
                        Active since {formatDate(selectedPlayer.createdAt)}
                      </p>
                    </div>
                    <div className="flex flex-col items-stretch md:items-end gap-3">
                      <div className="inline-flex rounded-full border border-white/10 bg-black/40 p-1 self-start md:self-end">
                        {MODES.map((mode) => {
                          const isActive = activeMode === mode.key;
                          return (
                            <button
                              key={mode.key}
                              type="button"
                              onClick={() => setActiveMode(mode.key)}
                              className={`px-3 py-1.5 text-xs font-semibold rounded-full transition ${
                                isActive
                                  ? 'bg-blue-500 text-white shadow-[0_0_12px_rgba(59,130,246,0.35)]'
                                  : 'text-gray-400 hover:text-white'
                              }`}
                            >
                              {mode.label}
                            </button>
                          );
                        })}
                      </div>
                      <button
                        type="button"
                        onClick={handleAdvancedStats}
                        disabled={!advancedPlayersPayload}
                        className="rounded-xl border border-cyan-400/40 bg-cyan-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-cyan-100 transition hover:bg-cyan-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Advanced X01 Stats
                      </button>
                    </div>
                  </div>

                  {overallStats ? (
                    <>
                      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
                        <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-4">
                          <div className="text-xs uppercase tracking-[0.3em] text-gray-500">
                            Legs Played
                          </div>
                          <div className="mt-2 text-3xl font-semibold text-white">
                            {overallStats.legs}
                          </div>
                        </div>
                        <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-4">
                          <div className="text-xs uppercase tracking-[0.3em] text-gray-500">
                            Legs Won
                          </div>
                          <div className="mt-2 text-3xl font-semibold text-white">
                            {overallStats.legsWon} / {overallStats.legs}
                          </div>
                        </div>
                        <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-4">
                          <div className="text-xs uppercase tracking-[0.3em] text-gray-500">
                            Window
                          </div>
                          <div className="mt-2">
                            <div className="inline-flex rounded-full border border-white/10 bg-black/40 p-1">
                              {WINDOW_ORDER.map((windowKey) => (
                                <button
                                  key={`${activeMode}-${windowKey}`}
                                  type="button"
                                  onClick={() => handleWindowChange(activeMode, windowKey)}
                                  className={`px-3 py-1 text-xs font-semibold rounded-full transition ${
                                    currentWindowKey === windowKey
                                      ? 'bg-blue-500 text-white'
                                      : 'text-gray-400 hover:text-white'
                                  }`}
                                >
                                  {WINDOW_LABELS[windowKey]}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>

                      {activeMode === 'x01' ? (
                        x01WindowStats ? (
                          <X01Summary stats={x01WindowStats} />
                        ) : (
                          <div className="text-sm text-gray-400">
                            No legs recorded for the selected window.
                          </div>
                        )
                      ) : activeMode === 'cricket' ? (
                        cricketWindowStats ? (
                          <CricketSummary stats={cricketWindowStats} />
                        ) : (
                          <div className="text-sm text-gray-400">
                            No legs recorded for the selected window.
                          </div>
                        )
                      ) : atcWindowStats ? (
                        <AroundTheClockSummary
                          stats={atcWindowStats}
                          gameMode={atcGameMode}
                          onGameModeChange={setAtcGameMode}
                        />
                      ) : (
                        <div className="text-sm text-gray-400">
                          No legs recorded for the selected window.
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="text-sm text-gray-400">
                      No statistics recorded yet for this mode.
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
        </div>
      </main>

      <footer className="relative z-10 border-t border-white/10 py-6 text-center text-xs text-gray-500 mt-12">
        {new Date().getFullYear()} Machine Darts - Precision analytics for every leg.
      </footer>
    </div>
  );
}

function MetricRow({
  title,
  metric,
  subtitle,
  formatter = formatNumber,
}: {
  title: string;
  metric: MetricTriple;
  subtitle?: string;
  formatter?: (value: number) => string;
}) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-2 border-t border-white/5 py-3 text-sm text-gray-300">
      <div>
        <div className="text-xs uppercase tracking-[0.3em] text-gray-500">{title}</div>
        {subtitle && <div className="text-[11px] text-gray-500 mt-1">{subtitle}</div>}
      </div>
      <div>
        <div className="text-base font-semibold text-white">{formatter(metric.current)}</div>
        <div className="text-[11px] text-gray-500 mt-1">
          Previous {formatter(metric.previous)}
        </div>
      </div>
      <div className="hidden md:block">
        <div className="text-xs uppercase tracking-[0.3em] text-gray-500">Best</div>
        <div className="text-base font-semibold text-white">{formatter(metric.best)}</div>
      </div>
    </div>
  );
}

function X01Summary({ stats }: { stats: X01WindowStats }) {
  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-white/10 bg-black/30 overflow-hidden">
        <div className="px-5 py-4 border-b border-white/10">
          <h3 className="text-sm font-semibold uppercase tracking-[0.3em] text-gray-400">
            From {stats.legs} Legs
          </h3>
        </div>
        <div className="px-5 py-4">
          <MetricRow title="PPR" metric={stats.averages.ppr} />
          <MetricRow title="PPR Until 170" metric={stats.averages.pprTo170} />
          <MetricRow title="First 9 PPR" metric={stats.averages.firstNine} />
          <MetricRow
            title="Checkout %"
            metric={stats.checkout.percentage}
            formatter={formatPercent}
            subtitle={`${stats.checkout.successes} / ${stats.checkout.attempts} attempts`}
          />
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-black/30">
        <div className="px-5 py-4 border-b border-white/10">
          <h3 className="text-sm font-semibold uppercase tracking-[0.3em] text-gray-400">
            Visit Breakdown
          </h3>
        </div>
        <div className="px-5 py-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-sm text-gray-300">
          {X01_BUCKET_LABELS.map(({ key, label }) => (
            <div
              key={key}
              className="rounded-xl border border-white/10 bg-black/30 px-4 py-3 flex flex-col gap-1"
            >
              <div className="text-[11px] uppercase tracking-[0.3em] text-gray-500">{label}</div>
              <div className="text-lg font-semibold text-white">
                {formatNumber(stats.buckets.total[key] ?? 0, 0)}
              </div>
              <div className="text-[11px] text-gray-500">
                Per leg {formatNumber(stats.buckets.perLeg[key] ?? 0)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CricketSummary({ stats }: { stats: CricketWindowStats }) {
  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-white/10 bg-black/30 overflow-hidden">
        <div className="px-5 py-4 border-b border-white/10">
          <h3 className="text-sm font-semibold uppercase tracking-[0.3em] text-gray-400">
            From {stats.legs} Legs
          </h3>
        </div>
        <div className="px-5 py-4">
          <MetricRow title="MPR" metric={stats.averages.mpr} />
          <MetricRow title="First 9 MPR" metric={stats.averages.firstNineMpr} />
          <MetricRow title="Score" metric={stats.averages.score} />
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-black/30">
        <div className="px-5 py-4 border-b border-white/10">
          <h3 className="text-sm font-semibold uppercase tracking-[0.3em] text-gray-400">
            Marks Distribution
          </h3>
        </div>
        <div className="px-5 py-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 text-sm text-gray-300">
          {CRICKET_MARK_LABELS.map(({ key, label }) => (
            <div
              key={key}
              className="rounded-xl border border-white/10 bg-black/30 px-4 py-3 flex flex-col gap-1"
            >
              <div className="text-[11px] uppercase tracking-[0.3em] text-gray-500">{label}</div>
              <div className="text-lg font-semibold text-white">
                {formatNumber(stats.marks.total[key] ?? 0, 0)}
              </div>
              <div className="text-[11px] text-gray-500">
                Per leg {formatNumber(stats.marks.perLeg[key] ?? 0)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AroundTheClockSummary({
  stats,
  gameMode,
  onGameModeChange
}: {
  stats: AroundTheClockWindowStats;
  gameMode: 'all' | 'single' | 'double' | 'triple' | 'full';
  onGameModeChange: (mode: 'all' | 'single' | 'double' | 'triple' | 'full') => void;
}) {
  const gameModes: Array<{ key: 'all' | 'single' | 'double' | 'triple' | 'full'; label: string; color: string }> = [
    { key: 'all', label: 'All', color: 'text-white' },
    { key: 'single', label: 'Single', color: 'text-blue-400' },
    { key: 'double', label: 'Double', color: 'text-orange-400' },
    { key: 'triple', label: 'Triple', color: 'text-red-400' },
    { key: 'full', label: 'Full', color: 'text-emerald-400' },
  ];

  return (
    <div className="space-y-6">
      {/* Mode Filter */}
      <div className="rounded-2xl border border-white/10 bg-black/30 px-5 py-4">
        <div className="text-xs uppercase tracking-[0.3em] text-gray-500 mb-3">Game Mode</div>
        <div className="flex flex-wrap gap-2">
          {gameModes.map((mode) => (
            <button
              key={mode.key}
              onClick={() => onGameModeChange(mode.key)}
              className={`px-4 py-2 text-sm font-semibold rounded-lg transition ${
                gameMode === mode.key
                  ? 'bg-blue-500 text-white shadow-[0_0_12px_rgba(59,130,246,0.35)]'
                  : 'bg-black/40 border border-white/10 text-gray-400 hover:text-white hover:border-blue-500/50'
              }`}
            >
              <span className={mode.color}>{mode.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-black/30 overflow-hidden">
        <div className="px-5 py-4 border-b border-white/10">
          <h3 className="text-sm font-semibold uppercase tracking-[0.3em] text-gray-400">
            From {stats.legs} Legs
          </h3>
        </div>
        <div className="px-5 py-4">
          <MetricRow title="Accuracy %" metric={stats.averages.accuracy} />
          <MetricRow title="Targets Per Leg" metric={stats.averages.targetsPerLeg} />
          <MetricRow title="Darts Per Target" metric={stats.averages.dartsPerTarget} />
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-black/30">
        <div className="px-5 py-4 border-b border-white/10">
          <h3 className="text-sm font-semibold uppercase tracking-[0.3em] text-gray-400">
            Performance Summary
          </h3>
        </div>
        <div className="px-5 py-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm text-gray-300">
          <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-3 flex flex-col gap-1">
            <div className="text-[11px] uppercase tracking-[0.3em] text-gray-500">Legs Won</div>
            <div className="text-lg font-semibold text-white">{stats.legsWon}</div>
            <div className="text-[11px] text-gray-500">
              {stats.legs > 0 ? `${((stats.legsWon / stats.legs) * 100).toFixed(1)}% win rate` : 'N/A'}
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-3 flex flex-col gap-1">
            <div className="text-[11px] uppercase tracking-[0.3em] text-gray-500">Total Legs</div>
            <div className="text-lg font-semibold text-white">{stats.legs}</div>
            <div className="text-[11px] text-gray-500">
              Played
            </div>
          </div>
        </div>
      </div>

      {/* Number Accuracy Breakdown */}
      {stats.numberAccuracy && Object.keys(stats.numberAccuracy).length > 0 && (
        <div className="rounded-2xl border border-white/10 bg-black/30">
          <div className="px-5 py-4 border-b border-white/10">
            <h3 className="text-sm font-semibold uppercase tracking-[0.3em] text-gray-400">
              Number Accuracy
            </h3>
          </div>
          <div className="px-5 py-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 text-sm text-gray-300">
            {[...Array.from({ length: 20 }, (_, i) => i + 1), 25].map((num) => {
              const accuracy = stats.numberAccuracy?.[String(num)] ?? 0;
              const displayNum = num === 25 ? 'Bull' : String(num);
              return (
                <div
                  key={num}
                  className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 flex flex-col gap-1"
                >
                  <div className="text-[11px] uppercase tracking-[0.3em] text-gray-500">{displayNum}</div>
                  <div className="text-lg font-semibold text-white">
                    {accuracy.toFixed(1)}%
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
