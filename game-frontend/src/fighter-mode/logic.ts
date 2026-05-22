import {
  DEFAULT_FIGHTER_CONFIG,
  RINGS,
  TARGET_NUMBERS,
} from "./constants";
import type {
  CombatLogEntry,
  CombatTimelineFrame,
  DartHit,
  DartOutcome,
  FighterDartRecord,
  FighterMatchState,
  FighterModeConfig,
  FighterPlayerState,
  FighterTarget,
} from "./types";

type RandomFn = () => number;
type NormalizedRing =
  | "single"
  | "double"
  | "triple"
  | "outer-bull"
  | "inner-bull"
  | "miss";

interface RecordOptions {
  timestamp?: number;
}

export function createInitialState(
  playerNames: string[],
  configOverride?: Partial<FighterModeConfig>,
  randomFn: RandomFn = Math.random
): FighterMatchState {
  const config: FighterModeConfig = {
    ...DEFAULT_FIGHTER_CONFIG,
    ...configOverride,
  };

  const players: FighterPlayerState[] = playerNames.map((name, idx) => ({
    id: `player-${idx + 1}`,
    name: name.trim() || `Player ${idx + 1}`,
    health: config.startingHealth,
    currentTarget: null,
    dartsThisTurn: [],
    attackPoints: 0,
    defensePoints: 0,
    turnComplete: false,
    lastTurnSummary: null,
    totalDamageDealt: 0,
    totalDamageTaken: 0,
    roundsStarted: 0,
    roundsWon: 0,
  }));

  const base: FighterMatchState = {
    players,
    round: 1,
    status: "awaiting_darts",
    activePlayerIndex: players.length > 0 ? 0 : null,
    roundStarterIndex: 0,
    config,
    lastCombat: null,
    combatLog: [],
    winnerIndex: null,
  };

  if (base.activePlayerIndex !== null) {
    return ensureTargetForPlayer(base, base.activePlayerIndex, randomFn);
  }

  return base;
}

export const startNewMatch = createInitialState;

export function generateRandomTarget(
  randomFn: RandomFn = Math.random
): FighterTarget {
  const numberIndex = Math.floor(randomFn() * TARGET_NUMBERS.length);
  const ringIndex = Math.floor(randomFn() * RINGS.length);
  const value = TARGET_NUMBERS[Math.max(0, Math.min(numberIndex, TARGET_NUMBERS.length - 1))];
  const ring = RINGS[Math.max(0, Math.min(ringIndex, RINGS.length - 1))];
  return {
    value,
    ring,
    label: `${ring === "double" ? "D" : "T"}${value}`,
  };
}

export function buildDartForOutcome(
  target: FighterTarget,
  outcome: DartOutcome
): DartHit {
  if (outcome === "critical") {
    return { value: target.value, ring: target.ring };
  }
  if (outcome === "solid") {
    const alternateRing = target.ring === "double" ? "triple" : "double";
    return { value: target.value, ring: alternateRing };
  }
  const fallbackValue = target.value === 20 ? 1 : target.value + 1;
  return { value: fallbackValue, ring: "single" };
}

export function recordDart(
  previous: FighterMatchState,
  playerIndex: number,
  dart: DartHit,
  options: RecordOptions = {},
  randomFn: RandomFn = Math.random
): FighterMatchState {
  if (previous.status === "finished") {
    return previous;
  }

  const state = cloneState(previous);
  if (playerIndex < 0 || playerIndex >= state.players.length) {
    return state;
  }

  ensureTargetForPlayer(state, playerIndex, randomFn);

  const player = state.players[playerIndex];
  if (!player.currentTarget) {
    return state;
  }

  const dartSlot = player.dartsThisTurn.length;
  if (dartSlot >= 3) {
    return state;
  }

  const { points, outcome } = scoreDart(dart, player.currentTarget);
  const role: "attack" | "defense" = dartSlot < 2 ? "attack" : "defense";
  const timestamp = options.timestamp ?? Date.now();
  const record: FighterDartRecord = {
    raw: { ...dart },
    points,
    role,
    outcome,
    index: dartSlot,
    timestamp,
  };

  player.dartsThisTurn = [...player.dartsThisTurn, record];
  if (role === "attack") {
    player.attackPoints += points;
  } else {
    player.defensePoints += points;
  }

  if (player.dartsThisTurn.length >= 3) {
    player.turnComplete = true;
    player.lastTurnSummary = {
      round: state.round,
      target: player.currentTarget,
      darts: player.dartsThisTurn,
      attackPoints: player.attackPoints,
      defensePoints: player.defensePoints,
    };

    const nextPlayer = findNextPlayerIndex(state, playerIndex);
    if (nextPlayer === -1) {
      return resolveCombat(state, randomFn);
    }

    state.activePlayerIndex = nextPlayer;
    ensureTargetForPlayer(state, nextPlayer, randomFn);
  } else {
    state.activePlayerIndex = playerIndex;
  }

  return state;
}

