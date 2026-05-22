export type KioskGame =
  | "x01"
  | "cricket"
  | "around_the_clock"
  | "target_trainer"
  | "shanghai"
  | "beer_race"
  | "bob27"
  | "bermuda"
  | "one_two_one"
  | "pacman";

export type KioskPlayerDraft = {
  firstName: string;
  lastName: string;
  nickname: string;
  saveProfile: boolean;
};

export type KioskFlowState = {
  playerCount: number;
  players: KioskPlayerDraft[];
  game: KioskGame;
};

const STORAGE_KEY = "machine_darts_club_kiosk_state";

const DEFAULT_PLAYER: KioskPlayerDraft = {
  firstName: "",
  lastName: "",
  nickname: "",
  saveProfile: false,
};

const DEFAULT_STATE: KioskFlowState = {
  playerCount: 2,
  players: [{ ...DEFAULT_PLAYER }, { ...DEFAULT_PLAYER }],
  game: "x01",
};

function sanitizePlayer(input?: Partial<KioskPlayerDraft>): KioskPlayerDraft {
  return {
    firstName: String(input?.firstName || "").trim(),
    lastName: String(input?.lastName || "").trim(),
    nickname: String(input?.nickname || "").trim(),
    saveProfile: Boolean(input?.saveProfile),
  };
}

function normalizeCount(value: number): number {
  const n = Number.isFinite(value) ? Math.round(value) : DEFAULT_STATE.playerCount;
  return Math.max(1, Math.min(8, n));
}

function normalizePlayers(players: Array<Partial<KioskPlayerDraft>>, count: number): KioskPlayerDraft[] {
  const out: KioskPlayerDraft[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(sanitizePlayer(players[i]));
  }
  return out;
}

export function getKioskState(): KioskFlowState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<KioskFlowState>;
    const playerCount = normalizeCount(Number(parsed.playerCount || DEFAULT_STATE.playerCount));
    const players = normalizePlayers(Array.isArray(parsed.players) ? parsed.players : [], playerCount);
    const game = String(parsed.game || DEFAULT_STATE.game) as KioskGame;
    return { playerCount, players, game };
  } catch {
    return DEFAULT_STATE;
  }
}

export function saveKioskState(next: Partial<KioskFlowState>): KioskFlowState {
  const current = getKioskState();
  const playerCount = normalizeCount(Number(next.playerCount ?? current.playerCount));
  const players = normalizePlayers(
    Array.isArray(next.players) ? next.players : current.players,
    playerCount,
  );
  const game = String(next.game ?? current.game) as KioskGame;
  const merged: KioskFlowState = { playerCount, players, game };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  return merged;
}

export function resetKioskState(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function formatPlayerDisplayName(player: KioskPlayerDraft, index: number): string {
  const fullName = `${player.firstName} ${player.lastName}`.trim();
  const base = fullName || `Player ${index + 1}`;
  const nick = player.nickname.trim();
  return nick ? `${base} (${nick})` : base;
}
