import React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Copy, Signal, UserRound, Wifi, WifiOff } from "lucide-react";

const API_URL = "http://localhost:8000";
const ONLINE_SESSION_KEY = "md_online_session";

type RoomPlayer = {
  id: string;
  name: string;
  ready: boolean;
  is_host: boolean;
};

type RoomState = {
  code: string;
  host_name: string;
  game: string;
  region: string;
  max_players: number;
  status: string;
  players: RoomPlayer[];
  player_count: number;
};

function maskName(name: string) {
  if (name.length <= 2) return name;
  return `${name.slice(0, 1)}***${name.slice(-1)}`;
}

export default function OnlineLobbyPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const mode = searchParams.get("mode") || "create";
  const room = (searchParams.get("room") || "------").toUpperCase();
  const playerId = searchParams.get("playerId") || "";
  const playerName = searchParams.get("playerName") || "Player";
  const [ready, setReady] = React.useState(false);
  const [opponentJoined, setOpponentJoined] = React.useState(mode === "join");
  const [copied, setCopied] = React.useState(false);
  const [roomState, setRoomState] = React.useState<RoomState | null>(null);
  const [connectionState, setConnectionState] = React.useState<"connecting" | "connected" | "disconnected">("connecting");
  const [error, setError] = React.useState<string | null>(null);

  const canStart = ready && opponentJoined;

  const refreshRoom = React.useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/api/online/rooms/${room}`);
      if (!response.ok) {
        throw new Error("Room not found");
      }
      const data = await response.json();
      const state = data?.room as RoomState;
      setRoomState(state);
      const me = state?.players?.find((p) => p.id === playerId);
      setReady(Boolean(me?.ready));
      setOpponentJoined((state?.player_count ?? 0) >= 2);
      setError(null);
    } catch (err) {
      // Try explicit reconnect before giving up.
      if (playerId) {
        try {
          const reconnectResp = await fetch(`${API_URL}/api/online/rooms/${room}/reconnect`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ player_name: playerName, player_id: playerId }),
          });
          if (reconnectResp.ok) {
            const data = await reconnectResp.json();
            const state = data?.room as RoomState;
            setRoomState(state);
            const me = state?.players?.find((p) => p.id === playerId);
            setReady(Boolean(me?.ready));
            setOpponentJoined((state?.player_count ?? 0) >= 2);
            setError(null);
            return;
          }
        } catch {
          // fall through to error
        }
      }
      setError("Unable to load room");
    }
  }, [room, playerId, playerName]);

  React.useEffect(() => {
    refreshRoom();
  }, [refreshRoom]);

  React.useEffect(() => {
    if (!room || !playerId) {
      return;
    }
    localStorage.setItem(
      ONLINE_SESSION_KEY,
      JSON.stringify({
        room,
        playerId,
        playerName,
      })
    );
  }, [room, playerId, playerName]);

  React.useEffect(() => {
    if (!room || room === "------") return;
    let ws: WebSocket | null = null;
    try {
      const url = `ws://localhost:8000/ws/online/${room}`;
      ws = new WebSocket(url);
      ws.onopen = () => setConnectionState("connected");
      ws.onclose = () => setConnectionState("disconnected");
      ws.onerror = () => setConnectionState("disconnected");
      ws.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data);
          if (data?.room) {
            const state = data.room as RoomState;
            setRoomState(state);
            const me = state.players?.find((p) => p.id === playerId);
            setReady(Boolean(me?.ready));
            setOpponentJoined((state.player_count ?? 0) >= 2);
          }
        } catch {
          // ignore malformed messages
        }
      };
    } catch {
      setConnectionState("disconnected");
    }

    return () => {
      if (ws) {
        ws.close();
      }
    };
  }, [room, playerId]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(room);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const toggleReady = async () => {
    if (!playerId) return;
    try {
      const desired = !ready;
      const response = await fetch(`${API_URL}/api/online/rooms/${room}/ready`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player_id: playerId, ready: desired }),
      });
      if (!response.ok) {
        throw new Error("Failed to update ready state");
      }
      setReady(desired);
      setError(null);
    } catch (err) {
      setError("Could not update ready state");
    }
  };

  const startMatch = async () => {
    if (!playerId) return;
    try {
      const response = await fetch(`${API_URL}/api/online/rooms/${room}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player_id: playerId }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.detail || "Failed to start match");
      }
      const data = await response.json();
      if (data?.room?.status === "in_match") {
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start match");
    }
  };

  const myPlayer = roomState?.players?.find((p) => p.id === playerId);
  const isHost = Boolean(myPlayer?.is_host);
  const showStart = isHost;
  const canStartHost = showStart && canStart && (roomState?.player_count ?? 0) >= 2;

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
                await fetch(`${API_URL}/api/online/rooms/${room}/leave`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ player_id: playerId }),
                });
              } catch {
                // Best effort leave.
              }
            }
            localStorage.removeItem(ONLINE_SESSION_KEY);
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
                onClick={handleCopy}
                className="inline-flex items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm hover:bg-white/20 transition-colors"
              >
                <Copy className="h-4 w-4" />
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            {error && (
              <div className="mt-3 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {error}
              </div>
            )}
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
                  <span>
                    {opponentJoined
                      ? maskName(String(roomState?.players?.find((p) => p.id !== playerId)?.name || "Opponent"))
                      : "Waiting for opponent..."}
                  </span>
                </div>
                <span className={`text-sm ${opponentJoined ? "text-amber-400" : "text-zinc-400"}`}>
                  {opponentJoined ? "Connected" : "Offline"}
                </span>
              </div>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={toggleReady}
                className={`rounded-xl px-4 py-2 font-semibold transition-colors ${
                  ready ? "bg-zinc-700 hover:bg-zinc-600" : "bg-red-600 hover:bg-red-500"
                }`}
              >
                {ready ? "Unready" : "Ready Up"}
              </button>
              {showStart && (
                <button
                  type="button"
                  onClick={startMatch}
                  disabled={!canStartHost}
                  className="rounded-xl px-4 py-2 font-semibold bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  Start Match
                </button>
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-white/10 bg-zinc-900/55 p-6 backdrop-blur">
            <h3 className="text-sm uppercase tracking-[0.2em] text-zinc-500 mb-3">Connection</h3>
            <div className="flex items-center gap-4 text-sm">
              <span className={`inline-flex items-center gap-2 ${connectionState === "connected" ? "text-green-400" : "text-zinc-400"}`}>
                <Wifi className="h-4 w-4" />
                {connectionState === "connected" ? "Server Connected" : "Server Disconnected"}
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
