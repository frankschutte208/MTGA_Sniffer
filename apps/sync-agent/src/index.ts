import { createApiServer } from "./api/server.js";
import {
  ARENA_METADATA_INDEX_PATH,
  DENOMINATOR_STATS_PATH,
  DEFAULT_COLLECTION_SNAPSHOT_PATH,
  DEFAULT_PLAYER_LOG_PATH,
  EXPORT_JSON_PATH,
  MEMORY_ANCHORS_PATH,
  MEMORY_SCAN_SCRIPT_PATH,
  SCRYFALL_CACHE_PATH,
  SCRYFALL_ARENA_LOOKUP_PATH,
  SYNC_HISTORY_LOG_PATH,
  SQLITE_FILE_PATH,
} from "./constants.js";
import { SyncService } from "./runtime/syncService.js";

const PORT = Number(process.env.MTGA_SYNC_PORT ?? 37241);

const syncService = new SyncService({
  playerLogPath: process.env.MTGA_PLAYER_LOG_PATH ?? DEFAULT_PLAYER_LOG_PATH,
  snapshotPath: process.env.MTGA_COLLECTION_SNAPSHOT_PATH ?? DEFAULT_COLLECTION_SNAPSHOT_PATH,
  sqlitePath: process.env.MTGA_SQLITE_PATH ?? SQLITE_FILE_PATH,
  exportJsonPath: process.env.MTGA_EXPORT_JSON_PATH ?? EXPORT_JSON_PATH,
  syncHistoryLogPath: process.env.MTGA_SYNC_HISTORY_LOG_PATH ?? SYNC_HISTORY_LOG_PATH,
  memoryScanScriptPath: process.env.MTGA_MEMORY_SCAN_SCRIPT_PATH ?? MEMORY_SCAN_SCRIPT_PATH,
  memoryAnchorsPath: process.env.MTGA_MEMORY_ANCHORS_PATH ?? MEMORY_ANCHORS_PATH,
  scryfallCachePath: process.env.MTGA_SCRYFALL_CACHE_PATH ?? SCRYFALL_CACHE_PATH,
  scryfallArenaLookupPath:
    process.env.MTGA_SCRYFALL_ARENA_LOOKUP_PATH ?? SCRYFALL_ARENA_LOOKUP_PATH,
  arenaMetadataIndexPath:
    process.env.MTGA_ARENA_METADATA_INDEX_PATH ?? ARENA_METADATA_INDEX_PATH,
  denominatorStatsPath:
    process.env.MTGA_DENOMINATOR_STATS_PATH ?? DENOMINATOR_STATS_PATH,
});

await syncService.start();

const app = createApiServer(syncService);
app.listen(PORT, () => {
  console.log(`MTGA Sniffer sync agent running on http://localhost:${PORT}`);
});
