import React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, CheckCircle2, Loader2, Radio, RefreshCw, ShieldAlert, WifiOff } from "lucide-react";
import { getRoomByCode, getStoredSession, type OnlineRoomState } from "../online/supabaseOnline";
import {
  createOnlineRtcConnection,
  type OnlineRtcConnection,
  type OnlineRtcLiveMessage,
  type OnlineRtcState,
} from "../online/onlineRtc";

type DiagnosticItem = {
  label: string;
  status: "waiting" | "active" | "done" | "failed";
  detail: string;
};

type DiagnosticFlags = {
  signalingReady: boolean;
  offerSeen: boolean;
  answerSeen: boolean;
  iceSeen: boolean;
  connected: boolean;
  dataOpen: boolean;
  failed: boolean;
};

function buildGameUrl(params: {
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
    p2pReady: "1",
  });
  if (params.profileId) {
    next.set("profileId", params.profileId);
  }
  return `/online/x01?${next.toString()}`;
}

function formatState(state: OnlineRtcState) {
  if (state === "connected") return "Direct peer link connected";
  if (state === "connecting") return "Establishing direct peer link";
  if (state === "failed") return "Direct peer link failed";
  return "Peer link disconnected";
}

function createEmptyDiagnosticFlags(): DiagnosticFlags {
  return {
    signalingReady: false,
    offerSeen: false,
    answerSeen: false,
    iceSeen: false,
    connected: false,
    dataOpen: false,
    failed: false,
  };
}

function updateDiagnosticFlags(flags: DiagnosticFlags, event: string): DiagnosticFlags {
  return {
    signalingReady: flags.signalingReady || event === "signaling-channel:SUBSCRIBED",
    offerSeen:
      flags.offerSeen ||
      event.startsWith("offer:") ||
      event === "signal:offer:receive" ||
      event === "signal:offer:send" ||
      event === "signal:offer:ok",
    answerSeen:
      flags.answerSeen ||
      event.startsWith("answer:") ||
      event === "signal:answer:receive" ||
      event === "signal:answer:send" ||
      event === "signal:answer:ok",
    iceSeen: flags.iceSeen || event.startsWith("ice:") || event.startsWith("ice-gathering:"),
    connected: flags.connected || event === "state:connected" || event === "peer:connected" || event === "ice:connected",
    dataOpen: flags.dataOpen || event === "datachannel:open",
    failed:
      flags.failed ||
      event === "state:failed" ||
      event === "peer:failed" ||
      event === "ice:failed" ||
      event.startsWith("error:"),
  };
}

function summarizeDiagnostics(flags: DiagnosticFlags, lastPongMs: number | null): DiagnosticItem[] {
  return [
    {
      label: "Signalling channel",
      status: flags.signalingReady ? "done" : flags.failed ? "failed" : "active",
      detail: flags.signalingReady ? "Connected to the room signal channel." : "Waiting for Supabase signalling.",
    },
    {
      label: "Offer / answer",
      status: flags.answerSeen ? "done" : flags.offerSeen ? "active" : flags.failed ? "failed" : "waiting",
      detail: flags.answerSeen
        ? "Both PCs exchanged the WebRTC setup messages."
        : flags.offerSeen
          ? "Offer sent or received, waiting for the answer."
          : "Waiting for the first peer setup message.",
    },
    {
      label: "Direct route check",
      status: flags.connected ? "done" : flags.failed && flags.iceSeen ? "failed" : flags.iceSeen ? "active" : "waiting",
      detail: flags.connected
        ? "A direct route between the two PCs was found."
        : flags.failed && flags.iceSeen
          ? "Signalling worked, but the direct route could not be made."
          : flags.iceSeen
            ? "Checking firewall/router/NAT routes."
            : "Waiting for ICE candidates.",
    },
    {
      label: "Data channel",
      status: flags.dataOpen ? "done" : flags.failed ? "failed" : flags.connected ? "active" : "waiting",
      detail: flags.dataOpen ? "The game data channel is open." : "Waiting for the peer data channel.",
    },
    {
      label: "Heartbeat",
      status: lastPongMs !== null ? "done" : flags.failed ? "failed" : flags.dataOpen ? "active" : "waiting",
      detail: lastPongMs !== null ? `Peer replied in ${lastPongMs}ms.` : "Waiting for a ping/pong reply.",
    },
  ];
}

