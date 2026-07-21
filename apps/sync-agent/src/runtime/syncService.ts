import type {
  CollectionEvent,
  OverlayChangeDateRow,
  OverlayInsights,
  OverlayRarityProgressRow,
  OverlayStatus,
  MetadataStatus,
  SetFormatStat,
  SyncStatus,
} from "@mtga/shared-types";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createEmptyCollectionState,
  reduceCollectionEvent,
  type CollectionState,
} from "../collection/reducer.js";
import { PARSER_VERSION } from "../constants.js";
import {
  type DenominatorStatsFile,
  type MetadataCachePaths,
  loadScryfallArenaLookup,
  loadScryfallCache,
  saveArenaMetadataIndex,
  saveDenominatorStats,
  saveScryfallCache,
  saveScryfallArenaLookup,
} from "../metadata/arenaMetadataCache.js";
import {
  buildArenaMetadataIndex,
  buildDenominatorStats,
  toRarityProgressRows,
  resolveCollectibleRarity,
  countCollectibleBasicLands,
} from "../metadata/denominatorStats.js";
import {
  fetchDefaultCardsBulkRef,
  isBulkDataNewer,
  refreshScryfallDefaultCards,
} from "../metadata/scryfallClient.js";
import { runMemoryScan } from "./memoryScanner.js";
import { filterScannedCards } from "./scanner/filter.js";
import { isMtgaRunning } from "./mtgaProcessDetector.js";
import { loadMtgaLocalCatalog, type LocalCardMetadata } from "./mtgaLocalCatalog.js";
import { MtgaWatcher } from "../watcher/mtgaWatcher.js";
import { SqliteCollectionStore } from "../storage/sqliteStore.js";

export interface SyncServiceOptions {
  playerLogPath: string;
  snapshotPath: string;
  sqlitePath: string;
  exportJsonPath: string;
  syncHistoryLogPath: string;
  memoryScanScriptPath: string;
  memoryAnchorsPath: string;
  scryfallCachePath: string;
  scryfallArenaLookupPath: string;
  arenaMetadataIndexPath: string;
  denominatorStatsPath: string;
}

export interface SyncHistoryEntry {
  syncedAt: string | null;
  source: string;
  uniqueCardsTracked: number;
  nonZeroCards: number;
  totalCopies: number;
  parserVersion: string;
  mtgaRunning: boolean;
}

export interface MemoryAnchorInput {
  name: string;
  quantity: number;
}

interface CollectionSnapshotCard {
  cardId?: string;
  count?: number;
}

interface CollectionSnapshotFile {
  cards?: CollectionSnapshotCard[];
}

export class SyncService {
  private static readonly AUTO_MEMORY_SCAN_INTERVAL_MS = 45_000;
  private readonly diagnostics: string[] = [];
  private readonly debugLines: string[] = [];
  private readonly store: SqliteCollectionStore;
  private readonly watcher: MtgaWatcher;
  private memoryScanInFlight = false;
  private lastAutoMemoryScanAt = 0;
  private lastLoggedSyncKey: string | null = null;
  private memoryAnchors: MemoryAnchorInput[] = [];
  private localCatalog = new Map<string, LocalCardMetadata>();
  private metadataByCardId = new Map<string, { rarity: "mythic" | "rare" | "uncommon" | "common" | "land" }>();
  private denominatorStats: DenominatorStatsFile | null = null;
  private metadataStatus: MetadataStatus = {
    source: "unavailable",
    lastRefreshedAt: null,
    stale: true,
    detail: "Metadata not loaded yet",
    lastError: null,
  };
  private readonly metadataPaths: MetadataCachePaths;
  private state: CollectionState = createEmptyCollectionState();
  private pendingFlush: NodeJS.Timeout | null = null;
  private status: SyncStatus = {
    lastSyncAt: null,
    lastSourceFile: null,
    parserVersion: PARSER_VERSION,
    isMtgaRunning: false,
    diagnostics: [],
  };

