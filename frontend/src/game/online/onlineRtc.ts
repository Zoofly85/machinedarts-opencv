import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabaseClient } from "./supabaseOnline";

export type OnlineRtcState = "connecting" | "connected" | "disconnected" | "failed";

export type OnlineRtcStats = {
  timestamp: number;
  state: OnlineRtcState;
  peerConnectionState: RTCPeerConnectionState | "none";
  iceConnectionState: RTCIceConnectionState | "none";
  iceGatheringState: RTCIceGatheringState | "none";
  signalingState: RTCSignalingState | "none";
  dataChannelState: RTCDataChannelState | "none";
  bufferedAmount: number;
  bytesSent: number;
  bytesReceived: number;
  sentKbps: number | null;
  receivedKbps: number | null;
  currentRoundTripTimeMs: number | null;
  availableOutgoingBitrateKbps: number | null;
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  candidatePairProtocol: string | null;
  selectedCandidatePairState: string | null;
  pendingInboundChunks: number;
};

export type RtcDartScore = {
  score: number;
  multiplier: number;
  segment: string;
  zone: string;
  confidence: number;
};

export type OnlineRtcLiveMessage =
  | {
      type: "message_ack";
      playerId: string;
      messageId: string;
      receivedType: string;
      receivedAt: number;
    }
  | {
      type: "peer_ping";
      playerId: string;
      sentAt: number;
    }
  | {
      type: "peer_pong";
      playerId: string;
      sentAt: number;
      receivedAt: number;
    }
  | {
      type: "fronton_snapshot";
      messageId?: string;
      playerId: string;
      turnIndex: number;
      dartIndex: number;
      remaining: number;
      imageDataUrl: string | null;
    }
  | {
      type: "dart_score";
      messageId?: string;
      playerId: string;
      turnIndex: number;
      dartIndex: number;
      remaining: number;
      appliedScore: number;
      dart: RtcDartScore | null;
      imageDataUrl: string | null;
    }
  | {
      type: "turn_commit";
      messageId?: string;
      playerId: string;
      turnIndex: number;
      currentPlayerId: string | null;
      currentSet: number;
      currentLeg: number;
      legWinner: number | null;
      setWinner: number | null;
      matchWinner: number | null;
      remaining: number;
      totalScored: number;
      dartsThrown: number;
      average: number;
      legsWon: number;
      setsWon: number;
      players: Array<{
        playerId: string;
        score: number;
        totalScored: number;
        dartsThrown: number;
        average: number;
        legsWon: number;
        setsWon: number;
      }>;
      darts: (RtcDartScore | null)[];
      appliedScores: number[];
    }
  | {
      type: "turn_owner";
      messageId?: string;
      playerId: string;
      currentPlayerId: string | null;
      turnIndex: number;
    }
  | {
      type: "match_complete";
      messageId?: string;
      playerId: string;
      summary: Record<string, unknown>;
    };

