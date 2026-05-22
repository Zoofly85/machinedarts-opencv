import { getClubControlBaseUrl } from "../../shared-domain/clubControlConfig";
import type { Board, PlaytimeMetrics, SocialNight, Tournament } from "../../shared-domain/contracts/club";

export type ClubPlayer = {
  id: string;
  name: string;
  createdAt?: string;
};

export type ClubPlayerStats = {
  player?: { id?: string; name?: string };
  history?: Array<Record<string, unknown>>;
  modes?: {
    x01?: {
      overall?: {
        legs?: number;
        legsWon?: number;
        averages?: {
          ppr?: { current?: number };
          pprTo170?: { current?: number };
          firstNine?: { current?: number };
        };
        checkout?: {
          attempts?: number;
          successes?: number;
          percentage?: { current?: number };
        };
        buckets?: { total?: Record<string, number> };
      };
    };
    cricket?: {
      overall?: {
        legs?: number;
        legsWon?: number;
        averages?: {
          mpr?: { current?: number };
          firstNineMpr?: { current?: number };
          score?: { current?: number };
        };
      };
    };
    around_the_clock?: {
      overall?: {
        legs?: number;
        legsWon?: number;
        averages?: {
          accuracy?: { current?: number };
          targetsPerLeg?: { current?: number };
          dartsPerTarget?: { current?: number };
        };
      };
    };
  };
};

export type SocialNightPlannerInputPlayer = {
  id?: string;
  name: string;
};

export type SocialNightPlanMatch = {
  match_id: string;
  round: number;
  a: { id?: string; name: string; start_score?: number };
  b: { id?: string; name: string; start_score?: number };
};

export type SocialNightPlanGroup = {
  board_id: string;
  group_name: string;
  participants: Array<{ id?: string; name: string; start_score?: number; rating?: number }>;
  fixtures: Array<{ round: number; matches: SocialNightPlanMatch[] }>;
  games_per_participant: number;
  qualify_wins: number;
};

export type SocialNightPlan = {
  name: string;
  format: "singles" | "doubles";
  game_mode: string;
  board_ids: string[];
  players_per_board: number;
  qualify_wins: number;
  groups: SocialNightPlanGroup[];
  generated_at: string;
};

export type SocialNightStandingsGroup = {
  group_name: string;
  board_id: string;
  qualify_wins: number;
  rows: Array<{
    id?: string;
    name: string;
    start_score?: number;
    wins: number;
    losses: number;
    played: number;
    qualified: boolean;
  }>;
};

export type SocialNightPlayoffBracket = {
  generated_at: string;
  qualifiers: Array<{ id?: string; name: string; wins: number; losses: number; played: number; group: string }>;
  size: number;
  rounds: Array<{
    round: number;
    matches: Array<{
      match_id: string;
      round: number;
      a: { id?: string | null; name: string };
      b: { id?: string | null; name: string };
      winner?: { id?: string | null; name: string } | null;
    }>;
  }>;
};

export async function getBoards(): Promise<Board[]> {
  const res = await fetch(`${getClubControlBaseUrl()}/api/club/boards`);
  if (!res.ok) throw new Error(`Failed to fetch boards (${res.status})`);
  const data = await res.json();
  return Array.isArray(data?.boards) ? data.boards : [];
}

export async function createSocialNight(name: string, boardIds: string[]): Promise<SocialNight> {
  const res = await fetch(`${getClubControlBaseUrl()}/api/club/social-nights`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, board_ids: boardIds }),
  });
  if (!res.ok) throw new Error(`Failed to create social night (${res.status})`);
  const data = await res.json();
  return data?.social_night as SocialNight;
}

export async function createSocialNightWithPlan(name: string, boardIds: string[], plan: SocialNightPlan): Promise<SocialNight> {
  const res = await fetch(`${getClubControlBaseUrl()}/api/club/social-nights`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, board_ids: boardIds, plan }),
  });
  if (!res.ok) throw new Error(`Failed to create social night (${res.status})`);
  const data = await res.json();
  return data?.social_night as SocialNight;
}

