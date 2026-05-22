function currentHostApiBaseUrl(): string | null {
  if (typeof window === "undefined" || !window.location.protocol.startsWith("http")) {
    return null;
  }
  if (window.location.port === "5173" || window.location.port === "3000") {
    return `${window.location.protocol}//${window.location.hostname}:8000`;
  }
  return window.location.origin;
}

const LOCAL_API_BASE_CANDIDATES = ["http://127.0.0.1:8000", "http://localhost:8000"];
const API_BASE_CANDIDATES = [
  currentHostApiBaseUrl(),
  ...LOCAL_API_BASE_CANDIDATES,
].filter((url, index, urls): url is string => Boolean(url) && urls.indexOf(url) === index);

// Keep a stable preferred base once one succeeds, but still allow fallback if it fails later.
let preferredBaseUrl: string = API_BASE_CANDIDATES[0];

export const API_BASE_URL = preferredBaseUrl;

function isJsonResponse(response: Response): boolean {
  return String(response.headers.get("content-type") || "").toLowerCase().includes("application/json");
}

async function fetchWithBackendFallback(path: string, init?: RequestInit): Promise<Response> {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const candidates = [preferredBaseUrl, ...API_BASE_CANDIDATES.filter((u) => u !== preferredBaseUrl)];

  let lastError: unknown = null;
  for (const base of candidates) {
    try {
      const response = await fetch(`${base}${normalizedPath}`, init);
      if (response.ok && !isJsonResponse(response)) {
        lastError = new Error(`Backend returned non-JSON from ${base}${normalizedPath}`);
        continue;
      }
      preferredBaseUrl = base;
      return response;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Network request failed");
}

export async function postJson<T = any>(path: string, payload?: unknown): Promise<T> {
  const response = await fetchWithBackendFallback(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((data && (data.message || data.detail)) || `Request failed: ${response.status}`);
  }
  return data as T;
}

export async function getJson<T = any>(path: string): Promise<T> {
  const response = await fetchWithBackendFallback(path);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((data && (data.message || data.detail)) || `Request failed: ${response.status}`);
  }
  return data as T;
}
