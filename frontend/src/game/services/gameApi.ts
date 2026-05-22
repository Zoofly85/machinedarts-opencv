import { getJson, postJson } from "./apiClient";

export type GameModeApi =
  | "x01"
  | "cricket"
  | "around_the_clock"
  | "beer_race"
  | "bermuda"
  | "bob27"
  | "shanghai"
  | "target-trainer"
  | "one_two_one"
  | "pacman";

export async function startGame<TState = any>(mode: GameModeApi, payload: unknown): Promise<TState> {
  const data = await postJson<any>(`/api/${mode}/start`, payload);
  return (data?.state ?? data) as TState;
}

export async function getGameState<TState = any>(mode: GameModeApi): Promise<TState> {
  return await getJson<TState>(`/api/${mode}/state`);
}

export async function stopGame(mode: GameModeApi): Promise<void> {
  await postJson(`/api/${mode}/stop`);
}

export async function forceNextTurn<TState = any>(mode: GameModeApi): Promise<TState> {
  const data = await postJson<any>(`/api/${mode}/force-next-turn`);
  return (data?.state ?? data) as TState;
}

export async function undoTurn<TState = any>(mode: GameModeApi): Promise<TState> {
  const data = await postJson<any>(`/api/${mode}/undo-turn`);
  return (data?.state ?? data) as TState;
}

export async function applyRemoteTurn<TState = any>(mode: Extract<GameModeApi, "x01">, payload: unknown): Promise<TState> {
  const data = await postJson<any>(`/api/${mode}/apply-remote-turn`, payload);
  return (data?.state ?? data) as TState;
}

export async function recordRemoteDart<TState = any>(mode: Extract<GameModeApi, "x01">, payload: unknown): Promise<TState> {
  const data = await postJson<any>(`/api/${mode}/record-remote-dart`, payload);
  return (data?.state ?? data) as TState;
}

export async function commitRemoteTurn<TState = any>(mode: Extract<GameModeApi, "x01">, payload: unknown): Promise<TState> {
  const data = await postJson<any>(`/api/${mode}/commit-remote-turn`, payload);
  return (data?.state ?? data) as TState;
}