  constructor(private readonly options: SyncServiceOptions) {
    this.metadataPaths = {
      scryfallCachePath: options.scryfallCachePath,
      scryfallArenaLookupPath: options.scryfallArenaLookupPath,
      arenaMetadataIndexPath: options.arenaMetadataIndexPath,
      denominatorStatsPath: options.denominatorStatsPath,
    };
    this.store = new SqliteCollectionStore(options.sqlitePath);
    this.watcher = new MtgaWatcher({
      playerLogPath: options.playerLogPath,
      snapshotPath: options.snapshotPath,
      onEvent: async (event, sourcePath) => {
        this.handleEvent(event, sourcePath);
      },
      onDiagnostic: (message) => this.pushDiagnostic(message),
      onDebugLine: (line, matched) => this.pushDebugLine(line, matched),
    });
  }

  async start(): Promise<void> {
    await this.store.init();
    this.state.counts = Object.fromEntries(
      this.store.getAll().map((row) => [row.cardId, row.count]),
    );
    this.status.isMtgaRunning = await isMtgaRunning();
    this.localCatalog = await loadMtgaLocalCatalog();
    this.pushDiagnostic(`local_catalog_loaded:${this.localCatalog.size}`);
    await this.loadMemoryAnchors();
    await this.refreshMetadataCache();
    await this.watcher.start();

    setInterval(async () => {
      this.status.isMtgaRunning = await isMtgaRunning();
      await this.maybeAutoMemoryScan();
    }, 10_000).unref();
  }

  async forceResync(): Promise<void> {
    const before = this.status.lastSyncAt;
    await this.watcher.forceRefresh();
    if (before === this.status.lastSyncAt) {
      await this.forceMemoryScan();
    }
    if (!this.status.lastSyncAt) {
      await this.flushToDisk();
    }
  }

  async forceMemoryScan(): Promise<{ ok: boolean; cardCount: number }> {
    if (this.memoryScanInFlight) {
      this.pushDiagnostic("memory_scan_skipped:already_running");
      return { ok: false, cardCount: 0 };
    }

    this.memoryScanInFlight = true;
    try {
      const anchors = this.resolveMemoryAnchors();
      const preEntries = Object.entries(this.state.counts);
      const preNonZeroCards = preEntries.filter(([, count]) => count > 0).length;
      if (anchors.length === 0) {
        this.pushDiagnostic("memory_scan_anchors_missing");
        return { ok: false, cardCount: 0 };
      }
      this.pushDiagnostic(`memory_scan_anchors_used:${anchors.length}`);

      const result = await runMemoryScan(this.options.memoryScanScriptPath, anchors);
      result.diagnostics.forEach((message) => this.pushDiagnostic(message));

      if (!result.ok) {
        return { ok: false, cardCount: 0 };
      }

      const filteredCards = filterScannedCards(result.cards, new Set(this.localCatalog.keys()));
      const filteredCount = Object.keys(filteredCards).length;
      this.pushDiagnostic(`memory_scan_filtered_cards:${filteredCount}`);
      if (filteredCount === 0) {
        this.pushDiagnostic("memory_scan_filtered_empty");
        return { ok: false, cardCount: 0 };
      }
      if (preNonZeroCards >= 1000 && filteredCount < Math.floor(preNonZeroCards * 0.5)) {
        this.pushDiagnostic(
          `memory_scan_rejected:partial_block:${filteredCount}_of_${preNonZeroCards}`,
        );
        return { ok: false, cardCount: 0 };
      }

      this.handleEvent(
        {
          source: "manual-resync",
          timestamp: new Date().toISOString(),
          cards: filteredCards,
        },
        "memory-scan",
      );
      await this.flushToDisk();
      return { ok: true, cardCount: filteredCount };
    } catch (error) {
      this.pushDiagnostic(`memory_scan_exception:${String(error)}`);
      return { ok: false, cardCount: 0 };
    } finally {
      this.memoryScanInFlight = false;
    }
  }

  getStatus(): SyncStatus {
    return {
      ...this.status,
      diagnostics: [...this.status.diagnostics],
    };
  }

