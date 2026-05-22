import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { InOutMode, TeamConfig } from "../context/LobbyContext";
import { SUPABASE_ANON_KEY, SUPABASE_FRONTON_BUCKET, SUPABASE_URL } from "./supabaseConfig";

export type OnlineRoomPlayer = {
  id: string;
  name: string;
  ready: boolean;
  is_host: boolean;
  seat: number;
};

export type OnlineGameSettings = {
  selectedGame: "x01";
  match: {
    sets: number;
    legs: number;
    freePlay?: boolean;
    bullOff?: boolean;
  };
  startingPlayer?: number;
  x01: {
    startScore: number;
    inMode: InOutMode;
    outMode: InOutMode;
    handicapEnabled?: boolean;
    gameVariant?: "standard" | "last_man_standing" | "team_play";
    lmsTotalLegs?: number;
    teams?: TeamConfig[];
  };
  playerSettings?: Array<
    | {
        startScore: number;
        inMode: InOutMode;
        outMode: InOutMode;
      }
    | null
  >;
  hostProfile?: {
    name: string;
    average: number | null;
    legs: number;
    window: number;
  };
};

export type OnlineRoomState = {
  id: string;
  code: string;
  host_name: string;
  game: string;
  region: string;
  max_players: number;
  status: string;
  created_at: string;
  starting_score: number;
  game_settings?: OnlineGameSettings | null;
  players: OnlineRoomPlayer[];
  player_count: number;
};

export type OnlineRoomSummary = {
  id: string;
  code: string;
  host_name: string;
  game: string;
  startScore: number;
  sets: number;
  legs: number;
  inMode: InOutMode;
  outMode: InOutMode;
  player_count: number;
  max_players: number;
  region: string;
  pingMs?: number;
  hostProfile?: OnlineGameSettings["hostProfile"] | null;
};

export type OnlineMatchState = {
  id: string;
  lobby_id: string;
  status: string;
  current_turn_player_id: string | null;
  leg_number: number;
};

export type OnlineThrow = {
  id: string;
  match_id: string;
  player_id: string;
  turn_index: number;
  dart_index?: number;
  visit_score: number;
  score?: number;
  darts_used: number;
  remaining: number;
  created_at: string;
  segment?: string | null;
  multiplier?: number | null;
  zone?: string | null;
  fronton_image_url?: string | null;
  fronton_image_path?: string | null;
};

type ThrowSelectMode = "rich" | "basic";

const ONLINE_SESSION_KEY = "md_online_session";
const ONLINE_PLAYER_NAME_KEY = "md_online_player_name";
export const OPEN_LOBBY_TIMEOUT_MS = 10 * 60 * 1000;
const BASIC_THROW_SELECT =
  "id, match_id, player_id, turn_index, dart_index, visit_score, score, darts_used, remaining, created_at, bed, multiplier";
const RICH_THROW_SELECT = `${BASIC_THROW_SELECT}, fronton_image_url, fronton_image_path`;

let supabaseClient: SupabaseClient | null = null;
let throwSelectMode: ThrowSelectMode = "rich";
let throwWriteMode: ThrowSelectMode = "rich";

export type StoredOnlineSession = {
  room: string;
  playerId: string;
  playerName: string;
  profileId?: string;
};