type SignalPayload = {
  senderId: string;
  targetId?: string | null;
  type: "offer" | "answer" | "candidate";
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

type Envelope =
  | {
      kind: "message";
      data: string;
    }
  | {
      kind: "chunk";
      id: string;
      index: number;
      total: number;
      data: string;
    };

type PendingChunkState = {
  total: number;
  parts: string[];
};

const ICE_SERVERS: RTCIceServer[] = [
  {
    urls: [
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
      "stun:stun2.l.google.com:19302",
      "stun:stun3.l.google.com:19302",
      "stun:stun4.l.google.com:19302",
    ],
  },
];
const CHUNK_SIZE = 12_000;
const OFFER_RETRY_MS = 2000;

export type OnlineRtcConnection = {
  send: (message: OnlineRtcLiveMessage) => boolean;
  close: () => void;
  getState: () => OnlineRtcState;
  getLatestStats: () => OnlineRtcStats | null;
};

export function createOnlineRtcConnection(options: {
  matchId: string;
  localPlayerId: string;
  remotePlayerId: string;
  initiator: boolean;
  onMessage: (message: OnlineRtcLiveMessage) => void;
  onStateChange?: (state: OnlineRtcState) => void;
  onStats?: (stats: OnlineRtcStats) => void;
  onDiagnostic?: (message: string) => void;
  onError?: (error: Error) => void;
}): OnlineRtcConnection {
  const supabase = getSupabaseClient();
  const pendingChunks = new Map<string, PendingChunkState>();
  const pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  let signalingChannel: RealtimeChannel | null = null;
  let peerConnection: RTCPeerConnection | null = null;
  let dataChannel: RTCDataChannel | null = null;
  let disposed = false;
  let startedOffer = false;
  let signalingReady = false;
  let offerRetryTimer: number | null = null;
  let statsTimer: number | null = null;
  let latestStats: OnlineRtcStats | null = null;
  let previousTrafficSample: { timestamp: number; bytesSent: number; bytesReceived: number } | null = null;
  let currentState: OnlineRtcState = "connecting";

  const emitState = (state: OnlineRtcState) => {
    currentState = state;
    options.onDiagnostic?.(`state:${state}`);
    options.onStateChange?.(state);
  };

  const emitDiagnostic = (message: string) => {
    if (!disposed) {
      options.onDiagnostic?.(message);
    }
  };

  const emitError = (error: unknown) => {
    if (disposed) {
      return;
    }
    const normalized = error instanceof Error ? error : new Error(String(error ?? "Unknown RTC error"));
    emitDiagnostic(`error:${normalized.message}`);
    options.onError?.(normalized);
  };

  const isPeerTransportOpen = () =>
    (dataChannel?.readyState === "open") || peerConnection?.connectionState === "connected";

  const readCandidate = (report: RTCStatsReport, id: string | undefined): RTCStats | null => {
    if (!id) {
      return null;
    }
    return (report.get(id) as RTCStats | undefined) ?? null;
  };

  const emitStats = async () => {
    if (disposed) {
      return;
    }

    const now = Date.now();
    const stats: OnlineRtcStats = {
      timestamp: now,
      state: currentState,
      peerConnectionState: peerConnection?.connectionState ?? "none",
      iceConnectionState: peerConnection?.iceConnectionState ?? "none",
      iceGatheringState: peerConnection?.iceGatheringState ?? "none",
      signalingState: peerConnection?.signalingState ?? "none",
      dataChannelState: dataChannel?.readyState ?? "none",
      bufferedAmount: dataChannel?.bufferedAmount ?? 0,
      bytesSent: latestStats?.bytesSent ?? 0,
      bytesReceived: latestStats?.bytesReceived ?? 0,
      sentKbps: null,
      receivedKbps: null,
      currentRoundTripTimeMs: null,
      availableOutgoingBitrateKbps: null,
      localCandidateType: null,
      remoteCandidateType: null,
      candidatePairProtocol: null,
      selectedCandidatePairState: null,
      pendingInboundChunks: pendingChunks.size,
    };

    if (peerConnection) {
      try {
        const report = await peerConnection.getStats();
        report.forEach((entry) => {
          const item = entry as RTCStats & Record<string, unknown>;
          if (item.type === "data-channel") {
            stats.bytesSent = Number(item.bytesSent ?? stats.bytesSent) || 0;
            stats.bytesReceived = Number(item.bytesReceived ?? stats.bytesReceived) || 0;
          }
          if (item.type === "candidate-pair" && (item.nominated || item.selected) && item.state === "succeeded") {
            stats.selectedCandidatePairState = String(item.state ?? "");
            stats.currentRoundTripTimeMs =
              typeof item.currentRoundTripTime === "number" ? Math.round(item.currentRoundTripTime * 1000) : null;
            stats.availableOutgoingBitrateKbps =
              typeof item.availableOutgoingBitrate === "number" ? Math.round(item.availableOutgoingBitrate / 1000) : null;

            const localCandidate = readCandidate(report, String(item.localCandidateId ?? ""));
            const remoteCandidate = readCandidate(report, String(item.remoteCandidateId ?? ""));
            const local = (localCandidate ?? {}) as RTCStats & Record<string, unknown>;
            const remote = (remoteCandidate ?? {}) as RTCStats & Record<string, unknown>;
            stats.localCandidateType = typeof local.candidateType === "string" ? local.candidateType : null;
            stats.remoteCandidateType = typeof remote.candidateType === "string" ? remote.candidateType : null;
            stats.candidatePairProtocol =
              typeof local.protocol === "string" ? local.protocol : typeof remote.protocol === "string" ? remote.protocol : null;
          }
        });
      } catch (error) {
        emitDiagnostic(`stats:error:${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (previousTrafficSample) {
      const elapsedSeconds = Math.max(0.1, (now - previousTrafficSample.timestamp) / 1000);
      stats.sentKbps = Math.max(0, Math.round(((stats.bytesSent - previousTrafficSample.bytesSent) * 8) / elapsedSeconds / 1000));
      stats.receivedKbps = Math.max(
        0,
        Math.round(((stats.bytesReceived - previousTrafficSample.bytesReceived) * 8) / elapsedSeconds / 1000),
      );
    }
    previousTrafficSample = {
      timestamp: now,
      bytesSent: stats.bytesSent,
      bytesReceived: stats.bytesReceived,
    };

    latestStats = stats;
    options.onStats?.(stats);
  };

  const startStatsTimer = () => {
    if (statsTimer !== null) {
      return;
    }
    void emitStats();
    statsTimer = window.setInterval(() => {
      void emitStats();
    }, 1000);
  };

  const flushPendingCandidates = async () => {
    if (!peerConnection?.remoteDescription) {
      return;
    }
    while (pendingRemoteCandidates.length > 0) {
      const candidate = pendingRemoteCandidates.shift();
      if (!candidate) {
        continue;
      }
      try {
        await peerConnection.addIceCandidate(candidate);
      } catch (error) {
        emitError(error);
      }
    }
  };

  const sendSignal = (payload: SignalPayload) => {
    if (!signalingChannel || !signalingReady || disposed) {
      emitDiagnostic(`signal:${payload.type}:queued`);
      return;
    }
    emitDiagnostic(`signal:${payload.type}:send`);
    void signalingChannel
      .send({
        type: "broadcast",
        event: "signal",
        payload,
      })
      .then((result) => {
        if (result !== "ok" && result !== "timed out") {
          emitError(new Error(`RTC signaling send failed: ${result}`));
        } else {
          emitDiagnostic(`signal:${payload.type}:${result}`);
        }
      })
      .catch((error) => {
        emitError(error);
      });
  };

  const handleEnvelope = (raw: string) => {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch {
      return;
    }

    if (envelope.kind === "message") {
      try {
        options.onMessage(JSON.parse(envelope.data) as OnlineRtcLiveMessage);
      } catch {
        // Ignore malformed peer data.
      }
      return;
    }

    const existing = pendingChunks.get(envelope.id) ?? {
      total: envelope.total,
      parts: Array.from({ length: envelope.total }, () => ""),
    };
    existing.parts[envelope.index] = envelope.data;
    pendingChunks.set(envelope.id, existing);

    if (existing.parts.every((part) => part.length > 0)) {
      pendingChunks.delete(envelope.id);
      try {
        options.onMessage(JSON.parse(existing.parts.join("")) as OnlineRtcLiveMessage);
      } catch {
        // Ignore malformed peer data.
      }
    }
  };

  const setupDataChannel = (channel: RTCDataChannel) => {
    dataChannel = channel;
    dataChannel.onopen = () => {
      emitDiagnostic("datachannel:open");
      emitState("connected");
    };
    dataChannel.onclose = () => {
      emitDiagnostic("datachannel:close");
      if (!disposed && !isPeerTransportOpen()) {
        emitState("disconnected");
      }
    };
    dataChannel.onerror = (event) => {
      emitError((event as Event & { error?: Error }).error ?? new Error("RTC data channel error"));
    };
    dataChannel.onmessage = (event) => {
      if (typeof event.data === "string") {
        emitDiagnostic("datachannel:message");
        handleEnvelope(event.data);
        void emitStats();
      }
    };
  };

  const ensurePeerConnection = () => {
    if (peerConnection) {
      return peerConnection;
    }

    peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    emitDiagnostic("peer:create");
    peerConnection.onicecandidate = (event) => {
      if (!event.candidate) {
        emitDiagnostic("ice:gathering:complete");
        return;
      }
      emitDiagnostic("ice:candidate:local");
      const candidate = typeof event.candidate.toJSON === "function" ? event.candidate.toJSON() : event.candidate;
      sendSignal({
        senderId: options.localPlayerId,
        targetId: options.remotePlayerId,
        type: "candidate",
        candidate,
      });
    };
    peerConnection.ondatachannel = (event) => {
      emitDiagnostic("datachannel:received");
      setupDataChannel(event.channel);
    };
    peerConnection.onconnectionstatechange = () => {
      const next = peerConnection?.connectionState;
      if (next) {
        emitDiagnostic(`peer:${next}`);
      }
      if (next === "connected") {
        emitState("connected");
      } else if (next === "failed" && !isPeerTransportOpen()) {
        emitState("failed");
      } else if ((next === "disconnected" || next === "closed") && !isPeerTransportOpen()) {
        emitState("disconnected");
      }
    };
    peerConnection.oniceconnectionstatechange = () => {
      const next = peerConnection?.iceConnectionState;
      if (next) {
        emitDiagnostic(`ice:${next}`);
      }
    };
    peerConnection.onicegatheringstatechange = () => {
      const next = peerConnection?.iceGatheringState;
      if (next) {
        emitDiagnostic(`ice-gathering:${next}`);
      }
    };
    peerConnection.onsignalingstatechange = () => {
      const next = peerConnection?.signalingState;
      if (next) {
        emitDiagnostic(`signaling:${next}`);
      }
    };
    return peerConnection;
  };

  const startOffer = async (force = false) => {
    if (disposed || !options.initiator || currentState === "connected") {
      return;
    }
    if (startedOffer && !force) {
      return;
    }
    const existingPeerConnection = ensurePeerConnection();
    if (
      force &&
      existingPeerConnection.localDescription?.type === "offer" &&
      existingPeerConnection.signalingState === "have-local-offer"
    ) {
      emitDiagnostic("offer:retry");
      sendSignal({
        senderId: options.localPlayerId,
        targetId: options.remotePlayerId,
        type: "offer",
        description: existingPeerConnection.localDescription,
      });
      return;
    }
    if (existingPeerConnection.signalingState !== "stable") {
      return;
    }
    startedOffer = true;
    try {
      const pc = existingPeerConnection;
      if (!dataChannel || dataChannel.readyState === "closed") {
        emitDiagnostic("datachannel:create");
        setupDataChannel(pc.createDataChannel("machine-darts-live", { ordered: true }));
      }
      emitDiagnostic("offer:create");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal({
        senderId: options.localPlayerId,
        targetId: options.remotePlayerId,
        type: "offer",
        description: offer,
      });
    } catch (error) {
      emitState("failed");
      emitError(error);
    }
  };

  const startOfferRetry = () => {
    if (!options.initiator || offerRetryTimer !== null) {
      return;
    }
    offerRetryTimer = window.setInterval(() => {
      if (disposed || currentState === "connected") {
        if (offerRetryTimer !== null) {
          window.clearInterval(offerRetryTimer);
          offerRetryTimer = null;
        }
        return;
      }
      void startOffer(true);
    }, OFFER_RETRY_MS);
  };

  const handleSignal = async (payload: SignalPayload) => {
    if (disposed || payload.senderId === options.localPlayerId) {
      return;
    }
    if (payload.targetId && payload.targetId !== options.localPlayerId) {
      return;
    }

    try {
      emitDiagnostic(`signal:${payload.type}:receive`);
      const pc = ensurePeerConnection();
      if (payload.type === "offer" && payload.description) {
        await pc.setRemoteDescription(payload.description);
        await flushPendingCandidates();
        emitDiagnostic("answer:create");
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal({
          senderId: options.localPlayerId,
          targetId: payload.senderId,
          type: "answer",
          description: answer,
        });
        return;
      }

      if (payload.type === "answer" && payload.description) {
        await pc.setRemoteDescription(payload.description);
        await flushPendingCandidates();
        emitDiagnostic("answer:applied");
        return;
      }

      if (payload.type === "candidate" && payload.candidate) {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(payload.candidate);
          emitDiagnostic("ice:candidate:remote:applied");
        } else {
          pendingRemoteCandidates.push(payload.candidate);
          emitDiagnostic("ice:candidate:remote:queued");
        }
      }
    } catch (error) {
      emitState("failed");
      emitError(error);
    }
  };

  signalingChannel = supabase
    .channel(`match-rtc:${options.matchId}`, {
      config: {
        broadcast: {
          self: false,
        },
      },
    })
    .on("broadcast", { event: "signal" }, ({ payload }) => {
      void handleSignal(payload as SignalPayload);
    });

  void signalingChannel.subscribe((status) => {
    if (disposed) {
      return;
    }
    emitDiagnostic(`signaling-channel:${status}`);
    if (status === "SUBSCRIBED") {
      signalingReady = true;
      if (!isPeerTransportOpen() && currentState !== "connected") {
        emitState("connecting");
      }
      void startOffer();
      startOfferRetry();
      return;
    }
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      if (!isPeerTransportOpen()) {
        emitState("failed");
      }
    }
    if (status === "CLOSED") {
      if (!isPeerTransportOpen()) {
        emitState("disconnected");
      }
    }
  });
  startStatsTimer();

  const send = (message: OnlineRtcLiveMessage): boolean => {
    if (!dataChannel || dataChannel.readyState !== "open") {
      return false;
    }

    const serialized = JSON.stringify(message);
    emitDiagnostic(`send:${message.type}:bytes:${serialized.length}:buffer:${dataChannel.bufferedAmount}`);
    if (serialized.length <= CHUNK_SIZE) {
      dataChannel.send(JSON.stringify({ kind: "message", data: serialized } satisfies Envelope));
      void emitStats();
      return true;
    }

    const chunkId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const total = Math.ceil(serialized.length / CHUNK_SIZE);
    emitDiagnostic(`send:${message.type}:chunks:${total}`);
    for (let index = 0; index < total; index += 1) {
      dataChannel.send(
        JSON.stringify({
          kind: "chunk",
          id: chunkId,
          index,
          total,
          data: serialized.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
        } satisfies Envelope),
      );
    }
    void emitStats();
    return true;
  };

  const close = () => {
    disposed = true;
    emitState("disconnected");
    if (dataChannel) {
      dataChannel.close();
      dataChannel = null;
    }
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }
    if (offerRetryTimer !== null) {
      window.clearInterval(offerRetryTimer);
      offerRetryTimer = null;
    }
    if (statsTimer !== null) {
      window.clearInterval(statsTimer);
      statsTimer = null;
    }
    if (signalingChannel) {
      void supabase.removeChannel(signalingChannel);
      signalingChannel = null;
    }
  };

  return {
    send,
    close,
    getState: () => currentState,
    getLatestStats: () => latestStats,
  };
}
