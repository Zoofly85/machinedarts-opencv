import React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Eye, Radio, RotateCcw, Users, Wifi, WifiOff } from "lucide-react";
import ScoreCorrection from "../components/ScoreCorrection";
import GameHeader from "../components/game/GameHeader";
import GameDartBoxes, { type GameDartBox } from "../components/game/GameDartBoxes";
import { GameControlButton } from "../components/game/GameControl";
import GamePlayerCard, { type GamePlayerCardStat } from "../components/player/GamePlayerCard";
import type { InOutMode, PlayerConfig } from "../context/LobbyContext";
import { addDart, correctScore, deleteCorrectionImages, type DartCorrectionPayload } from "../services/correctionApi";
import { computeCheckoutSuggestionsLocal } from "../services/x01CheckoutLocal";
import { getJson, postJson } from "../services/apiClient";
import {
  commitRemoteTurn as apiCommitRemoteTurn,
  getGameState as apiGetGameState,
  recordRemoteDart as apiRecordRemoteDart,
  startGame as apiStartGame,
  stopGame as apiStopGame,
} from "../services/gameApi";
import { useGameStateSync } from "../services/useGameStateSync";
import {
  getActiveMatchByLobbyId,
  getRoomByCode,
  getStoredSession,
  type OnlineMatchState,
  type OnlineRoomState,
} from "../online/supabaseOnline";
import {
  createOnlineRtcConnection,
  type OnlineRtcConnection,
  type OnlineRtcLiveMessage,
  type OnlineRtcStats,
  type OnlineRtcState,
  type RtcDartScore,
} from "../online/onlineRtc";

const ONLINE_BOARD_REPLAY_MIN_SCORE = 40;
const ONLINE_BOARD_REPLAY_INTRO_MS = 3000;
const ONLINE_BOARD_REPLAY_DART_MS = 1600;

interface DartScore {
  score: number;
  multiplier: number;
  segment: string;
  zone: string;
  confidence: number;
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

interface X01State {
  settings: {
    startScore: number;
    inMode: string;
    outMode: string;
    legsPerSet: number;
    setsToWin: number;
    freePlay?: boolean;
  };
  match: {
    currentSet: number;
    currentLeg: number;
    legWinner: number | null;
    setWinner: number | null;
    matchWinner: number | null;
  };
  currentPlayer: number | null;
  players: X01PlayerStateBackend[];
  currentTurn: X01TurnState;
  lastTurn: X01TurnHistoryEntry | null;
  lastCommittedTurn?: X01TurnHistoryEntry | null;
  winner: number | null;
  matchWinner: number | null;
  turnInputArmed?: boolean;
  turnInputReason?: string;
}

type LiveRemoteTurnState = {
  playerId: string;
  turnIndex: number;
  darts: (DartScore | null)[];
  appliedScores: number[];
  remaining: number;
};

type OnlineBoardReplayFrame = {
  dartIndex: number;
  imageDataUrl: string;
  label: string;
  scoreValue?: number;
};

type OnlineBoardReplay = {
  key: string;
  playerId: string;
  playerName: string;
  turnIndex: number;
  totalScore: number;
  checkout: boolean;
  frames: OnlineBoardReplayFrame[];
};

type MirroredPlayerState = {
  score: number;
  totalScored: number;
  dartsThrown: number;
  average: number;
  legsWon: number;
  setsWon: number;
};

type MirroredMatchState = {
  currentSet: number;
  currentLeg: number;
  legWinner: number | null;
  setWinner: number | null;
  matchWinner: number | null;
};

type PeerDeliveryStatus = {
  id: string;
  label: string;
  state: "pending" | "confirmed" | "failed";
  sentAt: number;
  attempts: number;
  maxAttempts: number;
  confirmedAt?: number;
};

type PendingPeerMessage = {
  message: OnlineRtcLiveMessage;
  label: string;
  attempts: number;
  maxAttempts: number;
  retryMs: number;
};

type OnlinePlayerX01Settings = {
  startScore: number;
  inMode: InOutMode;
  outMode: InOutMode;
};

function isInnerBull(dart: DartScore | null): boolean {
  if (!dart) return false;
  return dart.zone === "inner_bull" || (dart.segment === "25" && Math.round(dart.score) === 50);
}

function isDouble(dart: DartScore | null): boolean {
  if (!dart) return false;
  return isInnerBull(dart) || dart.zone === "double" || dart.multiplier === 2;
}

function isTriple(dart: DartScore | null): boolean {
  if (!dart) return false;
  return dart.zone === "triple" || dart.multiplier === 3;
}

function formatDartLabel(dart: DartScore | null): string {
  if (!dart) return "--";
  if (isInnerBull(dart)) return "BULL";
  if (dart.zone === "outer_bull" || (dart.segment === "25" && dart.score === 25)) return "25";
  if (isTriple(dart)) return `T${dart.segment}`;
  if (isDouble(dart)) return dart.segment === "25" ? "BULL" : `D${dart.segment}`;
  if (dart.segment === "25") return "25";
  if (dart.score === 0 || dart.zone === "miss") return "MISS";
  return dart.segment;
}

function formatAppliedScore(value: number): string {
  return value === 0 ? "0" : String(value);
}

function describeLiveMessage(message: OnlineRtcLiveMessage): string {
  if (message.type === "message_ack") {
    return `ack ${message.receivedType}`;
  }
  if (message.type === "peer_ping") {
    return "peer_ping";
  }
  if (message.type === "peer_pong") {
    return "peer_pong";
  }
  if (message.type === "fronton_snapshot") {
    return `snapshot t${message.turnIndex} d${message.dartIndex}`;
  }
  if (message.type === "dart_score") {
    return `dart t${message.turnIndex} d${message.dartIndex} ${message.appliedScore}`;
  }
  if (message.type === "turn_commit") {
    return `commit t${message.turnIndex} -> ${message.currentPlayerId ?? "none"}`;
  }
  if (message.type === "turn_owner") {
    return `owner -> ${message.currentPlayerId ?? "none"}`;
  }
  if (message.type === "match_complete") {
    return "match_complete";
  }
  return "unknown";
}

function shouldConfirmPeerMessage(message: OnlineRtcLiveMessage): boolean {
  return (
    message.type === "fronton_snapshot" ||
    message.type === "dart_score" ||
    message.type === "turn_commit" ||
    message.type === "turn_owner" ||
    message.type === "match_complete"
  );
}

function getPeerMessageId(message: OnlineRtcLiveMessage): string | null {
  if ("messageId" in message && typeof message.messageId === "string" && message.messageId.length > 0) {
    return message.messageId;
  }
  return null;
}

function createPeerMessageId(type: string): string {
  return `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getPeerMessageRetryPolicy(message: OnlineRtcLiveMessage): { maxAttempts: number; retryMs: number } | null {
  if (!shouldConfirmPeerMessage(message)) {
    return null;
  }
  if (message.type === "fronton_snapshot") {
    return { maxAttempts: 2, retryMs: 1500 };
  }
  return { maxAttempts: 4, retryMs: 900 };
}

function formatMonitorRate(value: number | null): string {
  if (value === null) {
    return "--";
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)} Mbps`;
  }
  return `${value} kbps`;
}

