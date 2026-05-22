import React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Radio, RefreshCw, Send, UserRound, Wifi } from "lucide-react";
import GameDartBoxes, { type GameDartBox } from "../components/game/GameDartBoxes";
import { createOnlineRtcConnection, type OnlineRtcConnection, type OnlineRtcLiveMessage, type OnlineRtcState, type RtcDartScore } from "../online/onlineRtc";
import { getRoomByCode, subscribeToLobby, type OnlineRoomState } from "../online/supabaseOnline";

type TestTurnView = {
  playerId: string;
  turnIndex: number;
  remaining: number;
  darts: (RtcDartScore | null)[];
  appliedScores: number[];
  imageDataUrl: string | null;
};

type LogEntry = {
  id: string;
  text: string;
};

function formatDartLabel(dart: RtcDartScore | null): string {
  if (!dart) return "--";
  if (dart.zone === "triple" || dart.multiplier === 3) return `T${dart.segment}`;
  if (dart.zone === "double" || dart.multiplier === 2) return `D${dart.segment}`;
  if (dart.score === 0 || dart.zone === "miss") return "MISS";
  return dart.segment;
}

function buildSnapshotDataUrl(playerName: string, turnIndex: number, dartIndex: number, remaining: number, note: string): string {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="900" height="540" viewBox="0 0 900 540">
      <defs>
        <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="#1f2937" />
          <stop offset="100%" stop-color="#050505" />
        </linearGradient>
      </defs>
      <rect width="900" height="540" rx="32" fill="url(#bg)" />
      <circle cx="450" cy="270" r="170" fill="#161616" stroke="#ef4444" stroke-width="8" />
      <circle cx="450" cy="270" r="118" fill="none" stroke="#22c55e" stroke-width="8" />
      <circle cx="450" cy="270" r="72" fill="none" stroke="#ef4444" stroke-width="8" />
      <circle cx="450" cy="270" r="18" fill="#22c55e" />
      <circle cx="450" cy="270" r="8" fill="#ef4444" />
      <text x="50" y="72" fill="#f8fafc" font-size="34" font-family="Arial, sans-serif" font-weight="700">${playerName}</text>
      <text x="50" y="116" fill="#94a3b8" font-size="24" font-family="Arial, sans-serif">Turn ${turnIndex} • Dart ${dartIndex}</text>
      <text x="50" y="160" fill="#f8fafc" font-size="54" font-family="Arial, sans-serif" font-weight="700">${remaining}</text>
      <text x="50" y="204" fill="#ef4444" font-size="24" font-family="Arial, sans-serif">${note}</text>
      <text x="450" y="500" fill="#94a3b8" text-anchor="middle" font-size="22" font-family="Arial, sans-serif">Machine Darts Online Flow Test</text>
    </svg>
  `;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function makeDartBoxes(prefix: string, darts: (RtcDartScore | null)[], appliedScores: number[]): GameDartBox[] {
  return [0, 1, 2].map((index) => ({
    key: `${prefix}-${index}`,
    title: `Dart ${index + 1}`,
    main: formatDartLabel(darts[index]),
    sub: `Counted ${appliedScores[index] ?? 0}`,
    filled: Boolean(darts[index]),
  }));
}

export default function OnlineFlowTestPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const room = (searchParams.get("room") || "").toUpperCase();
  const playerId = searchParams.get("playerId") || "";
  const playerName = searchParams.get("playerName") || "Player";

  const [roomState, setRoomState] = React.useState<OnlineRoomState | null>(null);
  const [connectionState, setConnectionState] = React.useState<"connecting" | "connected" | "disconnected">("connecting");
  const [rtcState, setRtcState] = React.useState<OnlineRtcState>("disconnected");
  const [logs, setLogs] = React.useState<LogEntry[]>([]);
  const [liveCurrentPlayerId, setLiveCurrentPlayerId] = React.useState<string | null>(null);
  const [localTurnIndex, setLocalTurnIndex] = React.useState(1);
  const [localRemaining, setLocalRemaining] = React.useState(501);
  const [localDarts, setLocalDarts] = React.useState<(RtcDartScore | null)[]>([null, null, null]);
  const [localScores, setLocalScores] = React.useState<number[]>([0, 0, 0]);
  const [localSnapshot, setLocalSnapshot] = React.useState<string | null>(null);
  const [remoteView, setRemoteView] = React.useState<TestTurnView | null>(null);

  const rtcConnectionRef = React.useRef<OnlineRtcConnection | null>(null);

  const addLog = React.useCallback((text: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((previous) => [{ id: `${Date.now()}-${Math.random()}`, text: `[${timestamp}] ${text}` }, ...previous].slice(0, 40));
  }, []);

  const refreshRoom = React.useCallback(async () => {
    if (!room || !playerId) {
      return;
    }
    try {
      const nextRoom = await getRoomByCode(room);
      setRoomState(nextRoom);
      setConnectionState("connected");
    } catch {
      setConnectionState("disconnected");
    }
  }, [room, playerId]);

  React.useEffect(() => {
    if (!room || !playerId) {
      navigate("/online");
      return;
    }
    void refreshRoom();
  }, [navigate, playerId, refreshRoom, room]);

  React.useEffect(() => {
    if (!roomState?.id) {
      return;
    }
    const unsubscribe = subscribeToLobby(roomState.id, async () => {
      await refreshRoom();
    });
    return () => {
      unsubscribe();
    };
  }, [refreshRoom, roomState?.id]);

  const orderedPlayers = React.useMemo(
    () => (roomState ? [...roomState.players].sort((a, b) => a.seat - b.seat) : []),
    [roomState],
  );
  const onlinePlayerIndex = React.useMemo(
    () => orderedPlayers.findIndex((player) => player.id === playerId),
    [orderedPlayers, playerId],
  );
  const remotePlayer = React.useMemo(
    () => orderedPlayers.find((player) => player.id !== playerId) ?? null,
    [orderedPlayers, playerId],
  );

  const handleLiveMessage = React.useCallback(
    (message: OnlineRtcLiveMessage) => {
      if (message.playerId === playerId) {
        return;
      }

      if (message.type === "turn_owner") {
        setLiveCurrentPlayerId(message.currentPlayerId);
        addLog(`Received turn owner -> ${message.currentPlayerId === playerId ? "you" : remotePlayer?.name ?? "peer"}`);
        return;
      }

      if (message.type === "fronton_snapshot") {
        setLiveCurrentPlayerId(message.playerId);
        setRemoteView((previous) => ({
          playerId: message.playerId,
          turnIndex: message.turnIndex,
          remaining: message.remaining,
          darts: previous?.playerId === message.playerId && previous.turnIndex === message.turnIndex ? previous.darts : [null, null, null],
          appliedScores:
            previous?.playerId === message.playerId && previous.turnIndex === message.turnIndex ? previous.appliedScores : [0, 0, 0],
          imageDataUrl: message.imageDataUrl,
        }));
        addLog(`Received board snapshot for turn ${message.turnIndex}`);
        return;
      }

      if (message.type === "dart_score") {
        setLiveCurrentPlayerId(message.playerId);
        setRemoteView((previous) => {
          const base =
            previous && previous.playerId === message.playerId && previous.turnIndex === message.turnIndex
              ? previous
              : {
                  playerId: message.playerId,
                  turnIndex: message.turnIndex,
                  remaining: message.remaining,
                  darts: [null, null, null] as (RtcDartScore | null)[],
                  appliedScores: [0, 0, 0],
                  imageDataUrl: message.imageDataUrl,
                };
          const nextDarts = [...base.darts];
          const nextScores = [...base.appliedScores];
          const index = Math.max(0, Math.min(2, message.dartIndex - 1));
          nextDarts[index] = message.dart;
          nextScores[index] = message.appliedScore;
          return {
            ...base,
            remaining: message.remaining,
            darts: nextDarts,
            appliedScores: nextScores,
            imageDataUrl: message.imageDataUrl,
          };
        });
        addLog(`Received dart ${message.dartIndex}: ${message.dart ? formatDartLabel(message.dart) : "MISS"} (${message.appliedScore})`);
      }
    },
    [addLog, playerId, remotePlayer?.name],
  );

  React.useEffect(() => {
    if (!roomState?.id || !remotePlayer || onlinePlayerIndex < 0) {
      rtcConnectionRef.current?.close();
      rtcConnectionRef.current = null;
      setRtcState("disconnected");
      return;
    }

    const rtc = createOnlineRtcConnection({
      matchId: `flowtest-${roomState.id}`,
      localPlayerId: playerId,
      remotePlayerId: remotePlayer.id,
      initiator: onlinePlayerIndex === 0,
      onMessage: handleLiveMessage,
      onStateChange: setRtcState,
      onError: (error) => addLog(`RTC error: ${error.message}`),
    });

    rtcConnectionRef.current = rtc;
    setRtcState("connecting");

    return () => {
      rtc.close();
      if (rtcConnectionRef.current === rtc) {
        rtcConnectionRef.current = null;
      }
      setRtcState("disconnected");
    };
  }, [addLog, handleLiveMessage, onlinePlayerIndex, playerId, remotePlayer, roomState?.id]);

  const sendLiveMessage = React.useCallback(
    (message: OnlineRtcLiveMessage) => {
      const ok = rtcConnectionRef.current?.send(message) ?? false;
      if (!ok) {
        addLog("Peer send failed");
      }
      return ok;
    },
    [addLog],
  );

  const claimTurn = React.useCallback(() => {
    setLiveCurrentPlayerId(playerId);
    sendLiveMessage({
      type: "turn_owner",
      playerId,
      currentPlayerId: playerId,
      turnIndex: localTurnIndex,
    });
    addLog("Sent turn owner -> you");
  }, [addLog, localTurnIndex, playerId, sendLiveMessage]);

  const sendBoardSnapshot = React.useCallback(
    (note: string, dartIndex: number) => {
      const imageDataUrl = buildSnapshotDataUrl(playerName, localTurnIndex, dartIndex, localRemaining, note);
      setLocalSnapshot(imageDataUrl);
      setLiveCurrentPlayerId(playerId);
      sendLiveMessage({
        type: "fronton_snapshot",
        playerId,
        turnIndex: localTurnIndex,
        dartIndex,
        remaining: localRemaining,
        imageDataUrl,
      });
      addLog(`Sent board snapshot (${note})`);
    },
    [addLog, localRemaining, localTurnIndex, playerId, playerName, sendLiveMessage],
  );

  const sendDartScore = React.useCallback(
    (dart: RtcDartScore | null, appliedScore: number) => {
      const rawIndex = localDarts.findIndex((entry) => entry === null);
      if (rawIndex < 0) {
        addLog("Local visit already has 3 darts");
        return;
      }
      const nextIndex = Math.max(0, Math.min(2, rawIndex));
      const dartIndex = nextIndex + 1;
      const nextRemaining = Math.max(0, localRemaining - appliedScore);
      const nextDarts = [...localDarts];
      const nextScores = [...localScores];
      nextDarts[nextIndex] = dart;
      nextScores[nextIndex] = appliedScore;
      setLocalDarts(nextDarts);
      setLocalScores(nextScores);
      setLocalRemaining(nextRemaining);
      setLiveCurrentPlayerId(playerId);

      const note = dart ? `${formatDartLabel(dart)} / ${appliedScore}` : `MISS / ${appliedScore}`;
      const imageDataUrl = buildSnapshotDataUrl(playerName, localTurnIndex, dartIndex, nextRemaining, note);
      setLocalSnapshot(imageDataUrl);

      sendLiveMessage({
        type: "dart_score",
        playerId,
        turnIndex: localTurnIndex,
        dartIndex,
        remaining: nextRemaining,
        appliedScore,
        dart,
        imageDataUrl,
      });
      addLog(`Sent dart ${dartIndex}: ${note}`);
    },
    [addLog, localDarts, localRemaining, localScores, localTurnIndex, playerId, playerName, sendLiveMessage],
  );

  const passTurn = React.useCallback(() => {
    if (!remotePlayer) {
      addLog("No remote player connected yet");
      return;
    }
    sendLiveMessage({
      type: "turn_owner",
      playerId,
      currentPlayerId: remotePlayer.id,
      turnIndex: localTurnIndex,
    });
    setLiveCurrentPlayerId(remotePlayer.id);
    setLocalTurnIndex((current) => current + 1);
    setLocalDarts([null, null, null]);
    setLocalScores([0, 0, 0]);
    addLog(`Passed turn to ${remotePlayer.name || "peer"}`);
  }, [addLog, localTurnIndex, playerId, remotePlayer, sendLiveMessage]);

  const resetLocalTestState = React.useCallback(() => {
    setLocalTurnIndex(1);
    setLocalRemaining(501);
    setLocalDarts([null, null, null]);
    setLocalScores([0, 0, 0]);
    setLocalSnapshot(null);
    setRemoteView(null);
    setLiveCurrentPlayerId(null);
    setLogs([]);
  }, []);

  const localBoxes = React.useMemo(() => makeDartBoxes("local", localDarts, localScores), [localDarts, localScores]);
  const remoteBoxes = React.useMemo(
    () => makeDartBoxes("remote", remoteView?.darts ?? [null, null, null], remoteView?.appliedScores ?? [0, 0, 0]),
    [remoteView],
  );
  const currentOwnerLabel =
    liveCurrentPlayerId === playerId ? `${playerName} (You)` : orderedPlayers.find((player) => player.id === liveCurrentPlayerId)?.name ?? "Nobody";

  const testButtons: Array<{ label: string; dart: RtcDartScore | null; appliedScore: number }> = [
    { label: "20", dart: { score: 20, multiplier: 1, segment: "20", zone: "single_inner", confidence: 1 }, appliedScore: 20 },
    { label: "T20", dart: { score: 60, multiplier: 3, segment: "20", zone: "triple", confidence: 1 }, appliedScore: 60 },
    { label: "D20", dart: { score: 40, multiplier: 2, segment: "20", zone: "double", confidence: 1 }, appliedScore: 40 },
    { label: "MISS", dart: { score: 0, multiplier: 1, segment: "0", zone: "miss", confidence: 1 }, appliedScore: 0 },
  ];

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden flex flex-col">
      <div
        className="pointer-events-none fixed inset-0 [background:
          radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
          radial-gradient(ellipse_at_bottom_right,rgba(255,255,255,0.08),transparent_70%),
          linear-gradient(135deg,rgba(255,255,255,0.04),rgba(0,0,0,0.96)_35%,rgba(255,255,255,0.03)_70%,rgba(0,0,0,1)_100%)
        ]"
      />

      <header className="relative z-10 w-full px-6 md:px-10 py-6 flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={() =>
            navigate(
              `/online/lobby?mode=join&room=${room}&playerId=${playerId}&playerName=${encodeURIComponent(playerName)}`,
            )
          }
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Lobby
        </button>
        <div className="flex-1 text-center md:text-left">
          <h1 className="text-2xl font-extrabold tracking-wide">
            Online <span className="text-red-500">Flow Test</span>
          </h1>
          <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Transport Only / No Real Scoring</p>
        </div>
      </header>

      <main className="relative z-10 flex-1 px-6 md:px-10 pb-8">
        <div className="h-full w-full max-w-7xl mx-auto grid grid-cols-1 xl:grid-cols-[1.15fr_0.85fr] gap-6">
          <section className="space-y-6">
            <div className="rounded-2xl border border-white/10 bg-zinc-900/55 p-6 backdrop-blur">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Room</p>
                  <p className="text-2xl font-bold tracking-[0.25em] text-red-400">{room}</p>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span className={`inline-flex items-center gap-2 ${connectionState === "connected" ? "text-emerald-400" : "text-zinc-400"}`}>
                    <Wifi className="h-4 w-4" />
                    {connectionState === "connected" ? "Lobby Synced" : "Lobby Disconnected"}
                  </span>
                  <span className={`inline-flex items-center gap-2 ${rtcState === "connected" ? "text-emerald-400" : rtcState === "connecting" ? "text-amber-300" : "text-red-300"}`}>
                    <Radio className="h-4 w-4" />
                    {rtcState === "connected" ? "Direct Peer" : rtcState === "connecting" ? "Connecting Peer" : "Peer Offline"}
                  </span>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                <div className="rounded-xl border border-white/10 bg-black/25 p-4">
                  <div className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-2">You</div>
                  <div className="flex items-center gap-2 text-white">
                    <UserRound className="h-4 w-4 text-red-400" />
                    {playerName}
                  </div>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/25 p-4">
                  <div className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-2">Peer</div>
                  <div className="text-white">{remotePlayer?.name || "Waiting for peer..."}</div>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/25 p-4">
                  <div className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-2">Current Owner</div>
                  <div className="text-white">{currentOwnerLabel}</div>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-zinc-900/55 p-6 backdrop-blur">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-xl font-bold">Local Controls</h2>
                  <p className="text-sm text-zinc-400">Use these buttons to verify turn and score flow PC-to-PC.</p>
                </div>
                <button
                  type="button"
                  onClick={resetLocalTestState}
                  className="inline-flex items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm hover:bg-white/20 transition-colors"
                >
                  <RefreshCw className="h-4 w-4" />
                  Reset Test
                </button>
              </div>

              <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="rounded-xl border border-white/10 bg-black/25 p-4">
                  <div className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-2">Turn</div>
                  <div className="text-3xl font-bold text-white">{localTurnIndex}</div>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/25 p-4">
                  <div className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-2">Remaining</div>
                  <div className="text-3xl font-bold text-white">{localRemaining}</div>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/25 p-4">
                  <div className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-2">Actions</div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={claimTurn} className="rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold hover:bg-red-500 transition-colors">
                      Claim Turn
                    </button>
                    <button
                      type="button"
                      onClick={() => sendBoardSnapshot("Empty board", 0)}
                      className="rounded-lg bg-zinc-700 px-3 py-2 text-sm font-semibold hover:bg-zinc-600 transition-colors"
                    >
                      Send Empty Board
                    </button>
                  </div>
                </div>
              </div>

              <GameDartBoxes boxes={localBoxes} />

              <div className="mt-6 flex flex-wrap gap-3">
                {testButtons.map((button) => (
                  <button
                    key={button.label}
                    type="button"
                    onClick={() => sendDartScore(button.dart, button.appliedScore)}
                    className="rounded-xl bg-zinc-800 px-4 py-2 font-semibold hover:bg-zinc-700 transition-colors"
                  >
                    Send {button.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={passTurn}
                  className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 font-semibold hover:bg-emerald-500 transition-colors"
                >
                  <Send className="h-4 w-4" />
                  Pass Turn
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <section className="rounded-2xl border border-white/10 bg-zinc-900/55 p-6 backdrop-blur">
                <h3 className="text-lg font-semibold mb-4">Local Snapshot</h3>
                <div className="rounded-2xl border border-white/10 bg-black/40 min-h-[280px] overflow-hidden flex items-center justify-center">
                  {localSnapshot ? (
                    <img src={localSnapshot} alt="Local flow test snapshot" className="w-full h-full object-contain bg-black" />
                  ) : (
                    <div className="text-sm text-zinc-500">No local snapshot sent yet.</div>
                  )}
                </div>
              </section>

              <section className="rounded-2xl border border-white/10 bg-zinc-900/55 p-6 backdrop-blur">
                <h3 className="text-lg font-semibold mb-4">Remote Snapshot</h3>
                <div className="rounded-2xl border border-white/10 bg-black/40 min-h-[280px] overflow-hidden flex items-center justify-center">
                  {remoteView?.imageDataUrl ? (
                    <img src={remoteView.imageDataUrl} alt="Remote flow test snapshot" className="w-full h-full object-contain bg-black" />
                  ) : (
                    <div className="text-sm text-zinc-500">Waiting for a peer snapshot.</div>
                  )}
                </div>
              </section>
            </div>
          </section>

          <section className="space-y-6">
            <div className="rounded-2xl border border-white/10 bg-zinc-900/55 p-6 backdrop-blur">
              <h2 className="text-xl font-bold">Remote Turn View</h2>
              <p className="mt-1 text-sm text-zinc-400">This is what your PC currently thinks the peer has sent.</p>

              <div className="mt-6 grid grid-cols-1 gap-4">
                <div className="rounded-xl border border-white/10 bg-black/25 p-4">
                  <div className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-2">Remote Turn</div>
                  <div className="text-3xl font-bold text-white">{remoteView?.turnIndex ?? "--"}</div>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/25 p-4">
                  <div className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-2">Remote Remaining</div>
                  <div className="text-3xl font-bold text-white">{remoteView?.remaining ?? "--"}</div>
                </div>
              </div>

              <GameDartBoxes boxes={remoteBoxes} />
            </div>

            <div className="rounded-2xl border border-white/10 bg-zinc-900/55 p-6 backdrop-blur">
              <h2 className="text-xl font-bold">Event Log</h2>
              <p className="mt-1 text-sm text-zinc-400">Use this to confirm both PCs are sending and receiving the same flow.</p>
              <div className="mt-4 rounded-2xl border border-white/10 bg-black/30 p-4 min-h-[420px] max-h-[420px] overflow-auto">
                {logs.length === 0 ? (
                  <div className="text-sm text-zinc-500">No events yet.</div>
                ) : (
                  <div className="space-y-2">
                    {logs.map((entry) => (
                      <div key={entry.id} className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-zinc-200">
                        {entry.text}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
