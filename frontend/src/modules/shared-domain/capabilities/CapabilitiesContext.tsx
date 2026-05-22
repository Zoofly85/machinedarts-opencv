import React from "react";

import { fetchAuthSession } from "./api";
import type { AuthSessionPayload, CapabilityMap } from "./types";

type CapabilitiesContextValue = {
  session: AuthSessionPayload | null;
  loading: boolean;
  error: string | null;
  can: (name: keyof CapabilityMap) => boolean;
};

const CapabilitiesContext = React.createContext<CapabilitiesContextValue | undefined>(undefined);

const DEFAULT_CAPABILITIES: CapabilityMap = {
  can_use_home: true,
  can_use_dashboard: false,
  can_manage_sessions: false,
  can_lock_settings: false,
  can_view_club_analytics: false,
  can_use_club_board: false,
  cloud_sync_enabled: false,
};

export function CapabilitiesProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<AuthSessionPayload | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const next = await fetchAuthSession();
        if (cancelled) return;
        setSession(next);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Unknown error");
        setSession(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const can = React.useCallback(
    (name: keyof CapabilityMap) => {
      const caps = session?.entitlements?.capabilities ?? DEFAULT_CAPABILITIES;
      return Boolean(caps[name]);
    },
    [session]
  );

  const value = React.useMemo<CapabilitiesContextValue>(() => ({ session, loading, error, can }), [session, loading, error, can]);
  return <CapabilitiesContext.Provider value={value}>{children}</CapabilitiesContext.Provider>;
}

export function useCapabilities() {
  const ctx = React.useContext(CapabilitiesContext);
  if (!ctx) {
    throw new Error("useCapabilities must be used inside CapabilitiesProvider");
  }
  return ctx;
}

