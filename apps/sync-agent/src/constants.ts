import os from "node:os";
import path from "node:path";

export const PARSER_VERSION = "v1";
const PACKAGE_ROOT =
  path.basename(process.cwd()).toLowerCase() === "sync-agent"
    ? process.cwd()
    : path.resolve(process.cwd(), "apps", "sync-agent");

export const DEFAULT_PLAYER_LOG_PATH = path.join(
  os.homedir(),
  "AppData",
  "LocalLow",
  "Wizards Of The Coast",
  "MTGA",
  "Player.log",
);

export const DEFAULT_COLLECTION_SNAPSHOT_PATH = path.join(
  os.homedir(),
  "AppData",
  "LocalLow",
  "Wizards Of The Coast",
  "MTGA",
  "collection_snapshot.json",
);

export const COLLECTOR_DATA_DIRECTORY = path.join(
  os.homedir(),
  "AppData",
  "LocalLow",
  "MTGA Sniffer",
);

export const DATA_DIRECTORY = COLLECTOR_DATA_DIRECTORY;
export const SCRYFALL_DIRECTORY = path.join(DATA_DIRECTORY, "scryfall");
export const SQLITE_FILE_PATH = path.join(DATA_DIRECTORY, "collection.sqlite");
export const EXPORT_JSON_PATH = path.join(DATA_DIRECTORY, "latest_collection.json");
export const SYNC_HISTORY_LOG_PATH = path.join(DATA_DIRECTORY, "sync_history.log");
export const MEMORY_ANCHORS_PATH = path.join(DATA_DIRECTORY, "memory_anchors.json");
export const SCRYFALL_CACHE_PATH = path.join(SCRYFALL_DIRECTORY, "scryfall_cache.json");
export const SCRYFALL_ARENA_LOOKUP_PATH = path.join(
  SCRYFALL_DIRECTORY,
  "arena_id_lookup_scryfall.json",
);
export const ARENA_METADATA_INDEX_PATH = path.join(SCRYFALL_DIRECTORY, "arena_metadata_index.json");
export const DENOMINATOR_STATS_PATH = path.join(SCRYFALL_DIRECTORY, "denominator_stats.json");
export const MEMORY_SCAN_EXPORTER_PATH = path.resolve(
  PACKAGE_ROOT,
  "..",
  "..",
  "vendor",
  "MTGA-collection-exporter",
  "V1.2",
  "MTGA-collection-exporter.exe",
);
/** @deprecated Use MEMORY_SCAN_EXPORTER_PATH. Kept for env/options compatibility. */
export const MEMORY_SCAN_SCRIPT_PATH = MEMORY_SCAN_EXPORTER_PATH;