  getMemoryAnchors(): MemoryAnchorInput[] {
    return this.memoryAnchors.map((anchor) => ({ ...anchor }));
  }

  async setMemoryAnchors(anchors: MemoryAnchorInput[]): Promise<void> {
    const normalized = anchors
      .map((anchor) => ({
        name: anchor.name.trim(),
        quantity: Math.floor(anchor.quantity),
      }))
      .filter((anchor) => anchor.name.length > 0 && anchor.quantity > 0 && anchor.quantity <= 400)
      .slice(0, 8);
    this.memoryAnchors = normalized;
    await this.persistMemoryAnchors();
    this.pushDiagnostic(`memory_scan_anchors_saved:${normalized.length}`);
  }

  getOverlayStatus(): OverlayStatus {
    const entries = Object.entries(this.state.counts);
    const nonZeroCards = entries.filter(([, count]) => count > 0).length;
    const totalCopies = entries.reduce((sum, [, count]) => sum + count, 0);
    let autoScanStatus = "inactive (manual rescan only)";
    if (!this.status.isMtgaRunning) {
      autoScanStatus = "inactive (MTGA not running)";
    } else if (this.memoryScanInFlight) {
      autoScanStatus = "running now";
    } else if (totalCopies <= 0) {
      const elapsed = Date.now() - this.lastAutoMemoryScanAt;
      const remainingMs = Math.max(0, SyncService.AUTO_MEMORY_SCAN_INTERVAL_MS - elapsed);
      autoScanStatus =
        this.lastAutoMemoryScanAt === 0 || remainingMs === 0
          ? "due now"
          : `next attempt in ${Math.ceil(remainingMs / 1000)}s`;
    }
    const latestMemoryDiagnostic =
      this.status.diagnostics.find(
        (entry) =>
          entry.includes("memory_scan_error:") ||
          entry.includes("memory_scan_spawn_error:") ||
          entry.includes("memory_scan_stderr:") ||
          entry.includes("memory_scan_upstream_"),
      ) ??
      this.status.diagnostics.find(
        (entry) =>
          entry.includes("memory_scan_timeout:") ||
          entry.includes("memory_scan_anchors_missing") ||
          entry.includes("memory_scan_filtered_empty") ||
          entry.includes("memory_scan_auto_failed"),
      );
    const statusDetail = totalCopies === 0 ? latestMemoryDiagnostic : undefined;
    return {
      isMtgaRunning: this.status.isMtgaRunning,
      lastSyncAt: this.status.lastSyncAt,
      lastSourceFile: this.status.lastSourceFile,
      parserVersion: this.status.parserVersion,
      uniqueCardsTracked: entries.length,
      nonZeroCards,
      totalCopies,
      autoScanStatus,
      statusDetail,
    };
  }

  async getOverlayInsights(): Promise<OverlayInsights> {
    const history = await this.getAllSyncHistory();
    return {
      recentChangeDates: this.computeRecentChangeDates(history),
      rarityProgress: this.computeRarityProgress(),
      metadataStatus: this.getMetadataStatus(),
    };
  }

  getMetadataStatus(): MetadataStatus {
    return { ...this.metadataStatus };
  }

  getSetFormatStats(): SetFormatStat[] {
    return [...(this.denominatorStats?.setFormatStats ?? [])];
  }

  getCollection() {
    return this.store.getAll().map((row) => {
      const local = this.localCatalog.get(row.cardId);
      const setCode = row.setCode ?? local?.setCode;
      const collectorNumber = row.collectorNumber ?? local?.collectorNumber;
      const rarity = row.rarity ?? local?.rarity;
      const imageUrl =
        setCode && collectorNumber
          ? `https://api.scryfall.com/cards/${setCode}/${encodeURIComponent(collectorNumber)}?format=image&version=normal`
          : undefined;

      return {
        ...row,
        name: row.name ?? local?.name,
        setCode,
        rarity,
        collectorNumber,
        imageUrl: row.imageUrl ?? imageUrl,
      };
    });
  }

  getDebugLines() {
    return [...this.debugLines];
  }

