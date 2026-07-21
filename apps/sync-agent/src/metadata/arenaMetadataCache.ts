import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MetadataStatus, SetFormatStat } from "@mtga/shared-types";
import type { ScryfallCardLite } from "./scryfallClient.js";
import type { ArenaIdLookup, ScryfallArenaLookupFile } from "../runtime/scanner/arenaIdLookup.js";

export interface RarityDenominatorStats {
  mythic: number;
  rare: number;
  uncommon: number;
  common: number;
  land: number;
}

export interface ArenaMetadataIndexRow {
  cardId: string;
  setCode?: string;
  collectorNumber?: string;
  rarity: "mythic" | "rare" | "uncommon" | "common" | "land";
  isCollectible: boolean;
  inStandard: boolean;
  inHistoric: boolean;
}

export interface ArenaMetadataIndex {
  updatedAt: string;
  source: MetadataStatus["source"];
  cards: ArenaMetadataIndexRow[];
}

export interface DenominatorStatsFile {
  updatedAt: string;
  source: MetadataStatus["source"];
  rarityDenominators: RarityDenominatorStats;
  setFormatStats: SetFormatStat[];
}

export interface ScryfallCacheFile {
  fetchedAt: string;
  bulkUpdatedAt?: string;
  cards: ScryfallCardLite[];
}

export interface MetadataCachePaths {
  scryfallCachePath: string;
  scryfallArenaLookupPath: string;
  arenaMetadataIndexPath: string;
  denominatorStatsPath: string;
}

export const CACHE_STALE_MS = 24 * 60 * 60 * 1000;

const readJson = async <T>(filePath: string): Promise<T | null> => {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
};

export const loadScryfallCache = async (paths: MetadataCachePaths): Promise<ScryfallCacheFile | null> =>
  readJson<ScryfallCacheFile>(paths.scryfallCachePath);

export const saveScryfallCache = async (
  paths: MetadataCachePaths,
  cache: ScryfallCacheFile,
): Promise<void> => {
  await writeJson(paths.scryfallCachePath, cache);
};

export const loadScryfallArenaLookup = async (
  paths: MetadataCachePaths,
): Promise<ScryfallArenaLookupFile | null> => readJson<ScryfallArenaLookupFile>(paths.scryfallArenaLookupPath);

export const saveScryfallArenaLookup = async (
  paths: MetadataCachePaths,
  fetchedAt: string,
  lookup: ArenaIdLookup,
): Promise<void> => {
  await writeJson(paths.scryfallArenaLookupPath, { fetchedAt, lookup } satisfies ScryfallArenaLookupFile);
};

export const loadArenaMetadataIndex = async (
  paths: MetadataCachePaths,
): Promise<ArenaMetadataIndex | null> => readJson<ArenaMetadataIndex>(paths.arenaMetadataIndexPath);

export const saveArenaMetadataIndex = async (
  paths: MetadataCachePaths,
  index: ArenaMetadataIndex,
): Promise<void> => {
  await writeJson(paths.arenaMetadataIndexPath, index);
};

export const loadDenominatorStats = async (
  paths: MetadataCachePaths,
): Promise<DenominatorStatsFile | null> => readJson<DenominatorStatsFile>(paths.denominatorStatsPath);

export const saveDenominatorStats = async (
  paths: MetadataCachePaths,
  stats: DenominatorStatsFile,
): Promise<void> => {
  await writeJson(paths.denominatorStatsPath, stats);
};

export const isStale = (updatedAt: string | null): boolean => {
  if (!updatedAt) {
    return true;
  }
  const ts = new Date(updatedAt).getTime();
  if (!Number.isFinite(ts)) {
    return true;
  }
  return Date.now() - ts > CACHE_STALE_MS;
};

