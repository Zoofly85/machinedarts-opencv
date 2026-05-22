import React from "react";

import LauncherControlPage from "./game/pages/LauncherControlPage";
import { getFlavorConfig } from "./config/productFlavor";
import HomeShell from "./modules/home/HomeShell";
import ClubBoardShell from "./modules/club-board/ClubBoardShell";
import ClubMasterShell from "./modules/club-master/ClubMasterShell";
import WrongInstallerPage from "./modules/shared-ui/WrongInstallerPage";
import { CapabilitiesProvider, useCapabilities } from "./modules/shared-domain/capabilities/CapabilitiesContext";
import { ensureOwnerAnalyticsSessionStarted } from "./services/ownerAnalytics";

type TabletPreviewConfig = {
  enabled: boolean;
  width: number;
  height: number;
};

const TABLET_PRESETS: Array<{ label: string; width: number; height: number }> = [
  { label: "Android 10in Portrait", width: 800, height: 1280 },
  { label: "iPad 10.2 Portrait", width: 810, height: 1080 },
  { label: "iPad Pro 11 Portrait", width: 834, height: 1194 },
  { label: "Android 10in Landscape", width: 1280, height: 800 },
  { label: "1366x768 Kiosk", width: 1366, height: 768 },
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseTabletPreviewConfig(): TabletPreviewConfig {
  if (typeof window === "undefined") {
    return { enabled: false, width: 800, height: 1280 };
  }
  const params = new URLSearchParams(window.location.search || "");
  const enabledRaw = String(params.get("tablet") || "").toLowerCase();
  const enabled = enabledRaw === "1" || enabledRaw === "true" || enabledRaw === "yes" || enabledRaw === "on";
  const width = clamp(Number(params.get("tabletWidth") || 800), 600, 1600);
  const height = clamp(Number(params.get("tabletHeight") || 1280), 600, 1600);
  return {
    enabled,
    width: Number.isFinite(width) ? width : 800,
    height: Number.isFinite(height) ? height : 1280,
  };
}

function TabletPreviewFrame({
  config,
  children,
}: {
  config: TabletPreviewConfig;
  children: React.ReactNode;
}) {
  if (!config.enabled) return <>{children}</>;

  const applyPreset = (width: number, height: number) => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search || "");
    params.set("tablet", "1");
    params.set("tabletWidth", String(width));
    params.set("tabletHeight", String(height));
    const nextSearch = params.toString();
    const hash = window.location.hash || "";
    window.location.replace(`${window.location.pathname}?${nextSearch}${hash}`);
  };

  return (
    <div className="min-h-screen bg-zinc-950 p-4 md:p-6">
      <div className="mx-auto max-w-[1900px]">
        <div className="mb-3 flex flex-wrap items-center justify-center gap-2">
          {TABLET_PRESETS.map((preset) => {
            const active = config.width === preset.width && config.height === preset.height;
            return (
              <button
                key={`${preset.width}x${preset.height}`}
                type="button"
                onClick={() => applyPreset(preset.width, preset.height)}
                className={`rounded-md border px-2.5 py-1 text-[11px] tracking-[0.12em] ${
                  active
                    ? "border-cyan-500 bg-cyan-900/30 text-cyan-200"
                    : "border-zinc-700 bg-zinc-900/60 text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                {preset.label} {preset.width}x{preset.height}
              </button>
            );
          })}
        </div>
        <div className="mb-3 text-center text-[11px] uppercase tracking-[0.22em] text-zinc-500">
          Tablet Preview {config.width}x{config.height}
        </div>
        <div
          className="mx-auto overflow-hidden rounded-[28px] border border-zinc-700/70 bg-black shadow-[0_30px_80px_rgba(0,0,0,0.7)]"
          style={{ width: `${config.width}px`, height: `${config.height}px`, maxWidth: "100%" }}
        >
          <div className="h-full overflow-y-auto overflow-x-hidden">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

function ShellGate() {
  const { session, loading, error } = useCapabilities();
  const flavor = getFlavorConfig();
  React.useEffect(() => {
    if (!session) return;
    const role = session?.board_context?.role ?? "home_user";
    const venue = session?.board_context?.venue_id ?? "local-venue";
    const board = session?.board_context?.board_id ?? "board-1";
    console.info("[diag] ui context", {
      flavor: flavor.flavor,
      shell: flavor.shell,
      role,
      venue,
      board,
      edition: session?.entitlements?.edition ?? "home",
    });
  }, [session, flavor.flavor, flavor.shell]);

  if (loading) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <div className="text-sm text-zinc-400">Loading session...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center px-6">
        <div className="max-w-xl w-full border border-red-800/70 rounded-2xl p-6 bg-zinc-950/90">
          <h1 className="text-xl font-semibold text-red-300">Session Check Failed</h1>
          <p className="mt-2 text-zinc-300">{error}</p>
          <p className="mt-4 text-sm text-zinc-500">Home shell fallback is available. Please verify backend auth endpoints.</p>
        </div>
      </div>
    );
  }

  const edition = session?.entitlements?.edition ?? "home";
  const role = session?.board_context?.role ?? "home_user";

  if (flavor.flavor === "club-board") {
    const allowed = session?.authenticated && edition === "club" && (role === "board_kiosk" || role === "operator");
    if (!allowed) {
      return (
        <WrongInstallerPage
          actual="Club Board"
          expected="Club Board account (club edition / board kiosk role)"
          message="This installer is for club board devices only. Sign in with a club board account or use the Home installer."
        />
      );
    }
    return <ClubBoardShell />;
  }

  if (flavor.flavor === "club-master") {
    const allowed = session?.authenticated && edition === "club" && role === "operator";
    if (!allowed) {
      return (
        <WrongInstallerPage
          actual="Club Master"
          expected="Club Operator account"
          message="This installer is for operator devices only. Sign in with an operator account or use the Board/Home installer."
        />
      );
    }
    return <ClubMasterShell />;
  }

  return <HomeShell />;
}

export default function App() {
  const isTauriShell = typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as any);
  const tabletPreviewConfig = React.useMemo(() => parseTabletPreviewConfig(), []);

  React.useEffect(() => {
    void ensureOwnerAnalyticsSessionStarted();
  }, []);

  if (isTauriShell) {
    return <LauncherControlPage />;
  }

  return (
    <TabletPreviewFrame config={tabletPreviewConfig}>
      <CapabilitiesProvider>
        <ShellGate />
      </CapabilitiesProvider>
    </TabletPreviewFrame>
  );
}
