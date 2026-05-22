function resolveSystemStatusWsUrl(): string {
  const host = window.location.hostname || "127.0.0.1";
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${host}:8000/ws/system/status`;
}

export type SystemStatusMessage = {
  initialization?: unknown;
  detection_status?: unknown;
  insights?: unknown;
  camera_status?: unknown;
  at_ms?: number;
};

export function connectSystemStatus(
  onMessage: (payload: SystemStatusMessage) => void,
  onStateChange?: (state: "open" | "closed" | "error") => void,
): () => void {
  const url = resolveSystemStatusWsUrl();
  let ws: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let closedByUser = false;

  const connect = () => {
    if (closedByUser) {
      return;
    }
    ws = new WebSocket(url);

    ws.onopen = () => onStateChange?.("open");
    ws.onerror = () => onStateChange?.("error");
    ws.onclose = () => {
      onStateChange?.("closed");
      if (!closedByUser) {
        reconnectTimer = window.setTimeout(connect, 1000);
      }
    };
    ws.onmessage = (event) => {
      try {
        onMessage(JSON.parse(event.data) as SystemStatusMessage);
      } catch {
        // Ignore malformed payloads.
      }
    };
  };

  connect();

  return () => {
    closedByUser = true;
    if (reconnectTimer != null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    try {
      ws?.close();
    } catch {
      // Ignore close failures.
    }
  };
}
