export function getBackendUiBaseUrl(): string {
  const { protocol, hostname, port } = window.location;

  if (port === "3000") {
    return `${protocol}//${hostname}:5173`;
  }

  return window.location.origin;
}
