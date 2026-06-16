import type { ArenaIdLookup } from "../runtime/scanner/arenaIdLookup.js";
import { buildArenaIdLookupFromScryfallBulk } from "../runtime/scanner/arenaIdLookup.js";

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

interface ScryfallBulkDataRef {
  type: string;
  download_uri: string;
}

interface ScryfallBulkListResponse {
  data?: ScryfallBulkDataRef[];
}

interface ScryfallDefaultCard {
  name?: string;
  arena_id?: number;
  set?: string;
  collector_number?: string;
  rarity?: string;
  legalities?: Record<string, string>;
}

export interface ScryfallFetchResult {
  fetchedAt: string;
  cards: ScryfallCardLite[];
  arenaIdLookup: ArenaIdLookup;
}

const SCRYFALL_BULK_DATA_ENDPOINT = "https://api.scryfall.com/bulk-data";
const USER_AGENT = "mtga-sniffer-sync-agent/0.1 (+local)";

const normalizeCollectorNumber = (value: string | undefined): string =>
  String(value ?? "").trim().toLowerCase();

export const fetchScryfallDefaultCards = async (): Promise<ScryfallFetchResult> => {
  const bulkRes = await fetch(SCRYFALL_BULK_DATA_ENDPOINT, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!bulkRes.ok) {
    throw new Error(`scryfall_bulk_index_failed:${bulkRes.status}`);
  }
  const bulkJson = (await bulkRes.json()) as ScryfallBulkListResponse;
  const defaultCardsRef = bulkJson.data?.find((item) => item.type === "default_cards");
  if (!defaultCardsRef) {
    throw new Error("scryfall_default_cards_ref_missing");
  }

  const cardsRes = await fetch(defaultCardsRef.download_uri, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!cardsRes.ok) {
    throw new Error(`scryfall_default_cards_failed:${cardsRes.status}`);
  }

  const cardsJson = (await cardsRes.json()) as ScryfallDefaultCard[];
  const cards: ScryfallCardLite[] = [];
  for (const card of cardsJson) {
    if (!card.set || !card.collector_number || !card.rarity) {
      continue;
    }
    cards.push({
      arenaId: card.arena_id,
      setCode: card.set.toLowerCase(),
      collectorNumber: normalizeCollectorNumber(card.collector_number),
      rarity: card.rarity.toLowerCase(),
      legalities: {
        standard: card.legalities?.standard,
        historic: card.legalities?.historic,
      },
    });
  }

  return {
    fetchedAt: new Date().toISOString(),
    cards,
    arenaIdLookup: buildArenaIdLookupFromScryfallBulk(cardsJson),
  };
};
