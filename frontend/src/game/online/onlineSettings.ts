import type { OnlineGameSettings } from "./supabaseOnline";

const ONLINE_SETTINGS_KEY = "md_online_game_settings";

export function setStoredOnlineSettings(settings: OnlineGameSettings): void {
  localStorage.setItem(ONLINE_SETTINGS_KEY, JSON.stringify(settings));
}

export function getStoredOnlineSettings(): OnlineGameSettings | null {
  const raw = localStorage.getItem(ONLINE_SETTINGS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OnlineGameSettings;
  } catch {
    return null;
  }
}

export function clearStoredOnlineSettings(): void {
  localStorage.removeItem(ONLINE_SETTINGS_KEY);
}