export function getOnlinePlayerName(): string {
  const existing = localStorage.getItem(ONLINE_PLAYER_NAME_KEY);
  if (existing && existing.trim()) {
    return existing.trim();
  }
  const generated = `Player-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  localStorage.setItem(ONLINE_PLAYER_NAME_KEY, generated);
  return generated;
}

export function getStoredSession(): StoredOnlineSession | null {
  try {
    const raw = localStorage.getItem(ONLINE_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.room && parsed?.playerId && parsed?.playerName) {
      return {
        room: String(parsed.room),
        playerId: String(parsed.playerId),
        playerName: String(parsed.playerName),
        profileId:
          typeof parsed.profileId === "string" && parsed.profileId.trim().length > 0
            ? parsed.profileId.trim()
            : undefined,
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function setStoredSession(room: string, playerId: string, playerName: string, profileId?: string): void {
  localStorage.setItem(
    ONLINE_SESSION_KEY,
    JSON.stringify({
      room,
      playerId,
      playerName,
      profileId: profileId?.trim() || undefined,
    }),
  );
}

export function clearStoredSession(): void {
  localStorage.removeItem(ONLINE_SESSION_KEY);
}

function getClient(): SupabaseClient {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.");
  }
  if (!supabaseClient) {
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return supabaseClient;
}

export function getSupabaseClient(): SupabaseClient {
  return getClient();
}

function randomRoomCode(len = 6): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function formatGameLabel(gameMode: string, startingScore: number): string {
  if (gameMode.toLowerCase() === "x01") {
    return `X01 ${startingScore}`;
  }
  return gameMode;
}

function lowerMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const message = "message" in error ? String((error as { message?: string }).message || "") : "";
  return message.toLowerCase();
}

function openLobbyCutoffIso(now = Date.now()): string {
  return new Date(now - OPEN_LOBBY_TIMEOUT_MS).toISOString();
}

async function deleteLobbies(lobbyIds: string[]): Promise<void> {
  if (lobbyIds.length === 0) {
    return;
  }
  const supabase = getClient();
  const uniqueIds = Array.from(new Set(lobbyIds.filter(Boolean)));
  if (uniqueIds.length === 0) {
    return;
  }
  await supabase.from("lobbies").delete().in("id", uniqueIds);
}

async function pruneExpiredOpenLobbies(): Promise<void> {
  const supabase = getClient();
  const cutoff = openLobbyCutoffIso();
  const { data: rooms } = await supabase
    .from("lobbies")
    .select("id, max_players")
    .in("status", ["waiting", "ready"])
    .lt("created_at", cutoff)
    .limit(100);

  if (!rooms?.length) {
    return;
  }

  const expiredIds: string[] = [];
  await Promise.all(
    rooms.map(async (room) => {
      const { count } = await supabase
        .from("lobby_players")
        .select("player_id", { count: "exact", head: true })
        .eq("lobby_id", room.id);
      if (Number(count || 0) < Number(room.max_players ?? 2)) {
        expiredIds.push(String(room.id || ""));
      }
    }),
  );

  await deleteLobbies(expiredIds);
}

async function closePlayerOpenLobbies(playerId: string): Promise<void> {
  const supabase = getClient();
  const { data: hostedRooms } = await supabase
    .from("lobbies")
    .select("id")
    .eq("host_player_id", playerId)
    .in("status", ["waiting", "ready"]);

  await deleteLobbies((hostedRooms || []).map((room) => String(room.id || "")));

  const { data: seats } = await supabase.from("lobby_players").select("lobby_id").eq("player_id", playerId);
  const lobbyIds = Array.from(new Set((seats || []).map((seat) => String(seat.lobby_id || "")).filter(Boolean)));
  if (lobbyIds.length === 0) {
    return;
  }

  const { data: openRooms } = await supabase.from("lobbies").select("id").in("id", lobbyIds).in("status", ["waiting", "ready"]);
  const openLobbyIds = (openRooms || []).map((room) => String(room.id || "")).filter(Boolean);
  if (openLobbyIds.length > 0) {
    await supabase.from("lobby_players").delete().eq("player_id", playerId).in("lobby_id", openLobbyIds);
  }
}

function isMissingColumnError(error: unknown): boolean {
  const message = lowerMessage(error);
  return (
    message.includes("column") ||
    message.includes("schema cache") ||
    message.includes("could not find") ||
    message.includes("does not exist")
  );
}

function mapThrowRow(row: Record<string, unknown>): OnlineThrow {
  const score = Number(row.score ?? row.visit_score ?? 0);
  const multiplier = row.multiplier === null || row.multiplier === undefined ? null : Number(row.multiplier);
  const segmentValue = row.segment ?? row.bed;
  const segment = segmentValue === undefined ? null : String(segmentValue ?? "");
  const derivedZone =
    score === 0
      ? "miss"
      : segment === "25" && multiplier === 2
        ? "inner_bull"
        : segment === "25" && score === 25
          ? "outer_bull"
          : multiplier === 3
            ? "triple"
            : multiplier === 2
              ? "double"
              : "single";

  return {
    id: String(row.id || ""),
    match_id: String(row.match_id || ""),
    player_id: String(row.player_id || ""),
    turn_index: Number(row.turn_index ?? 0),
    dart_index: row.dart_index === null || row.dart_index === undefined ? undefined : Number(row.dart_index),
    visit_score: Number(row.visit_score ?? row.score ?? 0),
    score,
    darts_used: Number(row.darts_used ?? 0),
    remaining: Number(row.remaining ?? 0),
    created_at: String(row.created_at || ""),
    segment,
    multiplier,
    zone: row.zone === undefined ? derivedZone : String(row.zone ?? ""),
    fronton_image_url: row.fronton_image_url === undefined ? null : String(row.fronton_image_url ?? ""),
    fronton_image_path: row.fronton_image_path === undefined ? null : String(row.fronton_image_path ?? ""),
  };
}

function normalizeThrowDartIndex(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.min(3, Math.trunc(value)));
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, body] = dataUrl.split(",", 2);
  const mimeMatch = header.match(/data:(.*?);base64/);
  const mimeType = mimeMatch?.[1] || "image/jpeg";
  const binary = atob(body || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

async function getRoomStateById(roomId: string): Promise<OnlineRoomState> {
  const supabase = getClient();
  const { data: room, error: roomError } = await supabase
    .from("lobbies")
    .select("id, code, host_player_id, status, game_mode, starting_score, max_players, created_at, game_settings")
    .eq("id", roomId)
    .single();

  if (roomError || !room) {
    throw new Error(roomError?.message || "Room not found");
  }

  const { data: lobbyPlayers, error: lobbyPlayersError } = await supabase
    .from("lobby_players")
    .select("player_id, ready, seat")
    .eq("lobby_id", room.id)
    .order("seat", { ascending: true });

  if (lobbyPlayersError) {
    throw new Error(lobbyPlayersError.message);
  }

  const playerIds = (lobbyPlayers || []).map((player) => String(player.player_id || ""));
  const nameById = new Map<string, string>();
  if (playerIds.length > 0) {
    const { data: players, error: playersError } = await supabase
      .from("players")
      .select("id, display_name")
      .in("id", playerIds);
    if (playersError) {
      throw new Error(playersError.message);
    }
    (players || []).forEach((player) => {
      nameById.set(String(player.id || ""), String(player.display_name || "Player"));
    });
  }

  const hostPlayerId = String(room.host_player_id || "");
  const hostName = nameById.get(hostPlayerId) || "Host";
  const players: OnlineRoomPlayer[] = (lobbyPlayers || []).map((player) => {
    const id = String(player.player_id || "");
    return {
      id,
      name: nameById.get(id) || "Player",
      ready: Boolean(player.ready),
      is_host: id === hostPlayerId,
      seat: Number(player.seat ?? 0),
    };
  });

  return {
    id: String(room.id || ""),
    code: String(room.code || ""),
    host_name: hostName,
    game: formatGameLabel(String(room.game_mode || "x01"), Number(room.starting_score ?? 501)),
    region: "Global",
    max_players: Number(room.max_players ?? 2),
    status: String(room.status || "waiting"),
    created_at: String(room.created_at || new Date().toISOString()),
    starting_score: Number(room.starting_score ?? 501),
    game_settings: (room.game_settings as OnlineGameSettings) ?? null,
    players,
    player_count: players.length,
  };
}

export async function ensureOnlinePlayer(preferredName?: string): Promise<{ playerId: string; playerName: string }> {
  const supabase = getClient();
  let {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const { data, error } = await supabase.auth.signInAnonymously();
    if (error || !data.user) {
      throw new Error(error?.message || "Failed to sign in anonymously");
    }
    user = data.user;
  }

  const preferred = preferredName?.trim();
  if (preferred) {
    localStorage.setItem(ONLINE_PLAYER_NAME_KEY, preferred);
  }
  const playerName = preferred || getOnlinePlayerName();
  const { data: player, error: upsertError } = await supabase
    .from("players")
    .upsert(
      {
        auth_user_id: user.id,
        display_name: playerName,
      },
      { onConflict: "auth_user_id" },
    )
    .select("id, display_name")
    .single();

  if (upsertError || !player) {
    throw new Error(upsertError?.message || "Failed to create/find player");
  }

  const resolvedName = String(player.display_name || playerName);
  if (resolvedName.trim()) {
    localStorage.setItem(ONLINE_PLAYER_NAME_KEY, resolvedName.trim());
  }

  return {
    playerId: String(player.id || ""),
    playerName: resolvedName,
  };
}

export async function getRoomByCode(roomCode: string): Promise<OnlineRoomState> {
  const supabase = getClient();
  const { data: room, error } = await supabase.from("lobbies").select("id").eq("code", roomCode.toUpperCase()).single();
  if (error || !room) {
    throw new Error(error?.message || "Room not found");
  }
  return await getRoomStateById(String(room.id));
}

export async function listOpenLobbies(): Promise<OnlineRoomSummary[]> {
  const supabase = getClient();
  await pruneExpiredOpenLobbies();

  const { data: rooms, error } = await supabase
    .from("lobbies")
    .select("id, code, host_player_id, game_mode, starting_score, max_players, status, created_at, game_settings")
    .in("status", ["waiting", "ready"])
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    throw new Error(error.message);
  }

  const openRooms = (rooms || []).filter((room) => {
    const createdAt = Date.parse(String(room.created_at || ""));
    return !Number.isFinite(createdAt) || Date.now() - createdAt < OPEN_LOBBY_TIMEOUT_MS;
  });
  const newestByHost = new Map<string, (typeof openRooms)[number]>();
  const duplicateRoomIds: string[] = [];
  for (const room of openRooms) {
    const hostId = String(room.host_player_id || room.id || "");
    if (newestByHost.has(hostId)) {
      duplicateRoomIds.push(String(room.id || ""));
      continue;
    }
    newestByHost.set(hostId, room);
  }
  void deleteLobbies(duplicateRoomIds);

  return await Promise.all(
    Array.from(newestByHost.values()).map(async (room) => {
      const [{ count }, { data: host }] = await Promise.all([
        supabase.from("lobby_players").select("player_id", { count: "exact", head: true }).eq("lobby_id", room.id),
        supabase.from("players").select("display_name").eq("id", room.host_player_id).single(),
      ]);
      const settings = (room.game_settings as OnlineGameSettings | null) ?? null;
      const startScore = Number(settings?.x01?.startScore ?? room.starting_score ?? 501);
      const sets = Math.max(1, Number(settings?.match?.sets ?? 1) || 1);
      const legs = Math.max(1, Number(settings?.match?.legs ?? 1) || 1);

      return {
        id: String(room.id || ""),
        code: String(room.code || ""),
        host_name: String(host?.display_name || "Host"),
        game: formatGameLabel(String(room.game_mode || "x01"), startScore),
        startScore,
        sets,
        legs,
        inMode: settings?.x01?.inMode ?? "straight",
        outMode: settings?.x01?.outMode ?? "double",
        player_count: Number(count || 0),
        max_players: Number(room.max_players ?? 2),
        region: "Global",
        hostProfile: settings?.hostProfile ?? null,
      };
    }),
  );
}

export async function createLobby(playerId: string, settings?: OnlineGameSettings | null): Promise<OnlineRoomState> {
  const supabase = getClient();
  await pruneExpiredOpenLobbies();
  await closePlayerOpenLobbies(playerId);

  let insertedRoomId: string | null = null;
  const startScore = settings?.x01?.startScore ?? 501;
  for (let attempt = 0; attempt < 5 && !insertedRoomId; attempt += 1) {
    const code = randomRoomCode(6);
    const payload: Record<string, unknown> = {
      code,
      host_player_id: playerId,
      status: "waiting",
      game_mode: "x01",
      starting_score: startScore,
      best_of_legs: 3,
      max_players: 2,
    };
    if (settings) {
      payload.game_settings = settings;
    }

    const { data: room, error } = await supabase.from("lobbies").insert(payload).select("id").single();
    if (!error && room?.id) {
      insertedRoomId = String(room.id);
      break;
    }

    if (error && settings && lowerMessage(error).includes("game_settings")) {
      const { data: fallbackRoom, error: fallbackError } = await supabase
        .from("lobbies")
        .insert({
          code,
          host_player_id: playerId,
          status: "waiting",
          game_mode: "x01",
          starting_score: startScore,
          best_of_legs: 3,
          max_players: 2,
        })
        .select("id")
        .single();
      if (!fallbackError && fallbackRoom?.id) {
        insertedRoomId = String(fallbackRoom.id);
        break;
      }
    }
  }

  if (!insertedRoomId) {
    throw new Error("Failed to create lobby (check Supabase schema and RLS).");
  }

  const { error: seatError } = await supabase.from("lobby_players").insert({
    lobby_id: insertedRoomId,
    player_id: playerId,
    seat: 1,
    ready: false,
  });
  if (seatError) {
    throw new Error(seatError.message);
  }

  return await getRoomStateById(insertedRoomId);
}

export async function joinLobbyByCode(roomCode: string, playerId: string): Promise<OnlineRoomState> {
  const supabase = getClient();
  const room = await getRoomByCode(roomCode);

  if (!["waiting", "ready"].includes(room.status)) {
    throw new Error("Room is not joinable");
  }

  const existing = room.players.find((player) => player.id === playerId);
  if (!existing) {
    if (room.player_count >= room.max_players) {
      throw new Error("Room is full");
    }
    const usedSeats = new Set(room.players.map((player) => player.seat));
    const seat = usedSeats.has(1) ? 2 : 1;
    const { error } = await supabase.from("lobby_players").insert({
      lobby_id: room.id,
      player_id: playerId,
      seat,
      ready: false,
    });
    if (error) {
      throw new Error(error.message);
    }
  }

  return await getRoomByCode(roomCode);
}

export async function setReady(roomCode: string, playerId: string, ready: boolean): Promise<OnlineRoomState> {
  const supabase = getClient();
  const room = await getRoomByCode(roomCode);
  const { error } = await supabase
    .from("lobby_players")
    .update({ ready })
    .eq("lobby_id", room.id)
    .eq("player_id", playerId);
  if (error) {
    throw new Error(error.message);
  }
  return await getRoomByCode(roomCode);
}

export async function startMatch(roomCode: string, playerId: string): Promise<OnlineRoomState> {
  const supabase = getClient();
  const room = await getRoomByCode(roomCode);
  const host = room.players.find((player) => player.is_host);
  if (!host || host.id !== playerId) {
    throw new Error("Only host can start");
  }
  if (room.player_count < 2) {
    throw new Error("Need 2 players");
  }
  if (!room.players.every((player) => player.ready)) {
    throw new Error("Both players must be ready");
  }

  const { error: lobbyError } = await supabase.from("lobbies").update({ status: "in_game" }).eq("id", room.id);
  if (lobbyError) {
    throw new Error(lobbyError.message);
  }

  const firstPlayer = [...room.players].sort((a, b) => a.seat - b.seat)[room.game_settings?.startingPlayer ?? 0] || host;
  const { error: matchError } = await supabase.from("matches").insert({
    lobby_id: room.id,
    status: "active",
    current_turn_player_id: firstPlayer.id,
    leg_number: 1,
  });
  if (matchError) {
    throw new Error(matchError.message);
  }

  return await getRoomByCode(roomCode);
}

export async function leaveRoom(roomCode: string, playerId: string): Promise<void> {
  const supabase = getClient();
  const room = await getRoomByCode(roomCode);

  await supabase.from("lobby_players").delete().eq("lobby_id", room.id).eq("player_id", playerId);

  const refreshed = await getRoomByCode(roomCode).catch(() => null);
  if (!refreshed || refreshed.player_count === 0) {
    await supabase.from("lobbies").delete().eq("id", room.id);
    return;
  }

  const hostStillPresent = refreshed.players.some((player) => player.is_host);
  if (!hostStillPresent) {
    const newHost = [...refreshed.players].sort((a, b) => a.seat - b.seat)[0];
    if (newHost) {
      await supabase.from("lobbies").update({ host_player_id: newHost.id }).eq("id", room.id);
    }
  }
}

export async function closeLobby(roomCode: string, playerId: string): Promise<void> {
  const supabase = getClient();
  const room = await getRoomByCode(roomCode);
  const host = room.players.find((player) => player.is_host);
  if (!host || host.id !== playerId) {
    throw new Error("Only host can close the lobby");
  }
  await supabase.from("lobbies").delete().eq("id", room.id);
}

export function subscribeToLobby(roomId: string, onChange: () => void): () => void {
  const supabase = getClient();
  const channel = supabase
    .channel(`lobby:${roomId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "lobbies", filter: `id=eq.${roomId}` }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "lobby_players", filter: `lobby_id=eq.${roomId}` }, onChange)
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}

