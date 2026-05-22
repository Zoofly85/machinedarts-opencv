import {
  exportPlayerBotBundle,
  getPlayerBotStatus,
  getPlayersCached,
  importCloudPlayerBotBundle,
  listImportedPlayerBots,
} from "./playersApi";
import {
  getLinkedCloudBotId,
  listCloudPlayerBots,
  publishPlayerBotToCloud,
} from "./playerBotCloudApi";

type PlayerBotSyncResult = {
  sharedProfilesSynced: number;
  installedBotsUpdated: number;
};

let syncInFlight: Promise<PlayerBotSyncResult> | null = null;
let syncCompletedThisSession = false;

export async function syncPlayerBotsWithCloud(options?: { force?: boolean }): Promise<PlayerBotSyncResult> {
  if (syncInFlight) {
    return syncInFlight;
  }
  if (syncCompletedThisSession && !options?.force) {
    return { sharedProfilesSynced: 0, installedBotsUpdated: 0 };
  }

  syncInFlight = (async () => {
    const result: PlayerBotSyncResult = {
      sharedProfilesSynced: 0,
      installedBotsUpdated: 0,
    };

    const [profiles, importedBots, cloudBots] = await Promise.all([
      getPlayersCached({ force: true }),
      listImportedPlayerBots(),
      listCloudPlayerBots(),
    ]);

    const statuses = await Promise.all(
      profiles.map(async (profile) => {
        try {
          return await getPlayerBotStatus(profile.id);
        } catch {
          return null;
        }
      }),
    );

    const sharedProfiles = profiles.filter((profile) => {
      const status = statuses.find((row) => row?.playerId === profile.id);
      return Boolean(status?.isUnlocked && getLinkedCloudBotId(profile.id));
    });

    for (const profile of sharedProfiles) {
      const { bundle } = await exportPlayerBotBundle(profile.id);
      await publishPlayerBotToCloud({
        playerId: profile.id,
        displayName: profile.name,
        bundle,
        visibility: "public",
      });
      result.sharedProfilesSynced += 1;
    }

    const latestCloudBots = result.sharedProfilesSynced > 0 ? await listCloudPlayerBots() : cloudBots;
    const staleBots = importedBots
      .filter((bot) => bot.autoUpdate && bot.cloudBotId)
      .map((bot) => ({
        local: bot,
        cloud: latestCloudBots.find((cloudBot) => cloudBot.id === bot.cloudBotId),
      }))
      .filter((row) => row.cloud && Number(row.cloud.version || 1) > Number(row.local.cloudVersion || 1));

    for (const row of staleBots) {
      if (!row.cloud) continue;
      await importCloudPlayerBotBundle({
        cloudBotId: row.cloud.id,
        bundle: row.cloud.bundle,
        cloudVersion: row.cloud.version,
        autoUpdate: true,
      });
      result.installedBotsUpdated += 1;
    }

    syncCompletedThisSession = true;
    return result;
  })();

  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}
