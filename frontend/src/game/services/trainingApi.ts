import { API_BASE_URL } from "../../services/api";

const API_URL = API_BASE_URL;

export type TrainingBlockType = "doubles" | "power_scoring";

export interface TrainingBlock {
  id?: string;
  order: number;
  type: TrainingBlockType;
  config: Record<string, unknown>;
}

export interface TrainingProgram {
  id: string;
  name: string;
  description: string;
  createdBy: string;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  blocks: TrainingBlock[];
}

export interface TrainingSession {
  id: string;
  programId: string;
  playerId: string;
  playerName: string;
  status: "active" | "completed" | string;
  startedAt: string;
  completedAt: string | null;
  activeBlockIndex: number;
  summary: Record<string, unknown>;
  metrics: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function listTrainingPrograms(includeArchived = false): Promise<TrainingProgram[]> {
  const response = await fetch(`${API_URL}/api/training/programs?include_archived=${includeArchived ? "true" : "false"}`);
  const data = await parseJson<{ programs: TrainingProgram[] }>(response);
  return data.programs ?? [];
}

export async function createTrainingProgram(payload: {
  name: string;
  description: string;
  created_by: string;
  blocks: TrainingBlock[];
}): Promise<TrainingProgram> {
  const response = await fetch(`${API_URL}/api/training/programs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await parseJson<{ program: TrainingProgram }>(response);
  return data.program;
}

export async function updateTrainingProgram(
  programId: string,
  payload: {
    name: string;
    description: string;
    created_by: string;
    is_archived: boolean;
    blocks: TrainingBlock[];
  }
): Promise<TrainingProgram> {
  const response = await fetch(`${API_URL}/api/training/programs/${programId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await parseJson<{ program: TrainingProgram }>(response);
  return data.program;
}

export async function deleteTrainingProgram(programId: string): Promise<void> {
  const response = await fetch(`${API_URL}/api/training/programs/${programId}`, {
    method: "DELETE",
  });
  await parseJson<{ status: string }>(response);
}

export async function archiveTrainingProgram(programId: string, archived: boolean): Promise<TrainingProgram> {
  const response = await fetch(`${API_URL}/api/training/programs/${programId}/archive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived }),
  });
  const data = await parseJson<{ program: TrainingProgram }>(response);
  return data.program;
}

export async function startTrainingSession(payload: {
  program_id: string;
  player_id?: string;
  player_name?: string;
}): Promise<TrainingSession> {
  const response = await fetch(`${API_URL}/api/training/sessions/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await parseJson<{ session: TrainingSession }>(response);
  return data.session;
}

export async function getTrainingSession(sessionId: string): Promise<TrainingSession> {
  const response = await fetch(`${API_URL}/api/training/sessions/${sessionId}`);
  const data = await parseJson<{ session: TrainingSession }>(response);
  return data.session;
}

export async function appendTrainingSessionEvent(
  sessionId: string,
  payload: {
    block_index: number;
    target_key: string;
    scored: number;
    multiplier: number;
    segment: string;
    zone: string;
    board_x?: number | null;
    board_y?: number | null;
    meta?: Record<string, unknown>;
  }
): Promise<TrainingSession> {
  const response = await fetch(`${API_URL}/api/training/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await parseJson<{ session: TrainingSession }>(response);
  return data.session;
}

export async function completeTrainingSession(
  sessionId: string,
  payload: {
    summary: Record<string, unknown>;
    metrics: Record<string, unknown>;
  }
): Promise<TrainingSession> {
  const response = await fetch(`${API_URL}/api/training/sessions/${sessionId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await parseJson<{ session: TrainingSession }>(response);
  return data.session;
}

export async function updateTrainingSessionEvent(
  sessionId: string,
  eventId: number,
  payload: {
    scored: number;
    multiplier: number;
    segment: string;
    zone: string;
    board_x?: number | null;
    board_y?: number | null;
    meta?: Record<string, unknown>;
  }
): Promise<TrainingSession> {
  const response = await fetch(`${API_URL}/api/training/sessions/${sessionId}/events/${eventId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await parseJson<{ session: TrainingSession }>(response);
  return data.session;
}

export async function getTrainingReportOverview(playerId = ""): Promise<Record<string, unknown>> {
  const response = await fetch(`${API_URL}/api/training/reports/overview?player_id=${encodeURIComponent(playerId)}`);
  const data = await parseJson<{ report: Record<string, unknown> }>(response);
  return data.report;
}

export async function getTrainingSessionReport(sessionId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${API_URL}/api/training/reports/session/${sessionId}`);
  const data = await parseJson<{ report: Record<string, unknown> }>(response);
  return data.report;
}

export async function getTrainingProgramReport(programId: string, playerId = ""): Promise<Record<string, unknown>> {
  const response = await fetch(
    `${API_URL}/api/training/reports/program/${programId}?player_id=${encodeURIComponent(playerId)}`
  );
  const data = await parseJson<{ report: Record<string, unknown> }>(response);
  return data.report;
}

export async function getDetectionRoundDart(dartIndex: number): Promise<Record<string, unknown>> {
  const response = await fetch(`${API_URL}/api/detection/round-dart/${Math.max(1, Math.min(3, Math.trunc(dartIndex)))}`);
  const data = await parseJson<{ round_dart: Record<string, unknown> }>(response);
  return data.round_dart;
}
