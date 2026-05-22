type DetectionMessage = Record<string, any>;
type Listener = (data: DetectionMessage) => void;
type VoidListener = () => void;

const STATUS_THROTTLE_MS = 250;

let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let connecting = false;

const listeners = new Set<Listener>();
const openListeners = new Set<VoidListener>();
const closeListeners = new Set<VoidListener>();
const errorListeners = new Set<(event: Event) => void>();
let lastStatusAt = 0;
let lastStatusKey = "";

function detectionWsUrl(): string {
  if (typeof window !== "undefined" && window.location.protocol.startsWith("http")) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    if (window.location.port === "5173" || window.location.port === "3000") {
      return `${protocol}//${window.location.hostname}:8000/ws/detection`;
    }
    return `${protocol}//${window.location.host}/ws/detection`;
  }
  return "ws://localhost:8000/ws/detection";
}

function notifyOpen() {
  openListeners.forEach((cb) => cb());
}

function notifyClose() {
  closeListeners.forEach((cb) => cb());
}

function notifyError(event: Event) {
  errorListeners.forEach((cb) => cb(event));
}

function notifyMessage(data: DetectionMessage) {
  if (data && data.event === "detection_status_update") {
    const now = Date.now();
    const key = `${data.dart_count ?? ""}|${data.detection_state ?? ""}|${data.is_active ?? ""}`;
    if (key === lastStatusKey && now - lastStatusAt < STATUS_THROTTLE_MS) {
      return;
    }
    lastStatusKey = key;
    lastStatusAt = now;
  }
  listeners.forEach((cb) => cb(data));
}

function clearReconnect() {
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer || listeners.size === 0) {
    return;
  }
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 3000);
}

function connect() {
  if (connecting) {
    return;
  }
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  connecting = true;
  socket = new WebSocket(detectionWsUrl());
  socket.onopen = () => {
    connecting = false;
    clearReconnect();
    notifyOpen();
  };
  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      notifyMessage(data);
    } catch (err) {
      // Ignore malformed payloads.
    }
  };
  socket.onerror = (event) => {
    notifyError(event);
  };
  socket.onclose = () => {
    connecting = false;
    notifyClose();
    scheduleReconnect();
  };
}

function disconnectIfIdle() {
  if (listeners.size > 0) {
    return;
  }
  clearReconnect();
  if (socket) {
    try {
      socket.close();
    } catch (err) {
      // ignore
    }
  }
  socket = null;
  connecting = false;
}

export function subscribeDetection(listener: Listener): () => void {
  listeners.add(listener);
  connect();
  return () => {
    listeners.delete(listener);
    disconnectIfIdle();
  };
}

export function onDetectionOpen(listener: VoidListener): () => void {
  openListeners.add(listener);
  connect();
  return () => {
    openListeners.delete(listener);
    disconnectIfIdle();
  };
}

export function onDetectionClose(listener: VoidListener): () => void {
  closeListeners.add(listener);
  connect();
  return () => {
    closeListeners.delete(listener);
    disconnectIfIdle();
  };
}

export function onDetectionError(listener: (event: Event) => void): () => void {
  errorListeners.add(listener);
  connect();
  return () => {
    errorListeners.delete(listener);
    disconnectIfIdle();
  };
}
