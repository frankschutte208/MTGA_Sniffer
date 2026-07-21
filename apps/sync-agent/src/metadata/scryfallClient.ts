import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import type { ArenaIdLookup } from "../runtime/scanner/arenaIdLookup.js";
import { buildArenaIdLookupFromScryfallBulk } from "../runtime/scanner/arenaIdLookup.js";
import type { ScryfallCacheFile } from "./arenaMetadataCache.js";

export interface ScryfallCardLite {
  arenaId?: number;
  setCode: string;
  collectorNumber: string;
  rarity: string;
  legalities: {
    standard?: string;
    historic?: string;
  };
}

export interface ScryfallBulkDataRef {
  type: string;
  updated_at: string;
  download_uri?: string;
  jsonl_download_uri?: string;
}

interface ScryfallBulkListResponse {
  data?: ScryfallBulkDataRef[];
}

export interface ScryfallDefaultCard {
  name?: string;
  arena_id?: number;
  set?: string;
  collector_number?: string;
  rarity?: string;
  legalities?: Record<string, string>;
}

export interface ScryfallFetchResult {
  fetchedAt: string;
  bulkUpdatedAt: string;
  cards: ScryfallCardLite[];
  arenaIdLookup: ArenaIdLookup;
  skippedDownload: boolean;
}

const SCRYFALL_BULK_DATA_ENDPOINT = "https://api.scryfall.com/bulk-data";
const USER_AGENT = "mtga-sniffer-sync-agent/0.1 (+local)";

const normalizeCollectorNumber = (value: string | undefined): string =>
  String(value ?? "").trim().toLowerCase();

export const isBulkDataNewer = (
  remoteUpdatedAt: string | null | undefined,
  cachedUpdatedAt: string | null | undefined,
): boolean => {
  if (!remoteUpdatedAt) {
    return true;
  }
  if (!cachedUpdatedAt) {
    return true;
  }
  const remoteTs = new Date(remoteUpdatedAt).getTime();
  const cachedTs = new Date(cachedUpdatedAt).getTime();
  if (!Number.isFinite(remoteTs) || !Number.isFinite(cachedTs)) {
    return true;
  }
  return remoteTs > cachedTs;
};

export const resolveBulkDownloadUri = (ref: ScryfallBulkDataRef): string | null =>
  ref.jsonl_download_uri ?? ref.download_uri ?? null;

export const toScryfallCardLite = (card: ScryfallDefaultCard): ScryfallCardLite | null => {
  if (!card.set || !card.collector_number || !card.rarity) {
    return null;
  }
  return {
    arenaId: card.arena_id,
    setCode: card.set.toLowerCase(),
    collectorNumber: normalizeCollectorNumber(card.collector_number),
    rarity: card.rarity.toLowerCase(),
    legalities: {
      standard: card.legalities?.standard,
      historic: card.legalities?.historic,
    },
  };
};

export const buildCardsFromScryfallBulk = (
  cardsJson: ScryfallDefaultCard[],
): { cards: ScryfallCardLite[]; arenaIdLookup: ArenaIdLookup } => {
  const cards: ScryfallCardLite[] = [];
  for (const card of cardsJson) {
    const lite = toScryfallCardLite(card);
    if (lite) {
      cards.push(lite);
    }
  }
  return {
    cards,
    arenaIdLookup: buildArenaIdLookupFromScryfallBulk(cardsJson),
  };
};

export const parseJsonlCards = (raw: string): ScryfallDefaultCard[] => {
  const cards: ScryfallDefaultCard[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      cards.push(JSON.parse(trimmed) as ScryfallDefaultCard);
    } catch {
      throw new Error("Scryfall JSONL parse failed (invalid line)");
    }
  }
  return cards;
};

const scryfallFetch = async (url: string): Promise<Response> =>
  fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });

export const fetchDefaultCardsBulkRef = async (): Promise<ScryfallBulkDataRef> => {
  const bulkRes = await scryfallFetch(SCRYFALL_BULK_DATA_ENDPOINT);
  if (!bulkRes.ok) {
    throw new Error(`Scryfall bulk index HTTP ${bulkRes.status}`);
  }
  const bulkJson = (await bulkRes.json()) as ScryfallBulkListResponse;
  const defaultCardsRef = bulkJson.data?.find((item) => item.type === "default_cards");
  if (!defaultCardsRef?.updated_at) {
    throw new Error("Scryfall default_cards bulk entry missing");
  }
  if (!resolveBulkDownloadUri(defaultCardsRef)) {
    throw new Error("Scryfall default_cards bulk has no download URI");
  }
  return defaultCardsRef;
};

