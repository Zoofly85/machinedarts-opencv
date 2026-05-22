import React from "react";
import { Cloud, Download, RefreshCw, Search, Share2, Trash2, Upload } from "lucide-react";
import BackendTopNav from "../components/BackendTopNav";
import {
  deleteImportedPlayerBot,
  exportPlayerBotBundle,
  getPlayerBotStatus,
  getPlayersCached,
  importCloudPlayerBotBundle,
  importPlayerBotBundle,
  listImportedPlayerBots,
  replaceImportedPlayerBot,
  type PlayerBotStatus,
  type PlayerProfile,
} from "../game/services/playersApi";
import {
  getLinkedCloudBotId,
  listCloudPlayerBots,
  publishPlayerBotToCloud,
  unshareCloudPlayerBot,
  type CloudPlayerBot,
} from "../game/services/playerBotCloudApi";

type Tab = "mine" | "marketplace";

function downloadJson(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function fmt(value: unknown): string {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(2) : "--";
}

function shortDate(value?: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Never" : date.toLocaleDateString();
}

export default function PlayerBotsPage() {
  const [activeTab, setActiveTab] = React.useState<Tab>("mine");
  const [profiles, setProfiles] = React.useState<PlayerProfile[]>([]);
  const [statuses, setStatuses] = React.useState<PlayerBotStatus[]>([]);
  const [importedBots, setImportedBots] = React.useState<PlayerBotStatus[]>([]);
  const [cloudBots, setCloudBots] = React.useState<CloudPlayerBot[]>([]);
  const [busyExportId, setBusyExportId] = React.useState<string | null>(null);
  const [sharingId, setSharingId] = React.useState<string | null>(null);
  const [installingCloudId, setInstallingCloudId] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [replacingBotId, setReplacingBotId] = React.useState<string | null>(null);
  const [deletingBotId, setDeletingBotId] = React.useState<string | null>(null);
  const [cloudLoading, setCloudLoading] = React.useState(false);
  const [cloudError, setCloudError] = React.useState("");
  const [search, setSearch] = React.useState("");
  const replaceInputRef = React.useRef<HTMLInputElement | null>(null);
  const autoSyncRanRef = React.useRef(false);
  const installedAutoUpdateRanRef = React.useRef(false);
  const [message, setMessage] = React.useState<string>("");

  const loadLocal = React.useCallback(async () => {
    const nextProfiles = await getPlayersCached({ force: true });
    setProfiles(nextProfiles);
    const rows = await Promise.all(
      nextProfiles.map(async (p) => {
        try {
          return await getPlayerBotStatus(p.id);
        } catch {
          return null;
        }
      }),
    );
    setStatuses(rows.filter((row): row is PlayerBotStatus => row !== null));
    setImportedBots(await listImportedPlayerBots());
  }, []);

  const loadCloud = React.useCallback(async () => {
    setCloudLoading(true);
    setCloudError("");
    try {
      setCloudBots(await listCloudPlayerBots());
    } catch (err) {
      setCloudError(err instanceof Error ? err.message : String(err));
      setCloudBots([]);
    } finally {
      setCloudLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadLocal().catch((err) => setMessage(String(err)));
    loadCloud().catch((err) => setCloudError(String(err)));
  }, [loadCloud, loadLocal]);

  React.useEffect(() => {
    if (autoSyncRanRef.current || profiles.length === 0 || statuses.length === 0) return;
    const sharedProfiles = profiles.filter((profile) => {
      const status = statuses.find((row) => row.playerId === profile.id);
      return Boolean(status?.isUnlocked && getLinkedCloudBotId(profile.id));
    });
    if (sharedProfiles.length === 0) return;
    autoSyncRanRef.current = true;
    void (async () => {
      try {
        for (const profile of sharedProfiles) {
          const { bundle } = await exportPlayerBotBundle(profile.id);
          await publishPlayerBotToCloud({
            playerId: profile.id,
            displayName: profile.name,
            bundle,
            visibility: "public",
          });
        }
        await loadCloud();
      } catch (err) {
        setCloudError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [loadCloud, profiles, statuses]);

  React.useEffect(() => {
    if (installedAutoUpdateRanRef.current || importedBots.length === 0 || cloudBots.length === 0) return;
    const staleBots = importedBots
      .filter((bot) => bot.autoUpdate && bot.cloudBotId)
      .map((bot) => ({
        local: bot,
        cloud: cloudBots.find((cloudBot) => cloudBot.id === bot.cloudBotId),
      }))
      .filter((row) => row.cloud && Number(row.cloud.version || 1) > Number(row.local.cloudVersion || 1));
    if (staleBots.length === 0) return;
    installedAutoUpdateRanRef.current = true;
    void (async () => {
      try {
        for (const row of staleBots) {
          if (!row.cloud) continue;
          await importCloudPlayerBotBundle({
            cloudBotId: row.cloud.id,
            bundle: row.cloud.bundle,
            cloudVersion: row.cloud.version,
            autoUpdate: true,
          });
        }
        setMessage(`${staleBots.length} installed PlayerBot${staleBots.length === 1 ? "" : "s"} auto-updated.`);
        await loadLocal();
      } catch (err) {
        setMessage(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [cloudBots, importedBots, loadLocal]);

  const handleExport = React.useCallback(async (playerId: string) => {
    setBusyExportId(playerId);
    setMessage("");
    try {
      const { filename, bundle } = await exportPlayerBotBundle(playerId);
      downloadJson(filename, bundle);
      setMessage("Player bot exported.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyExportId(null);
    }
  }, []);

  const handleShare = React.useCallback(async (profile: PlayerProfile) => {
    setSharingId(profile.id);
    setMessage("");
    try {
      const { bundle } = await exportPlayerBotBundle(profile.id);
      await publishPlayerBotToCloud({
        playerId: profile.id,
        displayName: profile.name,
        bundle,
        visibility: "public",
      });
      setMessage(`${profile.name} is shared. It will auto-sync when this PlayerBot page opens.`);
      await loadCloud();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSharingId(null);
    }
  }, [loadCloud]);

  const handleUnshare = React.useCallback(async (profile: PlayerProfile) => {
    setSharingId(profile.id);
    setMessage("");
    try {
      await unshareCloudPlayerBot(profile.id);
      setMessage(`${profile.name} is no longer public.`);
      await loadCloud();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSharingId(null);
    }
  }, [loadCloud]);

  const handleInstallCloud = React.useCallback(async (bot: CloudPlayerBot) => {
    setInstallingCloudId(bot.id);
    setMessage("");
    try {
      await importCloudPlayerBotBundle({
        cloudBotId: bot.id,
        bundle: bot.bundle,
        cloudVersion: bot.version,
        autoUpdate: true,
      });
      setMessage(`${bot.displayName} added to your local PlayerBots.`);
      await loadLocal();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setInstallingCloudId(null);
    }
  }, [loadLocal]);

  const handleImportFile = React.useCallback(async (file: File | null) => {
    if (!file) return;
    setImporting(true);
    setMessage("");
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      await importPlayerBotBundle(parsed);
      setMessage("Player bot imported.");
      await loadLocal();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }, [loadLocal]);

  const handleReplaceClick = React.useCallback((botId: string) => {
    setReplacingBotId(botId);
    setMessage("");
    replaceInputRef.current?.click();
  }, []);

  const handleReplaceFile = React.useCallback(async (file: File | null) => {
    if (!file || !replacingBotId) return;
    setImporting(true);
    setMessage("");
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      await replaceImportedPlayerBot(replacingBotId, parsed);
      setMessage("Player bot replaced.");
      await loadLocal();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
      setReplacingBotId(null);
    }
  }, [loadLocal, replacingBotId]);

  const handleDelete = React.useCallback(async (botId: string) => {
    setDeletingBotId(botId);
    setMessage("");
    try {
      await deleteImportedPlayerBot(botId);
      setMessage("Player bot deleted.");
      await loadLocal();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingBotId(null);
    }
  }, [loadLocal]);

  const filteredCloudBots = cloudBots.filter((bot) => {
    const needle = search.trim().toLowerCase();
    return !needle || bot.displayName.toLowerCase().includes(needle);
  });

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden">
      <div
        className="pointer-events-none fixed inset-0 [background:
        radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
        linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95)_30%,rgba(255,255,255,0.04)_60%,rgba(0,0,0,1)_100%)
      ]"
      />
      <BackendTopNav />

      <main className="relative z-10 w-full max-w-6xl mx-auto px-6 md:px-10 pb-10 space-y-5">
        <section className="rounded-xl border border-white/10 bg-white/5 p-5">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <h1 className="text-2xl font-bold">Player Bots</h1>
              <p className="text-sm text-zinc-400 mt-1">
                Share your own bot when you choose, or browse community bots and add the ones you want.
              </p>
            </div>
            <div className="inline-flex rounded-xl border border-white/10 bg-black/30 p-1">
              <button
                type="button"
                onClick={() => setActiveTab("mine")}
                className={`rounded-lg px-3 py-2 text-sm font-semibold ${activeTab === "mine" ? "bg-white text-black" : "text-zinc-300 hover:bg-white/10"}`}
              >
                My PlayerBot
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("marketplace")}
                className={`rounded-lg px-3 py-2 text-sm font-semibold ${activeTab === "marketplace" ? "bg-white text-black" : "text-zinc-300 hover:bg-white/10"}`}
              >
                Marketplace
              </button>
            </div>
          </div>
          {message && (
            <div className="mt-3 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-zinc-200">
              {message}
            </div>
          )}
        </section>

        {activeTab === "mine" ? (
          <>
            <section className="rounded-xl border border-white/10 bg-white/5 p-5">
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-lg font-semibold">Manual Import</h2>
                  <p className="text-sm text-zinc-400 mt-1">
                    Keep file import/export as a backup for offline sharing.
                  </p>
                </div>
                <label className="inline-flex items-center gap-2 rounded-lg border border-cyan-500/50 bg-cyan-500/20 px-3 py-2 text-sm font-semibold cursor-pointer hover:bg-cyan-500/30">
                  <Upload className="h-4 w-4" />
                  {importing ? "Importing..." : "Import Player Bot"}
                  <input
                    type="file"
                    accept=".json,.mdbot.json"
                    className="hidden"
                    disabled={importing}
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      void handleImportFile(file);
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
                <input
                  ref={replaceInputRef}
                  type="file"
                  accept=".json,.mdbot.json"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    void handleReplaceFile(file);
                    event.currentTarget.value = "";
                  }}
                />
              </div>
            </section>

            <section className="rounded-xl border border-white/10 bg-white/5 p-5">
              <h2 className="text-lg font-semibold">Your Profiles</h2>
              <div className="mt-3 space-y-2">
                {profiles.map((profile) => {
                  const status = statuses.find((row) => row.playerId === profile.id);
                  const unlocked = Boolean(status?.isUnlocked);
                  const linkedCloudId = getLinkedCloudBotId(profile.id);
                  return (
                    <div key={profile.id} className="rounded-lg border border-white/10 bg-black/30 px-3 py-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                      <div>
                        <div className="text-sm font-semibold">{profile.name}</div>
                        <div className="text-xs text-zinc-400">
                          {status
                            ? (unlocked
                                ? `${status.completedLegs} replayable won legs | PPR ${fmt(status.ppr)}`
                                : `${status.completedLegs}/${status.unlockWinsRequired ?? 5} wins to unlock`)
                            : "No bot history yet"}
                        </div>
                        <div className="text-xs text-zinc-500 mt-1">
                          {linkedCloudId ? "Shared to cloud. Auto-sync checks for new winning legs on this page." : "Not shared."}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={!unlocked || busyExportId === profile.id}
                          onClick={() => void handleExport(profile.id)}
                          className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/50 bg-emerald-500/20 px-3 py-2 text-sm font-semibold hover:bg-emerald-500/30 disabled:opacity-50"
                        >
                          <Download className="h-4 w-4" />
                          {busyExportId === profile.id ? "Exporting..." : "Export"}
                        </button>
                        {!linkedCloudId && (
                          <button
                            type="button"
                            disabled={!unlocked || sharingId === profile.id}
                            onClick={() => void handleShare(profile)}
                            className="inline-flex items-center gap-2 rounded-lg border border-sky-500/50 bg-sky-500/20 px-3 py-2 text-sm font-semibold hover:bg-sky-500/30 disabled:opacity-50"
                          >
                            <Share2 className="h-4 w-4" />
                            {sharingId === profile.id ? "Sharing..." : "Share My Bot"}
                          </button>
                        )}
                        {linkedCloudId && (
                          <button
                            type="button"
                            disabled={sharingId === profile.id}
                            onClick={() => void handleUnshare(profile)}
                            className="rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm font-semibold hover:bg-white/10 disabled:opacity-50"
                          >
                            Unshare
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="rounded-xl border border-white/10 bg-white/5 p-5">
              <h2 className="text-lg font-semibold">Installed Bots</h2>
              <div className="mt-3 space-y-2">
                {importedBots.length === 0 && (
                  <div className="text-sm text-zinc-500">No imported player bots yet.</div>
                )}
                {importedBots.map((bot) => (
                  <div key={bot.playerId} className="rounded-lg border border-white/10 bg-black/30 px-3 py-3">
                    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                      <div>
                        <div className="text-sm font-semibold">{bot.playerName}</div>
                        <div className="text-xs text-zinc-400 mt-1">
                          PPR {fmt(bot.ppr)} | First 9 {fmt(bot.firstNinePpr)} | Checkout {fmt(bot.checkoutPercentage)}%
                        </div>
                        {bot.cloudBotId && (
                          <div className="text-xs text-sky-300 mt-1">
                            Marketplace bot | auto-update {bot.autoUpdate ? "on" : "off"} | version {bot.cloudVersion || 1}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={importing || !bot.botId}
                          onClick={() => bot.botId && handleReplaceClick(bot.botId)}
                          className="rounded-lg border border-amber-500/50 bg-amber-500/20 px-3 py-2 text-xs font-semibold hover:bg-amber-500/30 disabled:opacity-50"
                        >
                          {replacingBotId === bot.botId ? "Replacing..." : "Replace"}
                        </button>
                        <button
                          type="button"
                          disabled={deletingBotId === bot.botId || !bot.botId}
                          onClick={() => bot.botId && void handleDelete(bot.botId)}
                          className="inline-flex items-center gap-2 rounded-lg border border-red-500/50 bg-red-500/20 px-3 py-2 text-xs font-semibold hover:bg-red-500/30 disabled:opacity-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {deletingBotId === bot.botId ? "Deleting..." : "Delete"}
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </>
        ) : (
          <section className="rounded-xl border border-white/10 bg-white/5 p-5">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-lg font-semibold">PlayerBot Marketplace</h2>
                <p className="text-sm text-zinc-400 mt-1">
                  Browse public PlayerBots, install the ones you want, and update them later from the same listing.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void loadCloud()}
                className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm font-semibold hover:bg-white/10"
              >
                <RefreshCw className={`h-4 w-4 ${cloudLoading ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>

            <div className="mt-4 flex items-center gap-2 rounded-xl border border-white/10 bg-black/30 px-3 py-2">
              <Search className="h-4 w-4 text-zinc-500" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search bots by name..."
                className="w-full bg-transparent text-sm outline-none placeholder:text-zinc-600"
              />
            </div>

            {cloudError && (
              <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
                Marketplace is not ready yet: {cloudError}
              </div>
            )}

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {!cloudLoading && filteredCloudBots.length === 0 && !cloudError && (
                <div className="text-sm text-zinc-500">No shared PlayerBots found yet.</div>
              )}
              {filteredCloudBots.map((bot) => (
                <div key={bot.id} className="rounded-xl border border-white/10 bg-black/30 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-base font-semibold">{bot.displayName}</div>
                      <div className="mt-1 text-xs text-zinc-400">
                        {bot.legsCount} legs | avg {fmt(bot.average)} | checkout {fmt(bot.checkoutPercentage)}%
                      </div>
                      <div className="mt-1 text-xs text-zinc-500">
                        Updated {shortDate(bot.updatedAt)} | version {bot.version}
                      </div>
                    </div>
                    <Cloud className="h-5 w-5 text-sky-300" />
                  </div>
                  <button
                    type="button"
                    disabled={installingCloudId === bot.id}
                    onClick={() => void handleInstallCloud(bot)}
                    className="mt-4 w-full rounded-lg border border-sky-500/50 bg-sky-500/20 px-3 py-2 text-sm font-semibold hover:bg-sky-500/30 disabled:opacity-50"
                  >
                    {installingCloudId === bot.id ? "Adding..." : "Add / Update Bot"}
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
