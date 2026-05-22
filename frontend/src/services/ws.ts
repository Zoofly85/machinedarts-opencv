function wsBaseUrl(): string {
  if (typeof window !== "undefined" && window.location.protocol.startsWith("http")) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    if (window.location.port === "5173" || window.location.port === "3000") {
      return `${protocol}//${window.location.hostname}:8000`;
    }
    return `${protocol}//${window.location.host}`;
  }
  return "ws://127.0.0.1:8000";
}

export function buildCameraWsUrl(cameraIndex: number): string {
  return `${wsBaseUrl()}/ws/camera/${cameraIndex}`;
}

export function buildEventsWsUrl(): string {
  return `${wsBaseUrl()}/ws/events`;
}


