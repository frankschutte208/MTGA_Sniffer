import { readFile } from "node:fs/promises";
import type { LocalCardMetadata } from "../mtgaLocalCatalog.js";

export const ARENA_ID_LOOKUP_FILE = "arena_id_lookup.json";
export const SCRYFALL_ARENA_LOOKUP_FILE = "arena_id_lookup_scryfall.json";

export type ArenaIdLookup = Record<string, string>;

export interface ScryfallArenaLookupFile {
  fetchedAt: string;
  lookup: ArenaIdLookup;
}

export const cleanArenaCardName = (raw: string): string =>
  raw
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

export const isValidArenaIdLookupKey = (key: string): boolean => {
  const id = Number(key);
  return Number.isInteger(id) && id > 0 && id < 500_000;
};

export const buildArenaIdLookupFromCatalog = (
  catalog: Map<string, LocalCardMetadata>,
): ArenaIdLookup => {
  const lookup: ArenaIdLookup = {};
  for (const [cardId, meta] of catalog.entries()) {
    if (!isValidArenaIdLookupKey(cardId)) {
      continue;
    }
    const rawName = meta.name?.trim();
    if (!rawName) {
      continue;
    }
    const name = cleanArenaCardName(rawName);
    if (name) {
      lookup[cardId] = name;
    }
  }
  return lookup;
};

export const buildArenaIdLookupFromScryfallBulk = (
  cards: Array<{ arena_id?: number; name?: string }>,
): ArenaIdLookup => {
  const lookup: ArenaIdLookup = {};
  for (const card of cards) {
    const arenaId = Number(card.arena_id ?? 0);
    const name = String(card.name ?? "").trim();
    if (!Number.isInteger(arenaId) || arenaId <= 0 || !name) {
      continue;
    }
    lookup[String(arenaId)] = name;
  }
  return lookup;
};

/** MTGA local catalog wins on key collision (authoritative grpIds in RAM). */
export const mergeArenaIdLookups = (mtga: ArenaIdLookup, scryfall: ArenaIdLookup): ArenaIdLookup => {
  const merged: ArenaIdLookup = { ...scryfall };
  for (const [key, name] of Object.entries(mtga)) {
    if (!isValidArenaIdLookupKey(key)) {
      continue;
    }
    const cleaned = name.trim();
    if (cleaned) {
      merged[key] = cleaned;
    }
  }
  return merged;
};

export const loadPersistedScryfallArenaLookup = async (
  filePath: string,
): Promise<ArenaIdLookup> => {
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as ScryfallArenaLookupFile;
    if (raw.lookup && typeof raw.lookup === "object") {
      return raw.lookup;
    }
  } catch {
    // missing or corrupt sidecar — scan still works with MTGA catalog only
  }
  return {};
};