  async getSyncHistory(limit = 25): Promise<SyncHistoryEntry[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    try {
      const content = await readFile(this.options.syncHistoryLogPath, "utf8");
      const lines = content.split(/\r?\n/).filter(Boolean);
      const recent = lines.slice(-safeLimit).reverse();
      const parsed: SyncHistoryEntry[] = [];

      for (const line of recent) {
        try {
          const entry = JSON.parse(line) as SyncHistoryEntry;
          parsed.push(entry);
        } catch {
          // Keep serving valid history lines even if one is malformed.
        }
      }
      return parsed;
    } catch {
      return [];
    }
  }

  private async getAllSyncHistory(): Promise<SyncHistoryEntry[]> {
    try {
      const content = await readFile(this.options.syncHistoryLogPath, "utf8");
      const lines = content.split(/\r?\n/).filter(Boolean);
      const parsed: SyncHistoryEntry[] = [];
      for (const line of lines) {
        try {
          parsed.push(JSON.parse(line) as SyncHistoryEntry);
        } catch {
          // Ignore malformed rows and keep parsing.
        }
      }
      return parsed;
    } catch {
      return [];
    }
  }

  private handleEvent(event: CollectionEvent, sourcePath: string): void {
    this.state = reduceCollectionEvent(this.state, event);
    this.status.lastSourceFile = sourcePath;
    this.status.lastSyncAt = event.timestamp;

    if (this.pendingFlush) {
      clearTimeout(this.pendingFlush);
    }

    // Debounce high-frequency append events from Player.log.
    this.pendingFlush = setTimeout(async () => {
      await this.flushToDisk();
      this.pendingFlush = null;
    }, 500);
  }

  private async flushToDisk(): Promise<void> {
    if (!this.state.updatedAt) {
      return;
    }
    await this.store.upsertCounts(this.state.counts, this.state.updatedAt);
    await this.store.writeSnapshot(this.options.exportJsonPath);
    await this.appendSyncHistory();
  }

  private async appendSyncHistory(): Promise<void> {
    const syncKey = `${this.state.updatedAt ?? "unknown"}|${this.status.lastSourceFile ?? "unknown"}`;
    if (this.lastLoggedSyncKey === syncKey) {
      return;
    }

    const entries = Object.entries(this.state.counts);
    const nonZeroCards = entries.filter(([, count]) => count > 0).length;
    const totalCopies = entries.reduce((sum, [, count]) => sum + count, 0);

    const logEntry = {
      syncedAt: this.state.updatedAt,
      source: this.status.lastSourceFile ?? "unknown",
      uniqueCardsTracked: entries.length,
      nonZeroCards,
      totalCopies,
      parserVersion: this.status.parserVersion,
      mtgaRunning: this.status.isMtgaRunning,
    };

    try {
      await appendFile(this.options.syncHistoryLogPath, `${JSON.stringify(logEntry)}\n`, "utf8");
      this.lastLoggedSyncKey = syncKey;
    } catch (error) {
      this.pushDiagnostic(`sync_history_log_error:${String(error)}`);
    }
  }

  private async maybeAutoMemoryScan(): Promise<void> {
    if (!this.status.isMtgaRunning || this.memoryScanInFlight) {
      return;
    }

    const now = Date.now();
    if (now - this.lastAutoMemoryScanAt < SyncService.AUTO_MEMORY_SCAN_INTERVAL_MS) {
      return;
    }

    const totalCopies = Object.values(this.state.counts).reduce((sum, count) => sum + count, 0);
    if (totalCopies > 0) {
      return;
    }
    if (this.resolveMemoryAnchors().length === 0) {
      this.pushDiagnostic("memory_scan_anchors_missing");
      return;
    }

    this.lastAutoMemoryScanAt = now;
    const result = await this.forceMemoryScan();
    this.pushDiagnostic(
      result.ok
        ? `memory_scan_auto_success:${result.cardCount}`
        : "memory_scan_auto_failed",
    );
  }

