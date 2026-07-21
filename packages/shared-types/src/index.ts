export type CardCountMap = Record<string, number>;

export interface CardMetadata {
  cardId: string;
  name?: string;
  setCode?: string;
  rarity?: string;
  collectorNumber?: string;
  imageUrl?: string;
}

export interface CollectionEvent {
  source: "player-log" | "snapshot-file" | "manual-resync";
  timestamp: string;
  cards: CardCountMap;
}

export interface SyncStatus {
  lastSyncAt: string | null;
  lastSourceFile: string | null;
  parserVersion: string;
  isMtgaRunning: boolean;
  diagnostics: string[];
}

export interface OverlayStatus {
  isMtgaRunning: boolean;
  lastSyncAt: string | null;
  lastSourceFile: string | null;
  parserVersion: string;
  uniqueCardsTracked: number;
  nonZeroCards: number;
  totalCopies: number;
  autoScanStatus: string;
  statusDetail?: string;
}

export interface OverlayChangeDateRow {
  date: string;
  cardsDelta: number;
  uniqueDelta: number;
  lastUpdateAt: string;
}

export interface OverlayRarityProgressRow {
  rarity: "Mythic" | "Rare" | "Uncommon" | "Common" | "Land";
  ownedUnique: number;
  totalCollectible: number;
}

export interface OverlayInsights {
  recentChangeDates: OverlayChangeDateRow[];
  rarityProgress: OverlayRarityProgressRow[];
  metadataStatus?: MetadataStatus;
}

export interface MetadataStatus {
  source: "scryfall+local" | "local_fallback" | "unavailable";
  lastRefreshedAt: string | null;
  stale: boolean;
  detail?: string;
  lastError?: string | null;
}

export interface SetFormatStat {
  setCode: string;
  totalCollectible: number;
  standardCount: number;
  historicCount: number;
}

export const SCAN_API_VERSION = 1;

export interface MemoryScanAnchor {
  cardId: number;
  quantity: number;
}

export interface MemoryScanRequest {
  scanApiVersion: number;
  scriptPath: string;
  anchors: MemoryScanAnchor[];
}

export interface MemoryScanMetrics {
  inspectedRegions?: number;
  candidateBlocks?: number;
  readErrors?: number;
  anchorsProvided?: number;
  anchorsMatched?: number;
  exitCode?: number | null;
}

export interface MemoryScanResponse {
  scanApiVersion: number;
  ok: boolean;
  cards: CardCountMap;
  diagnostics: string[];
  metrics: MemoryScanMetrics;
}

export interface CollectionRecord extends CardMetadata {
  count: number;
  updatedAt: string;
}
