import { getClubControlBaseUrl, getClubControlConfig } from "../../shared-domain/clubControlConfig";

type HeartbeatPayload = {
  status: string;
  shell: string;
  active_game: string;
  fps: number | null;
  diagnostics: Record<string, unknown>;
};

export async function sendBoardHeartbeat(payload: HeartbeatPayload): Promise<void> {
  const cfg = getClubControlConfig();
  await fetch(`${getClubControlBaseUrl()}/api/club/boards/${encodeURIComponent(cfg.boardId)}/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...payload,
      venue_id: cfg.venueId,
      machine_id: cfg.machineId,
    }),
  });
}

export async function registerBoard(): Promise<{ ok: boolean; message?: string }> {
  const cfg = getClubControlConfig();
  const res = await fetch(`${getClubControlBaseUrl()}/api/club/boards/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      board_id: cfg.boardId,
      venue_id: cfg.venueId,
      machine_id: cfg.machineId,
      shell: "club-board",
    }),
  });
  if (res.ok) return { ok: true };
  const data = await res.json().catch(() => ({}));
  return { ok: false, message: String(data?.detail?.message || data?.detail || `Register failed (${res.status})`) };
}
