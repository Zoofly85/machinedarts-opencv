export const API_BASE_URL = "http://localhost:8000";

export async function postJson<T = any>(path: string, payload?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
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
  const response = await fetch(`${API_BASE_URL}${path}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((data && (data.message || data.detail)) || `Request failed: ${response.status}`);
  }
  return data as T;
}
