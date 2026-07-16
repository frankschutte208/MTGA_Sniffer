import type { LocalCardMetadata } from "../runtime/mtgaLocalCatalog.js";
import type { MetadataStatus, SetFormatStat } from "@mtga/shared-types";
import type { ScryfallCardLite } from "./scryfallClient.js";
import type {
  ArenaMetadataIndex,
  ArenaMetadataIndexRow,
  DenominatorStatsFile,
  RarityDenominatorStats,
} from "./arenaMetadataCache.js";

const normalizeCollectorNumber = (value: string | undefined): string =>
  String(value ?? "").trim().toLowerCase();

export const isBasicLandName = (name: string | undefined): boolean => {
  if (!name) {
    return false;
  }
  return ["plains", "island", "swamp", "mountain", "forest", "wastes"].includes(
    name.trim().toLowerCase(),
  );
};

export const isMtgaBasicLandRarity = (raw: string | undefined): boolean => {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "land" || value === "basic";
};

/** MTGA basic lands use rarity code 1; Scryfall labels them common — prefer MTGA for land bucket. */
export const resolveCollectibleRarity = (
  localRarity: string | undefined,
  localName: string | undefined,
  scryfallRarity?: string,
): "mythic" | "rare" | "uncommon" | "common" | "land" | null => {
  if (isMtgaBasicLandRarity(localRarity) || isBasicLandName(localName)) {
    return "land";
  }
  return normalizeRarity(scryfallRarity ?? localRarity);
};

export const countCollectibleBasicLands = (
  localCatalog: Map<string, LocalCardMetadata>,
): number => {
  let count = 0;
  for (const meta of localCatalog.values()) {
    if (!meta.isCollectible) {
      continue;
    }
    if (isMtgaBasicLandRarity(meta.rarity) || isBasicLandName(meta.name)) {
      count += 1;
    }
  }
  return count;
};

const normalizeRarity = (raw: string | undefined): "mythic" | "rare" | "uncommon" | "common" | "land" | null => {
  const value = raw?.trim().toLowerCase();
  switch (value) {
    case "mythic":
    case "mythicrare":
    case "mythic_rare":
    case "5":
      return "mythic";
    case "rare":
    case "4":
      return "rare";
    case "uncommon":
    case "3":
      return "uncommon";
    case "common":
    case "2":
      return "common";
    case "land":
    case "basic":
    case "1":
      return "land";
    default:
      return null;
  }
};

const mapToDisplayRarity = (rarity: string): "Mythic" | "Rare" | "Uncommon" | "Common" | "Land" => {
  switch (rarity) {
    case "mythic":
      return "Mythic";
    case "rare":
      return "Rare";
    case "uncommon":
      return "Uncommon";
    case "common":
      return "Common";
    default:
      return "Land";
  }
};

interface BuildParams {
  localCatalog: Map<string, LocalCardMetadata>;
  scryfallCards: ScryfallCardLite[];
  source: MetadataStatus["source"];
}

export const buildArenaMetadataIndex = ({
  localCatalog,
  scryfallCards,
  source,
}: BuildParams): ArenaMetadataIndex => {
  const scryfallBySetCollector = new Map<string, ScryfallCardLite>();
  for (const card of scryfallCards) {
    const key = `${card.setCode}|${normalizeCollectorNumber(card.collectorNumber)}`;
    if (!scryfallBySetCollector.has(key)) {
      scryfallBySetCollector.set(key, card);
    }
  }

  const cards: ArenaMetadataIndexRow[] = [];
  for (const [cardId, local] of localCatalog.entries()) {
    const isCollectible = Boolean(local.isCollectible);
    if (!isCollectible) {
      continue;
    }
    const key = `${(local.setCode ?? "").toLowerCase()}|${normalizeCollectorNumber(local.collectorNumber)}`;
    const scryfall = scryfallBySetCollector.get(key);
    const rarity = resolveCollectibleRarity(local.rarity, local.name, scryfall?.rarity);
    if (!rarity) {
      continue;
    }
    cards.push({
      cardId,
      setCode: local.setCode,
      collectorNumber: local.collectorNumber,
      rarity,
      isCollectible,
      inStandard: scryfall?.legalities.standard === "legal",
      inHistoric: scryfall?.legalities.historic === "legal",
    });
  }

  return {
    updatedAt: new Date().toISOString(),
    source,
    cards,
  };
};

export const buildDenominatorStats = (index: ArenaMetadataIndex): DenominatorStatsFile => {
  const rarityDenominators: RarityDenominatorStats = {
    mythic: 0,
    rare: 0,
    uncommon: 0,
    common: 0,
    land: 0,
  };

  const bySet = new Map<string, SetFormatStat>();
  for (const row of index.cards) {
    rarityDenominators[row.rarity] += 1;
    const setCode = row.setCode ?? "unknown";
    const existing =
      bySet.get(setCode) ??
      {
        setCode,
        totalCollectible: 0,
        standardCount: 0,
        historicCount: 0,
      };
    existing.totalCollectible += 1;
    if (row.inStandard) {
      existing.standardCount += 1;
    }
    if (row.inHistoric) {
      existing.historicCount += 1;
    }
    bySet.set(setCode, existing);
  }

  const setFormatStats = Array.from(bySet.values()).sort((a, b) => b.totalCollectible - a.totalCollectible);
  return {
    updatedAt: new Date().toISOString(),
    source: index.source,
    rarityDenominators,
    setFormatStats,
  };
};

export const toRarityProgressRows = (
  stats: DenominatorStatsFile | null,
  ownedByRarity: Record<"mythic" | "rare" | "uncommon" | "common" | "land", number>,
) => {
  const denominators = stats?.rarityDenominators ?? {
    mythic: 0,
    rare: 0,
    uncommon: 0,
    common: 0,
    land: 0,
  };
  const rarityOrder = ["mythic", "rare", "uncommon", "common", "land"] as const;
  return rarityOrder.map((rarity) => ({
    rarity: mapToDisplayRarity(rarity),
    ownedUnique: ownedByRarity[rarity] ?? 0,
    totalCollectible: denominators[rarity] ?? 0,
  }));
};

