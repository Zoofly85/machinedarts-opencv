import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";

const MIN_UPDATE_VERSION = "1.1.0";

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

export default function LauncherControlPage() {
  const [busy, setBusy] = React.useState<"close" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [updateMessage, setUpdateMessage] = React.useState<string | null>(null);
  const [availableVersion, setAvailableVersion] = React.useState<string | null>(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = React.useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = React.useState(false);
  const pendingUpdateRef = React.useRef<Update | null>(null);

  React.useEffect(() => {
    return () => {
      const pending = pendingUpdateRef.current;
      pendingUpdateRef.current = null;
      if (pending) {
        pending.close().catch(() => undefined);
      }
    };
  }, []);

  const closeMachineDarts = React.useCallback(async () => {
    if (busy || isCheckingUpdate || isInstallingUpdate) return;
    setBusy("close");
    setError(null);
    try {
      await invoke("close_machine_darts");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to close Machine Darts.");
      setBusy(null);
    }
  }, [busy, isCheckingUpdate, isInstallingUpdate]);

  const checkForUpdates = React.useCallback(async () => {
    if (isCheckingUpdate || isInstallingUpdate || busy) return;
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
    } catch (e) {
      setUpdateMessage(friendlyUpdaterError(e));
    } finally {
      setIsCheckingUpdate(false);
    }
  }, [busy, isCheckingUpdate, isInstallingUpdate]);

  const installUpdate = React.useCallback(async () => {
    const pending = pendingUpdateRef.current;
    if (!pending || isInstallingUpdate || isCheckingUpdate || busy) return;
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
    } catch (e) {
      setUpdateMessage(e instanceof Error ? e.message : "Failed to install update.");
    } finally {
      setIsInstallingUpdate(false);
    }
  }, [busy, isCheckingUpdate, isInstallingUpdate]);

  return (
    <div className="min-h-screen bg-black text-white flex items-center justify-center px-6">
      <div className="w-full max-w-md rounded-2xl border border-white/15 bg-zinc-950/90 p-6 shadow-2xl">
        <h1 className="text-2xl font-bold">Machine Darts Control</h1>
        <p className="mt-2 text-sm text-zinc-400">Use this window to update or close the Machine Darts app and backend.</p>

        <div className="mt-6 grid gap-3">
          <button
            type="button"
            onClick={checkForUpdates}
            disabled={busy !== null || isCheckingUpdate || isInstallingUpdate}
            className="w-full rounded-xl px-4 py-3 text-sm font-semibold bg-cyan-700 hover:bg-cyan-600 disabled:opacity-60"
          >
            {isCheckingUpdate ? "Checking..." : "Check for Updates"}
          </button>
          <button
            type="button"
            onClick={installUpdate}
            disabled={busy !== null || isCheckingUpdate || isInstallingUpdate || !availableVersion}
            className="w-full rounded-xl px-4 py-3 text-sm font-semibold bg-emerald-700 hover:bg-emerald-600 disabled:opacity-60"
          >
            {isInstallingUpdate ? "Installing..." : availableVersion ? `Install ${availableVersion}` : "Install Update"}
          </button>
          <button
            type="button"
            onClick={closeMachineDarts}
            disabled={busy !== null || isCheckingUpdate || isInstallingUpdate}
            className="w-full rounded-xl px-4 py-3 text-sm font-semibold bg-red-700 hover:bg-red-600 disabled:opacity-60"
          >
            {busy === "close" ? "Closing..." : "Close Machine Darts App"}
          </button>
        </div>

        {updateMessage && <p className="mt-4 text-sm text-zinc-200">{updateMessage}</p>}
        {error && <p className="mt-4 text-sm text-red-300">{error}</p>}
      </div>
    </div>
  );
}
