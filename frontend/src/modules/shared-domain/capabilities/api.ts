import { API_BASE_URL } from "../../../services/api";
import type { AuthSessionPayload } from "./types";

export async function fetchAuthSession(): Promise<AuthSessionPayload> {
  const res = await fetch(`${API_BASE_URL}/api/auth/session`);
  if (!res.ok) {
    throw new Error(`Failed to fetch auth session (${res.status})`);
  }
  return (await res.json()) as AuthSessionPayload;
}

