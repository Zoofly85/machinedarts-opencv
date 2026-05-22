const configuredApiBaseUrl = String(import.meta.env.VITE_API_BASE_URL || "").trim();

function defaultApiBaseUrl(): string {
  if (typeof window === "undefined" || !window.location.protocol.startsWith("http")) {
    return "http://127.0.0.1:8000";
  }

  if (window.location.port === "5173" || window.location.port === "3000") {
    return `${window.location.protocol}//${window.location.hostname}:8000`;
  }

  return window.location.origin;
}

export const API_BASE_URL = configuredApiBaseUrl || defaultApiBaseUrl();
const MODEL_SETTINGS_CACHE_TTL_MS = 30_000;
let modelSettingsCache: { data: any; ts: number } | null = null;
let modelSettingsInFlight: Promise<any> | null = null;

export async function getCameras() {
  const res = await fetch(`${API_BASE_URL}/api/cameras`);
  if (!res.ok) throw new Error("Failed to fetch cameras");
  return res.json();
}

export async function getCalibrationStatus(cameraIndex: number) {
  const res = await fetch(`${API_BASE_URL}/api/calibration/status/${cameraIndex}`);
  if (!res.ok) throw new Error("Failed to fetch calibration status");
  return res.json();
}

export async function rotateCalibration(cameraIndex: number) {
  const res = await fetch(`${API_BASE_URL}/api/calibration/rotate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ camera_index: cameraIndex }),
  });
  if (!res.ok) throw new Error("Failed to rotate calibration");
  return res.json();
}

export async function saveCalibration(cameraIndex: number) {
  const res = await fetch(`${API_BASE_URL}/api/calibration/save/${cameraIndex}`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to save calibration");
  return res.json();
}

export async function getDetectionSettings() {
  const res = await fetch(`${API_BASE_URL}/api/settings/detection`);
  if (!res.ok) throw new Error("Failed to fetch detection settings");
  return res.json();
}

export async function updateDetectionSettings(settings: Record<string, unknown>) {
  const res = await fetch(`${API_BASE_URL}/api/settings/detection`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings }),
  });
  if (!res.ok) throw new Error("Failed to update detection settings");
  return res.json();
}

export async function resetDetectionSettings() {
  const res = await fetch(`${API_BASE_URL}/api/settings/detection/reset`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to reset detection settings");
  return res.json();
}

export async function getDetectionInsights() {
  const res = await fetch(`${API_BASE_URL}/api/settings/detection/insights`);
  if (!res.ok) throw new Error("Failed to fetch detection insights");
  return res.json();
}

export async function setDetectionPageActive(enabled: boolean) {
  const res = await fetch(`${API_BASE_URL}/api/settings/detection/page-active`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: Boolean(enabled) }),
  });
  if (!res.ok) throw new Error("Failed to update detection page activity");
  return res.json();
}

export async function pickReplayFolder(initialPath?: string) {
  const res = await fetch(`${API_BASE_URL}/api/settings/replay/pick-folder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initial_path: initialPath || "" }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to open folder picker (${res.status}) ${text}`.trim());
  }
  return res.json() as Promise<{ path?: string | null }>;
}

export async function getModelSettings(options?: { force?: boolean; maxAgeMs?: number }) {
  const force = Boolean(options?.force);
  const maxAgeMs = Number.isFinite(options?.maxAgeMs) ? Math.max(0, Number(options?.maxAgeMs)) : MODEL_SETTINGS_CACHE_TTL_MS;
  const now = Date.now();

  if (!force && modelSettingsCache && now - modelSettingsCache.ts <= maxAgeMs) {
    return modelSettingsCache.data;
  }
  if (!force && modelSettingsInFlight) {
    return modelSettingsInFlight;
  }

  modelSettingsInFlight = (async () => {
    const res = await fetch(`${API_BASE_URL}/api/settings/models`);
    if (!res.ok) throw new Error("Failed to fetch model settings");
    const data = await res.json();
    modelSettingsCache = { data, ts: Date.now() };
    return data;
  })();

  try {
    return await modelSettingsInFlight;
  } finally {
    modelSettingsInFlight = null;
  }
}

export async function updateModelSettings(settings: Record<string, unknown>) {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/api/settings/models`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings }),
    });
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : "Failed to reach backend");
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(String(data?.detail ?? "Failed to update model settings"));
  }
  const data = await res.json();
  modelSettingsCache = { data, ts: Date.now() };
  return data;
}

export async function getModelAccuracyStats() {
  const res = await fetch(`${API_BASE_URL}/api/settings/models/stats`);
  if (!res.ok) throw new Error("Failed to fetch model accuracy stats");
  return res.json();
}

export async function resetModelAccuracyStats() {
  const res = await fetch(`${API_BASE_URL}/api/settings/models/stats/reset`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to reset model accuracy stats");
  return res.json();
}

export async function getSystemAccuracyStats() {
  const res = await fetch(`${API_BASE_URL}/api/settings/system-accuracy`);
  if (!res.ok) throw new Error("Failed to fetch system accuracy stats");
  return res.json();
}

export async function resetSystemAccuracyStats() {
  const res = await fetch(`${API_BASE_URL}/api/settings/system-accuracy/reset`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to reset system accuracy stats");
  return res.json();
}

export async function getBotSpeed() {
  const res = await fetch(`${API_BASE_URL}/api/bots/speed`);
  if (!res.ok) throw new Error("Failed to fetch bot speed");
  return res.json();
}

export async function updateBotSpeed(speed: "slow" | "normal" | "fast") {
  const res = await fetch(`${API_BASE_URL}/api/bots/speed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ speed }),
  });
  if (!res.ok) throw new Error("Failed to update bot speed");
  return res.json();
}

