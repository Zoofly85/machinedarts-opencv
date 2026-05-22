const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

export function isOwnerAnalyticsUiEnabled(): boolean {
  return ENABLED_VALUES.has(String(import.meta.env.VITE_OWNER_ANALYTICS_UI || "").trim().toLowerCase());
}
