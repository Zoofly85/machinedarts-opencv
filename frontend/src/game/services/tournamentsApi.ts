import { API_BASE_URL } from "../../services/api";

const API_URL = API_BASE_URL;

export type TournamentParticipantType = "profile" | "guest" | "ai_bot" | "player_bot";

export type TournamentParticipant = {
  id: string;
  name: string;
  type: TournamentParticipantType;
  profileId?: string | null;
  botLevel?: number | null;
  sourcePlayerId?: string | null;
};

export type TournamentMatch = {
  id: string;
  round: number;
  position: number;
  playerAId?: string | null;
  playerBId?: string | null;
  status: "waiting" | "pending" | "active" | "complete";
  winnerId?: string | null;
  readyParticipantIds?: string[];
  background?: boolean;
  backgroundLog?: string[];
  legsA?: number | null;
  legsB?: number | null;
  startedAt?: string | null;
  completedAt?: string | null;
};

export type TournamentSettings = {
  startScore: number;
  legsPerSet: number;
  setsToWin: number;
  inMode: "straight" | "double" | "master";
  outMode: "straight" | "double" | "master";
};

export type Tournament = {
  id: string;
  name: string;
  format: "knockout";
  status: "draft" | "active" | "complete";
  participants: TournamentParticipant[];
  matches: TournamentMatch[];
  settings: TournamentSettings;
  winnerId?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

async function readJson(res: Response): Promise<any> {
  return await res.json().catch(() => ({}));
}

export async function listTournaments(): Promise<Tournament[]> {
  const res = await fetch(`${API_URL}/api/tournaments`);
  const data = await readJson(res);
  if (!res.ok) {
    throw new Error(String(data?.detail || `Failed to list tournaments (${res.status})`));
  }
  return Array.isArray(data?.tournaments) ? data.tournaments as Tournament[] : [];
}

export async function getTournament(tournamentId: string): Promise<Tournament> {
  const res = await fetch(`${API_URL}/api/tournaments/${encodeURIComponent(tournamentId)}`);
  const data = await readJson(res);
  if (!res.ok) {
    throw new Error(String(data?.detail || `Failed to fetch tournament (${res.status})`));
  }
  return data.tournament as Tournament;
}

export async function createTournament(payload: {
  name: string;
  participants: Array<Partial<TournamentParticipant>>;
  settings: TournamentSettings;
}): Promise<Tournament> {
  const res = await fetch(`${API_URL}/api/tournaments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await readJson(res);
  if (!res.ok) {
    throw new Error(String(data?.detail || `Failed to create tournament (${res.status})`));
  }
  return data.tournament as Tournament;
}

export async function setTournamentMatchStatus(tournamentId: string, matchId: string, status: "pending" | "active"): Promise<Tournament> {
  const res = await fetch(`${API_URL}/api/tournaments/${encodeURIComponent(tournamentId)}/matches/${encodeURIComponent(matchId)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  const data = await readJson(res);
  if (!res.ok) {
    throw new Error(String(data?.detail || `Failed to update match (${res.status})`));
  }
  return data.tournament as Tournament;
}

export async function setTournamentMatchReady(payload: {
  tournamentId: string;
  matchId: string;
  participantId: string;
  ready: boolean;
}): Promise<Tournament> {
  const res = await fetch(`${API_URL}/api/tournaments/${encodeURIComponent(payload.tournamentId)}/matches/${encodeURIComponent(payload.matchId)}/ready`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      participantId: payload.participantId,
      ready: payload.ready,
    }),
  });
  const data = await readJson(res);
  if (!res.ok) {
    throw new Error(String(data?.detail || `Failed to update ready state (${res.status})`));
  }
  return data.tournament as Tournament;
}

export async function resolveTournamentBackground(tournamentId: string): Promise<{ tournament: Tournament; resolved: number }> {
  const res = await fetch(`${API_URL}/api/tournaments/${encodeURIComponent(tournamentId)}/background/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const data = await readJson(res);
  if (!res.ok) {
    throw new Error(String(data?.detail || `Failed to resolve background matches (${res.status})`));
  }
  return {
    tournament: data.tournament as Tournament,
    resolved: Number(data.resolved || 0),
  };
}

export async function recordTournamentMatchResult(payload: {
  tournamentId: string;
  matchId: string;
  winnerId: string;
  legsA?: number | null;
  legsB?: number | null;
}): Promise<Tournament> {
  const res = await fetch(`${API_URL}/api/tournaments/${encodeURIComponent(payload.tournamentId)}/matches/${encodeURIComponent(payload.matchId)}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      winnerId: payload.winnerId,
      legsA: payload.legsA ?? null,
      legsB: payload.legsB ?? null,
    }),
  });
  const data = await readJson(res);
  if (!res.ok) {
    throw new Error(String(data?.detail || `Failed to record result (${res.status})`));
  }
  return data.tournament as Tournament;
}

export async function deleteTournament(tournamentId: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/tournaments/${encodeURIComponent(tournamentId)}`, { method: "DELETE" });
  const data = await readJson(res);
  if (!res.ok) {
    throw new Error(String(data?.detail || `Failed to delete tournament (${res.status})`));
  }
}
