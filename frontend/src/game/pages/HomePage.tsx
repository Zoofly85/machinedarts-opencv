import React from "react";
import { motion } from "framer-motion";
import { PlayCircle, Target, User, Compass, Settings, Bot, Wifi } from "lucide-react";
import { Link } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { API_BASE_URL } from "../../services/api";
import Logo from "../components/Logo";
import DartboardSVG from "../components/DartboardSVG";
import ActionButton from "../components/ActionButton";
import { isOwnerAnalyticsUiEnabled } from "../../config/ownerAnalyticsUi";
import packageJson from "../../../package.json";

const MIN_UPDATE_VERSION = "1.1.0";
const PACKAGE_VERSION = String(packageJson.version || "").trim();

function parseSemver(version: string): [number, number, number] {
  const clean = String(version || "").trim().replace(/^v/i, "");
  const [major = "0", minor = "0", patchPart = "0"] = clean.split(".");
  const patch = patchPart.split("-")[0];
  return [
    Number.parseInt(major, 10) || 0,
    Number.parseInt(minor, 10) || 0,
    Number.parseInt(patch, 10) || 0,
  ];
}

function compareSemver(a: string, b: string): number {
  const av = parseSemver(a);
  const bv = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    if (av[i] > bv[i]) return 1;
    if (av[i] < bv[i]) return -1;
  }
  return 0;
}

function friendlyUpdaterError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? "").trim();
  if (!message) return "Failed to check for updates.";
  if (/latest\.json|404|check failed/i.test(message)) {
    return "Update feed not found (latest.json missing in updater repo).";
  }
  return message;
}

