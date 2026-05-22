import React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Copy, Signal, UserRound, Wifi, WifiOff } from "lucide-react";
import {
  clearStoredSession,
  closeLobby,
  getActiveMatchByLobbyId,
  getRoomByCode,
  joinLobbyByCode,
  leaveRoom,
  OPEN_LOBBY_TIMEOUT_MS,
  setReady,
  startMatch,
  subscribeToLobby,
  type OnlineRoomState,
} from "../online/supabaseOnline";

function maskName(name: string) {
  if (name.length <= 2) return name;
  return `${name.slice(0, 1)}***${name.slice(-1)}`;
}

function buildConnectUrl(params: {
  room: string;
  matchId: string;
  playerId: string;
  playerName: string;
  profileId?: string;
}) {
  const next = new URLSearchParams({
    room: params.room,
    matchId: params.matchId,
    playerId: params.playerId,
    playerName: params.playerName,
  });
  if (params.profileId) {
    next.set("profileId", params.profileId);
  }
  return `/online/connect?${next.toString()}`;
}

export default function OnlineLobbyPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const mode = searchParams.get("mode") || "create";
  const room = (searchParams.get("room") || "------").toUpperCase();
  const playerId = searchParams.get("playerId") || "";
  const playerName = searchParams.get("playerName") || "Player";
  const profileId = searchParams.get("profileId") || "";
  const [ready, setReadyState] = React.useState(false);
  const [opponentJoined, setOpponentJoined] = React.useState(mode === "join");
  const [copied, setCopied] = React.useState(false);
  const [roomState, setRoomState] = React.useState<OnlineRoomState | null>(null);
  const [connectionState, setConnectionState] =
    React.useState<"connecting" | "connected" | "disconnected">("connecting");
  const [error, setError] = React.useState<string | null>(null);
  const [autoCloseTriggered, setAutoCloseTriggered] = React.useState(false);

  const canStart = ready && opponentJoined;

  const refreshRoom = React.useCallback(async () => {
    try {
      const state = await getRoomByCode(room);
      setRoomState(state);
      const me = state.players?.find((player) => player.id === playerId);
      setReadyState(Boolean(me?.ready));
      setOpponentJoined((state.player_count ?? 0) >= 2);
      setError(null);
    } catch (err) {
      if (playerId && room && room !== "------") {
        try {
          const state = await joinLobbyByCode(room, playerId);
          setRoomState(state);
          const me = state.players?.find((player) => player.id === playerId);
          setReadyState(Boolean(me?.ready));
          setOpponentJoined((state.player_count ?? 0) >= 2);
          setError(null);
          return;
        } catch {
          // fall through to show error
        }
      }
      setError(err instanceof Error ? err.message : "Unable to load room");
    }
  }, [room, playerId]);

  React.useEffect(() => {
    void refreshRoom();
  }, [refreshRoom]);

  React.useEffect(() => {
    if (!roomState?.id) {
      setConnectionState("disconnected");
      return;
    }
    setConnectionState("connecting");
    const unsubscribe = subscribeToLobby(roomState.id, async () => {
      try {
        const state = await getRoomByCode(room);
        setRoomState(state);
        const me = state.players?.find((player) => player.id === playerId);
        setReadyState(Boolean(me?.ready));
        setOpponentJoined((state.player_count ?? 0) >= 2);
        setConnectionState("connected");
      } catch {
        setConnectionState("disconnected");
      }
    });

    setConnectionState("connected");
    return () => {
      unsubscribe();
    };
  }, [roomState?.id, room, playerId]);

  React.useEffect(() => {
    if (!room || room === "------") return;
    const timer = window.setInterval(() => {
      void refreshRoom();
    }, 2000);
    return () => {
      window.clearInterval(timer);
    };
  }, [room, refreshRoom]);

  React.useEffect(() => {
    if (!roomState?.id) return;
    let cancelled = false;

    const checkMatch = async () => {
      try {
        const match = await getActiveMatchByLobbyId(roomState.id);
        if (cancelled || !match) return;
        navigate(buildConnectUrl({ room, matchId: match.id, playerId, playerName, profileId }));
      } catch {
        // ignore polling errors
      }
    };

    void checkMatch();
    const timer = window.setInterval(() => {
      void checkMatch();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [roomState?.id, room, navigate, playerId, playerName, profileId]);

  React.useEffect(() => {
    if (!roomState || !roomState.id || !roomState.created_at || !playerId) return;
    const myPlayer = roomState.players.find((player) => player.id === playerId);
    if (!myPlayer?.is_host || autoCloseTriggered || !["waiting", "ready"].includes(roomState.status)) {
      return;
    }
    if ((roomState.player_count ?? 0) >= (roomState.max_players ?? 2)) {
      return;
    }

    const createdAtMs = Number(new Date(roomState.created_at));
    if (!createdAtMs || Number.isNaN(createdAtMs)) {
      return;
    }

    const remainingMs = Math.max(0, OPEN_LOBBY_TIMEOUT_MS - (Date.now() - createdAtMs));
    const closeRoom = async () => {
      try {
        await closeLobby(room, playerId);
        setAutoCloseTriggered(true);
        clearStoredSession();
        navigate("/online");
      } catch {
        setError("Failed to auto-close lobby");
      }
    };

    if (remainingMs === 0) {
      void closeRoom();
      return;
    }

    const timeout = window.setTimeout(() => {
      void closeRoom();
    }, remainingMs);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [roomState, room, playerId, navigate, autoCloseTriggered]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(room);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const toggleReady = async () => {
    if (!playerId) return;
    try {
      const desired = !ready;
      const state = await setReady(room, playerId, desired);
      setRoomState(state);
      setReadyState(desired);
      setOpponentJoined((state.player_count ?? 0) >= 2);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update ready state");
    }
  };

  const onStartMatch = async () => {
    if (!playerId) return;
    try {
      const state = await startMatch(room, playerId);
      setRoomState(state);
      setError(null);
      const match = await getActiveMatchByLobbyId(state.id);
      if (match) {
        navigate(buildConnectUrl({ room, matchId: match.id, playerId, playerName, profileId }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start match");
    }
  };

  const myPlayer = roomState?.players?.find((player) => player.id === playerId);
  const isHost = Boolean(myPlayer?.is_host);
  const showStart = isHost;
  const canStartHost = showStart && canStart && (roomState?.player_count ?? 0) >= 2;
  const canClose = isHost && !autoCloseTriggered;
  const opponent = roomState?.players?.find((player) => player.id !== playerId) || null;

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
          onClick={async () => {
            if (playerId && room && room !== "------") {
              try {
                await leaveRoom(room, playerId);
              } catch {
                // best effort leave
              }
            }
            clearStoredSession();
            navigate("/online");
          }}
          className="px-4 py-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 transition-colors"
        >
          Back
        </button>
        <div className="flex-1 text-center md:text-left">
          <h1 className="text-2xl font-extrabold tracking-wide">
            Online <span className="text-red-500">Lobby</span>
          </h1>
          <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Waiting Room</p>
        </div>
      </header>

      <main className="relative z-10 flex-1 px-6 md:px-10 pb-8">
        <div className="h-full w-full max-w-4xl mx-auto grid grid-cols-1 gap-6">
          <section className="rounded-2xl border border-white/10 bg-zinc-900/55 p-6 backdrop-blur">
            <p className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-2">Room Code</p>
            <div className="flex items-center gap-3">
              <p className="text-3xl font-bold tracking-[0.3em] text-red-400">{room}</p>
              <button
                type="button"
                onClick={() => void handleCopy()}
                className="inline-flex items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm hover:bg-white/20 transition-colors"
              >
                <Copy className="h-4 w-4" />
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            {error ? (
              <div className="mt-3 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {error}
              </div>
            ) : null}
          </section>

          <section className="rounded-2xl border border-white/10 bg-zinc-900/55 p-6 backdrop-blur">
            <h2 className="text-lg font-semibold mb-4">Players</h2>
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-xl border border-white/10 bg-black/25 px-4 py-3">
                <div className="flex items-center gap-3">
                  <UserRound className="h-5 w-5 text-red-400" />
                  <span>You ({maskName(String(playerName))})</span>
                </div>
                <span className={`text-sm ${ready ? "text-green-400" : "text-zinc-400"}`}>{ready ? "Ready" : "Not Ready"}</span>
              </div>
              <div className="flex items-center justify-between rounded-xl border border-white/10 bg-black/25 px-4 py-3">
                <div className="flex items-center gap-3">
                  <UserRound className="h-5 w-5 text-red-400" />
                  <span>{opponent ? maskName(String(opponent.name || "Opponent")) : "Waiting for opponent..."}</span>
                </div>
                <span className={`text-sm ${opponentJoined ? "text-amber-400" : "text-zinc-400"}`}>
                  {opponentJoined ? (opponent?.ready ? "Ready" : "Connected") : "Offline"}
                </span>
              </div>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void toggleReady()}
                className={`rounded-xl px-4 py-2 font-semibold transition-colors ${
                  ready ? "bg-zinc-700 hover:bg-zinc-600" : "bg-red-600 hover:bg-red-500"
                }`}
              >
                {ready ? "Unready" : "Ready Up"}
              </button>
              {showStart ? (
                <button
                  type="button"
                  onClick={() => void onStartMatch()}
                  disabled={!canStartHost}
                  className="rounded-xl px-4 py-2 font-semibold bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  Start Connection
                </button>
              ) : null}
              <button
                type="button"
                  onClick={() =>
                    navigate(
                      `/online/test?room=${room}&playerId=${playerId}&playerName=${encodeURIComponent(playerName)}${
                        profileId ? `&profileId=${encodeURIComponent(profileId)}` : ""
                      }`,
                    )
                  }
                className="rounded-xl px-4 py-2 font-semibold bg-blue-600 hover:bg-blue-500 transition-colors"
              >
                Flow Test
              </button>
              {canClose ? (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await closeLobby(room, playerId);
                      clearStoredSession();
                      navigate("/online");
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "Could not close lobby");
                    }
                  }}
                  className="rounded-xl px-4 py-2 font-semibold bg-zinc-800 hover:bg-zinc-700 transition-colors"
                >
                  Close Lobby
                </button>
              ) : null}
            </div>
          </section>

          <section className="rounded-2xl border border-white/10 bg-zinc-900/55 p-6 backdrop-blur">
            <h3 className="text-sm uppercase tracking-[0.2em] text-zinc-500 mb-3">Connection</h3>
            <div className="flex items-center gap-4 text-sm flex-wrap">
              <span className={`inline-flex items-center gap-2 ${connectionState === "connected" ? "text-green-400" : "text-zinc-400"}`}>
                <Wifi className="h-4 w-4" />
                {connectionState === "connected" ? "Lobby Synced" : "Sync Disconnected"}
              </span>
              <span className={`inline-flex items-center gap-2 ${opponentJoined ? "text-green-400" : "text-zinc-400"}`}>
                {opponentJoined ? <Signal className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />}
                {opponentJoined ? "Opponent Linked" : "Waiting for Opponent"}
              </span>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
