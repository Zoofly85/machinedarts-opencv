export type ClubKioskSession = {
  active: boolean;
  startedAt: number;
  lastActivityAt: number;
  game: string;
  playerNames: string[];
  queuedMatch?: {
    socialNightId: string;
    matchId: string;
    boardId: string;
    aName: string;
    bName: string;
    resultPosted?: boolean;
  };
};

const STORAGE_KEY = "machine_darts_club_kiosk_session";
export const KIOSK_SESSION_TIMEOUT_MS = 15 * 60 * 1000;

function nowMs(): number {
  return Date.now();
}

export function getClubKioskSession(): ClubKioskSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ClubKioskSession>;
    if (!parsed || !parsed.active) return null;
    return {
      active: true,
      startedAt: Number(parsed.startedAt || nowMs()),
      lastActivityAt: Number(parsed.lastActivityAt || nowMs()),
      game: String(parsed.game || ""),
      playerNames: Array.isArray(parsed.playerNames) ? parsed.playerNames.map((n) => String(n || "")) : [],
      queuedMatch:
        parsed.queuedMatch && typeof parsed.queuedMatch === "object"
          ? {
              socialNightId: String((parsed.queuedMatch as any).socialNightId || ""),
              matchId: String((parsed.queuedMatch as any).matchId || ""),
              boardId: String((parsed.queuedMatch as any).boardId || ""),
              aName: String((parsed.queuedMatch as any).aName || ""),
              bName: String((parsed.queuedMatch as any).bName || ""),
              resultPosted: Boolean((parsed.queuedMatch as any).resultPosted),
            }
          : undefined,
    };
  } catch {
    return null;
  }
}

export function startClubKioskSession(
  game: string,
  playerNames: string[],
  queuedMatch?: ClubKioskSession["queuedMatch"],
): ClubKioskSession {
  const ts = nowMs();
  const session: ClubKioskSession = {
    active: true,
    startedAt: ts,
    lastActivityAt: ts,
    game: String(game || ""),
    playerNames: playerNames.map((n) => String(n || "")),
    queuedMatch: queuedMatch ? { ...queuedMatch } : undefined,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  return session;
}

export function touchClubKioskSession(): ClubKioskSession | null {
  const current = getClubKioskSession();
  if (!current) return null;
  const next: ClubKioskSession = { ...current, lastActivityAt: nowMs() };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function endClubKioskSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function markQueuedMatchResultPosted(): ClubKioskSession | null {
  const current = getClubKioskSession();
  if (!current || !current.queuedMatch) return current;
  const next: ClubKioskSession = {
    ...current,
    queuedMatch: {
      ...current.queuedMatch,
      resultPosted: true,
    },
    lastActivityAt: nowMs(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function isClubKioskSessionExpired(session: ClubKioskSession, timeoutMs: number = KIOSK_SESSION_TIMEOUT_MS): boolean {
  return nowMs() - Number(session.lastActivityAt || 0) > timeoutMs;
}
