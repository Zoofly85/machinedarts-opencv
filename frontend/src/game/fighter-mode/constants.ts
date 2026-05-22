import type { FighterModeConfig } from "./types";

export const DEFAULT_FIGHTER_CONFIG: FighterModeConfig = {
  startingHealth: 500,
  combatDurationMs: 10_000,
  timelineStepMs: 1_000,
};

export const TARGET_NUMBERS: readonly number[] = Object.freeze([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
]);

export const RINGS: readonly ("double" | "triple")[] = Object.freeze([
  "double",
  "triple",
]);
