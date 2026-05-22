import { API_BASE_URL } from "./api";
import { getFlavorConfig } from "../config/productFlavor";

const INSTALL_ID_KEY = "md_owner_analytics_install_id";

let sessionStartPromise: Promise<void> | null = null;

function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `md-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function getInstallId(): string {
  const existing = localStorage.getItem(INSTALL_ID_KEY)?.trim();
  if (existing) {
    return existing;
  }
  const created = generateId();
  localStorage.setItem(INSTALL_ID_KEY, created);
  return created;
}

async function resolveAppVersion(): Promise<string | null> {
  const fallback = String(import.meta.env.VITE_APP_VERSION || "").trim() || null;
  if (!("__TAURI_INTERNALS__" in window)) {
    return fallback;
  }
  try {
    const appModule = await import("@tauri-apps/api/app");
    return (await appModule.getVersion()) || fallback;
  } catch {
    return fallback;
  }
}

export function ensureOwnerAnalyticsSessionStarted(): Promise<void> {
  if (sessionStartPromise) {
    return sessionStartPromise;
  }

  sessionStartPromise = (async () => {
    try {
      const flavor = getFlavorConfig();
      const payload = {
        installId: getInstallId(),
        sessionId: generateId(),
        appVersion: await resolveAppVersion(),
        productFlavor: flavor.flavor,
        uiShell: flavor.shell,
        platform: navigator.platform || navigator.userAgent || "unknown",
        isTauri: "__TAURI_INTERNALS__" in window,
        userAgent: navigator.userAgent || "",
        language: navigator.language || "",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
      };
      await fetch(`${API_BASE_URL}/api/owner-analytics/session-start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch {
      // Best-effort only.
    }
  })();

  return sessionStartPromise;
}
