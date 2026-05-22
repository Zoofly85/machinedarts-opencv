import React from "react";
import { useNavigate } from "react-router-dom";
import { Globe, PlusCircle, RefreshCw, Search, Signal, Users } from "lucide-react";

type LobbyItem = {
  code: string;
  host_name: string;
  game: string;
  player_count: number;
  max_players: number;
  region: string;
  pingMs?: number;
};

const API_URL = "http://localhost:8000";
const ONLINE_SESSION_KEY = "md_online_session";

const getOnlinePlayerName = () => {
  const existing = localStorage.getItem("md_online_player_name");
  if (existing && existing.trim()) {
    return existing.trim();
  }
  const generated = `Player-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  localStorage.setItem("md_online_player_name", generated);
  return generated;
};

export default function OnlinePage() {
  const navigate = useNavigate();
  const [roomCode, setRoomCode] = React.useState("");
  const [openLobbies, setOpenLobbies] = React.useState<LobbyItem[]>([]);
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [lastSession, setLastSession] = React.useState<{ room: string; playerId: string; playerName: string } | null>(null);

  const normalizedCode = roomCode.trim().toUpperCase();

  const refreshOpenLobbies = async () => {
    setIsRefreshing(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/api/online/rooms`);
      if (!response.ok) {
        throw new Error("Failed to load lobbies");
      }
      const data = await response.json();
      setOpenLobbies(Array.isArray(data?.rooms) ? data.rooms : []);
    } catch (err) {
      setError("Could not load open lobbies");
      setOpenLobbies([]);
    } finally {
      setIsRefreshing(false);
    }
  };

  React.useEffect(() => {
    refreshOpenLobbies();
    try {
      const raw = localStorage.getItem(ONLINE_SESSION_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.room && parsed?.playerId) {
          setLastSession(parsed);
        }
      }
    } catch {
      setLastSession(null);
    }
  }, []);

  const persistSession = (room: string, playerId: string, playerName: string) => {
    const payload = { room, playerId, playerName };
    localStorage.setItem(ONLINE_SESSION_KEY, JSON.stringify(payload));
    setLastSession(payload);
  };

  const handleCreate = async () => {
    setError(null);
    const playerName = getOnlinePlayerName();
    try {
      const response = await fetch(`${API_URL}/api/online/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host_name: playerName,
          player_name: playerName,
          game: "X01 501",
          region: "Auto",
          max_players: 2,
        }),
      });
      if (!response.ok) {
        throw new Error("Failed to create room");
      }
      const data = await response.json();
      const code = data?.room?.code;
      const playerId = data?.player_id;
      if (!code || !playerId) {
        throw new Error("Invalid room response");
      }
      persistSession(code, playerId, playerName);
      navigate(`/online/lobby?mode=create&room=${code}&playerId=${playerId}&playerName=${encodeURIComponent(playerName)}`);
    } catch (err) {
      setError("Could not create room");
    }
  };

  const handleJoin = async () => {
    if (!normalizedCode) return;
    setError(null);
    const playerName = getOnlinePlayerName();
    try {
      const response = await fetch(`${API_URL}/api/online/rooms/${normalizedCode}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player_name: playerName }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.detail || "Failed to join room");
      }
      const data = await response.json();
      const playerId = data?.player_id;
      if (!playerId) {
        throw new Error("Invalid join response");
      }
      persistSession(normalizedCode, playerId, playerName);
      navigate(`/online/lobby?mode=join&room=${normalizedCode}&playerId=${playerId}&playerName=${encodeURIComponent(playerName)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join room");
    }
  };

  const handleJoinOpenLobby = async (lobby: LobbyItem) => {
    setRoomCode(lobby.code);
    const playerName = getOnlinePlayerName();
    setError(null);
    try {
      const response = await fetch(`${API_URL}/api/online/rooms/${lobby.code}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player_name: playerName }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.detail || "Failed to join room");
      }
      const data = await response.json();
      const playerId = data?.player_id;
      if (!playerId) {
        throw new Error("Invalid join response");
      }
      persistSession(lobby.code, playerId, playerName);
      navigate(`/online/lobby?mode=join&room=${lobby.code}&playerId=${playerId}&playerName=${encodeURIComponent(playerName)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join room");
    }
  };

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
          onClick={() => navigate("/")}
          className="px-4 py-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 transition-colors"
        >
          Back
        </button>
        <div className="flex-1 text-center md:text-left">
          <h1 className="text-2xl font-extrabold tracking-wide">
            Online <span className="text-red-500">Play</span>
          </h1>
          <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Create · Join · Compete</p>
        </div>
      </header>

      <main className="relative z-10 flex-1 px-6 md:px-10 pb-8">
        <div className="h-full w-full max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-[1.2fr_0.8fr] gap-6">
          <section className="rounded-2xl border border-white/10 bg-zinc-900/55 p-6 backdrop-blur">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-3">
                <Globe className="h-6 w-6 text-red-400" />
                <h2 className="text-xl font-bold">Open Lobbies</h2>
              </div>
              <button
                type="button"
                onClick={refreshOpenLobbies}
                className="inline-flex items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm hover:bg-white/20 transition-colors"
              >
                <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>
            <p className="text-zinc-300 text-sm mb-4">
              Join players who are already waiting for an opponent.
            </p>
            {error && (
              <div className="mb-4 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {error}
              </div>
            )}
            <div className="space-y-3 max-h-[420px] overflow-auto pr-1">
              {openLobbies.length === 0 && (
                <div className="rounded-xl border border-white/10 bg-black/25 px-4 py-4 text-sm text-zinc-400">
                  No open lobbies right now. Create one to start.
                </div>
              )}
              {openLobbies.map((lobby) => (
                <div key={lobby.code} className="rounded-xl border border-white/10 bg-black/25 px-4 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm text-zinc-300">
                        Host: <span className="font-semibold text-white">{lobby.host_name}</span>
                      </p>
                      <p className="text-xs text-zinc-500 mt-1">
                        {lobby.game} · {lobby.player_count}/{lobby.max_players} · {lobby.region}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-green-400">
                      <Signal className="h-4 w-4" />
                      {lobby.pingMs ?? 0}ms
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Room {lobby.code}</p>
                    <button
                      type="button"
                      onClick={() => handleJoinOpenLobby(lobby)}
                      className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold hover:bg-red-500 transition-colors"
                    >
                      Join
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <div className="space-y-6">
            {lastSession && (
              <section className="rounded-2xl border border-white/10 bg-zinc-900/55 p-6 backdrop-blur">
                <div className="flex items-center gap-3 mb-4">
                  <Globe className="h-6 w-6 text-red-400" />
                  <h2 className="text-xl font-bold">Resume Lobby</h2>
                </div>
                <p className="text-zinc-300 text-sm mb-4">
                  Reconnect to your last online room: <span className="font-semibold text-white">{lastSession.room}</span>
                </p>
                <button
                  type="button"
                  onClick={() =>
                    navigate(
                      `/online/lobby?mode=join&room=${lastSession.room}&playerId=${lastSession.playerId}&playerName=${encodeURIComponent(lastSession.playerName)}`
                    )
                  }
                  className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-zinc-700 px-4 py-3 font-semibold hover:bg-zinc-600 transition-colors"
                >
                  Reconnect
                </button>
              </section>
            )}
            <section className="rounded-2xl border border-white/10 bg-zinc-900/55 p-6 backdrop-blur">
              <div className="flex items-center gap-3 mb-4">
                <PlusCircle className="h-6 w-6 text-red-400" />
                <h2 className="text-xl font-bold">Create Lobby</h2>
              </div>
              <p className="text-zinc-300 text-sm mb-6">
                Create a room and wait in the open lobby list for an opponent.
              </p>
              <button
                type="button"
                onClick={handleCreate}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-3 font-semibold hover:bg-red-500 transition-colors"
              >
                <Users className="h-5 w-5" />
                Create Room
              </button>
            </section>

            <section className="rounded-2xl border border-white/10 bg-zinc-900/55 p-6 backdrop-blur">
              <div className="flex items-center gap-3 mb-4">
                <Search className="h-6 w-6 text-red-400" />
                <h2 className="text-xl font-bold">Join by Code</h2>
              </div>
              <p className="text-zinc-300 text-sm mb-4">
                Private room fallback if you share direct codes.
              </p>
              <input
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value)}
                maxLength={10}
                placeholder="ROOM CODE"
                className="w-full rounded-xl bg-black/45 border border-white/15 px-4 py-3 text-white placeholder:text-zinc-500 uppercase tracking-[0.2em] text-sm mb-4"
              />
              <button
                type="button"
                onClick={handleJoin}
                disabled={!normalizedCode}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-3 font-semibold hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Globe className="h-5 w-5" />
                Join Room
              </button>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