  private computeRecentChangeDates(history: SyncHistoryEntry[]): OverlayChangeDateRow[] {
    interface DayAccumulator {
      cardsDelta: number;
      uniqueDelta: number;
      lastUpdateAt: string;
    }
    const byDay = new Map<string, DayAccumulator>();
    let previousTotalCopies: number | null = null;
    let previousNonZeroCards: number | null = null;

    for (const entry of history) {
      if (!entry.syncedAt) {
        continue;
      }
      if (previousTotalCopies === null || previousNonZeroCards === null) {
        previousTotalCopies = entry.totalCopies;
        previousNonZeroCards = entry.nonZeroCards;
        continue;
      }

      const cardsDelta = entry.totalCopies - previousTotalCopies;
      const uniqueDelta = entry.nonZeroCards - previousNonZeroCards;
      previousTotalCopies = entry.totalCopies;
      previousNonZeroCards = entry.nonZeroCards;

      if (cardsDelta === 0 && uniqueDelta === 0) {
        continue;
      }

      const dayKey = this.toLocalDateKey(entry.syncedAt);
      const existing = byDay.get(dayKey);
      if (!existing) {
        byDay.set(dayKey, {
          cardsDelta,
          uniqueDelta,
          lastUpdateAt: entry.syncedAt,
        });
      } else {
        existing.cardsDelta += cardsDelta;
        existing.uniqueDelta += uniqueDelta;
        if (entry.syncedAt > existing.lastUpdateAt) {
          existing.lastUpdateAt = entry.syncedAt;
        }
      }
    }

    return Array.from(byDay.entries())
      .sort(([dayA], [dayB]) => dayB.localeCompare(dayA))
      .slice(0, 5)
      .map(([date, value]) => ({
        date,
        cardsDelta: value.cardsDelta,
        uniqueDelta: value.uniqueDelta,
        lastUpdateAt: value.lastUpdateAt,
      }));
  }

  private computeRarityProgress(): OverlayRarityProgressRow[] {
    const numerators = {
      mythic: 0,
      rare: 0,
      uncommon: 0,
      common: 0,
      land: 0,
    } satisfies Record<"mythic" | "rare" | "uncommon" | "common" | "land", number>;
    for (const [cardId, count] of Object.entries(this.state.counts)) {
      if (count <= 0) {
        continue;
      }
      const local = this.localCatalog.get(cardId);
      const meta = this.metadataByCardId.get(cardId);
      const rarity = resolveCollectibleRarity(local?.rarity, local?.name, meta?.rarity);
      if (!rarity) {
        continue;
      }
      numerators[rarity] += 1;
    }
    const rows = toRarityProgressRows(this.denominatorStats, numerators);
    const landDenominator = countCollectibleBasicLands(this.localCatalog);
    if (landDenominator <= 0) {
      return rows;
    }
    return rows.map((row) =>
      row.rarity === "Land" ? { ...row, totalCollectible: landDenominator } : row,
    );
  }