const isGzipPayload = (url: string, contentType: string | null): boolean => {
  const normalizedUrl = url.toLowerCase();
  if (normalizedUrl.endsWith(".gz") || normalizedUrl.endsWith(".jsonl.gz")) {
    return true;
  }
  return (contentType ?? "").toLowerCase().includes("gzip");
};

async function* iterateLines(stream: Readable): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      yield buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) {
    yield buffer;
  }
}

const downloadJsonlCards = async (downloadUri: string): Promise<ScryfallDefaultCard[]> => {
  const cardsRes = await scryfallFetch(downloadUri);
  if (!cardsRes.ok) {
    throw new Error(`Scryfall bulk download HTTP ${cardsRes.status}`);
  }
  if (!cardsRes.body) {
    throw new Error("Scryfall bulk download returned empty body");
  }

  const nodeStream = Readable.fromWeb(cardsRes.body as import("node:stream/web").ReadableStream);
  const contentType = cardsRes.headers.get("content-type");
  const payloadStream = isGzipPayload(downloadUri, contentType)
    ? nodeStream.pipe(createGunzip())
    : nodeStream;

  const cards: ScryfallDefaultCard[] = [];
  for await (const line of iterateLines(payloadStream)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      cards.push(JSON.parse(trimmed) as ScryfallDefaultCard);
    } catch {
      throw new Error("Scryfall JSONL parse failed (invalid line)");
    }
  }
  if (cards.length === 0) {
    throw new Error("Scryfall JSONL parse failed (no cards)");
  }
  return cards;
};

const downloadJsonCards = async (downloadUri: string): Promise<ScryfallDefaultCard[]> => {
  const cardsRes = await scryfallFetch(downloadUri);
  if (!cardsRes.ok) {
    throw new Error(`Scryfall bulk download HTTP ${cardsRes.status}`);
  }
  const cardsJson = (await cardsRes.json()) as ScryfallDefaultCard[];
  if (!Array.isArray(cardsJson) || cardsJson.length === 0) {
    throw new Error("Scryfall JSON bulk parse failed (empty or invalid array)");
  }
  return cardsJson;
};

const downloadDefaultCards = async (
  bulkRef: ScryfallBulkDataRef,
): Promise<{ cards: ScryfallCardLite[]; arenaIdLookup: ArenaIdLookup }> => {
  if (bulkRef.jsonl_download_uri) {
    try {
      const cardsJson = await downloadJsonlCards(bulkRef.jsonl_download_uri);
      return buildCardsFromScryfallBulk(cardsJson);
    } catch (error) {
      if (!bulkRef.download_uri) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Scryfall JSONL failed (${message}); JSON fallback unavailable`);
    }
  }

  if (!bulkRef.download_uri) {
    throw new Error("Scryfall default_cards bulk has no download URI");
  }
  const cardsJson = await downloadJsonCards(bulkRef.download_uri);
  return buildCardsFromScryfallBulk(cardsJson);
};

export const refreshScryfallDefaultCards = async (
  cached: ScryfallCacheFile | null,
  options?: { arenaLookup?: ArenaIdLookup | null },
): Promise<ScryfallFetchResult> => {
  const bulkRef = await fetchDefaultCardsBulkRef();
  const cachedBulkUpdatedAt = cached?.bulkUpdatedAt ?? cached?.fetchedAt ?? null;
  const hasCachedCards = Boolean(cached?.cards?.length);

  if (hasCachedCards && !isBulkDataNewer(bulkRef.updated_at, cachedBulkUpdatedAt)) {
    return {
      fetchedAt: cached!.fetchedAt,
      bulkUpdatedAt: bulkRef.updated_at,
      cards: cached!.cards,
      arenaIdLookup: options?.arenaLookup ?? {},
      skippedDownload: true,
    };
  }

  const downloaded = await downloadDefaultCards(bulkRef);
  if (downloaded.cards.length === 0) {
    throw new Error("Scryfall bulk contained zero usable Arena cards");
  }

  return {
    fetchedAt: new Date().toISOString(),
    bulkUpdatedAt: bulkRef.updated_at,
    cards: downloaded.cards,
    arenaIdLookup: downloaded.arenaIdLookup,
    skippedDownload: false,
  };
};

/** @deprecated Use refreshScryfallDefaultCards */
export const fetchScryfallDefaultCards = async (): Promise<ScryfallFetchResult> =>
  refreshScryfallDefaultCards(null);