export default function HomePage() {
  const [dartboardSize, setDartboardSize] = React.useState(700);
  const [isClosingApp, setIsClosingApp] = React.useState(false);
  const [isCheckingUpdate, setIsCheckingUpdate] = React.useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = React.useState(false);
  const [updateMessage, setUpdateMessage] = React.useState<string | null>(null);
  const [availableVersion, setAvailableVersion] = React.useState<string | null>(null);
  const [appVersion, setAppVersion] = React.useState(PACKAGE_VERSION);
  const pendingUpdateRef = React.useRef<Update | null>(null);
  const isTauriApp = React.useMemo(() => "__TAURI_INTERNALS__" in window, []);
  const ownerAnalyticsUiEnabled = React.useMemo(() => isOwnerAnalyticsUiEnabled(), []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const key = e.key.toLowerCase();
      if (key === "p") window.location.hash = "#/practice";
      if (key === "g") window.location.hash = "#/game";
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  React.useEffect(() => {
    const updateSize = () => {
      const maxWidth = Math.min(window.innerWidth * 0.95, 800);
      const maxHeight = Math.min(window.innerHeight * 0.8, 800);
      setDartboardSize(Math.min(maxWidth, maxHeight));
    };

    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    const maybeUploadTrainingData = async () => {
      try {
        const countResp = await fetch(`${API_BASE_URL}/api/training-data/count`);
        if (!countResp.ok || cancelled) return;
        const countData = await countResp.json();
        const total = Number(countData?.counts?.total ?? 0);
        if (!Number.isFinite(total) || total < 10) return;
        await fetch(`${API_BASE_URL}/api/training-data/upload`, { method: "POST" });
      } catch {
        // Best-effort only on home page.
      }
    };

    void maybeUploadTrainingData();
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    return () => {
      const pending = pendingUpdateRef.current;
      pendingUpdateRef.current = null;
      if (pending) {
        pending.close().catch(() => undefined);
      }
    };
  }, []);

  React.useEffect(() => {
    if (!isTauriApp) return;
    let cancelled = false;
    getVersion()
      .then((version) => {
        if (!cancelled && version) setAppVersion(version);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isTauriApp]);

  const handleCloseMachineDarts = React.useCallback(async () => {
    if (!isTauriApp || isClosingApp) {
      return;
    }
    setIsClosingApp(true);
    try {
      await invoke("close_machine_darts");
    } catch {
      setIsClosingApp(false);
    }
  }, [isTauriApp, isClosingApp]);

  const handleCheckForUpdates = React.useCallback(async () => {
    if (!isTauriApp || isCheckingUpdate || isInstallingUpdate) return;
    setIsCheckingUpdate(true);
    setUpdateMessage("Checking for updates...");
    setAvailableVersion(null);
    try {
      const currentVersion = await getVersion();
      const update = await check();
      if (!update) {
        setUpdateMessage("You are up to date.");
        return;
      }
      if (compareSemver(update.version, MIN_UPDATE_VERSION) < 0) {
        await update.close().catch(() => undefined);
        setUpdateMessage(
          `Update ${update.version} ignored (minimum supported update is ${MIN_UPDATE_VERSION}).`
        );
        return;
      }
      // Extra guard in case feed serves an older build.
      if (compareSemver(update.version, currentVersion) <= 0) {
        await update.close().catch(() => undefined);
        setUpdateMessage("You are up to date.");
        return;
      }
      if (pendingUpdateRef.current) {
        await pendingUpdateRef.current.close().catch(() => undefined);
      }
      pendingUpdateRef.current = update;
      setAvailableVersion(update.version);
      setUpdateMessage(`Update available: ${update.version}`);
    } catch (err) {
      setUpdateMessage(friendlyUpdaterError(err));
    } finally {
      setIsCheckingUpdate(false);
    }
  }, [isTauriApp, isCheckingUpdate, isInstallingUpdate]);

  const handleInstallUpdate = React.useCallback(async () => {
    const pending = pendingUpdateRef.current;
    if (!pending || isInstallingUpdate) return;
    setIsInstallingUpdate(true);
    try {
      // Ensure backend files are not locked before NSIS installer runs.
      await invoke("prepare_update_install").catch(() => undefined);
      await pending.downloadAndInstall((event) => {
        if (event.event === "Started") {
          setUpdateMessage("Downloading update...");
        } else if (event.event === "Progress") {
          setUpdateMessage(`Downloading update... +${event.data.chunkLength} bytes`);
        } else if (event.event === "Finished") {
          setUpdateMessage("Download complete. Installing...");
        }
      });
      setUpdateMessage("Update installed. Please restart Machine Darts.");
      setAvailableVersion(null);
      await pending.close().catch(() => undefined);
      pendingUpdateRef.current = null;
    } catch (err) {
      setUpdateMessage(err instanceof Error ? err.message : "Failed to install update.");
    } finally {
      setIsInstallingUpdate(false);
    }
  }, [isInstallingUpdate]);

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden">
      <div className="pointer-events-none fixed inset-0 [background:
        radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
        radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.08),transparent_70%),
        radial-gradient(ellipse_at_bottom_left,rgba(255,255,255,0.06),transparent_70%),
        radial-gradient(ellipse_at_bottom_right,rgba(255,255,255,0.1),transparent_65%),
        linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95) 30%,rgba(255,255,255,0.04) 60%,rgba(0,0,0,1) 100%)
      ]" />

      <header className="relative z-10 w-full px-6 md:px-10 py-6 flex items-center justify-between">
        <Logo />
      </header>

      <main className="relative z-10 w-full px-6 md:px-10 flex-1 flex items-center">
        <section className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-4 items-center py-8 w-full min-h-[calc(100vh-160px)]">
          <div className="space-y-12 max-w-3xl mx-auto">
            <motion.h1
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              className="text-6xl sm:text-7xl font-extrabold leading-tight text-center lg:text-left"
            >
              Precision <span className="text-red-500">Automatic</span> Dart Scoring
            </motion.h1>

            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.1 }}
              className="flex flex-col gap-6 w-full max-w-xl mx-auto lg:mx-0"
            >
              <ActionButton
                href="/practice"
                label="Practice"
                aria="Start practice session"
                icon={<Target className="h-7 w-7" />}
                kbd="P"
              />
              <ActionButton
                href="/game"
                label="Game"
                aria="Start a new match"
                icon={<PlayCircle className="h-7 w-7" />}
                kbd="G"
              />
              <ActionButton
                href="/online"
                label="Online"
                aria="Create or join an online match"
                icon={<Wifi className="h-7 w-7" />}
              />
              <ActionButton
                href="/profile"
                label="Profiles"
                aria="View player profiles and stats"
                icon={<User className="h-7 w-7" />}
              />
              <ActionButton
                href="/settings/player-bots"
                label="Player Bots"
                aria="Export and import player bots"
                icon={<Bot className="h-7 w-7" />}
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Link
                  to="/calibration"
                  className="group inline-flex items-center justify-between gap-4 w-full rounded-2xl px-8 py-5 text-lg font-semibold tracking-wide border border-red-600/60 bg-red-600/90 text-white shadow-lg shadow-red-900/40 hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-500 transition"
                >
                  <span className="flex items-center gap-3">
                    <Compass className="h-7 w-7" />
                    Calibration
                  </span>
                </Link>
                <Link
                  to="/settings/runtime"
                  className="group inline-flex items-center justify-between gap-4 w-full rounded-2xl px-8 py-5 text-lg font-semibold tracking-wide border border-red-600/60 bg-red-600/90 text-white shadow-lg shadow-red-900/40 hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-500 transition"
                >
                  <span className="flex items-center gap-3">
                    <Settings className="h-7 w-7" />
                    Backend Settings
                  </span>
                </Link>
              </div>
              {ownerAnalyticsUiEnabled && (
                <Link
                  to="/owner-analytics"
                  className="group inline-flex items-center justify-between gap-4 w-full rounded-2xl px-8 py-5 text-lg font-semibold tracking-wide border border-emerald-600/50 bg-emerald-700/20 text-emerald-100 shadow-lg shadow-emerald-950/30 hover:bg-emerald-700/30 focus:outline-none focus:ring-2 focus:ring-emerald-500 transition"
                >
                  <span className="flex items-center gap-3">
                    <Wifi className="h-7 w-7" />
                    Owner Analytics
                  </span>
                  <span className="text-xs uppercase tracking-[0.22em] text-emerald-300/80">Local Only</span>
                </Link>
              )}
              {isTauriApp && (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={handleCheckForUpdates}
                      disabled={isCheckingUpdate || isInstallingUpdate}
                      className="inline-flex items-center justify-center gap-3 w-full rounded-2xl px-6 py-4 text-base font-semibold tracking-wide border border-cyan-600/70 bg-cyan-700/90 text-white shadow-lg shadow-cyan-900/40 hover:bg-cyan-600 focus:outline-none focus:ring-2 focus:ring-cyan-500 transition disabled:opacity-70"
                    >
                      {isCheckingUpdate ? "Checking..." : "Check for Updates"}
                    </button>
                    <button
                      type="button"
                      onClick={handleInstallUpdate}
                      disabled={!availableVersion || isInstallingUpdate || isCheckingUpdate}
                      className="inline-flex items-center justify-center gap-3 w-full rounded-2xl px-6 py-4 text-base font-semibold tracking-wide border border-emerald-600/70 bg-emerald-700/90 text-white shadow-lg shadow-emerald-900/40 hover:bg-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-500 transition disabled:opacity-50"
                    >
                      {isInstallingUpdate ? "Installing..." : availableVersion ? `Install ${availableVersion}` : "Install Update"}
                    </button>
                  </div>
                  {updateMessage && (
                    <div className="rounded-lg border border-white/15 bg-black/40 px-4 py-2 text-sm text-zinc-200">
                      {updateMessage}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={handleCloseMachineDarts}
                    disabled={isClosingApp}
                    className="inline-flex items-center justify-center gap-3 w-full rounded-2xl px-8 py-5 text-lg font-semibold tracking-wide border border-red-700/70 bg-red-700/90 text-white shadow-lg shadow-red-900/40 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 transition disabled:opacity-70"
                  >
                    {isClosingApp ? "Closing Machine Darts..." : "Close Machine Darts App"}
                  </button>
                </div>
              )}
            </motion.div>
          </div>

          <div className="relative flex items-center justify-center w-full h-full">
            <motion.div
              initial={{ scale: 0.92, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 120, damping: 18 }}
              className="relative w-full h-full flex items-center justify-center"
            >
              <motion.div
                initial={{ rotate: 0 }}
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, repeatType: "loop", duration: 24, ease: "linear" }}
                style={{ transformOrigin: "50% 50%" }}
                className="drop-shadow-[0_0_60px_rgba(220,38,38,0.4)]"
              >
                <DartboardSVG size={dartboardSize} />
              </motion.div>
            </motion.div>
          </div>
        </section>
      </main>

      <footer className="relative z-10 border-t border-white/10 py-6 text-center text-xs text-zinc-500">
        © {new Date().getFullYear()} Machine Darts
      </footer>
      {appVersion && (
        <div className="pointer-events-none fixed bottom-5 right-6 z-20 rounded-md border border-white/10 bg-black/65 px-3 py-1.5 text-sm font-semibold tabular-nums text-zinc-200 shadow-lg shadow-black/40">
          v{appVersion}
        </div>
      )}
    </div>
  );
}
