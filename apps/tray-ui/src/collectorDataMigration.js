import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

export const migrateCollectorDataIfNeeded = async ({
  legacyCollectorDirectory,
  collectorDataDirectory,
  existsSyncImpl,
}) => {
  if (
    legacyCollectorDirectory === collectorDataDirectory ||
    !existsSyncImpl(legacyCollectorDirectory)
  ) {
    return;
  }

  await mkdir(collectorDataDirectory, { recursive: true });
  const filesToMigrate = [
    "collection.sqlite",
    "latest_collection.json",
    "sync_history.log",
    "memory_anchors.json",
  ];
  for (const fileName of filesToMigrate) {
    const legacyPath = path.join(legacyCollectorDirectory, fileName);
    const targetPath = path.join(collectorDataDirectory, fileName);
    if (!existsSyncImpl(targetPath) && existsSyncImpl(legacyPath)) {
      await cp(legacyPath, targetPath, { force: false });
    }
  }

  const legacyScryfallDirectory = path.join(legacyCollectorDirectory, "scryfall");
  const targetScryfallDirectory = path.join(collectorDataDirectory, "scryfall");
  if (!existsSyncImpl(targetScryfallDirectory) && existsSyncImpl(legacyScryfallDirectory)) {
    await cp(legacyScryfallDirectory, targetScryfallDirectory, {
      recursive: true,
      force: false,
    });
  }
};

