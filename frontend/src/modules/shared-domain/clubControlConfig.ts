const STORAGE_KEY = "machine_darts_club_control";

export type ClubControlConfig = {
  controlServerUrl: string;
  venueId: string;
  boardId: string;
  machineId: string;
  clubName: string;
};

function normalizeUrl(input: string): string {
  const raw = String(input || "").trim();
  if (!raw) return "http://127.0.0.1:8000";
  let value = raw;
  if (!/^https?:\/\//i.test(value)) {
    value = `http://${value}`;
  }
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "http://127.0.0.1:8000";
  }
}

function defaultMachineId(): string {
  const existing = localStorage.getItem("machine_darts_machine_id");
  if (existing) return existing;
  const generated = `pc-${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem("machine_darts_machine_id", generated);
  return generated;
}

export function getClubControlConfig(): ClubControlConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ClubControlConfig>;
      return {
        controlServerUrl: normalizeUrl(String(parsed.controlServerUrl || "http://127.0.0.1:8000")),
        venueId: String(parsed.venueId || "club-venue-1"),
        boardId: String(parsed.boardId || "board-1"),
        machineId: String(parsed.machineId || defaultMachineId()),
        clubName: String(parsed.clubName || "Pukekohe Darts Club"),
      };
    }
  } catch {
    // Fall through to defaults.
  }
  return {
    controlServerUrl: normalizeUrl("http://127.0.0.1:8000"),
    venueId: "club-venue-1",
    boardId: "board-1",
    machineId: defaultMachineId(),
    clubName: "Pukekohe Darts Club",
  };
}

export function saveClubControlConfig(next: Partial<ClubControlConfig>): ClubControlConfig {
  const current = getClubControlConfig();
  const merged: ClubControlConfig = {
    controlServerUrl: normalizeUrl(String(next.controlServerUrl ?? current.controlServerUrl)),
    venueId: String(next.venueId ?? current.venueId).trim() || "club-venue-1",
    boardId: String(next.boardId ?? current.boardId).trim() || "board-1",
    machineId: String(next.machineId ?? current.machineId).trim() || defaultMachineId(),
    clubName: String(next.clubName ?? current.clubName).trim() || "Pukekohe Darts Club",
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  return merged;
}

export function getClubControlBaseUrl(): string {
  return getClubControlConfig().controlServerUrl;
}
