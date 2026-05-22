import { postJson } from "./apiClient";

export interface DartCorrectionPayload {
  dartIndex: number;
  multiplier: number;
  segment: number;
  score: number;
}

interface StatusResponse {
  status?: string;
  message?: string;
}

function ensureSuccess(data: StatusResponse, fallback: string): void {
  if (data?.status && data.status !== "success") {
    throw new Error(data.message || fallback);
  }
}

export async function correctScore(payload: DartCorrectionPayload): Promise<void> {
  const data = await postJson<StatusResponse>("/api/correction/score", payload);
  ensureSuccess(data, "Failed to correct score");
}

export async function addDart(payload: DartCorrectionPayload): Promise<void> {
  const data = await postJson<StatusResponse>("/api/correction/add-dart", payload);
  ensureSuccess(data, "Failed to add dart");
}

export async function deleteCorrectionImages(dartIndex: number): Promise<void> {
  await postJson("/api/correction/delete-images", { dartIndex });
}