export function resetMatch(
  state: FighterMatchState,
  randomFn: RandomFn = Math.random
): FighterMatchState {
  const names = state.players.map((player) => player.name);
  return createInitialState(names, state.config, randomFn);
}

function resolveCombat(
  state: FighterMatchState,
  randomFn: RandomFn = Math.random
): FighterMatchState {
  if (state.players.length < 2) {
    state.status = "finished";
    state.winnerIndex = 0;
    state.activePlayerIndex = null;
    return state;
  }

  const playerSnapshots = state.players.map((player) => ({
    health: player.health,
    attack: player.attackPoints,
    defense: player.defensePoints,
  }));

  const damageToPlayer: number[] = playerSnapshots.map((snapshot, index) => {
    const attackerIndex = index === 0 ? 1 : 0;
    const attacker = playerSnapshots[attackerIndex];
    return Math.max(0, attacker.attack - snapshot.defense);
  });

  state.players = state.players.map((player, index) => {
    const damageReceived = damageToPlayer[index];
    const opponentIndex = index === 0 ? 1 : 0;
    const damageInflicted = damageToPlayer[opponentIndex];
    const updatedHealth = Math.max(0, player.health - damageReceived);

    return {
      ...player,
      health: updatedHealth,
      totalDamageDealt: player.totalDamageDealt + damageInflicted,
      totalDamageTaken: player.totalDamageTaken + damageReceived,
    };
  });

  const healthBefore = playerSnapshots.map((snapshot) => snapshot.health);
  const healthAfter = state.players.map((player) => player.health);
  const timeline = buildTimeline(
    healthBefore,
    healthAfter,
    state.config
  );

  const combatEntry: CombatLogEntry = {
    round: state.round,
    attackTotals: playerSnapshots.map((snapshot) => snapshot.attack),
    defenseTotals: playerSnapshots.map((snapshot) => snapshot.defense),
    damageDealt: [damageToPlayer[1], damageToPlayer[0]],
    damageReceived: [...damageToPlayer],
    healthAfter,
    timeline,
  };

  state.lastCombat = combatEntry;
  state.combatLog = [...state.combatLog, combatEntry];

  const winner = determineWinner(state.players);
  if (winner !== null) {
    state.status = "finished";
    state.winnerIndex = winner;
    state.activePlayerIndex = null;
    state.players[winner] = {
      ...state.players[winner],
      roundsWon: state.players[winner].roundsWon + 1,
    };
    return state;
  }

  state.round += 1;
  state.roundStarterIndex =
    (state.roundStarterIndex + 1) % state.players.length;
  state.activePlayerIndex = state.roundStarterIndex;
  state.status = "awaiting_darts";

  state.players = state.players.map((player) => ({
    ...player,
    currentTarget: null,
    dartsThisTurn: [],
    attackPoints: 0,
    defensePoints: 0,
    turnComplete: false,
  }));

  state.players[state.activePlayerIndex].roundsStarted += 1;
  return ensureTargetForPlayer(state, state.activePlayerIndex, randomFn);
}

function determineWinner(players: FighterPlayerState[]): number | null {
  const zeroHealthPlayers = players
    .map((player, index) => ({ health: player.health, index }))
    .filter((entry) => entry.health <= 0);

  if (zeroHealthPlayers.length === 0) {
    return null;
  }

  if (zeroHealthPlayers.length === players.length) {
    const best = players
      .map((player, index) => ({
        damageDealt: player.totalDamageDealt,
        index,
      }))
      .sort((a, b) => b.damageDealt - a.damageDealt)[0];
    return best ? best.index : null;
  }

  return zeroHealthPlayers
    .sort((a, b) => a.health - b.health)[0]
    ?.index ?? null;
}