function prettyDiagnostic(event: string) {
  const labels: Record<string, string> = {
    "signaling-channel:SUBSCRIBED": "Signalling channel ready",
    "signal:offer:send": "Sending offer",
    "signal:offer:receive": "Offer received",
    "offer:create": "Offer created",
    "offer:retry": "Retrying offer",
    "answer:create": "Answer created",
    "answer:applied": "Answer applied",
    "signal:answer:receive": "Answer received",
    "ice:checking": "Checking direct route",
    "ice:connected": "Direct route connected",
    "peer:connected": "Peer connected",
    "datachannel:open": "Data channel open",
    "heartbeat:pong": "Heartbeat reply received",
    "state:connected": "Connection verified",
    "state:failed": "Connection failed",
    "ice:failed": "Direct route failed",
    "peer:failed": "Peer connection failed",
  };
  return labels[event] || event.replace(/:/g, " ");
}

export default function OnlineConnectPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const storedSession = React.useMemo(() => getStoredSession(), []);
  const room = (searchParams.get("room") || storedSession?.room || "").toUpperCase();
  const matchId = searchParams.get("matchId") || "";
  const playerId = searchParams.get("playerId") || storedSession?.playerId || "";
  const playerName = searchParams.get("playerName") || storedSession?.playerName || "Player";
  const profileId = searchParams.get("profileId") || storedSession?.profileId || "";
  const [roomState, setRoomState] = React.useState<OnlineRoomState | null>(null);
  const [rtcState, setRtcState] = React.useState<OnlineRtcState>("connecting");
  const [error, setError] = React.useState<string | null>(null);
  const [lastPongMs, setLastPongMs] = React.useState<number | null>(null);
  const [diagnostics, setDiagnostics] = React.useState<string[]>([]);
  const [diagnosticFlags, setDiagnosticFlags] = React.useState<DiagnosticFlags>(() => createEmptyDiagnosticFlags());
  const [retryKey, setRetryKey] = React.useState(0);
  const [joinCountdown, setJoinCountdown] = React.useState<number | null>(null);
  const rtcRef = React.useRef<OnlineRtcConnection | null>(null);

  const orderedPlayers = React.useMemo(
    () => [...(roomState?.players ?? [])].sort((a, b) => a.seat - b.seat),
    [roomState?.players],
  );
  const localIndex = orderedPlayers.findIndex((player) => player.id === playerId);
  const remotePlayer = orderedPlayers.find((player) => player.id !== playerId) ?? null;
  const remotePlayerId = remotePlayer?.id ?? "";
  const canConnect = Boolean(room && matchId && playerId && remotePlayerId && localIndex >= 0);
  const readyForGame = rtcState === "connected" && lastPongMs !== null;
  const diagnosticItems = React.useMemo(
    () => summarizeDiagnostics(diagnosticFlags, lastPongMs),
    [diagnosticFlags, lastPongMs],
  );
  const lastDiagnostic = diagnostics.length > 0 ? diagnostics[diagnostics.length - 1] : "";

  const goToGame = React.useCallback(() => {
    if (!room || !matchId || !playerId) return;
    rtcRef.current?.close();
    rtcRef.current = null;
    navigate(buildGameUrl({ room, matchId, playerId, playerName, profileId }), { replace: true });
  }, [matchId, navigate, playerId, playerName, profileId, room]);

  React.useEffect(() => {
    if (!room) {
      setError("Missing room code.");
      return;
    }
    let cancelled = false;
    const loadRoom = async () => {
      try {
        const state = await getRoomByCode(room);
        if (!cancelled) {
          setRoomState(state);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unable to load room.");
        }
      }
    };
    void loadRoom();
    const timer = window.setInterval(() => {
      void loadRoom();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [room]);

  React.useEffect(() => {
    setLastPongMs(null);
    setDiagnostics([]);
    setDiagnosticFlags(createEmptyDiagnosticFlags());
    setJoinCountdown(null);
  }, [retryKey, matchId, playerId, remotePlayerId]);

  React.useEffect(() => {
    if (!canConnect) {
      rtcRef.current?.close();
      rtcRef.current = null;
      setRtcState("disconnected");
      return;
    }

    const handleMessage = (message: OnlineRtcLiveMessage) => {
      if (message.playerId === playerId) {
        return;
      }
      if (message.type === "peer_ping") {
        rtcRef.current?.send({
          type: "peer_pong",
          playerId,
          sentAt: message.sentAt,
          receivedAt: Date.now(),
        });
        return;
      }
      if (message.type === "peer_pong") {
        setLastPongMs(Math.max(1, Date.now() - message.sentAt));
        setDiagnostics((previous) => [...previous, "heartbeat:pong"].slice(-24));
        setDiagnosticFlags((previous) => updateDiagnosticFlags(previous, "heartbeat:pong"));
      }
    };

    const rtc = createOnlineRtcConnection({
      matchId,
      localPlayerId: playerId,
      remotePlayerId,
      initiator: localIndex === 0,
      onMessage: handleMessage,
      onStateChange: setRtcState,
      onDiagnostic: (message) => {
        setDiagnostics((previous) => [...previous, message].slice(-24));
        setDiagnosticFlags((previous) => updateDiagnosticFlags(previous, message));
      },
      onError: (err) => setError(err.message),
    });

    rtcRef.current = rtc;
    setRtcState("connecting");
    setError(null);

    return () => {
      rtc.close();
      if (rtcRef.current === rtc) {
        rtcRef.current = null;
      }
      setRtcState("disconnected");
    };
  }, [canConnect, localIndex, matchId, playerId, remotePlayerId, retryKey]);

  React.useEffect(() => {
    if (rtcState !== "connected") {
      return;
    }
    const sendPing = () => {
      rtcRef.current?.send({
        type: "peer_ping",
        playerId,
        sentAt: Date.now(),
      });
    };
    sendPing();
    const timer = window.setInterval(sendPing, 800);
    return () => {
      window.clearInterval(timer);
    };
  }, [playerId, rtcState]);

  React.useEffect(() => {
    if (!readyForGame) {
      setJoinCountdown(null);
      return;
    }
    setJoinCountdown((previous) => previous ?? 3);
  }, [readyForGame]);

  React.useEffect(() => {
    if (joinCountdown === null) {
      return;
    }
    if (joinCountdown <= 0) {
      goToGame();
      return;
    }
    const timer = window.setTimeout(() => {
      setJoinCountdown((previous) => (previous === null ? null : previous - 1));
    }, 1000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [goToGame, joinCountdown]);

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden flex flex-col">
      <div
        className="pointer-events-none fixed inset-0 [background:
          radial-gradient(circle_at_20%_10%,rgba(34,197,94,0.18),transparent_34%),
          radial-gradient(circle_at_80%_20%,rgba(239,68,68,0.16),transparent_32%),
          linear-gradient(135deg,rgba(0,0,0,1),rgba(24,24,27,0.96)_48%,rgba(12,6,6,1))
        ]"
      />

      <header className="relative z-10 w-full px-6 md:px-10 py-6 flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={() => navigate(`/online/lobby?room=${room}&playerId=${playerId}&playerName=${encodeURIComponent(playerName)}`)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Lobby
        </button>
        <div className="flex-1 text-center md:text-left">
          <h1 className="text-2xl font-extrabold tracking-wide">
            Peer <span className="text-red-500">Connection</span>
          </h1>
          <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Direct PC to PC check</p>
        </div>
      </header>

      <main className="relative z-10 flex-1 px-6 md:px-10 pb-10 flex items-center justify-center">
        <section className="w-full max-w-3xl rounded-3xl border border-white/10 bg-zinc-950/75 p-6 md:p-8 shadow-2xl backdrop-blur">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-5">
            <div>
              <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Room {room || "------"}</p>
              <h2 className="mt-2 text-3xl font-black">Connecting before the match</h2>
              <p className="mt-2 text-sm text-zinc-400">
                {playerName} vs {remotePlayer?.name || "opponent"}
              </p>
            </div>
            <div
              className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold ${
                readyForGame
                  ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-300"
                  : rtcState === "failed"
                    ? "border-red-400/40 bg-red-500/15 text-red-300"
                    : "border-white/15 bg-white/10 text-zinc-200"
              }`}
            >
              {readyForGame ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : rtcState === "failed" || rtcState === "disconnected" ? (
                <WifiOff className="h-4 w-4" />
              ) : (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              {readyForGame ? "Peer verified" : formatState(rtcState)}
            </div>
          </div>

          <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="rounded-2xl border border-white/10 bg-black/35 p-4">
              <Radio className="h-5 w-5 text-red-400" />
              <p className="mt-3 text-sm font-semibold">Signalling</p>
              <p className="mt-1 text-xs text-zinc-500">Supabase only introduces the PCs.</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/35 p-4">
              <Radio className="h-5 w-5 text-emerald-400" />
              <p className="mt-3 text-sm font-semibold">Direct Channel</p>
              <p className="mt-1 text-xs text-zinc-500">Game data goes over WebRTC peer-to-peer.</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/35 p-4">
              <CheckCircle2 className="h-5 w-5 text-sky-400" />
              <p className="mt-3 text-sm font-semibold">Heartbeat</p>
              <p className="mt-1 text-xs text-zinc-500">
                {lastPongMs ? `Last reply ${lastPongMs}ms` : "Waiting for peer reply."}
              </p>
            </div>
          </div>

          {error ? (
            <div className="mt-6 rounded-2xl border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-200">
              {error}
            </div>
          ) : null}

          {readyForGame ? (
            <div className="mt-6 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-4 text-sm text-emerald-100">
              Connection verified. Entering game in{" "}
              <span className="font-bold">{joinCountdown ?? 3}</span>...
            </div>
          ) : null}

          <div className="mt-6 rounded-2xl border border-white/10 bg-black/35 p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-400">Connection Steps</h3>
              {lastDiagnostic ? <span className="text-xs text-zinc-500">Last: {prettyDiagnostic(lastDiagnostic)}</span> : null}
            </div>
            <div className="mt-4 space-y-3">
              {diagnosticItems.map((item) => (
                <div key={item.label} className="flex items-start gap-3 rounded-xl bg-white/[0.03] px-3 py-3">
                  <span
                    className={`mt-1 h-2.5 w-2.5 rounded-full ${
                      item.status === "done"
                        ? "bg-emerald-400"
                        : item.status === "failed"
                          ? "bg-red-400"
                          : item.status === "active"
                            ? "bg-amber-300 animate-pulse"
                            : "bg-zinc-600"
                    }`}
                  />
                  <div>
                    <p className="text-sm font-semibold">{item.label}</p>
                    <p className="mt-0.5 text-xs text-zinc-500">{item.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {rtcState === "failed" || rtcState === "disconnected" ? (
            <div className="mt-6 rounded-2xl border border-amber-400/30 bg-amber-500/10 p-4 text-sm text-amber-100">
              <div className="flex items-start gap-3">
                <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />
                <p>
                  If Windows asks, allow the app on private networks. Some work, school, mobile hotspot, or strict router
                  networks can block direct peer-to-peer. This app is still staying peer-only here, so it will not relay
                  through a server.
                </p>
              </div>
            </div>
          ) : null}

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => setRetryKey((value) => value + 1)}
              className="inline-flex items-center gap-2 rounded-xl bg-zinc-800 px-4 py-2 font-semibold hover:bg-zinc-700 transition-colors"
            >
              <RefreshCw className="h-4 w-4" />
              Retry Connection
            </button>
            <button
              type="button"
              onClick={goToGame}
              disabled={!readyForGame}
              className="rounded-xl bg-green-600 px-4 py-2 font-semibold hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {readyForGame ? "Enter Game Now" : "Enter Game"}
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
