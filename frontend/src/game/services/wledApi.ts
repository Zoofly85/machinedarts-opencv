import { getJson, postJson } from "./apiClient";

export type WledEventConfig = {
  mode: "color" | "effect" | "preset";
  color: number[];
  effect?: number;
  preset?: number;
  duration_ms?: number;
};

export type WledSettings = {
  enabled: boolean;
  host: string;
  brightness: number;
  timeout_ms: number;
  events: Record<string, WledEventConfig>;
};

export async function getWledSettings(): Promise<{ settings: WledSettings }> {
  return getJson("/api/wled/settings");
}

export async function updateWledSettings(settings: WledSettings): Promise<{ status: string; settings: WledSettings }> {
  return postJson("/api/wled/settings", settings);
}

export async function testWledEvent(event: string): Promise<unknown> {
  return postJson("/api/wled/test", { event });
}