export async function getActiveMatchByLobbyId(lobbyId: string): Promise<OnlineMatchState | null> {
  const supabase = getClient();
  const { data, error } = await supabase
    .from("matches")
    .select("id, lobby_id, status, current_turn_player_id, leg_number")
    .eq("lobby_id", lobbyId)
    .in("status", ["active", "paused"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  if (!data) {
    return null;
  }
  return {
    id: String(data.id || ""),
    lobby_id: String(data.lobby_id || ""),
    status: String(data.status || "active"),
    current_turn_player_id: data.current_turn_player_id ? String(data.current_turn_player_id) : null,
    leg_number: Number(data.leg_number ?? 1),
  };
}

export async function listMatchThrows(matchId: string): Promise<OnlineThrow[]> {
  const supabase = getClient();
  const select = throwSelectMode === "rich" ? RICH_THROW_SELECT : BASIC_THROW_SELECT;
  const { data, error } = await supabase
    .from("throws")
    .select(select)
    .eq("match_id", matchId)
    .order("turn_index", { ascending: true })
    .order("dart_index", { ascending: true })
    .order("created_at", { ascending: true });

  if (error && throwSelectMode === "rich" && isMissingColumnError(error)) {
    throwSelectMode = "basic";
    return await listMatchThrows(matchId);
  }
  if (error) {
    throw new Error(error.message);
  }

  return (((data || []) as unknown[]) as Record<string, unknown>[]).map((row) => mapThrowRow(row));
}

export async function uploadFrontonSnapshot(params: {
  matchId: string;
  playerId: string;
  turnIndex: number;
  dartIndex: number;
  imageDataUrl: string;
}): Promise<{ publicUrl: string | null; path: string | null }> {
  if (!params.imageDataUrl) {
    return { publicUrl: null, path: null };
  }

  const supabase = getClient();
  const blob = dataUrlToBlob(params.imageDataUrl);
  const ext = blob.type.includes("png") ? "png" : "jpg";
  const path = `${params.matchId}/${params.playerId}/turn-${params.turnIndex}-dart-${params.dartIndex}.${ext}`;

  const { error } = await supabase.storage.from(SUPABASE_FRONTON_BUCKET).upload(path, blob, {
    upsert: true,
    contentType: blob.type || "image/jpeg",
    cacheControl: "3600",
  });
  if (error) {
    return { publicUrl: null, path: null };
  }

  const { data } = supabase.storage.from(SUPABASE_FRONTON_BUCKET).getPublicUrl(path);
  return {
    publicUrl: data.publicUrl || null,
    path,
  };
}

export async function submitX01Visit(params: {
  matchId: string;
  playerId: string;
  turnIndex: number;
  dartIndex?: number;
  visitScore: number;
  dartScores?: number[];
  dartsUsed: number;
  remaining: number;
}): Promise<void> {
  const supabase = getClient();
  const safeScore = Number.isFinite(params.visitScore) ? Number(params.visitScore) : 0;
  const safeDartsUsed = Number.isFinite(params.dartsUsed) ? Number(params.dartsUsed) : 0;
  const safeRemaining = Number.isFinite(params.remaining) ? Number(params.remaining) : 0;
  const safeDartIndex = Number.isFinite(params.dartIndex) ? Number(params.dartIndex) : 1;
  const dartIndex = safeDartIndex <= 0 ? 1 : safeDartIndex;
  const dartScores = (params.dartScores || [])
    .map((score) => (Number.isFinite(score) ? Number(score) : 0))
    .filter((score) => Number.isFinite(score));

  const rows =
    dartScores.length > 0
      ? dartScores.map((score, idx) => ({
          match_id: params.matchId,
          player_id: params.playerId,
          turn_index: params.turnIndex,
          dart_index: idx + 1,
          score,
          visit_score: score,
          darts_used: 1,
          remaining: safeRemaining,
        }))
      : [
          {
            match_id: params.matchId,
            player_id: params.playerId,
            turn_index: params.turnIndex,
            dart_index: dartIndex,
            score: safeScore,
            visit_score: safeScore,
            darts_used: safeDartsUsed,
            remaining: safeRemaining,
          },
        ];

  const { error } = await supabase.from("throws").upsert(rows, { onConflict: "match_id,player_id,turn_index,dart_index" });
  if (error) {
    throw new Error(error.message);
  }
}

export async function upsertX01Dart(params: {
  matchId: string;
  playerId: string;
  turnIndex: number;
  dartIndex: number;
  score: number;
  remaining: number;
  segment?: string | null;
  multiplier?: number | null;
  zone?: string | null;
  dartLabel?: string | null;
  frontonImageUrl?: string | null;
  frontonImagePath?: string | null;
}): Promise<void> {
  const supabase = getClient();
  const safeScore = Number.isFinite(params.score) ? Number(params.score) : 0;
  const safeRemaining = Number.isFinite(params.remaining) ? Number(params.remaining) : 0;
  const dartIndex = normalizeThrowDartIndex(params.dartIndex);
  const normalizedBed =
    params.segment?.trim() ||
    params.dartLabel?.trim() ||
    (safeScore === 0 ? "MISS" : null);

  const richRow: Record<string, unknown> = {
    match_id: params.matchId,
    player_id: params.playerId,
    turn_index: params.turnIndex,
    dart_index: dartIndex,
    score: safeScore,
    visit_score: safeScore,
    darts_used: 1,
    remaining: safeRemaining,
    bed: normalizedBed,
    multiplier: params.multiplier ?? 1,
    fronton_image_url: params.frontonImageUrl ?? null,
    fronton_image_path: params.frontonImagePath ?? null,
  };

  const basicRow = {
    match_id: params.matchId,
    player_id: params.playerId,
    turn_index: params.turnIndex,
    dart_index: dartIndex,
    score: safeScore,
    visit_score: safeScore,
    darts_used: 1,
    remaining: safeRemaining,
    bed: normalizedBed,
    multiplier: params.multiplier ?? 1,
  };

  const payload = throwWriteMode === "rich" ? richRow : basicRow;
  const { error } = await supabase.from("throws").upsert(payload, { onConflict: "match_id,player_id,turn_index,dart_index" });
  if (error && throwWriteMode === "rich" && isMissingColumnError(error)) {
    throwWriteMode = "basic";
    const { error: fallbackError } = await supabase.from("throws").upsert(basicRow, {
      onConflict: "match_id,player_id,turn_index,dart_index",
    });
    if (fallbackError) {
      throw new Error(fallbackError.message);
    }
    return;
  }
  if (error) {
    throw new Error(error.message);
  }
}

export async function setMatchCurrentPlayer(matchId: string, playerId: string): Promise<void> {
  const supabase = getClient();
  const { error } = await supabase.from("matches").update({ current_turn_player_id: playerId }).eq("id", matchId);
  if (error) {
    throw new Error(error.message);
  }
}

export function subscribeToMatches(lobbyId: string, onChange: () => void): () => void {
  const supabase = getClient();
  const channel = supabase
    .channel(`match:${lobbyId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "matches", filter: `lobby_id=eq.${lobbyId}` }, onChange)
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}

export function subscribeToThrows(matchId: string, onChange: () => void): () => void {
  const supabase = getClient();
  const channel = supabase
    .channel(`throws:${matchId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "throws", filter: `match_id=eq.${matchId}` }, onChange)
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}