function ensureTargetForPlayer(
  state: FighterMatchState,
  playerIndex: number,
  randomFn: RandomFn = Math.random
): FighterMatchState {
  if (
    playerIndex === null ||
    playerIndex < 0 ||
    playerIndex >= state.players.length
  ) {
    return state;
  }

  const player = state.players[playerIndex];
  if (!player.currentTarget) {
    player.currentTarget = generateRandomTarget(randomFn);
    player.roundsStarted += 1;
  }
  return state;
}

function cloneState(state: FighterMatchState): FighterMatchState {
  return {
    ...state,
    players: state.players.map(clonePlayer),
    config: { ...state.config },
    lastCombat: state.lastCombat ? cloneCombat(state.lastCombat) : null,
    combatLog: state.combatLog.map(cloneCombat),
  };
}

function clonePlayer(player: FighterPlayerState): FighterPlayerState {
  return {
    ...player,
    currentTarget: player.currentTarget
      ? { ...player.currentTarget }
      : null,
    dartsThisTurn: player.dartsThisTurn.map(cloneDartRecord),
    lastTurnSummary: player.lastTurnSummary
      ? {
          ...player.lastTurnSummary,
          target: { ...player.lastTurnSummary.target },
          darts: player.lastTurnSummary.darts.map(cloneDartRecord),
        }
      : null,
  };
}

function cloneDartRecord(record: FighterDartRecord): FighterDartRecord {
  return {
    ...record,
    raw: { ...record.raw },
  };
}

function cloneCombat(entry: CombatLogEntry): CombatLogEntry {
  return {
    ...entry,
    attackTotals: [...entry.attackTotals],
    defenseTotals: [...entry.defenseTotals],
    damageDealt: [...entry.damageDealt],
    damageReceived: [...entry.damageReceived],
    healthAfter: [...entry.healthAfter],
    timeline: entry.timeline.map((frame) => ({
      ms: frame.ms,
      health: [...frame.health],
    })),
  };
}

function scoreDart(
  dart: DartHit,
  target: FighterTarget
): { points: number; outcome: DartOutcome } {
  const normalizedRing = normalizeRing(dart.ring);
  const normalizedTargetRing = normalizeRing(target.ring);
  const sameNumber = dart.value === target.value;
  const sameRing = normalizedRing === normalizedTargetRing;

  if (sameNumber && sameRing) {
    return { points: 50, outcome: "critical" };
  }
  if (sameNumber) {
    return { points: 25, outcome: "solid" };
  }
  return { points: 10, outcome: "glancing" };
}

function normalizeRing(ring: string): NormalizedRing {
  const compact = ring.toLowerCase();
  if (compact === "d" || compact === "double") {
    return "double";
  }
  if (compact === "t" || compact === "triple" || compact === "treble") {
    return "triple";
  }
  if (compact === "outer-bull" || compact === "outerbull") {
    return "outer-bull";
  }
  if (compact === "inner-bull" || compact === "innerbull" || compact === "bull") {
    return "inner-bull";
  }
  if (compact === "miss") {
    return "miss";
  }
  return "single";
}

function findNextPlayerIndex(
  state: FighterMatchState,
  fromIndex: number
): number {
  const total = state.players.length;
  for (let offset = 1; offset <= total; offset += 1) {
    const candidate = (fromIndex + offset) % total;
    if (!state.players[candidate].turnComplete) {
      return candidate;
    }
  }
  return -1;
}

function buildTimeline(
  startHealth: number[],
  endHealth: number[],
  config: FighterModeConfig
): CombatTimelineFrame[] {
  const frames: CombatTimelineFrame[] = [];
  const steps = Math.max(
    1,
    Math.floor(config.combatDurationMs / config.timelineStepMs)
  );
  const duration = config.combatDurationMs;
  for (let step = 0; step <= steps; step += 1) {
    const ratio = step / steps;
    const ms = Math.min(duration, step * config.timelineStepMs);
    frames.push({
      ms,
      health: startHealth.map((start, index) => {
        const end = endHealth[index] ?? start;
        return Math.max(0, Math.round(start + (end - start) * ratio));
      }),
    });
  }
  return frames;
}