  private toLocalDateKey(isoDate: string): string {
    const date = new Date(isoDate);
    if (Number.isNaN(date.getTime())) {
      return isoDate.slice(0, 10);
    }
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  private async refreshMetadataCache(): Promise<void> {
    let lastError: string | null = null;
    let detail: string | undefined;
    let bulkRefUpdatedAt: string | null = null;

    try {
      const cachedScryfall = await loadScryfallCache(this.metadataPaths);
      const cachedLookup = await loadScryfallArenaLookup(this.metadataPaths);
      let scryfallCards = cachedScryfall?.cards ?? [];
      let effectiveMetadataUpdatedAt = cachedScryfall?.fetchedAt ?? null;
      let source: MetadataStatus["source"] = "local_fallback";

      try {
        const fetched = await refreshScryfallDefaultCards(cachedScryfall, {
          arenaLookup: cachedLookup?.lookup ?? null,
        });
        bulkRefUpdatedAt = fetched.bulkUpdatedAt;
        scryfallCards = fetched.cards;
        effectiveMetadataUpdatedAt = fetched.fetchedAt;

        if (fetched.skippedDownload) {
          detail = `bulk unchanged (${this.formatMetadataTimestamp(fetched.bulkUpdatedAt)}); using cache`;
          source = "local_fallback";
          this.pushDiagnostic(`metadata_scryfall_skipped:bulk_unchanged:${fetched.bulkUpdatedAt}`);
          if (cachedScryfall && cachedScryfall.bulkUpdatedAt !== fetched.bulkUpdatedAt) {
            await saveScryfallCache(this.metadataPaths, {
              ...cachedScryfall,
              bulkUpdatedAt: fetched.bulkUpdatedAt,
            });
          }
        } else {
          await saveScryfallCache(this.metadataPaths, {
            fetchedAt: fetched.fetchedAt,
            bulkUpdatedAt: fetched.bulkUpdatedAt,
            cards: fetched.cards,
          });
          await saveScryfallArenaLookup(
            this.metadataPaths,
            fetched.fetchedAt,
            fetched.arenaIdLookup,
          );
          source = "scryfall+local";
          detail = `downloaded ${fetched.cards.length.toLocaleString()} cards`;
          this.pushDiagnostic(`metadata_scryfall_cards:${fetched.cards.length}`);
          this.pushDiagnostic(
            `metadata_scryfall_arena_lookup:${Object.keys(fetched.arenaIdLookup).length}`,
          );
        }
      } catch (error) {
        lastError = this.formatMetadataError(error);
        detail = `refresh failed: ${lastError}`;
        this.pushDiagnostic(`metadata_scryfall_refresh_failed:${lastError}`);
        try {
          const bulkRef = await fetchDefaultCardsBulkRef();
          bulkRefUpdatedAt = bulkRef.updated_at;
        } catch (bulkError) {
          this.pushDiagnostic(
            `metadata_scryfall_bulk_index_failed:${this.formatMetadataError(bulkError)}`,
          );
        }
      }

      const index = buildArenaMetadataIndex({
        localCatalog: this.localCatalog,
        scryfallCards,
        source,
      });
      await saveArenaMetadataIndex(this.metadataPaths, index);

      const stats = buildDenominatorStats(index);
      await saveDenominatorStats(this.metadataPaths, stats);
      this.denominatorStats = stats;

      this.metadataByCardId.clear();
      for (const row of index.cards) {
        this.metadataByCardId.set(row.cardId, { rarity: row.rarity });
      }

      const cachedBulkUpdatedAt =
        cachedScryfall?.bulkUpdatedAt ?? cachedScryfall?.fetchedAt ?? null;
      const stale = lastError
        ? isBulkDataNewer(bulkRefUpdatedAt, cachedBulkUpdatedAt)
        : false;

      this.metadataStatus = {
        source: stats.source,
        lastRefreshedAt: effectiveMetadataUpdatedAt ?? stats.updatedAt,
        stale,
        detail,
        lastError,
      };
      this.pushDiagnostic(`metadata_refresh_ok:${stats.source}:${index.cards.length}`);
    } catch (error) {
      lastError = this.formatMetadataError(error);
      this.metadataStatus = {
        source: "unavailable",
        lastRefreshedAt: this.metadataStatus.lastRefreshedAt,
        stale: true,
        detail: `metadata rebuild failed: ${lastError}`,
        lastError,
      };
      this.pushDiagnostic(`metadata_refresh_error:${lastError}`);
    }
  }

  private formatMetadataTimestamp(isoDate: string): string {
    const date = new Date(isoDate);
    if (Number.isNaN(date.getTime())) {
      return isoDate;
    }
    return date.toLocaleString();
  }

  private formatMetadataError(error: unknown): string {
    if (error instanceof Error) {
      return error.message.replace(/\s+/g, " ").trim();
    }
    return String(error).replace(/\s+/g, " ").trim();
  }

  private resolveMemoryAnchors(): Array<{ cardId: number; quantity: number }> {
    const ownedCounts = this.getOwnedCountsForAnchorResolution();
    const normalizeAnchorName = (value: string): string =>
      value
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^\w\s]/g, " ")
        .replace(/_/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const rawNameToCardIds = new Map<string, string[]>();
    const normalizedNameToCardIds = new Map<string, string[]>();
    for (const [cardId, local] of this.localCatalog.entries()) {
      if (!local.name) {
        continue;
      }
      const rawName = local.name.trim().toLowerCase();
      const rawExisting = rawNameToCardIds.get(rawName) ?? [];
      rawExisting.push(cardId);
      rawNameToCardIds.set(rawName, rawExisting);
      const normalizedName = normalizeAnchorName(local.name);
      if (!normalizedName) {
        continue;
      }
      const existing = normalizedNameToCardIds.get(normalizedName) ?? [];
      existing.push(cardId);
      normalizedNameToCardIds.set(normalizedName, existing);
    }

    const pickOwnedCandidate = (candidates: string[], anchorQuantity: number): string | null => {
      if (candidates.length === 0) {
        return null;
      }
      const owned = candidates.filter((id) => Number(ownedCounts[id] ?? 0) > 0);
      const pool = owned.length > 0 ? owned : candidates;
      const qtyMatch = pool.find(
        (id) => Math.abs(Number(ownedCounts[id] ?? 0) - anchorQuantity) <= 2,
      );
      return qtyMatch ?? pool[0];
    };

    const resolveCardIdByName = (
      anchorName: string,
      anchorQuantity: number,
    ): { cardId: string | null; mode: string } => {
      const raw = anchorName.trim().toLowerCase();
      const exactCandidates = rawNameToCardIds.get(raw);
      if (exactCandidates && exactCandidates.length > 0) {
        const cardId = pickOwnedCandidate(exactCandidates, anchorQuantity);
        if (cardId) {
          return {
            cardId,
            mode: exactCandidates.length > 1 ? "exact_owned_printing" : "exact",
          };
        }
      }

      const normalized = normalizeAnchorName(anchorName);
      if (!normalized) {
        return { cardId: null, mode: "empty" };
      }

      const exactNormalized = normalizedNameToCardIds.get(normalized);
      if (exactNormalized && exactNormalized.length > 0) {
        const cardId = pickOwnedCandidate(exactNormalized, anchorQuantity);
        if (cardId) {
          return {
            cardId,
            mode: exactNormalized.length > 1 ? "normalized_exact_owned_printing" : "normalized_exact",
          };
        }
      }

      let bestCardId: string | null = null;
      let bestScore = Number.POSITIVE_INFINITY;
      let bestCandidates: string[] = [];
      for (const [candidateName, candidateCardIds] of normalizedNameToCardIds.entries()) {
        if (
          !candidateName.includes(normalized) &&
          !normalized.includes(candidateName)
        ) {
          continue;
        }
        const score = Math.abs(candidateName.length - normalized.length);
        if (score < bestScore && candidateCardIds.length > 0) {
          bestScore = score;
          bestCandidates = candidateCardIds;
        }
      }
      if (bestCandidates.length > 0) {
        bestCardId = pickOwnedCandidate(bestCandidates, anchorQuantity);
      }
      if (bestCardId) {
        return { cardId: bestCardId, mode: "normalized_fuzzy" };
      }
      return { cardId: null, mode: "not_found" };
    };

    const resolved: Array<{ cardId: number; quantity: number }> = [];
    for (const anchor of this.memoryAnchors) {
      const { cardId, mode } = resolveCardIdByName(anchor.name, anchor.quantity);
      if (!cardId) {
        this.pushDiagnostic(`memory_scan_anchor_not_found:${anchor.name}`);
        continue;
      }
      if (mode !== "exact") {
        this.pushDiagnostic(`memory_scan_anchor_resolved_${mode}:${anchor.name}`);
      }
      resolved.push({
        cardId: Number(cardId),
        quantity: anchor.quantity,
      });
    }
    if (resolved.length > 0) {
      return resolved;
    }

    // Fallback 1: derive anchors from already-known owned cards.
    const autoAnchors = this.buildAutoAnchorsFromState();
    if (autoAnchors.length > 0) {
      this.pushDiagnostic(`memory_scan_anchors_auto:${autoAnchors.length}`);
      return autoAnchors;
    }

    // Fallback 2: derive anchors from last exported snapshot if state is empty.
    const snapshotAnchors = this.buildAutoAnchorsFromSnapshot();
    if (snapshotAnchors.length > 0) {
      this.pushDiagnostic(`memory_scan_anchors_snapshot:${snapshotAnchors.length}`);
    }
    return snapshotAnchors;
  }