export async function generateSocialNightPlan(params: {
  name: string;
  format: "singles" | "doubles";
  game_mode: string;
  board_ids: string[];
  players_per_board: number;
  qualify_wins: number;
  players: SocialNightPlannerInputPlayer[];
  random_seed?: number;
  preserve_rating_order?: boolean;
}): Promise<SocialNightPlan> {
  const res = await fetch(`${getClubControlBaseUrl()}/api/club/social-nights/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`Failed to generate social night plan (${res.status})`);
  const data = await res.json();
  return data?.plan as SocialNightPlan;
}

export async function getSocialNight(socialNightId: string): Promise<{ social_night: SocialNight & { plan?: SocialNightPlan; results?: Record<string, unknown>; playoffs?: SocialNightPlayoffBracket }; standings: { groups: SocialNightStandingsGroup[] } }> {
  const safeId = encodeURIComponent(String(socialNightId || ""));
  const res = await fetch(`${getClubControlBaseUrl()}/api/club/social-nights/${safeId}`);
  if (!res.ok) throw new Error(`Failed to fetch social night (${res.status})`);
  const data = await res.json();
  return data as { social_night: SocialNight & { plan?: SocialNightPlan; results?: Record<string, unknown>; playoffs?: SocialNightPlayoffBracket }; standings: { groups: SocialNightStandingsGroup[] } };
}

export async function submitSocialNightResult(params: {
  socialNightId: string;
  matchId: string;
  winner: "a" | "b";
  scoreA?: number;
  scoreB?: number;
}): Promise<{ groups: SocialNightStandingsGroup[] }> {
  const safeId = encodeURIComponent(String(params.socialNightId || ""));
  const res = await fetch(`${getClubControlBaseUrl()}/api/club/social-nights/${safeId}/results`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      match_id: params.matchId,
      winner: params.winner,
      score_a: params.scoreA,
      score_b: params.scoreB,
    }),
  });
  if (!res.ok) throw new Error(`Failed to submit social-night result (${res.status})`);
  const data = await res.json();
  return (data?.standings || { groups: [] }) as { groups: SocialNightStandingsGroup[] };
}

export async function generateSocialNightPlayoffs(params: {
  socialNightId: string;
  minQualifiers?: number;
  maxQualifiers?: number;
}): Promise<SocialNightPlayoffBracket> {
  const safeId = encodeURIComponent(String(params.socialNightId || ""));
  const res = await fetch(`${getClubControlBaseUrl()}/api/club/social-nights/${safeId}/playoffs/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      min_qualifiers: params.minQualifiers ?? 4,
      max_qualifiers: params.maxQualifiers ?? 16,
    }),
  });
  if (!res.ok) throw new Error(`Failed to generate playoffs (${res.status})`);
  const data = await res.json();
  return (data?.playoffs || { qualifiers: [], rounds: [] }) as SocialNightPlayoffBracket;
}

export async function createTournament(name: string, boardIds: string[], notes = ""): Promise<Tournament> {
  const res = await fetch(`${getClubControlBaseUrl()}/api/club/tournaments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, board_ids: boardIds, notes }),
  });
  if (!res.ok) throw new Error(`Failed to create tournament (${res.status})`);
  const data = await res.json();
  return data?.tournament as Tournament;
}

export async function getPlaytimeMetrics(): Promise<PlaytimeMetrics> {
  const res = await fetch(`${getClubControlBaseUrl()}/api/club/analytics/playtime`);
  if (!res.ok) throw new Error(`Failed to fetch playtime analytics (${res.status})`);
  const data = await res.json();
  return data?.metrics as PlaytimeMetrics;
}

export async function testClubServerConnection(): Promise<boolean> {
  const res = await fetch(`${getClubControlBaseUrl()}/api/club/boards`);
  return res.ok;
}

export async function startBoardSession(boardId: string, title: string, notes = ""): Promise<void> {
  const safeBoardId = encodeURIComponent(String(boardId || ""));
  const res = await fetch(`${getClubControlBaseUrl()}/api/club/boards/${safeBoardId}/session/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, notes }),
  });
  if (!res.ok) throw new Error(`Failed to start board session (${res.status})`);
}

export async function stopBoardSession(boardId: string): Promise<void> {
  const safeBoardId = encodeURIComponent(String(boardId || ""));
  const res = await fetch(`${getClubControlBaseUrl()}/api/club/boards/${safeBoardId}/session/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok && res.status !== 404) throw new Error(`Failed to stop board session (${res.status})`);
}

export async function getPlayers(): Promise<ClubPlayer[]> {
  const res = await fetch(`${getClubControlBaseUrl()}/api/players`);
  if (!res.ok) throw new Error(`Failed to fetch players (${res.status})`);
  const data = await res.json();
  return Array.isArray(data?.players) ? data.players : [];
}

export async function getPlayerStats(playerId: string): Promise<ClubPlayerStats> {
  const safeId = encodeURIComponent(String(playerId || ""));
  const res = await fetch(`${getClubControlBaseUrl()}/api/players/${safeId}/stats`);
  if (!res.ok) throw new Error(`Failed to fetch player stats (${res.status})`);
  return (await res.json()) as ClubPlayerStats;
}
