import { API_BASE_URL } from "../../services/api";

const API_URL = API_BASE_URL;
const PLAYERS_CACHE_TTL_MS = 60_000;

export type PlayerProfile = {
  id: string;
  name: string;
  createdAt?: string;
};

export type PlayerBotStatus = {
  botId?: string;
  playerId: string;
  playerName: string;
  completedLegs: number;
  playedLegs?: number;
  isUnlocked: boolean;
  progressPercentage: number;
  unlockWinsRequired?: number;
  availableWonLegs?: number;
  wonLegPoolSize?: number;
  windowLegs?: number;
  gamesPlayed?: number;
  ppr?: number | null;
  average?: number | null;
  pprTo170?: number | null;
  firstNinePpr?: number | null;
  checkoutPercentage?: number | null;
  checkoutAttempts?: number;
  checkoutSuccesses?: number;
  cloudBotId?: string | null;
  cloudVersion?: number;
  autoUpdate?: boolean;
};

export type PlayerStats = {
  player?: PlayerProfile;
  modes?: {
    x01?: {
      windows?: Record<
        string,
        {
          legs?: number;
          averages?: {
            ppr?: {
              current?: number;
            };
          };
        }
      >;
    };
  };
};

let playersCache: { players: PlayerProfile[]; ts: number } | null = null;
let playersInFlight: Promise<PlayerProfile[]> | null = null;

export function invalidatePlayersCache(): void {
  playersCache = null;
}

export async function getPlayersCached(options?: { force?: boolean; maxAgeMs?: number }): Promise<PlayerProfile[]> {
  const force = Boolean(options?.force);
  const maxAgeMs = Number.isFinite(options?.maxAgeMs)
    ? Math.max(0, Number(options?.maxAgeMs))
    : PLAYERS_CACHE_TTL_MS;
  const now = Date.now();

  if (!force && playersCache && now - playersCache.ts <= maxAgeMs) {
    return playersCache.players;
  }
  if (!force && playersInFlight) {
    return playersInFlight;
  }

  playersInFlight = (async () => {
    const res = await fetch(`${API_URL}/api/players`);
    if (!res.ok) {
      throw new Error(`Failed to fetch players (${res.status})`);
    }
    const data = await res.json();
    const players: PlayerProfile[] = Array.isArray(data?.players)
      ? data.players
          .map((p: any) => ({
            id: String(p?.id ?? "").trim(),
            name: String(p?.name ?? "").trim(),
            createdAt: p?.createdAt ? String(p.createdAt) : undefined,
          }))
          .filter((p: PlayerProfile) => p.id && p.name)
      : [];
    playersCache = { players, ts: Date.now() };
    return players;
  })();

  try {
    return await playersInFlight;
  } finally {
    playersInFlight = null;
  }
}

export async function getPlayerBotStatus(playerId: string): Promise<PlayerBotStatus> {
  const res = await fetch(`${API_URL}/api/players/${encodeURIComponent(playerId)}/bot-status`);
  if (!res.ok) {
    throw new Error(`Failed to fetch player bot status (${res.status})`);
  }
  return await res.json();
}

export async function getPlayerStats(playerId: string): Promise<PlayerStats> {
  const res = await fetch(`${API_URL}/api/players/${encodeURIComponent(playerId)}/stats?gameMode=x01&limit=100`);
  if (!res.ok) {
    throw new Error(`Failed to fetch player stats (${res.status})`);
  }
  return await res.json();
}

export async function renamePlayerProfile(playerId: string, name: string): Promise<PlayerProfile> {
  const res = await fetch(`${API_URL}/api/players/${encodeURIComponent(playerId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(String(data?.detail || `Failed to rename profile (${res.status})`));
  }
  const player = data?.player;
  if (!player?.id || !player?.name) {
    throw new Error("Rename response did not include a player profile.");
  }
  invalidatePlayersCache();
  return {
    id: String(player.id),
    name: String(player.name),
    createdAt: player.createdAt ? String(player.createdAt) : undefined,
  };
}

export async function listImportedPlayerBots(): Promise<PlayerBotStatus[]> {
  const res = await fetch(`${API_URL}/api/player-bots`);
  if (!res.ok) {
    throw new Error(`Failed to fetch imported player bots (${res.status})`);
  }
  const data = await res.json();
  return Array.isArray(data?.bots) ? (data.bots as PlayerBotStatus[]) : [];
}

export async function exportPlayerBotBundle(playerId: string): Promise<{ filename: string; bundle: Record<string, unknown> }> {
  const res = await fetch(`${API_URL}/api/player-bots/export/${encodeURIComponent(playerId)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(String(data?.detail || `Failed to export player bot (${res.status})`));
  }
  return {
    filename: String(data?.filename || "playerbot.mdbot.json"),
    bundle: (data?.bundle && typeof data.bundle === "object") ? data.bundle as Record<string, unknown> : {},
  };
}

export async function importPlayerBotBundle(bundle: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${API_URL}/api/player-bots/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bundle }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(String(data?.detail || `Failed to import player bot (${res.status})`));
  }
  return data;
}

export async function importCloudPlayerBotBundle(options: {
  cloudBotId: string;
  bundle: Record<string, unknown>;
  cloudVersion?: number;
  autoUpdate?: boolean;
}): Promise<any> {
  const res = await fetch(`${API_URL}/api/player-bots/cloud/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cloudBotId: options.cloudBotId,
      bundle: options.bundle,
      cloudVersion: options.cloudVersion ?? 1,
      autoUpdate: options.autoUpdate ?? true,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(String(data?.detail || `Failed to import cloud player bot (${res.status})`));
  }
  return data;
}

export async function replaceImportedPlayerBot(botId: string, bundle: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${API_URL}/api/player-bots/${encodeURIComponent(botId)}/replace`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bundle }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(String(data?.detail || `Failed to replace player bot (${res.status})`));
  }
  return data;
}

export async function deleteImportedPlayerBot(botId: string): Promise<any> {
  const res = await fetch(`${API_URL}/api/player-bots/${encodeURIComponent(botId)}`, {
    method: "DELETE",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(String(data?.detail || `Failed to delete player bot (${res.status})`));
  }
  return data;
}