  private getOwnedCountsForAnchorResolution(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const row of this.store.getAll()) {
      counts[row.cardId] = row.count;
    }
    for (const [cardId, count] of Object.entries(this.state.counts)) {
      counts[cardId] = count;
    }
    return counts;
  }

  private buildAutoAnchorsFromState(): Array<{ cardId: number; quantity: number }> {
    const candidates = Object.entries(this.state.counts)
      .filter(([cardId, count]) => {
        if (count <= 0 || count > 20) {
          return false;
        }
        const meta = this.localCatalog.get(cardId);
        return Boolean(meta?.name);
      })
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);

    return candidates.map(([cardId, quantity]) => ({
      cardId: Number(cardId),
      quantity,
    }));
  }

  private buildAutoAnchorsFromSnapshot(): Array<{ cardId: number; quantity: number }> {
    try {
      const raw = readFileSync(this.options.exportJsonPath, "utf8");
      const parsed = JSON.parse(raw) as CollectionSnapshotFile;
      const cards = Array.isArray(parsed.cards) ? parsed.cards : [];
      const candidates = cards
        .map((card) => ({
          cardId: String(card.cardId ?? ""),
          count: Number(card.count ?? 0),
        }))
        .filter(({ cardId, count }) => {
          if (!cardId || !Number.isFinite(count) || count <= 0 || count > 20) {
            return false;
          }
          const meta = this.localCatalog.get(cardId);
          return Boolean(meta?.name);
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 6);

      return candidates.map(({ cardId, count }) => ({
        cardId: Number(cardId),
        quantity: count,
      }));
    } catch {
      return [];
    }
  }

  private async loadMemoryAnchors(): Promise<void> {
    try {
      const raw = await readFile(this.options.memoryAnchorsPath, "utf8");
      const parsed = JSON.parse(raw) as MemoryAnchorInput[];
      if (!Array.isArray(parsed)) {
        this.memoryAnchors = [];
        return;
      }
      this.memoryAnchors = parsed
        .map((anchor) => ({
          name: String(anchor.name ?? "").trim(),
          quantity: Number(anchor.quantity ?? 0),
        }))
        .filter((anchor) => anchor.name.length > 0 && anchor.quantity > 0 && anchor.quantity <= 400)
        .slice(0, 8);
      this.pushDiagnostic(`memory_scan_anchors_loaded:${this.memoryAnchors.length}`);
    } catch {
      this.memoryAnchors = [];
    }
  }

  private async persistMemoryAnchors(): Promise<void> {
    await mkdir(path.dirname(this.options.memoryAnchorsPath), { recursive: true });
    await writeFile(
      this.options.memoryAnchorsPath,
      JSON.stringify(this.memoryAnchors, null, 2),
      "utf8",
    );
  }

  private pushDiagnostic(message: string): void {
    this.diagnostics.unshift(`${new Date().toISOString()} ${message}`);
    this.status.diagnostics = this.diagnostics.slice(0, 40);
  }

  private pushDebugLine(line: string, matched: boolean): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    const isInteresting =
      matched ||
      trimmed.includes("InventoryInfo") ||
      trimmed.includes("collection") ||
      trimmed.includes("cardId") ||
      trimmed.includes("Deck");
    if (!isInteresting) {
      return;
    }

    const normalized = trimmed.slice(0, 260);
    this.debugLines.unshift(
      `${new Date().toISOString()} [${matched ? "matched" : "seen"}] ${normalized}`,
    );
    this.debugLines.splice(40);
  }
}
