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
  isStale,
  loadDenominatorStats,
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
} from "../metadata/denominatorStats.js";
import { fetchScryfallDefaultCards } from "../metadata/scryfallClient.js";
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
      const debugRunId = `rescan-${Date.now()}`;
      const anchors = this.resolveMemoryAnchors();
      const preEntries = Object.entries(this.state.counts);
      const preNonZeroCards = preEntries.filter(([, count]) => count > 0).length;
      const preTotalCopies = preEntries.reduce((sum, [, count]) => sum + count, 0);
      // #region agent log
      fetch("http://127.0.0.1:7550/ingest/2b83070b-81b8-4e5b-a58a-c619cbd759c2", { method: "POST", headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "d7d7eb" }, body: JSON.stringify({ sessionId: "d7d7eb", runId: debugRunId, hypothesisId: "H1", location: "syncService.ts:forceMemoryScan:start", message: "Manual memory scan invoked", data: { anchorsCount: anchors.length, preNonZeroCards, preTotalCopies, preTrackedCards: preEntries.length }, timestamp: Date.now() }) }).catch(() => {});
      // #endregion
      if (anchors.length === 0) {
        this.pushDiagnostic("memory_scan_anchors_missing");
        return { ok: false, cardCount: 0 };
      }
      this.pushDiagnostic(`memory_scan_anchors_used:${anchors.length}`);

      const result = await runMemoryScan(this.options.memoryScanScriptPath, anchors);
      // #region agent log
      fetch("http://127.0.0.1:7550/ingest/2b83070b-81b8-4e5b-a58a-c619cbd759c2", { method: "POST", headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "d7d7eb" }, body: JSON.stringify({ sessionId: "d7d7eb", runId: debugRunId, hypothesisId: "H1", location: "syncService.ts:forceMemoryScan:rawResult", message: "Memory scan raw result", data: { ok: result.ok, rawCards: Object.keys(result.cards).length, diagnostics: result.diagnostics.slice(0, 12) }, timestamp: Date.now() }) }).catch(() => {});
      // #endregion
      result.diagnostics.forEach((message) => this.pushDiagnostic(message));

      if (!result.ok) {
        return { ok: false, cardCount: 0 };
      }

      const filteredCards = filterScannedCards(result.cards, new Set(this.localCatalog.keys()));
      const filteredCount = Object.keys(filteredCards).length;
      const rawCount = Object.keys(result.cards).length;
      const droppedCount = rawCount - filteredCount;
      // #region agent log
      fetch("http://127.0.0.1:7550/ingest/2b83070b-81b8-4e5b-a58a-c619cbd759c2", { method: "POST", headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "d7d7eb" }, body: JSON.stringify({ sessionId: "d7d7eb", runId: debugRunId, hypothesisId: "H2", location: "syncService.ts:forceMemoryScan:filtered", message: "Filtered memory scan cards", data: { rawCount, filteredCount, droppedCount }, timestamp: Date.now() }) }).catch(() => {});
      // #endregion
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

      let changedCards = 0;
      let increasedCards = 0;
      let newlyOwnedCards = 0;
      for (const [cardId, nextCount] of Object.entries(filteredCards)) {
        const prevCount = Number(this.state.counts[cardId] ?? 0);
        if (prevCount !== nextCount) {
          changedCards += 1;
        }
        if (nextCount > prevCount) {
          increasedCards += 1;
        }
        if (prevCount <= 0 && nextCount > 0) {
          newlyOwnedCards += 1;
        }
      }
      // #region agent log
      fetch("http://127.0.0.1:7550/ingest/2b83070b-81b8-4e5b-a58a-c619cbd759c2", { method: "POST", headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "d7d7eb" }, body: JSON.stringify({ sessionId: "d7d7eb", runId: debugRunId, hypothesisId: "H3", location: "syncService.ts:forceMemoryScan:delta", message: "Pre-merge scan delta stats", data: { changedCards, increasedCards, newlyOwnedCards }, timestamp: Date.now() }) }).catch(() => {});
      // #endregion

      this.handleEvent(
        {
          source: "manual-resync",
          timestamp: new Date().toISOString(),
          cards: filteredCards,
        },
        "memory-scan",
      );
      await this.flushToDisk();
      const postEntries = Object.entries(this.state.counts);
      const postNonZeroCards = postEntries.filter(([, count]) => count > 0).length;
      const postTotalCopies = postEntries.reduce((sum, [, count]) => sum + count, 0);
      // #region agent log
      fetch("http://127.0.0.1:7550/ingest/2b83070b-81b8-4e5b-a58a-c619cbd759c2", { method: "POST", headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "d7d7eb" }, body: JSON.stringify({ sessionId: "d7d7eb", runId: debugRunId, hypothesisId: "H4", location: "syncService.ts:forceMemoryScan:postFlush", message: "Post-flush state after memory scan", data: { postNonZeroCards, postTotalCopies, nonZeroDelta: postNonZeroCards - preNonZeroCards, totalCopiesDelta: postTotalCopies - preTotalCopies }, timestamp: Date.now() }) }).catch(() => {});
      // #endregion
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
          entry.includes("memory_scan_stderr:"),
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
      const rarity =
        this.metadataByCardId.get(cardId)?.rarity ??
        this.normalizeRarity(this.localCatalog.get(cardId)?.rarity);
      if (!rarity) {
        continue;
      }
      numerators[rarity] += 1;
    }
    return toRarityProgressRows(this.denominatorStats, numerators);
  }

  private normalizeRarity(
    raw: string | undefined,
  ): "mythic" | "rare" | "uncommon" | "common" | "land" | null {
    const value = raw?.trim().toLowerCase();
    switch (value) {
      case "mythic":
      case "mythicrare":
      case "mythic_rare":
        return "mythic";
      case "rare":
        return "rare";
      case "uncommon":
        return "uncommon";
      case "common":
      case "2":
        return "common";
      case "land":
      case "basic":
      case "1":
        return "land";
      case "3":
        return "uncommon";
      case "4":
        return "rare";
      case "5":
        return "mythic";
      default:
        return null;
    }
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
    try {
      const cachedStats = await loadDenominatorStats(this.metadataPaths);
      const cachedScryfall = await loadScryfallCache(this.metadataPaths);
      const lastScryfallRefreshAt = cachedScryfall?.fetchedAt ?? null;
      const needsRefresh = !lastScryfallRefreshAt || isStale(lastScryfallRefreshAt);
      let scryfallCards = cachedScryfall?.cards ?? [];
      let effectiveMetadataUpdatedAt =
        lastScryfallRefreshAt ?? cachedStats?.updatedAt ?? null;
      // Source semantics:
      // - scryfall+local: live Scryfall fetch succeeded in this startup cycle.
      // - local_fallback: local cache/local catalog path (no live fetch this cycle).
      let source: MetadataStatus["source"] = "local_fallback";

      if (needsRefresh) {
        try {
          const fetched = await fetchScryfallDefaultCards();
          scryfallCards = fetched.cards;
          await saveScryfallCache(this.metadataPaths, fetched);
          await saveScryfallArenaLookup(
            this.metadataPaths,
            fetched.fetchedAt,
            fetched.arenaIdLookup,
          );
          source = "scryfall+local";
          effectiveMetadataUpdatedAt = fetched.fetchedAt;
          this.pushDiagnostic(`metadata_scryfall_cards:${fetched.cards.length}`);
          this.pushDiagnostic(
            `metadata_scryfall_arena_lookup:${Object.keys(fetched.arenaIdLookup).length}`,
          );
        } catch (error) {
          this.pushDiagnostic(`metadata_scryfall_refresh_failed:${String(error)}`);
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

      this.metadataStatus = {
        source: stats.source,
        lastRefreshedAt: effectiveMetadataUpdatedAt ?? stats.updatedAt,
        stale: isStale(effectiveMetadataUpdatedAt ?? stats.updatedAt),
      };
      this.pushDiagnostic(`metadata_refresh_ok:${stats.source}:${index.cards.length}`);
    } catch (error) {
      this.metadataStatus = {
        source: "unavailable",
        lastRefreshedAt: this.metadataStatus.lastRefreshedAt,
        stale: true,
      };
      this.pushDiagnostic(`metadata_refresh_error:${String(error)}`);
    }
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
