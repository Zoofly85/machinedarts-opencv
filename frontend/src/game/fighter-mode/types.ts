export type RingType =
  | "single"
  | "double"
  | "triple"
  | "outer-bull"
  | "inner-bull"
  | "miss";

export type DartOutcome = "critical" | "solid" | "glancing";

export interface DartHit {
  value: number | "bull" | null;
  ring: RingType;
  metadata?: {
    timestamp?: number;
    confidence?: number;
    source?: string;
  };
}

export interface FighterTarget {
  value: number;
  ring: "double" | "triple";
  label: string;
}

export interface FighterDartRecord {
  raw: DartHit;
  points: number;
  role: "attack" | "defense";
  outcome: DartOutcome;
  index: number;
  timestamp: number;
}

export interface FighterTurnSummary {
  round: number;
  target: FighterTarget;
  darts: FighterDartRecord[];
  attackPoints: number;
  defensePoints: number;
}

export interface CombatTimelineFrame {
  ms: number;
  health: number[];
}

export interface CombatLogEntry {
  round: number;
  attackTotals: number[];
  defenseTotals: number[];
  damageDealt: number[];
  damageReceived: number[];
  healthAfter: number[];
  timeline: CombatTimelineFrame[];
}

export interface FighterModeConfig {
  startingHealth: number;
  combatDurationMs: number;
  timelineStepMs: number;
}

export interface FighterPlayerState {
  id: string;
  name: string;
  health: number;
  currentTarget: FighterTarget | null;
  dartsThisTurn: FighterDartRecord[];
  attackPoints: number;
  defensePoints: number;
  turnComplete: boolean;
  lastTurnSummary: FighterTurnSummary | null;
  totalDamageDealt: number;
  totalDamageTaken: number;
  roundsStarted: number;
  roundsWon: number;
}

export interface FighterMatchState {
  players: FighterPlayerState[];
  round: number;
  status: "awaiting_darts" | "round_complete" | "finished";
  activePlayerIndex: number | null;
  roundStarterIndex: number;
  config: FighterModeConfig;
  lastCombat: CombatLogEntry | null;
  combatLog: CombatLogEntry[];
  winnerIndex: number | null;
}
