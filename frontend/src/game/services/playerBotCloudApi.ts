import { getSupabaseClient } from "../online/supabaseOnline";

const CLOUD_LINKS_KEY = "md_player_bot_cloud_links";

export type CloudPlayerBot = {
  id: string;
  displayName: string;
  sourcePlayerId?: string | null;
  ownerUserId?: string | null;
  visibility: "public" | "private" | "club";
  version: number;
  schemaVersion: number;
  statsSnapshot: Record<string, unknown>;
  bundle: Record<string, unknown>;
  bundleHash?: string | null;
  legsCount: number;
  average?: number | null;
  checkoutPercentage?: number | null;
  updatedAt?: string | null;
  createdAt?: string | null;
};

type CloudLinks = Record<string, string>;

function readCloudLinks(): CloudLinks {
  try {
    const parsed = JSON.parse(localStorage.getItem(CLOUD_LINKS_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed as CloudLinks : {};
  } catch {
    return {};
  }
}

function writeCloudLinks(links: CloudLinks): void {
  localStorage.setItem(CLOUD_LINKS_KEY, JSON.stringify(links));
}

function mapVisibility(value: unknown): CloudPlayerBot["visibility"] {
  const text = String(value || "public").toLowerCase();
  return text === "private" || text === "club" ? text : "public";
}

function mapCloudRow(row: Record<string, unknown>): CloudPlayerBot {
  return {
    id: String(row.id || ""),
    displayName: String(row.display_name || "Player Bot"),
    sourcePlayerId: typeof row.source_player_id === "string" ? row.source_player_id : null,
    ownerUserId: typeof row.owner_user_id === "string" ? row.owner_user_id : null,
    visibility: mapVisibility(row.visibility),
    version: Number(row.version || 1),
    schemaVersion: Number(row.schema_version || 1),
    statsSnapshot: row.stats_snapshot && typeof row.stats_snapshot === "object" ? row.stats_snapshot as Record<string, unknown> : {},
    bundle: row.bundle && typeof row.bundle === "object" ? row.bundle as Record<string, unknown> : {},
    bundleHash: typeof row.bundle_hash === "string" ? row.bundle_hash : null,
    legsCount: Number(row.legs_count || 0),
    average: row.average === null || row.average === undefined ? null : Number(row.average),
    checkoutPercentage:
      row.checkout_percentage === null || row.checkout_percentage === undefined ? null : Number(row.checkout_percentage),
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
    createdAt: typeof row.created_at === "string" ? row.created_at : null,
  };
}

async function ensureAnonymousUser(): Promise<string> {
  const supabase = getSupabaseClient();
  const current = await supabase.auth.getUser();
  if (current.data.user?.id) {
    return current.data.user.id;
  }
  const signedIn = await supabase.auth.signInAnonymously();
  if (signedIn.error || !signedIn.data.user?.id) {
    throw new Error(signedIn.error?.message || "Could not start Supabase anonymous session.");
  }
  return signedIn.data.user.id;
}

async function hashBundle(bundle: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(bundle));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function getLinkedCloudBotId(playerId: string): string | null {
  return readCloudLinks()[playerId] || null;
}

export function unlinkCloudPlayerBot(playerId: string): void {
  const links = readCloudLinks();
  delete links[playerId];
  writeCloudLinks(links);
}

export async function publishPlayerBotToCloud(options: {
  playerId: string;
  displayName: string;
  bundle: Record<string, unknown>;
  visibility?: CloudPlayerBot["visibility"];
}): Promise<CloudPlayerBot> {
  const supabase = getSupabaseClient();
  const ownerUserId = await ensureAnonymousUser();
  const existingCloudId = getLinkedCloudBotId(options.playerId);
  const botMeta = options.bundle.botMeta && typeof options.bundle.botMeta === "object"
    ? options.bundle.botMeta as Record<string, unknown>
    : {};
  const statsSnapshot = options.bundle.statsSnapshot && typeof options.bundle.statsSnapshot === "object"
    ? options.bundle.statsSnapshot as Record<string, unknown>
    : {};
  const wonLegs = Array.isArray(options.bundle.wonLegs) ? options.bundle.wonLegs : [];
  const bundleHash = await hashBundle(options.bundle);

  let nextVersion = 1;
  if (existingCloudId) {
    const { data } = await supabase.from("player_bots").select("*").eq("id", existingCloudId).maybeSingle();
    const existing = data as Record<string, unknown> | null;
    if (existing && String(existing.bundle_hash || "") === bundleHash) {
      return mapCloudRow(existing);
    }
    nextVersion = Number(existing?.version || 0) + 1;
  }

  const payload = {
    ...(existingCloudId ? { id: existingCloudId } : {}),
    owner_user_id: ownerUserId,
    source_player_id: String(botMeta.playerId || options.playerId),
    display_name: options.displayName.trim() || String(botMeta.playerName || "Player Bot"),
    visibility: options.visibility || "public",
    schema_version: Number(options.bundle.schemaVersion || 1),
    version: nextVersion,
    stats_snapshot: statsSnapshot,
    bundle: options.bundle,
    bundle_hash: bundleHash,
    legs_count: wonLegs.length,
    average: Number(statsSnapshot.average ?? statsSnapshot.ppr ?? 0) || null,
    checkout_percentage: Number(statsSnapshot.checkoutPercentage ?? 0) || null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase.from("player_bots").upsert(payload).select("*").single();
  if (error) {
    throw new Error(error.message);
  }
  const row = mapCloudRow(data as Record<string, unknown>);
  if (row.id) {
    const links = readCloudLinks();
    links[options.playerId] = row.id;
    writeCloudLinks(links);
  }
  return row;
}

export async function unshareCloudPlayerBot(playerId: string): Promise<void> {
  const cloudBotId = getLinkedCloudBotId(playerId);
  if (!cloudBotId) return;
  const supabase = getSupabaseClient();
  const ownerUserId = await ensureAnonymousUser();
  const { error } = await supabase
    .from("player_bots")
    .update({ visibility: "private", updated_at: new Date().toISOString() })
    .eq("id", cloudBotId)
    .eq("owner_user_id", ownerUserId);
  if (error) {
    throw new Error(error.message);
  }
  unlinkCloudPlayerBot(playerId);
}

export async function listCloudPlayerBots(): Promise<CloudPlayerBot[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("player_bots")
    .select("*")
    .eq("visibility", "public")
    .order("average", { ascending: false, nullsFirst: false })
    .limit(100);
  if (error) {
    throw new Error(error.message);
  }
  return Array.isArray(data) ? data.map((row) => mapCloudRow(row as Record<string, unknown>)).filter((row) => row.id) : [];
}