function formatMonitorBytes(value: number): string {
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${value} B`;
}

function summarizeCandidatePair(stats: OnlineRtcStats | null): string {
  if (!stats?.localCandidateType && !stats?.remoteCandidateType) {
    return "--";
  }
  const protocol = stats.candidatePairProtocol ? `/${stats.candidatePairProtocol.toUpperCase()}` : "";
  return `${stats.localCandidateType ?? "local"} -> ${stats.remoteCandidateType ?? "remote"}${protocol}`;
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

function getRoomX01Defaults(roomState: OnlineRoomState | null | undefined): OnlinePlayerX01Settings {
  return {
    startScore: roomState?.game_settings?.x01?.startScore ?? roomState?.starting_score ?? 501,
    inMode: roomState?.game_settings?.x01?.inMode ?? "straight",
    outMode: roomState?.game_settings?.x01?.outMode ?? "double",
  };
}

function getRoomPlayerX01Settings(
  roomState: OnlineRoomState | null | undefined,
  orderedPlayerIndex: number,
  seat?: number | null,
): OnlinePlayerX01Settings {
  const defaults = getRoomX01Defaults(roomState);
  const playerSettings = roomState?.game_settings?.playerSettings;
  const seatIndex = typeof seat === "number" && seat >= 0 ? seat : orderedPlayerIndex;
  const perPlayer = playerSettings?.[seatIndex] ?? playerSettings?.[orderedPlayerIndex] ?? null;

  return {
    startScore: perPlayer?.startScore ?? defaults.startScore,
    inMode: perPlayer?.inMode ?? defaults.inMode,
    outMode: perPlayer?.outMode ?? defaults.outMode,
  };
}

function buildFallbackPlayers(roomState: OnlineRoomState): X01PlayerStateBackend[] {
  const ordered = [...roomState.players].sort((a, b) => a.seat - b.seat);
  return ordered.map((player, index) => {
    const playerSettings = getRoomPlayerX01Settings(roomState, index, player.seat);
    return {
      name: player.name,
      score: playerSettings.startScore,
      startingScore: playerSettings.startScore,
      hasIn: playerSettings.inMode === "straight",
      inMode: playerSettings.inMode,
      outMode: playerSettings.outMode,
      dartsThrown: 0,
      totalScored: 0,
      average: 0,
      firstNineAverage: 0,
      legsWon: 0,
      setsWon: 0,
    };
  });
}

async function fetchFrontonImageDataUrl(): Promise<string | null> {
  try {
    const payload = await getJson<{ image?: string }>("/api/detection/image?view=fronton&max_size=600&quality=60");
    return payload.image ? `data:image/jpeg;base64,${payload.image}` : null;
  } catch {
    return null;
  }
}

export default function OnlineX01GamePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const storedSession = React.useMemo(() => getStoredSession(), []);
  const roomCode = (searchParams.get("room") || storedSession?.room || "").toUpperCase();
  const routeMatchId = searchParams.get("matchId") || "";
  const p2pReady = searchParams.get("p2pReady") === "1";
  const session = React.useMemo(
    () => ({
      playerId: searchParams.get("playerId") || storedSession?.playerId || "",
      playerName: searchParams.get("playerName") || storedSession?.playerName || "Player",
      profileId: searchParams.get("profileId") || storedSession?.profileId || "",
    }),
    [searchParams, storedSession],
  );

  const [roomState, setRoomState] = React.useState<OnlineRoomState | null>(null);
  const [onlineMatch, setOnlineMatch] = React.useState<OnlineMatchState | null>(null);
  const [onlinePlayerIndex, setOnlinePlayerIndex] = React.useState<number | null>(null);
  const [x01State, setX01State] = React.useState<X01State | null>(null);
  const [frontonImage, setFrontonImage] = React.useState<string | null>(null);
  const [dartCount, setDartCount] = React.useState(0);
  const [detectionState, setDetectionState] = React.useState<string>("no_movement");
  const [error, setError] = React.useState<string | null>(null);
  const [connectionState, setConnectionState] =
    React.useState<"connecting" | "connected" | "disconnected">("connecting");
  const [rtcState, setRtcState] = React.useState<OnlineRtcState>("disconnected");
  const [lastPeerSent, setLastPeerSent] = React.useState<string>("-");
  const [lastPeerReceived, setLastPeerReceived] = React.useState<string>("-");
  const [lastPeerConfirmed, setLastPeerConfirmed] = React.useState<string>("-");
  const [peerDeliveries, setPeerDeliveries] = React.useState<Record<string, PeerDeliveryStatus>>({});
  const [rtcStats, setRtcStats] = React.useState<OnlineRtcStats | null>(null);
  const [rtcDiagnostics, setRtcDiagnostics] = React.useState<string[]>([]);
  const [liveCurrentPlayerId, setLiveCurrentPlayerId] = React.useState<string | null>(null);
  const [liveRemoteSnapshot, setLiveRemoteSnapshot] = React.useState<string | null>(null);
  const [liveRemoteTurn, setLiveRemoteTurn] = React.useState<LiveRemoteTurnState | null>(null);
  const [mirroredPlayers, setMirroredPlayers] = React.useState<Record<string, MirroredPlayerState>>({});
  const [mirroredMatch, setMirroredMatch] = React.useState<MirroredMatchState | null>(null);
  const [onlineBoardReplay, setOnlineBoardReplay] = React.useState<OnlineBoardReplay | null>(null);
  const [onlineBoardReplayIndex, setOnlineBoardReplayIndex] = React.useState(0);
  const [isCorrectionModalOpen, setIsCorrectionModalOpen] = React.useState(false);
  const [selectedDartIndex, setSelectedDartIndex] = React.useState(-1);

  const gameStartedRef = React.useRef(false);
  const lastSubmittedDartsRef = React.useRef<{ turnIndex: number; submittedCount: number }>({
    turnIndex: -1,
    submittedCount: 0,
  });
  const lastSubmittedScoresRef = React.useRef<{ turnIndex: number; scores: number[] }>({
    turnIndex: -1,
    scores: [],
  });
  const lastUploadedSnapshotTurnRef = React.useRef<number>(-1);
  const lastLiveSnapshotKeyRef = React.useRef<string>("");
  const liveSnapshotInFlightRef = React.useRef(false);
  const lastSetTurnRef = React.useRef<number>(-1);
  const lastCommittedTurnRef = React.useRef<number>(-1);
  const forceTurnSyncInFlightRef = React.useRef(false);
  const rtcConnectionRef = React.useRef<OnlineRtcConnection | null>(null);
  const hasNavigatedToStatsRef = React.useRef(false);
  const matchCompleteSentRef = React.useRef(false);
  const finishToStatsRef = React.useRef<((summary: X01State) => Promise<void>) | null>(null);
  const syncLocalTurnToLiveOwnerRef = React.useRef<((currentPlayerId: string | null, turnIndex?: number | null) => Promise<void>) | null>(null);
  const applyRemoteCommittedTurnRef = React.useRef<
    ((message: Extract<OnlineRtcLiveMessage, { type: "turn_commit" }>) => Promise<void>) | null
  >(null);
  const recordRemoteDartRef = React.useRef<
    ((message: Extract<OnlineRtcLiveMessage, { type: "dart_score" }>) => Promise<void>) | null
  >(null);
  const startingScoreRef = React.useRef(roomState?.starting_score ?? 501);
  const onlinePlayerIndexRef = React.useRef<number | null>(null);
  const localCurrentPlayerIndexRef = React.useRef<number | null>(null);
  const localTurnHasDartsRef = React.useRef(false);
  const orderedRoomPlayersRef = React.useRef<OnlineRoomState["players"]>([]);
  const startedRouteMatchIdRef = React.useRef<string>("");
  const localCatchupTimersRef = React.useRef<number[]>([]);
  const remoteDartKeysRef = React.useRef<Set<string>>(new Set());
  const lastAppliedRemoteTurnRef = React.useRef<string>("");
  const remoteTurnApplyInFlightRef = React.useRef(false);
  const playerX01SettingsByIdRef = React.useRef<Record<string, OnlinePlayerX01Settings>>({});
  const lastRemoteTurnIndexByPlayerRef = React.useRef<Record<string, number>>({});
  const remoteTurnMutationQueueRef = React.useRef<Promise<void>>(Promise.resolve());
  const peerDeliveryTimeoutsRef = React.useRef<Record<string, number>>({});
  const pendingPeerMessagesRef = React.useRef<Record<string, PendingPeerMessage>>({});
  const receivedPeerMessageIdsRef = React.useRef<Set<string>>(new Set());
  const lastDetectorResetOwnerKeyRef = React.useRef<string>("");
  const onlineBoardReplayFramesRef = React.useRef<Record<string, OnlineBoardReplayFrame[]>>({});
  const lastStartedOnlineBoardReplayKeyRef = React.useRef<string>("");

  const refreshRoomAndMatch = React.useCallback(async () => {
    if (!roomCode || !session.playerId) {
      return;
    }
    const room = await getRoomByCode(roomCode);
    const ordered = [...room.players].sort((a, b) => a.seat - b.seat);
    const match = await getActiveMatchByLobbyId(room.id);
    setRoomState(room);
    setOnlinePlayerIndex(ordered.findIndex((player) => player.id === session.playerId));
    setOnlineMatch(match);
  }, [roomCode, session.playerId]);

  const refreshLocalState = React.useCallback(async () => {
    try {
      const state = await apiGetGameState<X01State>("x01");
      setX01State(state);
      return state;
    } catch (err) {
      return null;
    }
  }, []);

  const connectMatchId = routeMatchId || onlineMatch?.id || "";
  const effectiveMatchId = React.useMemo(
    () => connectMatchId || roomState?.id || "",
    [connectMatchId, roomState?.id],
  );

  React.useEffect(() => {
    if (!roomCode || !connectMatchId || !session.playerId || p2pReady) {
      return;
    }
    navigate(
      buildConnectUrl({
        room: roomCode,
        matchId: connectMatchId,
        playerId: session.playerId,
        playerName: session.playerName,
        profileId: session.profileId,
      }),
      { replace: true },
    );
  }, [connectMatchId, navigate, p2pReady, roomCode, session.playerId, session.playerName, session.profileId]);

  React.useEffect(() => {
    if (!roomCode || !session.playerId) {
      navigate("/online");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        await refreshRoomAndMatch();
        const image = await fetchFrontonImageDataUrl();
        if (!cancelled) {
          setFrontonImage(image);
          setConnectionState("connected");
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load online match");
          setConnectionState("disconnected");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roomCode, session.playerId, navigate, refreshRoomAndMatch]);

  React.useEffect(() => {
    if (!roomState) {
      return;
    }
    if (!effectiveMatchId || startedRouteMatchIdRef.current === effectiveMatchId || gameStartedRef.current) {
      return;
    }
    gameStartedRef.current = true;
    let cancelled = false;

    const orderedPlayers = [...roomState.players].sort((a, b) => a.seat - b.seat);
    const settings = roomState.game_settings;
    const defaultX01Settings = getRoomX01Defaults(roomState);
    const payload = {
      players: orderedPlayers.map((player, index) => ({
        name: player.name || "Player",
        isBot: false,
        profileId: player.id === session.playerId && session.profileId ? session.profileId : undefined,
        x01Settings: getRoomPlayerX01Settings(roomState, index, player.seat),
      })),
      startScore: defaultX01Settings.startScore,
      inMode: defaultX01Settings.inMode,
      outMode: defaultX01Settings.outMode,
      startingPlayer: settings?.startingPlayer ?? 0,
      legsPerSet: settings?.match?.legs ?? 3,
      setsToWin: settings?.match?.sets ?? 1,
      freePlay: settings?.match?.freePlay ?? false,
      gameVariant: settings?.x01?.gameVariant ?? "standard",
      lmsTotalLegs: settings?.x01?.lmsTotalLegs ?? 3,
      teams: settings?.x01?.teams ?? [],
      analyticsSource: "online_p2p",
      localInputPlayerIndex: orderedPlayers.findIndex((player) => player.id === session.playerId),
    };

    (async () => {
      try {
        if (cancelled) {
          return;
        }
        await apiStopGame("x01").catch(() => undefined);
        if (cancelled) {
          return;
        }
        const state = await apiStartGame<X01State>("x01", payload);
        if (cancelled) {
          return;
        }
        setX01State(state);
        await postJson("/api/detection/reset").catch(() => undefined);
        if (cancelled) {
          return;
        }
        setDartCount(0);
        setDetectionState("no_movement");
        setFrontonImage(await fetchFrontonImageDataUrl());
        startedRouteMatchIdRef.current = effectiveMatchId;
      } catch (err) {
        const existing = await refreshLocalState();
        if (!existing) {
          setError(err instanceof Error ? err.message : "Failed to start local online match");
        }
      } finally {
        gameStartedRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roomState, effectiveMatchId, refreshLocalState, session.playerId, session.profileId]);

  const handleExitMatch = React.useCallback(async () => {
    await apiStopGame("x01").catch(() => undefined);
    navigate("/online");
  }, [navigate]);

  useGameStateSync({
    enabled: Boolean(roomState),
    refresh: refreshLocalState,
    pollMs: 0,
    onStatus: ({ dartCount: nextDartCount, detectionState: nextDetectionState }) => {
      if (typeof nextDartCount === "number") {
        setDartCount(nextDartCount);
      }
      if (typeof nextDetectionState === "string") {
        setDetectionState(nextDetectionState);
      }
    },
    onEvent: (data) => {
      if (data.event === "x01_state_updated" && data.state) {
        const nextState = data.state as X01State;
        setX01State(nextState);
        void syncOnlineTurnOwner(nextState);
      }
      if (
        data.event === "dart_detected" ||
        data.event === "dart_score" ||
        data.event === "dart_score_unavailable" ||
        data.event === "darts_removed"
      ) {
        void fetchFrontonImageDataUrl().then((image) => {
          setFrontonImage(image);
        });
      }
      if (data.event === "dart_detected") {
        const detectedDartIndex = Math.max(1, Math.min(3, Number(data.dart_count ?? 0)));
        void syncOnlineFrontonSnapshot(detectedDartIndex);
        scheduleLocalStateCatchup();
      }
      return false;
    },
  });

  const orderedRoomPlayers = React.useMemo(
    () => (roomState ? [...roomState.players].sort((a, b) => a.seat - b.seat) : []),
    [roomState],
  );
  const playerConfigs = React.useMemo<PlayerConfig[]>(
    () =>
      orderedRoomPlayers.map((player, index) => {
        const x01Settings = getRoomPlayerX01Settings(roomState, index, player.seat);
        return {
          name: player.name || "Player",
          isBot: false,
          profileId: player.id === session.playerId && session.profileId ? session.profileId : undefined,
          x01Settings,
        };
      }),
    [orderedRoomPlayers, roomState, session.playerId, session.profileId],
  );

  const finishToStats = React.useCallback(
    async (summary: X01State) => {
      if (hasNavigatedToStatsRef.current) {
        return;
      }
      hasNavigatedToStatsRef.current = true;
      const statsPlayers =
        playerConfigs.length > 0
          ? playerConfigs
          : (summary.players ?? []).map((player, index) => {
              const x01Settings = getRoomPlayerX01Settings(roomState, index, orderedRoomPlayers[index]?.seat);
              return {
                name: player.name || `Player ${index + 1}`,
                isBot: false,
                profileId: index === onlinePlayerIndex && session.profileId ? session.profileId : undefined,
                x01Settings,
              };
            });
      await apiStopGame("x01").catch(() => undefined);
      navigate("/x01/stats", {
        state: {
          summary,
          players: statsPlayers,
        },
      });
    },
    [navigate, onlinePlayerIndex, orderedRoomPlayers, playerConfigs, roomState, session.profileId],
  );

  React.useEffect(() => {
    onlinePlayerIndexRef.current = onlinePlayerIndex;
  }, [onlinePlayerIndex]);

  React.useEffect(() => {
    orderedRoomPlayersRef.current = orderedRoomPlayers;
  }, [orderedRoomPlayers]);

  React.useEffect(() => {
    finishToStatsRef.current = finishToStats;
  }, [finishToStats]);

  React.useEffect(() => {
    startingScoreRef.current = getRoomX01Defaults(roomState).startScore;
  }, [roomState]);

  React.useEffect(() => {
    const next: Record<string, OnlinePlayerX01Settings> = {};
    orderedRoomPlayers.forEach((player, index) => {
      next[player.id] = getRoomPlayerX01Settings(roomState, index, player.seat);
    });
    playerX01SettingsByIdRef.current = next;
  }, [orderedRoomPlayers, roomState]);

  React.useEffect(() => {
    localCurrentPlayerIndexRef.current = x01State?.currentPlayer ?? null;
    localTurnHasDartsRef.current = Boolean((x01State?.currentTurn?.darts ?? []).some((dart) => dart !== null));
  }, [x01State?.currentPlayer, x01State?.currentTurn?.darts]);

  const syncLocalTurnToLiveOwner = React.useCallback(
    async (currentPlayerId: string | null, turnIndex?: number | null) => {
      if (
        !currentPlayerId ||
        currentPlayerId !== session.playerId
      ) {
        return;
      }
      const expectedLocalIndex = onlinePlayerIndexRef.current;
      if (expectedLocalIndex === null) {
        return;
      }
      const resetKey = `${currentPlayerId}:${turnIndex ?? "unknown"}`;
      if (lastDetectorResetOwnerKeyRef.current !== resetKey) {
        lastDetectorResetOwnerKeyRef.current = resetKey;
        await postJson("/api/detection/reset").catch(() => undefined);
        setDartCount(0);
        setDetectionState("no_movement");
      }
      if (forceTurnSyncInFlightRef.current || remoteTurnApplyInFlightRef.current) {
        return;
      }
      if (localCurrentPlayerIndexRef.current === expectedLocalIndex) {
        return;
      }

      forceTurnSyncInFlightRef.current = true;
      try {
        const state = await refreshLocalState();
        if (state) {
          setX01State(state);
        }
      } catch {
        setError("Failed to sync local turn");
      } finally {
        forceTurnSyncInFlightRef.current = false;
      }
    },
    [refreshLocalState, session.playerId],
  );

  React.useEffect(() => {
    syncLocalTurnToLiveOwnerRef.current = syncLocalTurnToLiveOwner;
  }, [syncLocalTurnToLiveOwner]);

  const syncMirroredPlayersFromState = React.useCallback((state: X01State, orderedPlayers: OnlineRoomState["players"]) => {
    if (!Array.isArray(state.players) || orderedPlayers.length === 0) {
      return;
    }
    setMirroredPlayers((previous) => {
      const next = { ...previous };
      state.players.forEach((playerState, index) => {
        const playerId = orderedPlayers[index]?.id;
        if (!playerId) {
          return;
        }
        next[playerId] = {
          score: playerState.score,
          totalScored: playerState.totalScored,
          dartsThrown: playerState.dartsThrown,
          average: playerState.average,
          legsWon: playerState.legsWon,
          setsWon: playerState.setsWon,
        };
      });
      return next;
    });
  }, []);

  const recordRemoteLiveDart = React.useCallback(
    async (message: Extract<OnlineRtcLiveMessage, { type: "dart_score" }>) => {
      const orderedPlayers = orderedRoomPlayersRef.current;
      const remotePlayerIndex = orderedPlayers.findIndex((player) => player.id === message.playerId);
      if (remotePlayerIndex < 0) {
        return;
      }
      try {
        const state = await apiRecordRemoteDart<X01State>("x01", {
          playerIndex: remotePlayerIndex,
          dartIndex: message.dartIndex,
          dart: message.dart,
        });
        localCurrentPlayerIndexRef.current = state.currentPlayer ?? null;
        localTurnHasDartsRef.current = Boolean((state.currentTurn?.darts ?? []).some((dart) => dart !== null));
        setX01State(state);
        const syncedCurrentPlayerId =
          state.currentPlayer !== null && state.currentPlayer !== undefined
            ? orderedPlayers[state.currentPlayer]?.id ?? message.playerId
            : message.playerId;
        setLiveCurrentPlayerId(syncedCurrentPlayerId ?? null);
        syncMirroredPlayersFromState(state, orderedPlayers);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to record remote dart");
      }
    },
    [syncMirroredPlayersFromState],
  );

  React.useEffect(() => {
    recordRemoteDartRef.current = recordRemoteLiveDart;
  }, [recordRemoteLiveDart]);

  const applyRemoteCommittedTurn = React.useCallback(
    async (message: Extract<OnlineRtcLiveMessage, { type: "turn_commit" }>) => {
      const turnKey = `${message.playerId}:${message.turnIndex}:${message.players
        .map((player) => `${player.playerId}:${player.score}:${player.legsWon}:${player.setsWon}`)
        .join("|")}`;
      if (lastAppliedRemoteTurnRef.current === turnKey) {
        return;
      }
      const orderedPlayers = orderedRoomPlayersRef.current;
      const remotePlayerIndex = orderedPlayers.findIndex((player) => player.id === message.playerId);
      if (remotePlayerIndex < 0) {
        return;
      }
      remoteTurnApplyInFlightRef.current = true;
      try {
        const state = await apiCommitRemoteTurn<X01State>("x01", {
          playerIndex: remotePlayerIndex,
          darts: message.darts,
        });
        lastAppliedRemoteTurnRef.current = turnKey;
        localCurrentPlayerIndexRef.current = state.currentPlayer ?? null;
        localTurnHasDartsRef.current = Boolean((state.currentTurn?.darts ?? []).some((dart) => dart !== null));
        setX01State(state);
        const syncedCurrentPlayerId =
          state.currentPlayer !== null && state.currentPlayer !== undefined
            ? orderedPlayers[state.currentPlayer]?.id ?? message.currentPlayerId
            : message.currentPlayerId;
        setLiveCurrentPlayerId(syncedCurrentPlayerId ?? null);
        syncMirroredPlayersFromState(state, orderedPlayers);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to apply remote turn");
      } finally {
        remoteTurnApplyInFlightRef.current = false;
      }
    },
    [session.playerId, syncMirroredPlayersFromState],
  );

  React.useEffect(() => {
    applyRemoteCommittedTurnRef.current = applyRemoteCommittedTurn;
  }, [applyRemoteCommittedTurn]);

  const scheduleLocalStateCatchup = React.useCallback(() => {
    if (onlinePlayerIndexRef.current === null || localCurrentPlayerIndexRef.current !== onlinePlayerIndexRef.current) {
      return;
    }

    localCatchupTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    localCatchupTimersRef.current = [280, 650].map((delayMs) =>
      window.setTimeout(() => {
        void refreshLocalState();
      }, delayMs),
    );
  }, [refreshLocalState]);

  React.useEffect(() => {
    return () => {
      localCatchupTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      localCatchupTimersRef.current = [];
      Object.values(peerDeliveryTimeoutsRef.current).forEach((timeoutId) => window.clearTimeout(timeoutId));
      peerDeliveryTimeoutsRef.current = {};
      pendingPeerMessagesRef.current = {};
      receivedPeerMessageIdsRef.current.clear();
    };
  }, []);

  const rtcRemotePlayerId = React.useMemo(() => {
    if (orderedRoomPlayers.length < 2) {
      return null;
    }
    return orderedRoomPlayers.find((player) => player.id !== session.playerId)?.id ?? null;
  }, [orderedRoomPlayers, session.playerId]);

  const liveCurrentPlayerIndex = React.useMemo(() => {
    if (!liveCurrentPlayerId || orderedRoomPlayers.length === 0) {
      return null;
    }
    const index = orderedRoomPlayers.findIndex((player) => player.id === liveCurrentPlayerId);
    return index >= 0 ? index : null;
  }, [liveCurrentPlayerId, orderedRoomPlayers]);

  const activeLivePlayerId = React.useMemo(() => {
    if (liveCurrentPlayerId) {
      return liveCurrentPlayerId;
    }
    return liveRemoteTurn?.playerId ?? null;
  }, [liveCurrentPlayerId, liveRemoteTurn?.playerId]);

  const activeLivePlayerIndex = React.useMemo(() => {
    if (!activeLivePlayerId || orderedRoomPlayers.length === 0) {
      return null;
    }
    const index = orderedRoomPlayers.findIndex((player) => player.id === activeLivePlayerId);
    return index >= 0 ? index : null;
  }, [activeLivePlayerId, orderedRoomPlayers]);

  const storeOnlineBoardReplayFrame = React.useCallback(
    (
      playerId: string,
      turnIndex: number,
      dartIndex: number,
      imageDataUrl: string | null,
      scoreValue?: number,
    ) => {
      if (!playerId || !imageDataUrl) {
        return;
      }
      const safeDartIndex = Math.max(0, Math.min(3, Math.trunc(Number(dartIndex) || 0)));
      const key = `${playerId}:${turnIndex}`;
      const existing = onlineBoardReplayFramesRef.current[key] ?? [];
      const label = safeDartIndex === 0 ? "Ready" : `Dart ${safeDartIndex}`;
      const nextFrame: OnlineBoardReplayFrame = {
        dartIndex: safeDartIndex,
        imageDataUrl,
        label,
        scoreValue,
      };
      const nextFrames = existing.filter((frame) => frame.dartIndex !== safeDartIndex);
      nextFrames.push(nextFrame);
      nextFrames.sort((a, b) => a.dartIndex - b.dartIndex);
      onlineBoardReplayFramesRef.current[key] = nextFrames.slice(-4);
    },
    [],
  );

  const startOnlineBoardReplay = React.useCallback(
    (params: {
      playerId: string;
      turnIndex: number;
      appliedScores: number[];
      checkout?: boolean;
      force?: boolean;
    }) => {
      const totalScore = params.appliedScores.reduce((sum, value) => sum + (Number(value) || 0), 0);
      const checkout = Boolean(params.checkout);
      if (!params.force && !checkout && totalScore < ONLINE_BOARD_REPLAY_MIN_SCORE) {
        return;
      }

      const key = `${params.playerId}:${params.turnIndex}`;
      const frames = onlineBoardReplayFramesRef.current[key] ?? [];
      if (frames.length === 0 || lastStartedOnlineBoardReplayKeyRef.current === key) {
        return;
      }

      const playerName =
        orderedRoomPlayersRef.current.find((player) => player.id === params.playerId)?.name ||
        (params.playerId === session.playerId ? session.playerName : "Opponent");
      lastStartedOnlineBoardReplayKeyRef.current = key;
      setOnlineBoardReplay({
        key,
        playerId: params.playerId,
        playerName,
        turnIndex: params.turnIndex,
        totalScore,
        checkout,
        frames,
      });
      setOnlineBoardReplayIndex(0);
    },
    [session.playerId, session.playerName],
  );

  React.useEffect(() => {
    if (!onlineBoardReplay) {
      return;
    }
    const isLastFrame = onlineBoardReplayIndex >= onlineBoardReplay.frames.length - 1;
    const currentFrame = onlineBoardReplay.frames[Math.min(onlineBoardReplayIndex, onlineBoardReplay.frames.length - 1)];
    const delay =
      currentFrame?.dartIndex === 0 ? ONLINE_BOARD_REPLAY_INTRO_MS : ONLINE_BOARD_REPLAY_DART_MS;
    const timer = window.setTimeout(() => {
      if (isLastFrame) {
        setOnlineBoardReplay(null);
        setOnlineBoardReplayIndex(0);
        return;
      }
      setOnlineBoardReplayIndex((previous) => Math.min(previous + 1, onlineBoardReplay.frames.length - 1));
    }, isLastFrame ? delay + 1800 : delay);
    return () => window.clearTimeout(timer);
  }, [onlineBoardReplay, onlineBoardReplayIndex]);

  const handleLiveRtcMessage = React.useCallback(
    (message: OnlineRtcLiveMessage) => {
      if (message.playerId === session.playerId) {
        return;
      }

      if (message.type === "peer_ping") {
        rtcConnectionRef.current?.send({
          type: "peer_pong",
          playerId: session.playerId,
          sentAt: message.sentAt,
          receivedAt: Date.now(),
        });
        setLastPeerReceived("peer_ping -> peer_pong");
        return;
      }

      if (message.type === "peer_pong") {
        setLastPeerReceived("peer_pong");
        return;
      }

      if (message.type === "message_ack") {
        const timeoutId = peerDeliveryTimeoutsRef.current[message.messageId];
        if (timeoutId) {
          window.clearTimeout(timeoutId);
          delete peerDeliveryTimeoutsRef.current[message.messageId];
        }
        const ackLabel = `${message.receivedType} confirmed`;
        setPeerDeliveries((previous) => {
          const existing = previous[message.messageId];
          return {
            ...previous,
            [message.messageId]: {
              id: message.messageId,
              label: existing?.label ?? message.receivedType,
              state: "confirmed",
              sentAt: existing?.sentAt ?? Date.now(),
              attempts: existing?.attempts ?? 1,
              maxAttempts: existing?.maxAttempts ?? 1,
              confirmedAt: message.receivedAt,
            },
          };
        });
        delete pendingPeerMessagesRef.current[message.messageId];
        setLastPeerConfirmed(ackLabel);
        setLastPeerReceived(ackLabel);
        return;
      }

      const incomingMessageId = getPeerMessageId(message);
      if (incomingMessageId && shouldConfirmPeerMessage(message)) {
        rtcConnectionRef.current?.send({
          type: "message_ack",
          playerId: session.playerId,
          messageId: incomingMessageId,
          receivedType: message.type,
          receivedAt: Date.now(),
        });
        if (receivedPeerMessageIdsRef.current.has(incomingMessageId)) {
          setLastPeerReceived(`${describeLiveMessage(message)} duplicate confirmed`);
          return;
        }
        receivedPeerMessageIdsRef.current.add(incomingMessageId);
      }

      setLastPeerReceived(describeLiveMessage(message));

      if (message.type === "turn_owner") {
        setLiveCurrentPlayerId(message.currentPlayerId);
        setLiveRemoteTurn((previous) =>
          previous && previous.playerId === message.currentPlayerId ? previous : null,
        );
        setLiveRemoteSnapshot(null);
        void syncLocalTurnToLiveOwnerRef.current?.(message.currentPlayerId, message.turnIndex);
        return;
      }

      if (message.type === "match_complete") {
        const summary = message.summary as unknown as X01State;
        setX01State(summary);
        setMirroredMatch(summary.match ?? null);
        void finishToStatsRef.current?.(summary);
        return;
      }

      if (message.type === "fronton_snapshot") {
        const previousTurnIndex = lastRemoteTurnIndexByPlayerRef.current[message.playerId];
        if (previousTurnIndex !== undefined && message.turnIndex < previousTurnIndex) {
          remoteDartKeysRef.current.clear();
        }
        lastRemoteTurnIndexByPlayerRef.current[message.playerId] = message.turnIndex;
        setLiveCurrentPlayerId(message.playerId);
        if (message.imageDataUrl) {
          setLiveRemoteSnapshot(message.imageDataUrl);
        }
        storeOnlineBoardReplayFrame(
          message.playerId,
          message.turnIndex,
          message.dartIndex,
          message.imageDataUrl,
        );
        setLiveRemoteTurn((previous) => {
          if (previous && previous.playerId === message.playerId && previous.turnIndex === message.turnIndex) {
            return {
              ...previous,
              remaining: message.remaining,
            };
          }
          return {
            playerId: message.playerId,
            turnIndex: message.turnIndex,
            darts: [null, null, null],
            appliedScores: [0, 0, 0],
            remaining: message.remaining,
          };
        });
        return;
      }

      if (message.type === "turn_commit") {
        const previousTurnIndex = lastRemoteTurnIndexByPlayerRef.current[message.playerId];
        if (previousTurnIndex !== undefined && message.turnIndex < previousTurnIndex) {
          remoteDartKeysRef.current.clear();
        }
        lastRemoteTurnIndexByPlayerRef.current[message.playerId] = message.turnIndex;
        setLiveCurrentPlayerId(message.currentPlayerId);
        setMirroredPlayers((previous) => {
          const next = { ...previous };
          message.players.forEach((playerState) => {
            next[playerState.playerId] = {
              score: playerState.score,
              totalScored: playerState.totalScored,
              dartsThrown: playerState.dartsThrown,
              average: playerState.average,
              legsWon: playerState.legsWon,
              setsWon: playerState.setsWon,
            };
          });
          return next;
        });
        setMirroredMatch({
          currentSet: message.currentSet,
          currentLeg: message.currentLeg,
          legWinner: message.legWinner,
          setWinner: message.setWinner,
          matchWinner: message.matchWinner,
        });
        startOnlineBoardReplay({
          playerId: message.playerId,
          turnIndex: message.turnIndex,
          appliedScores: message.appliedScores ?? [],
          checkout: message.legWinner !== null || message.matchWinner !== null,
        });
        remoteTurnMutationQueueRef.current = remoteTurnMutationQueueRef.current
          .catch(() => undefined)
          .then(async () => {
            await applyRemoteCommittedTurnRef.current?.(message);
          });
        setLiveRemoteTurn(null);
        return;
      }

      if (message.type === "dart_score") {
        const previousTurnIndex = lastRemoteTurnIndexByPlayerRef.current[message.playerId];
        if (previousTurnIndex !== undefined && message.turnIndex < previousTurnIndex) {
          remoteDartKeysRef.current.clear();
        }
        lastRemoteTurnIndexByPlayerRef.current[message.playerId] = message.turnIndex;
        setLiveCurrentPlayerId(message.playerId);
        if (message.imageDataUrl) {
          setLiveRemoteSnapshot(message.imageDataUrl);
        }
        storeOnlineBoardReplayFrame(
          message.playerId,
          message.turnIndex,
          message.dartIndex,
          message.imageDataUrl,
          message.appliedScore,
        );
        const remoteDartKey = `${message.playerId}:${message.turnIndex}:${message.dartIndex}:${message.remaining}:${message.appliedScore}`;
        if (!remoteDartKeysRef.current.has(remoteDartKey)) {
          remoteDartKeysRef.current.add(remoteDartKey);
          setMirroredPlayers((previous) => {
            const configuredStartScore = playerX01SettingsByIdRef.current[message.playerId]?.startScore ?? startingScoreRef.current;
            const existing = previous[message.playerId] ?? {
              score: configuredStartScore,
              totalScored: 0,
              dartsThrown: 0,
              average: 0,
              legsWon: 0,
              setsWon: 0,
            };
            const totalScored = existing.totalScored + message.appliedScore;
            const dartsThrown = existing.dartsThrown + 1;
            return {
              ...previous,
              [message.playerId]: {
                ...existing,
                score: message.remaining,
                totalScored,
                dartsThrown,
                average: dartsThrown > 0 ? (totalScored / dartsThrown) * 3 : 0,
              },
            };
          });
          remoteTurnMutationQueueRef.current = remoteTurnMutationQueueRef.current
            .catch(() => undefined)
            .then(async () => {
              await recordRemoteDartRef.current?.(message);
            });
        }
        setLiveRemoteTurn((previous) => {
          const base =
            previous && previous.playerId === message.playerId && previous.turnIndex === message.turnIndex
              ? previous
              : {
                  playerId: message.playerId,
                  turnIndex: message.turnIndex,
                  darts: [null, null, null] as (DartScore | null)[],
                  appliedScores: [0, 0, 0],
                  remaining: message.remaining,
                };
          const nextDarts = [...base.darts];
          const nextAppliedScores = [...base.appliedScores];
          const dartIndex = Math.max(0, Math.min(2, message.dartIndex - 1));
          nextDarts[dartIndex] = message.dart as DartScore | null;
          nextAppliedScores[dartIndex] = message.appliedScore;
          return {
            ...base,
            darts: nextDarts,
            appliedScores: nextAppliedScores,
            remaining: message.remaining,
          };
        });
      }
    },
    [session.playerId, startOnlineBoardReplay, storeOnlineBoardReplayFrame],
  );

  const schedulePeerMessageRetry = React.useCallback((messageId: string) => {
    const pending = pendingPeerMessagesRef.current[messageId];
    if (!pending) {
      return;
    }
    if (peerDeliveryTimeoutsRef.current[messageId]) {
      window.clearTimeout(peerDeliveryTimeoutsRef.current[messageId]);
    }
    peerDeliveryTimeoutsRef.current[messageId] = window.setTimeout(() => {
      const nextPending = pendingPeerMessagesRef.current[messageId];
      if (!nextPending) {
        return;
      }
      if (nextPending.attempts >= nextPending.maxAttempts) {
        delete pendingPeerMessagesRef.current[messageId];
        delete peerDeliveryTimeoutsRef.current[messageId];
        setPeerDeliveries((previous) => {
          const existing = previous[messageId];
          if (!existing || existing.state === "confirmed") {
            return previous;
          }
          return {
            ...previous,
            [messageId]: {
              ...existing,
              state: "failed",
            },
          };
        });
        setLastPeerConfirmed(`${nextPending.label} not confirmed`);
        return;
      }

      const sent = rtcConnectionRef.current?.send(nextPending.message) ?? false;
      nextPending.attempts += 1;
      pendingPeerMessagesRef.current[messageId] = nextPending;
      setPeerDeliveries((previous) => {
        const existing = previous[messageId];
        if (!existing || existing.state === "confirmed") {
          return previous;
        }
        return {
          ...previous,
          [messageId]: {
            ...existing,
            attempts: nextPending.attempts,
          },
        };
      });
      setLastPeerSent(
        `${nextPending.label}${sent ? ` (retry ${nextPending.attempts}/${nextPending.maxAttempts})` : " (retry failed)"}`,
      );
      schedulePeerMessageRetry(messageId);
    }, pending.retryMs);
  }, []);

  const sendLiveRtcMessage = React.useCallback(
    (message: OnlineRtcLiveMessage): boolean => {
      const retryPolicy = getPeerMessageRetryPolicy(message);
      const needsConfirmation = retryPolicy !== null;
      const messageId = needsConfirmation ? getPeerMessageId(message) ?? createPeerMessageId(message.type) : null;
      const outgoing =
        needsConfirmation && messageId
          ? ({
              ...message,
              messageId,
            } as OnlineRtcLiveMessage)
          : message;
      const label = describeLiveMessage(outgoing);
      const sent = rtcConnectionRef.current?.send(outgoing) ?? false;

      if (needsConfirmation && messageId && retryPolicy && sent) {
        pendingPeerMessagesRef.current[messageId] = {
          message: outgoing,
          label,
          attempts: 1,
          maxAttempts: retryPolicy.maxAttempts,
          retryMs: retryPolicy.retryMs,
        };
        setPeerDeliveries((previous) => ({
          ...previous,
          [messageId]: {
            id: messageId,
            label,
            state: "pending",
            sentAt: Date.now(),
            attempts: 1,
            maxAttempts: retryPolicy.maxAttempts,
          },
        }));
        schedulePeerMessageRetry(messageId);
      }

      setLastPeerSent(`${label}${sent ? (needsConfirmation ? " (awaiting confirm)" : "") : " (failed)"}`);
      return sent;
    },
    [schedulePeerMessageRetry],
  );

  React.useEffect(() => {
    if (!effectiveMatchId || !session.playerId || !rtcRemotePlayerId || onlinePlayerIndex === null) {
      rtcConnectionRef.current?.close();
      rtcConnectionRef.current = null;
      setRtcState("disconnected");
      setRtcStats(null);
      return;
    }

    const rtc = createOnlineRtcConnection({
      matchId: effectiveMatchId,
      localPlayerId: session.playerId,
      remotePlayerId: rtcRemotePlayerId,
      initiator: onlinePlayerIndex === 0,
      onMessage: handleLiveRtcMessage,
      onStateChange: setRtcState,
      onStats: setRtcStats,
      onDiagnostic: (message) => {
        setRtcDiagnostics((previous) => [`${new Date().toLocaleTimeString()} ${message}`, ...previous].slice(0, 12));
      },
    });

    rtcConnectionRef.current = rtc;
    setRtcState("connecting");
    setRtcStats(null);
    setRtcDiagnostics([]);

    return () => {
      rtc.close();
      if (rtcConnectionRef.current === rtc) {
        rtcConnectionRef.current = null;
      }
      setRtcState("disconnected");
      setRtcStats(null);
    };
  }, [
    effectiveMatchId,
    session.playerId,
    rtcRemotePlayerId,
    onlinePlayerIndex,
    handleLiveRtcMessage,
  ]);

  const syncOnlineFrontonSnapshot = React.useCallback(
    async (dartIndex: number) => {
      if (
        !session.playerId ||
        !effectiveMatchId ||
        onlinePlayerIndex === null ||
        x01State?.currentPlayer !== onlinePlayerIndex ||
        !x01State?.currentTurn
      ) {
        return;
      }

      const currentTurnIndex = x01State.currentTurn.turnIndex ?? (x01State.lastTurn?.turnIndex ?? 0) + 1;
      const safeDartIndex = Math.max(0, Math.min(3, Math.trunc(dartIndex)));
      const remaining = Number.isFinite(x01State.currentTurn.remaining)
        ? Number(x01State.currentTurn.remaining)
        : roomState?.starting_score ?? 501;
      const snapshotKey = `${currentTurnIndex}:${safeDartIndex}:${remaining}`;

      if (lastLiveSnapshotKeyRef.current === snapshotKey || liveSnapshotInFlightRef.current) {
        return;
      }

      liveSnapshotInFlightRef.current = true;
      try {
        const latestFrontonImage = await fetchFrontonImageDataUrl();
        if (latestFrontonImage) {
          setFrontonImage(latestFrontonImage);
        }
        storeOnlineBoardReplayFrame(
          session.playerId,
          currentTurnIndex,
          safeDartIndex,
          latestFrontonImage,
        );
        const sent = sendLiveRtcMessage({
          type: "fronton_snapshot",
          playerId: session.playerId,
          turnIndex: currentTurnIndex,
          dartIndex: safeDartIndex,
          remaining,
          imageDataUrl: latestFrontonImage ?? null,
        });
        if (sent) {
          lastLiveSnapshotKeyRef.current = snapshotKey;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to sync live fronton snapshot");
      } finally {
        liveSnapshotInFlightRef.current = false;
      }
    },
    [
      session.playerId,
      effectiveMatchId,
      onlinePlayerIndex,
      x01State?.currentPlayer,
      x01State?.currentTurn,
      x01State?.lastTurn?.turnIndex,
      roomState?.starting_score,
      sendLiveRtcMessage,
    ],
  );

  const syncOnlineTurnOwner = React.useCallback(
    async (state: X01State) => {
      if (onlinePlayerIndex === null || orderedRoomPlayers.length === 0) {
        return;
      }

      const committedTurn = state.lastCommittedTurn ?? state.lastTurn;
      if (!committedTurn || committedTurn.playerIndex !== onlinePlayerIndex) {
        return;
      }
      if (committedTurn.turnIndex < lastCommittedTurnRef.current || committedTurn.turnIndex < lastSetTurnRef.current) {
        lastCommittedTurnRef.current = -1;
        lastSetTurnRef.current = -1;
      }
      if (lastSetTurnRef.current >= committedTurn.turnIndex) {
        return;
      }

      const desiredIndex = state.currentPlayer ?? ((onlinePlayerIndex + 1) % orderedRoomPlayers.length);
      const desiredPlayer = orderedRoomPlayers[desiredIndex];
      if (!desiredPlayer?.id) {
        return;
      }
      const committedPlayer = state.players?.[onlinePlayerIndex];
      if (committedPlayer && lastCommittedTurnRef.current < committedTurn.turnIndex) {
        const committedAppliedScores = [...(committedTurn.appliedScores ?? [0, 0, 0])];
        const commitSent = sendLiveRtcMessage({
          type: "turn_commit",
          playerId: session.playerId,
          turnIndex: committedTurn.turnIndex,
          currentPlayerId: desiredPlayer.id,
          currentSet: state.match?.currentSet ?? 1,
          currentLeg: state.match?.currentLeg ?? 1,
          legWinner: state.match?.legWinner ?? null,
          setWinner: state.match?.setWinner ?? null,
          matchWinner: state.match?.matchWinner ?? state.matchWinner ?? null,
          remaining: committedPlayer.score,
          totalScored: committedPlayer.totalScored,
          dartsThrown: committedPlayer.dartsThrown,
          average: committedPlayer.average,
          legsWon: committedPlayer.legsWon,
          setsWon: committedPlayer.setsWon,
          players: state.players.map((player, index) => ({
            playerId: orderedRoomPlayers[index]?.id ?? `player-${index}`,
            score: player.score,
            totalScored: player.totalScored,
            dartsThrown: player.dartsThrown,
            average: player.average,
            legsWon: player.legsWon,
            setsWon: player.setsWon,
          })),
          darts: (committedTurn.darts ?? []).map((dart) =>
            dart
              ? {
                  score: dart.score,
                  multiplier: dart.multiplier,
                  segment: dart.segment,
                  zone: dart.zone,
                  confidence: dart.confidence,
                }
              : null,
          ),
          appliedScores: committedAppliedScores,
        });
        startOnlineBoardReplay({
          playerId: session.playerId,
          turnIndex: committedTurn.turnIndex,
          appliedScores: committedAppliedScores,
          checkout:
            (state.match?.legWinner !== null && state.match?.legWinner !== undefined) ||
            (state.match?.matchWinner !== null && state.match?.matchWinner !== undefined) ||
            (state.matchWinner !== null && state.matchWinner !== undefined),
        });
        if (commitSent) {
          lastCommittedTurnRef.current = committedTurn.turnIndex;
        }
      }
      setLiveCurrentPlayerId(desiredPlayer.id);
      const ownerSent = sendLiveRtcMessage({
        type: "turn_owner",
        playerId: session.playerId,
        currentPlayerId: desiredPlayer.id,
        turnIndex: committedTurn.turnIndex,
      });
      if (ownerSent) {
        lastSetTurnRef.current = committedTurn.turnIndex;
      }
    },
    [onlinePlayerIndex, orderedRoomPlayers, sendLiveRtcMessage, session.playerId, startOnlineBoardReplay],
  );

  React.useEffect(() => {
    if (
      rtcState !== "connected" ||
      !session.playerId ||
      !effectiveMatchId ||
      onlinePlayerIndex === null ||
      x01State?.currentPlayer !== onlinePlayerIndex ||
      !x01State?.currentTurn
    ) {
      return;
    }

    const currentTurnIndex = x01State.currentTurn.turnIndex ?? (x01State.lastTurn?.turnIndex ?? 0) + 1;
    const darts = x01State.currentTurn.darts ?? [];
    const appliedScores = x01State.currentTurn.appliedScores ?? [];
    const dartsThrown = darts.filter((dart) => dart !== null).length;

    if (lastSubmittedDartsRef.current.turnIndex !== currentTurnIndex) {
      lastSubmittedDartsRef.current = { turnIndex: currentTurnIndex, submittedCount: 0 };
      lastSubmittedScoresRef.current = { turnIndex: currentTurnIndex, scores: [] };
    }

    const remaining = Number.isFinite(x01State.currentTurn.remaining) ? x01State.currentTurn.remaining : roomState?.starting_score ?? 501;

    void (async () => {
      const previousScores = lastSubmittedScoresRef.current.scores;
      for (let index = 0; index < dartsThrown; index += 1) {
        const score = Number.isFinite(appliedScores[index]) ? Number(appliedScores[index]) : 0;
        const shouldSend =
          index >= lastSubmittedDartsRef.current.submittedCount || previousScores[index] !== score;
        if (!shouldSend) {
          continue;
        }

        const dart = darts[index];
        const latestFrontonImage = await fetchFrontonImageDataUrl();
        if (latestFrontonImage) {
          setFrontonImage(latestFrontonImage);
        }
        storeOnlineBoardReplayFrame(
          session.playerId,
          currentTurnIndex,
          index + 1,
          latestFrontonImage,
          score,
        );
        const sent = sendLiveRtcMessage({
          type: "dart_score",
          playerId: session.playerId,
          turnIndex: currentTurnIndex,
          dartIndex: index + 1,
          remaining,
          appliedScore: score,
          dart: (dart
            ? {
                score: dart.score,
                multiplier: dart.multiplier,
                segment: dart.segment,
                zone: dart.zone,
                confidence: dart.confidence,
              }
            : null) as RtcDartScore | null,
          imageDataUrl: latestFrontonImage ?? null,
        });
        try {
          if (!sent) {
            throw new Error("Peer connection is not ready");
          }
          lastSubmittedDartsRef.current.submittedCount = Math.max(lastSubmittedDartsRef.current.submittedCount, index + 1);
          previousScores[index] = score;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to sync dart online");
          break;
        }
      }
    })();
  }, [
    rtcState,
    x01State?.currentTurn,
    x01State?.currentPlayer,
    x01State?.lastTurn?.turnIndex,
    effectiveMatchId,
    onlinePlayerIndex,
    roomState?.starting_score,
    session.playerId,
    sendLiveRtcMessage,
    storeOnlineBoardReplayFrame,
  ]);

  React.useEffect(() => {
    if (
      rtcState !== "connected" ||
      !session.playerId ||
      !effectiveMatchId ||
      onlinePlayerIndex === null ||
      x01State?.currentPlayer !== onlinePlayerIndex ||
      !x01State?.currentTurn
    ) {
      return;
    }

    const currentTurnIndex = x01State.currentTurn.turnIndex ?? (x01State.lastTurn?.turnIndex ?? 0) + 1;
    if (lastUploadedSnapshotTurnRef.current === currentTurnIndex) {
      return;
    }

    const darts = x01State.currentTurn.darts ?? [];
    if (darts.some((dart) => dart !== null)) {
      return;
    }

    const remaining = Number.isFinite(x01State.currentTurn.remaining)
      ? Number(x01State.currentTurn.remaining)
      : roomState?.starting_score ?? 501;

    void (async () => {
      const latestFrontonImage = await fetchFrontonImageDataUrl();
      if (latestFrontonImage) {
        setFrontonImage(latestFrontonImage);
      }
      storeOnlineBoardReplayFrame(session.playerId, currentTurnIndex, 0, latestFrontonImage);
      const sent = sendLiveRtcMessage({
        type: "fronton_snapshot",
        playerId: session.playerId,
        turnIndex: currentTurnIndex,
        dartIndex: 0,
        remaining,
        imageDataUrl: latestFrontonImage ?? null,
      });

      try {
        if (!sent) {
          return;
        }
        lastUploadedSnapshotTurnRef.current = currentTurnIndex;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to sync turn-start board snapshot");
      }
    })();
  }, [
    rtcState,
    x01State?.currentTurn,
    x01State?.currentPlayer,
    x01State?.lastTurn?.turnIndex,
    effectiveMatchId,
    onlinePlayerIndex,
    roomState?.starting_score,
    session.playerId,
    sendLiveRtcMessage,
    storeOnlineBoardReplayFrame,
  ]);

  React.useEffect(() => {
    if (!x01State) {
      return;
    }
    void syncOnlineTurnOwner(x01State);
  }, [x01State, syncOnlineTurnOwner]);

  React.useEffect(() => {
    const matchWinner = x01State?.matchWinner ?? x01State?.match?.matchWinner;
    if (matchWinner === null || matchWinner === undefined || !x01State) {
      return;
    }
    if (dartCount !== 0) {
      return;
    }

    if (!matchCompleteSentRef.current) {
      sendLiveRtcMessage({
        type: "match_complete",
        playerId: session.playerId,
        summary: x01State as unknown as Record<string, unknown>,
      });
      matchCompleteSentRef.current = true;
    }

    void finishToStats(x01State);
  }, [dartCount, finishToStats, sendLiveRtcMessage, session.playerId, x01State]);

  const fallbackPlayers = React.useMemo(() => (roomState ? buildFallbackPlayers(roomState) : []), [roomState]);
  const localCurrentPlayerIndex = x01State?.currentPlayer ?? null;

  React.useEffect(() => {
    if (!roomState || orderedRoomPlayers.length === 0) {
      return;
    }
    setMirroredPlayers((previous) => {
      const next = { ...previous };
      orderedRoomPlayers.forEach((player, index) => {
        const fallback = fallbackPlayers[index];
        if (!fallback) {
          return;
        }
        const existing = next[player.id];
        next[player.id] = {
          score: existing?.score ?? fallback.score,
          totalScored: existing?.totalScored ?? fallback.totalScored,
          dartsThrown: existing?.dartsThrown ?? fallback.dartsThrown,
          average: existing?.average ?? fallback.average,
          legsWon: existing?.legsWon ?? fallback.legsWon,
          setsWon: existing?.setsWon ?? fallback.setsWon,
        };
      });
      return next;
    });
  }, [roomState, orderedRoomPlayers, fallbackPlayers]);

  React.useEffect(() => {
    remoteDartKeysRef.current.clear();
    lastCommittedTurnRef.current = -1;
    lastSetTurnRef.current = -1;
    matchCompleteSentRef.current = false;
    hasNavigatedToStatsRef.current = false;
    lastAppliedRemoteTurnRef.current = "";
    lastRemoteTurnIndexByPlayerRef.current = {};
    remoteTurnMutationQueueRef.current = Promise.resolve();
    setMirroredMatch(null);
  }, [onlineMatch?.id]);

  React.useEffect(() => {
    if (!x01State || onlinePlayerIndex === null || !session.playerId) {
      return;
    }
    const peerSaysLocalTurn = liveCurrentPlayerId
      ? liveCurrentPlayerId === session.playerId
      : x01State.currentPlayer === onlinePlayerIndex;
    if (!Array.isArray(x01State.players) || x01State.players.length === 0) {
      return;
    }
    setMirroredPlayers((previous) => {
      const next = { ...previous };
      orderedRoomPlayers.forEach((player, index) => {
        const backendState = x01State.players?.[index];
        if (!backendState) {
          return;
        }
        const isSyncedLocalPlayer = player.id === session.playerId;
        next[player.id] = {
          score:
            isSyncedLocalPlayer && peerSaysLocalTurn && x01State.currentTurn
              ? x01State.currentTurn.remaining
              : backendState.score,
          totalScored: backendState.totalScored,
          dartsThrown: backendState.dartsThrown,
          average: backendState.average,
          legsWon: backendState.legsWon,
          setsWon: backendState.setsWon,
        };
      });
      return next;
    });
  }, [rtcState, x01State, onlinePlayerIndex, orderedRoomPlayers, session.playerId, liveCurrentPlayerId]);

  const getDisplayName = React.useCallback(
    (index: number) =>
      orderedRoomPlayers[index]?.name ||
      x01State?.players?.[index]?.name ||
      fallbackPlayers[index]?.name ||
      `Player ${index + 1}`,
    [orderedRoomPlayers, x01State?.players, fallbackPlayers],
  );

  const localTurnHasDarts = React.useMemo(
    () => Boolean((x01State?.currentTurn?.darts ?? []).some((dart) => dart !== null)),
    [x01State?.currentTurn?.darts],
  );

  const shouldPreferLiveTurnOwner = React.useMemo(() => {
    if (rtcState !== "connected" || activeLivePlayerIndex === null) {
      return false;
    }
    if (localCurrentPlayerIndex === null) {
      return true;
    }
    if (activeLivePlayerIndex === localCurrentPlayerIndex) {
      return false;
    }
    const livePlayerId = orderedRoomPlayers[activeLivePlayerIndex]?.id ?? null;
    if (activeLivePlayerId && livePlayerId === activeLivePlayerId) {
      return true;
    }
    return !localTurnHasDarts;
  }, [
    rtcState,
    activeLivePlayerIndex,
    localCurrentPlayerIndex,
    orderedRoomPlayers,
    activeLivePlayerId,
    localTurnHasDarts,
  ]);

  const resolvedCurrentPlayerIndex = React.useMemo(
    () =>
      shouldPreferLiveTurnOwner
        ? activeLivePlayerIndex ?? localCurrentPlayerIndex ?? 0
        : localCurrentPlayerIndex ?? activeLivePlayerIndex ?? 0,
    [shouldPreferLiveTurnOwner, activeLivePlayerIndex, localCurrentPlayerIndex],
  );

  const displayPlayers = React.useMemo(() => {
    if (!roomState || orderedRoomPlayers.length === 0) {
      return x01State?.players ?? [];
    }
    const basePlayers = x01State?.players?.length ? x01State.players : fallbackPlayers;
    return orderedRoomPlayers.map((player, index) => {
      const base = basePlayers[index] ?? fallbackPlayers[index];
      const isBackendActive = index === localCurrentPlayerIndex && x01State?.currentTurn;
      const isLiveRemoteTurnPlayer =
        player.id !== session.playerId && liveCurrentPlayerId === player.id && liveRemoteTurn?.playerId === player.id;
      const liveRemaining = isLiveRemoteTurnPlayer ? liveRemoteTurn?.remaining ?? null : null;

      return {
        ...base,
        name: player.name,
        score: isBackendActive ? x01State?.currentTurn.remaining ?? base.score : liveRemaining ?? base.score,
        totalScored: base.totalScored,
        dartsThrown: base.dartsThrown,
        average: base.average,
        legsWon: base.legsWon,
        setsWon: base.setsWon,
      };
    });
  }, [
    roomState,
    orderedRoomPlayers,
    x01State,
    fallbackPlayers,
    session.playerId,
    localCurrentPlayerIndex,
    liveRemoteTurn,
    liveCurrentPlayerId,
  ]);

  const displayCurrentTurn = React.useMemo<X01TurnState | null>(() => {
    const remoteCurrentPlayerIndex = resolvedCurrentPlayerIndex;
    if (remoteCurrentPlayerIndex === null || remoteCurrentPlayerIndex === onlinePlayerIndex) {
      return x01State?.currentTurn ?? null;
    }

    const remotePlayer = orderedRoomPlayers[remoteCurrentPlayerIndex];
    const backendRemotePlayer =
      (x01State?.players?.length ? x01State.players[remoteCurrentPlayerIndex] : fallbackPlayers[remoteCurrentPlayerIndex]) ??
      null;
    if (!remotePlayer) {
      return x01State?.currentTurn ?? null;
    }
    if (x01State?.currentPlayer === remoteCurrentPlayerIndex && x01State.currentTurn) {
      return x01State.currentTurn;
    }
    if (liveRemoteTurn && liveRemoteTurn.playerId === remotePlayer.id) {
      const scored = liveRemoteTurn.appliedScores.reduce((sum, value) => sum + value, 0);
      const dartsUsed = liveRemoteTurn.darts.filter((dart) => dart !== null).length;
      return {
        darts: liveRemoteTurn.darts,
        appliedScores: liveRemoteTurn.appliedScores,
        scored,
        remaining: liveRemoteTurn.remaining,
        bust: false,
        finished: false,
        dartsUsed,
        scoreBefore: liveRemoteTurn.remaining + scored,
        hasInBefore: true,
        hasInAfter: true,
        turnIndex: liveRemoteTurn.turnIndex,
      };
    }

    return {
      darts: [null, null, null],
      appliedScores: [0, 0, 0],
      scored: 0,
      remaining: backendRemotePlayer?.score ?? roomState?.starting_score ?? 501,
      bust: false,
      finished: false,
      dartsUsed: 0,
      scoreBefore: backendRemotePlayer?.score ?? roomState?.starting_score ?? 501,
      hasInBefore: true,
      hasInAfter: true,
      turnIndex: 0,
    };
  }, [
    x01State?.currentTurn,
    x01State?.players,
    resolvedCurrentPlayerIndex,
    onlinePlayerIndex,
    liveRemoteTurn,
    orderedRoomPlayers,
    fallbackPlayers,
    roomState?.starting_score,
  ]);

  const currentPlayerIndex = React.useMemo(
    () => resolvedCurrentPlayerIndex,
    [resolvedCurrentPlayerIndex],
  );
  const currentPlayer = orderedRoomPlayers[currentPlayerIndex] || orderedRoomPlayers[0] || null;
  const currentTurn = displayCurrentTurn;
  const currentDartScores = currentTurn?.darts ?? [null, null, null];
  const appliedScores = currentTurn?.appliedScores ?? [0, 0, 0];
  const effectiveMatch = x01State?.match ?? mirroredMatch ?? null;
  const winnerIndex = x01State?.winner ?? effectiveMatch?.legWinner ?? null;
  const setWinnerIndex = effectiveMatch?.setWinner ?? null;
  const matchWinnerIndex = x01State?.matchWinner ?? effectiveMatch?.matchWinner ?? null;
  const isLocalTurn =
    currentPlayer?.id === session.playerId &&
    onlinePlayerIndex !== null &&
    x01State?.currentPlayer === onlinePlayerIndex;
  const currentConfiguredSettings = React.useMemo(
    () =>
      currentPlayerIndex >= 0 && currentPlayerIndex < orderedRoomPlayers.length
        ? getRoomPlayerX01Settings(roomState, currentPlayerIndex, orderedRoomPlayers[currentPlayerIndex]?.seat)
        : getRoomX01Defaults(roomState),
    [currentPlayerIndex, orderedRoomPlayers, roomState],
  );
  const currentPlayerState = React.useMemo(
    () =>
      currentPlayerIndex >= 0
        ? (x01State?.players?.[currentPlayerIndex] ?? fallbackPlayers[currentPlayerIndex] ?? null)
        : null,
    [currentPlayerIndex, x01State?.players, fallbackPlayers],
  );
  const currentInMode = currentPlayerState?.inMode ?? currentConfiguredSettings.inMode;
  const currentOutMode = currentPlayerState?.outMode ?? currentConfiguredSettings.outMode;
  const requiresIn = React.useMemo(() => {
    if (!currentTurn || !currentPlayerState) {
      return false;
    }
    if ((currentPlayerState.inMode || currentInMode) === "straight") {
      return false;
    }
    return !currentPlayerState.hasIn;
  }, [currentInMode, currentPlayerState, currentTurn]);
  const checkoutSuggestions = React.useMemo<(string | null)[]>(() => {
    if (!currentTurn || requiresIn || winnerIndex !== null || !currentPlayerState) {
      return [null, null, null];
    }
    const turnState = currentTurn;
    const turnDarts = turnState.darts ?? [];
    const turnApplied = turnState.appliedScores ?? [];
    const scoreBefore = Number(turnState.scoreBefore ?? currentPlayerState.score ?? 0);
    const appliedTotal = turnApplied.reduce((sum, value) => sum + Number(value || 0), 0);
    const remaining = Math.max(0, scoreBefore - appliedTotal);
    const dartsThrown = turnDarts.filter((dart) => dart !== null).length;
    return computeCheckoutSuggestionsLocal(remaining, dartsThrown, currentOutMode);
  }, [currentOutMode, currentPlayerState, currentTurn, requiresIn, winnerIndex]);

  const activeRemoteSnapshot = React.useMemo(() => {
    if (!currentPlayer || currentPlayer.id === session.playerId) {
      return null;
    }
    return liveRemoteSnapshot && liveCurrentPlayerId === currentPlayer.id ? liveRemoteSnapshot : null;
  }, [currentPlayer, liveRemoteSnapshot, liveCurrentPlayerId, session.playerId]);

  const boardImage = currentPlayer?.id === session.playerId ? frontonImage : activeRemoteSnapshot;
  const canEditLocalTurn = React.useMemo(
    () => Boolean(isLocalTurn && x01State?.turnInputArmed && winnerIndex === null && matchWinnerIndex === null),
    [isLocalTurn, matchWinnerIndex, winnerIndex, x01State?.turnInputArmed],
  );
  const currentOnlineBoardReplayFrame = onlineBoardReplay
    ? onlineBoardReplay.frames[Math.min(onlineBoardReplayIndex, onlineBoardReplay.frames.length - 1)]
    : null;

  const handleOpenCorrection = React.useCallback(
    (index: number) => {
      if (!canEditLocalTurn) {
        return;
      }
      setSelectedDartIndex(index);
      setIsCorrectionModalOpen(true);
    },
    [canEditLocalTurn],
  );

  const handleSaveCorrection = React.useCallback(
    async (correction: DartCorrectionPayload) => {
      try {
        await correctScore(correction);
        await refreshLocalState();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to correct score");
      }
    },
    [refreshLocalState],
  );

  const handleAddDart = React.useCallback(
    async (correction: DartCorrectionPayload) => {
      try {
        await addDart(correction);
        await refreshLocalState();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to add dart");
      }
    },
    [refreshLocalState],
  );

  const handleDeleteScore = React.useCallback(
    async (dartIndex: number) => {
      try {
        await deleteCorrectionImages(dartIndex);
        await refreshLocalState();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to refresh correction data");
      }
    },
    [refreshLocalState],
  );

  const setsToWin = x01State?.settings?.setsToWin ?? roomState?.game_settings?.match?.sets ?? 1;
  const legsPerSet = x01State?.settings?.legsPerSet ?? roomState?.game_settings?.match?.legs ?? 1;
  const headerMeta = effectiveMatch
    ? `Set ${effectiveMatch.currentSet} | Leg ${effectiveMatch.currentLeg}${setsToWin > 1 ? ` | Best of ${setsToWin * 2 - 1} Sets` : ""}${legsPerSet > 1 ? ` | Best of ${legsPerSet * 2 - 1} Legs` : ""} / Room ${roomCode}`
    : onlineMatch
      ? `Leg ${onlineMatch.leg_number} / Room ${roomCode}`
      : `Room ${roomCode}`;
  const connectionTone =
    connectionState === "connected" ? "text-emerald-400" : connectionState === "connecting" ? "text-amber-300" : "text-red-300";
  const liveTransportLabel =
    rtcState === "connected" ? "Direct Peer" : rtcState === "connecting" ? "Connecting Peer" : "Peer Required";
  const pendingPeerDeliveryCount = React.useMemo(
    () => Object.values(peerDeliveries).filter((delivery) => delivery.state === "pending").length,
    [peerDeliveries],
  );
  const failedPeerDeliveryCount = React.useMemo(
    () => Object.values(peerDeliveries).filter((delivery) => delivery.state === "failed").length,
    [peerDeliveries],
  );
  const latestPeerDelivery = React.useMemo(() => {
    const deliveries = Object.values(peerDeliveries);
    if (deliveries.length === 0) {
      return null;
    }
    return deliveries.sort((a, b) => (b.confirmedAt ?? b.sentAt) - (a.confirmedAt ?? a.sentAt))[0];
  }, [peerDeliveries]);
  const dartBoxes = React.useMemo<GameDartBox[]>(
    () =>
      [0, 1, 2].map((index) => {
        const dart = currentDartScores[index];
        const applied = appliedScores[index] ?? 0;
        const suggestion = checkoutSuggestions[index];
        const showSuggestion = !dart && Boolean(suggestion) && winnerIndex === null;
        return {
          key: `online-dart-${index}`,
          title: `Dart ${index + 1}`,
          main: showSuggestion ? (
            <span className="text-blue-400/60">[{suggestion}]</span>
          ) : !dart && canEditLocalTurn ? (
            <span className="text-zinc-500">No dart - Click to add</span>
          ) : (
            formatDartLabel(dart)
          ),
          sub: dart
            ? canEditLocalTurn
              ? `Counted ${formatAppliedScore(applied)} - Click to edit`
              : `Counted ${formatAppliedScore(applied)}`
            : showSuggestion
              ? canEditLocalTurn
                ? "Checkout guide - Click to add"
                : "Checkout guide"
              : canEditLocalTurn
                ? "Add a missed dart or correct this slot"
                : `Counted ${formatAppliedScore(applied)}`,
          filled: Boolean(dart),
          onClick: canEditLocalTurn ? () => handleOpenCorrection(index) : undefined,
        };
      }),
    [appliedScores, canEditLocalTurn, checkoutSuggestions, currentDartScores, handleOpenCorrection, winnerIndex],
  );

  return (
    <div className="min-h-screen bg-black text-white">
      <GameHeader
        title={
          <>
            Online <span className="text-red-500">X01</span>
          </>
        }
        subtitle="Live Scores / Fronton Board / Turn Sync"
        meta={<span className={connectionTone}>{headerMeta}</span>}
        right={
          <>
            <GameControlButton
              label="Refresh"
              icon={<RotateCcw className="h-4 w-4" />}
              onClick={() => {
                void refreshRoomAndMatch();
                void refreshLocalState();
              }}
            />
            <GameControlButton
              label="Exit Match"
              icon={<WifiOff className="h-4 w-4" />}
              variant="danger"
              onClick={() => {
                void handleExitMatch();
              }}
            />
          </>
        }
      />

      <main className="px-6 md:px-10 py-6 space-y-6">
        <section className="grid grid-cols-1 xl:grid-cols-[1.16fr_0.84fr] items-start gap-6">
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {displayPlayers.map((player, index) => {
                const isActive = index === currentPlayerIndex;
                const isWinner = matchWinnerIndex === index || winnerIndex === index;
                const stats: GamePlayerCardStat[] = [
                  { label: "Score", value: player.score },
                  { label: "Avg", value: player.average.toFixed(2), align: "right" },
                  { label: "Darts", value: player.dartsThrown },
                  { label: "Legs / Sets", value: `${player.legsWon}/${player.setsWon}`, align: "right" },
                ];

                return (
                  <GamePlayerCard
                    key={orderedRoomPlayers[index]?.id || player.name || index}
                    variant={isWinner ? "winner" : isActive ? "active" : "default"}
                    detectionState={isActive && orderedRoomPlayers[index]?.id === session.playerId ? detectionState : undefined}
                    statusLabel={
                      orderedRoomPlayers[index]?.id === session.playerId
                        ? isActive
                          ? "Your Turn"
                          : "You"
                        : isActive
                          ? "Opponent Throwing"
                          : "Opponent"
                    }
                    title={player.name}
                    subtitle={orderedRoomPlayers[index]?.id === session.playerId ? "Local board active on your turn" : "Synced from online throw feed"}
                    main={
                      <div className="text-6xl font-black tracking-tight tabular-nums text-white">
                        {player.score}
                      </div>
                    }
                    headerRight={orderedRoomPlayers[index]?.id === session.playerId ? <Users className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    stats={stats}
                  />
                );
              })}
            </div>

            <section className="rounded-3xl border border-white/10 bg-zinc-950/80 p-5 shadow-[0_25px_80px_rgba(0,0,0,0.5)]">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <div>
                  <div className="text-xs uppercase tracking-[0.3em] text-zinc-500">Current Visit</div>
                  <div className="mt-1 text-xl font-semibold text-white">
                    {currentPlayer ? currentPlayer.name : "Waiting for Player"}
                  </div>
                </div>
                <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/35 px-3 py-1.5 text-sm text-zinc-300">
                  <Radio className="h-4 w-4 text-red-400" />
                  {currentPlayer?.id === session.playerId ? "Your board live" : "Watching opponent fronton"}
                </div>
              </div>

              {requiresIn ? (
                <div className="mb-4 rounded-2xl border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-100">
                  {currentPlayer?.id === session.playerId ? "You need" : `${currentPlayer?.name || "This player"} needs`} a{" "}
                  {currentInMode === "double" ? "double" : "double or triple"} to start scoring.
                </div>
              ) : null}

              <GameDartBoxes boxes={dartBoxes} />
            </section>

            <div className="min-h-[108px] space-y-3">
              {matchWinnerIndex !== null ? (
                <div className="rounded-2xl border border-emerald-500/30 bg-emerald-600/10 px-4 py-3 text-sm text-emerald-200 flex items-center justify-between gap-3">
                  <span className="text-base font-semibold">{getDisplayName(matchWinnerIndex)} wins the match!</span>
                  <span className="shrink-0 text-xs uppercase tracking-[0.25em] text-emerald-300">Match Complete</span>
                </div>
              ) : null}
              {setWinnerIndex !== null && matchWinnerIndex === null ? (
                <div className="rounded-2xl border border-blue-500/30 bg-blue-600/10 px-4 py-3 text-sm text-blue-200 flex items-center justify-between gap-3">
                  <span className="text-base font-semibold">
                    {getDisplayName(setWinnerIndex)} wins Set {Math.max(1, (effectiveMatch?.currentSet ?? 1) - 1)}!
                  </span>
                  <span className="shrink-0 text-xs uppercase tracking-[0.25em] text-blue-300">Starting next set...</span>
                </div>
              ) : null}
              {winnerIndex !== null && setWinnerIndex === null && matchWinnerIndex === null ? (
                <div className="rounded-2xl border border-emerald-500/30 bg-emerald-600/10 px-4 py-3 text-sm text-emerald-200 flex items-center justify-between gap-3">
                  <span className="text-base font-semibold">
                    {getDisplayName(winnerIndex)} wins Leg {effectiveMatch?.currentLeg ?? 1}!
                  </span>
                  <span className="shrink-0 text-xs uppercase tracking-[0.25em] text-emerald-300">Starting next leg...</span>
                </div>
              ) : null}
              {error ? (
                <div className="rounded-2xl border border-red-500/30 bg-red-600/10 px-4 py-3 text-sm text-red-200">
                  {error}
                </div>
              ) : null}
              {rtcState !== "connected" ? (
                <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                  Live online play is peer-to-peer only. Wait for <span className="font-semibold">Direct Peer</span> before throwing, or the other PC will not receive live scores.
                </div>
              ) : null}
              <div className="rounded-2xl border border-white/10 bg-zinc-950/70 px-4 py-3 text-xs text-zinc-400">
                <div>Last peer sent: <span className="text-zinc-200">{lastPeerSent}</span></div>
                <div className="mt-1">Last peer received: <span className="text-zinc-200">{lastPeerReceived}</span></div>
                <div className="mt-1">
                  Last peer confirmation:{" "}
                  <span
                    className={
                      latestPeerDelivery?.state === "confirmed"
                        ? "text-emerald-300"
                        : latestPeerDelivery?.state === "failed"
                          ? "text-red-300"
                          : "text-amber-300"
                    }
                  >
                    {latestPeerDelivery
                      ? `${latestPeerDelivery.label} ${
                          latestPeerDelivery.state === "confirmed"
                            ? "confirmed"
                            : latestPeerDelivery.state === "failed"
                              ? "not confirmed"
                              : `retrying ${latestPeerDelivery.attempts}/${latestPeerDelivery.maxAttempts}`
                        }`
                      : lastPeerConfirmed}
                  </span>
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-zinc-950/70 px-4 py-3 text-xs text-zinc-400">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs uppercase tracking-[0.22em] text-zinc-500">Peer Monitor</span>
                  <span
                    className={
                      rtcState === "connected"
                        ? "text-emerald-300"
                        : rtcState === "connecting"
                          ? "text-amber-300"
                          : "text-red-300"
                    }
                  >
                    {rtcStats?.peerConnectionState ?? rtcState} / ICE {rtcStats?.iceConnectionState ?? "--"}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <div className="text-zinc-500">Ping</div>
                    <div className="mt-0.5 text-zinc-200">{rtcStats?.currentRoundTripTimeMs ?? "--"} ms</div>
                  </div>
                  <div>
                    <div className="text-zinc-500">Send / Receive</div>
                    <div className="mt-0.5 text-zinc-200">
                      {formatMonitorRate(rtcStats?.sentKbps ?? null)} / {formatMonitorRate(rtcStats?.receivedKbps ?? null)}
                    </div>
                  </div>
                  <div>
                    <div className="text-zinc-500">Data Buffer</div>
                    <div className={rtcStats && rtcStats.bufferedAmount > 256_000 ? "mt-0.5 text-amber-300" : "mt-0.5 text-zinc-200"}>
                      {formatMonitorBytes(rtcStats?.bufferedAmount ?? 0)}
                    </div>
                  </div>
                  <div>
                    <div className="text-zinc-500">Ack Queue</div>
                    <div className={failedPeerDeliveryCount > 0 ? "mt-0.5 text-red-300" : pendingPeerDeliveryCount > 0 ? "mt-0.5 text-amber-300" : "mt-0.5 text-zinc-200"}>
                      {pendingPeerDeliveryCount} pending / {failedPeerDeliveryCount} failed
                    </div>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
                  <div>
                    <span className="text-zinc-500">Route </span>
                    <span className="text-zinc-200">{summarizeCandidatePair(rtcStats)}</span>
                  </div>
                  <div>
                    <span className="text-zinc-500">Total </span>
                    <span className="text-zinc-200">
                      {formatMonitorBytes(rtcStats?.bytesSent ?? 0)} sent / {formatMonitorBytes(rtcStats?.bytesReceived ?? 0)} received
                    </span>
                  </div>
                </div>
                {rtcDiagnostics.length > 0 ? (
                  <div className="mt-3 max-h-24 overflow-y-auto border-t border-white/10 pt-2 font-mono text-[11px] leading-5 text-zinc-500">
                    {rtcDiagnostics.slice(0, 6).map((item, index) => (
                      <div key={`${item}-${index}`}>{item}</div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="space-y-4 xl:w-full xl:max-w-[680px] xl:justify-self-end">
          <section className="rounded-[2rem] border border-white/10 bg-zinc-950/85 overflow-hidden shadow-[0_25px_80px_rgba(0,0,0,0.55)]">
            <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-white/10">
              <div>
                <div className="text-xs uppercase tracking-[0.28em] text-zinc-500">Fronton View</div>
                <div className="mt-1 text-lg font-semibold text-white">
                  {currentPlayer?.id === session.playerId ? "Local Board Snapshot" : "Opponent Board Snapshot"}
                </div>
              </div>
              <div className="text-right text-sm text-zinc-400">
                <div className="inline-flex items-center gap-2">
                  {connectionState === "connected" ? <Wifi className="h-4 w-4 text-emerald-400" /> : <WifiOff className="h-4 w-4 text-zinc-500" />}
                  {connectionState === "connected" ? "Synced" : connectionState}
                </div>
                <div className="mt-1 text-xs uppercase tracking-[0.22em] text-zinc-500">{liveTransportLabel}</div>
                <div className="mt-1 text-xs uppercase tracking-[0.22em] text-zinc-500">Darts on board {dartCount}</div>
              </div>
            </div>

            <div className="p-5 flex justify-center">
              <div
                className={`relative w-full max-w-[560px] 2xl:max-w-[600px] aspect-square min-h-[360px] rounded-[1.7rem] border overflow-hidden bg-black/70 ${
                  currentPlayer?.id === session.playerId && detectionState !== "no_movement"
                    ? "border-red-500/40 shadow-[0_0_45px_rgba(239,68,68,0.15)]"
                    : "border-white/10"
                }`}
              >
                {boardImage ? (
                  <img
                    src={boardImage}
                    alt="Fronton dartboard snapshot"
                    className="absolute inset-0 w-full h-full object-contain bg-black"
                  />
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6">
                    <div className="text-xs uppercase tracking-[0.3em] text-zinc-500">No Fronton Snapshot Yet</div>
                    <div className="mt-3 text-lg text-zinc-300 max-w-md">
                      The board image will appear here once the current player has thrown and the fronton snapshot has been synced.
                    </div>
                  </div>
                )}

                <div className="absolute left-4 bottom-4 rounded-2xl border border-white/10 bg-black/70 px-4 py-3 backdrop-blur">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Now Throwing</div>
                  <div className="mt-1 text-lg font-semibold text-white">{currentPlayer?.name || "Waiting..."}</div>
                  <div className="mt-1 text-sm text-zinc-400">
                    {currentPlayer?.id === session.playerId ? "Local camera + scoring live" : `${liveTransportLabel} board sync`}
                  </div>
                </div>
              </div>
            </div>
          </section>
          </div>
        </section>
      </main>

      {onlineBoardReplay && currentOnlineBoardReplayFrame ? (
        <div className="fixed bottom-5 right-5 z-40 w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-cyan-400/30 bg-zinc-950/95 shadow-[0_20px_70px_rgba(0,0,0,0.65)] backdrop-blur">
          <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
            <div>
              <div className="text-[11px] uppercase tracking-[0.24em] text-cyan-300">Board Replay</div>
              <div className="mt-0.5 text-sm font-semibold text-white">
                {onlineBoardReplay.checkout ? "Checkout" : "Score"} {onlineBoardReplay.totalScore}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setOnlineBoardReplay(null);
                setOnlineBoardReplayIndex(0);
              }}
              className="rounded-lg border border-white/10 px-2 py-1 text-xs font-semibold text-zinc-300 hover:border-white/25 hover:text-white"
            >
              Close
            </button>
          </div>
          <div className="bg-black">
            <div className="relative aspect-square">
              <img
                src={currentOnlineBoardReplayFrame.imageDataUrl}
                alt="Online board replay"
                className="absolute inset-0 h-full w-full object-contain"
              />
              <div className="absolute left-3 top-3 rounded-xl border border-white/10 bg-black/70 px-3 py-2">
                <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                  {onlineBoardReplay.playerName}
                </div>
                <div className="mt-0.5 text-sm font-semibold text-white">
                  {currentOnlineBoardReplayFrame.label}
                  {typeof currentOnlineBoardReplayFrame.scoreValue === "number"
                    ? ` - ${currentOnlineBoardReplayFrame.scoreValue}`
                    : ""}
                </div>
              </div>
              <div className="absolute bottom-3 right-3 rounded-xl border border-white/10 bg-black/70 px-3 py-2 text-xs text-zinc-300">
                {onlineBoardReplayIndex + 1}/{onlineBoardReplay.frames.length}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <ScoreCorrection
        isOpen={isCorrectionModalOpen}
        onClose={() => setIsCorrectionModalOpen(false)}
        dartIndex={selectedDartIndex}
        originalScore={selectedDartIndex >= 0 ? currentDartScores[selectedDartIndex] : null}
        onSaveCorrection={handleSaveCorrection}
        onDeleteImages={handleDeleteScore}
        onAddDart={handleAddDart}
      />
    </div>
  );
}
