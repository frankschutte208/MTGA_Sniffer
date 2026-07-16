import { exec, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CardCountMap, MemoryScanAnchor, MemoryScanResponse } from "@mtga/shared-types";
import type { LocalCardMetadata } from "../mtgaLocalCatalog.js";
import { loadMtgaLocalCatalog } from "../mtgaLocalCatalog.js";
import {
  ARENA_ID_LOOKUP_FILE,
  buildArenaIdLookupFromCatalog,
  loadPersistedScryfallArenaLookup,
  mergeArenaIdLookups,
} from "./arenaIdLookup.js";
import { SCAN_API_VERSION, SCAN_TIMEOUT_MS } from "./config.js";
import { loadScanConfig, type ScanConfig } from "./scanConfig.js";
import { SCRYFALL_ARENA_LOOKUP_PATH } from "../../constants.js";

const UPSTREAM_ANCHORS_FILE = "last_anchors.json";
const UPSTREAM_OUTPUT_FILE = "mtga_collection.json";
const UPSTREAM_EXE_NAME = "MTGA-collection-exporter.exe";
const UPSTREAM_MTG_PY_NAME = "mtg.py";
const UPSTREAM_LOG_FILE = "upstream.log";

export interface UpstreamCollectionRow {
  count: number;
  name: string;
  id?: number;
  set?: string;
  cn?: string;
}

export interface CatalogLookup {
  nameByCardId: Map<string, string>;
  cardIdByNameSetCn: Map<string, string>;
  cardIdsByNameSet: Map<string, string[]>;
}

export const buildCatalogLookup = (catalog: Map<string, LocalCardMetadata>): CatalogLookup => {
  const nameByCardId = new Map<string, string>();
  const cardIdByNameSetCn = new Map<string, string>();
  const cardIdsByNameSet = new Map<string, string[]>();

  for (const [cardId, meta] of catalog.entries()) {
    if (meta.name) {
      nameByCardId.set(cardId, meta.name);
    }
    const name = meta.name?.trim().toLowerCase() ?? "";
    const setCode = meta.setCode?.trim().toLowerCase() ?? "";
    const collectorNumber = meta.collectorNumber?.trim() ?? "";
    if (!name) {
      continue;
    }
    cardIdByNameSetCn.set(`${name}|${setCode}|${collectorNumber}`, cardId);
    const nameSetKey = `${name}|${setCode}`;
    const existing = cardIdsByNameSet.get(nameSetKey) ?? [];
    existing.push(cardId);
    cardIdsByNameSet.set(nameSetKey, existing);
  }

  return { nameByCardId, cardIdByNameSetCn, cardIdsByNameSet };
};

export const toUpstreamAnchorsJson = (
  anchors: MemoryScanAnchor[],
  lookup: CatalogLookup,
): Array<[number, number, string]> =>
  anchors.map((anchor) => {
    const cardId = String(anchor.cardId);
    const name = lookup.nameByCardId.get(cardId) ?? `Card ${cardId}`;
    return [anchor.cardId, anchor.quantity, name];
  });

export const mapUpstreamRowsToCardIds = (
  rows: UpstreamCollectionRow[],
  lookup: CatalogLookup,
): CardCountMap => {
  const cards: CardCountMap = {};
  for (const row of rows) {
    const count = Number(row.count ?? 0);
    if (!Number.isFinite(count) || count <= 0) {
      continue;
    }
    const grpId = Number(row.id ?? 0);
    if (Number.isFinite(grpId) && grpId > 0) {
      const cardId = String(Math.floor(grpId));
      cards[cardId] = (cards[cardId] ?? 0) + Math.floor(count);
      continue;
    }
    const name = String(row.name ?? "")
      .trim()
      .toLowerCase();
    const setCode = String(row.set ?? "")
      .trim()
      .toLowerCase();
    const collectorNumber = String(row.cn ?? "").trim();
    if (!name) {
      continue;
    }

    const exactKey = `${name}|${setCode}|${collectorNumber}`;
    let cardId = lookup.cardIdByNameSetCn.get(exactKey);
    if (!cardId) {
      const candidates = lookup.cardIdsByNameSet.get(`${name}|${setCode}`) ?? [];
      if (candidates.length === 1) {
        cardId = candidates[0];
      }
    }
    if (!cardId) {
      continue;
    }
    cards[cardId] = (cards[cardId] ?? 0) + Math.floor(count);
  }
  return cards;
};

export const readVendorManifest = async (
  exporterPath: string,
): Promise<{ sha256: string; version: string }> => {
  const manifestPath = path.join(path.dirname(exporterPath), "manifest.json");
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as {
    sha256?: string;
    version?: string;
  };
  if (!raw.sha256 || !raw.version) {
    throw new Error("memory_scan_vendor_manifest_invalid");
  }
  return { sha256: raw.sha256.toLowerCase(), version: raw.version };
};

export const verifyVendorExporterHash = async (exporterPath: string): Promise<void> => {
  const manifest = await readVendorManifest(exporterPath);
  const bytes = await readFile(exporterPath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== manifest.sha256) {
    throw new Error(`memory_scan_vendor_hash_mismatch:expected=${manifest.sha256}:actual=${hash}`);
  }
};

const parseUpstreamOutput = (raw: string): UpstreamCollectionRow[] => {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }
  const rows: UpstreamCollectionRow[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const record = row as Record<string, unknown>;
    const name = String(record.name ?? "").trim();
    if (!name) {
      continue;
    }
    rows.push({
      count: Number(record.count ?? 0),
      name,
      id: record.id !== undefined ? Number(record.id) : undefined,
      set: record.set ? String(record.set) : undefined,
      cn: record.cn ? String(record.cn) : undefined,
    });
  }
  return rows;
};

export const classifyUpstreamLog = (logText: string): string[] => {
  const log = logText.toLowerCase();
  if (!log.trim()) {
    return ["memory_scan_upstream_empty_log"];
  }
  if (log.includes("database init failed")) {
    return ["memory_scan_upstream_database_init_failed"];
  }
  if (log.includes("scryfall download failed") || log.includes("failed to download database")) {
    return ["memory_scan_upstream_scryfall_failed"];
  }
  if (log.includes("error scanning local files") || log.includes("charmap")) {
    return ["memory_scan_upstream_local_catalog_failed"];
  }
  if (log.includes("mtg arena not found") || log.includes("please start the game")) {
    return ["memory_scan_error:attach_failed"];
  }
  if (log.includes("no valid collection data")) {
    return ["memory_scan_upstream_no_blocks"];
  }
  if (log.includes("collection not found")) {
    return ["memory_scan_upstream_anchors_not_found"];
  }
  return ["memory_scan_upstream_unclassified_failure"];
};

const canRunPinnedPython = (): boolean => {
  const result = spawnSync("py", ["-3", "-c", "import pymem"], {
    stdio: "ignore",
    windowsHide: true,
  });
  return result.status === 0;
};

const execAsync = promisify(exec);

const spawnUpstreamExe = async (
  workExePath: string,
  scanDir: string,
  vendorDir: string,
  timeoutMs: number,
  usePython: boolean,
): Promise<{ exitCode: number | null; logText: string; runtime: "python" | "exe" }> => {
  const logPath = path.join(scanDir, UPSTREAM_LOG_FILE);
  const mtgPyVendor = path.join(vendorDir, UPSTREAM_MTG_PY_NAME);

  let command: string;
  let runtime: "python" | "exe";
  if (usePython) {
    await copyFile(mtgPyVendor, path.join(scanDir, UPSTREAM_MTG_PY_NAME));
    runtime = "python";
    command = `(echo Y& echo.& echo.& echo.& echo.& echo.) | py -3 "${path.join(scanDir, UPSTREAM_MTG_PY_NAME)}" > "${logPath}" 2>&1`;
  } else {
    runtime = "exe";
    command = `(echo Y& echo.& echo.& echo.& echo.& echo.) | "${workExePath}" > "${logPath}" 2>&1`;
  }

  let exitCode: number | null = 0;
  try {
    await execAsync(command, {
      cwd: scanDir,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 1024,
    });
  } catch (error) {
    const execError = error as { code?: number | null };
    exitCode = execError.code ?? 1;
  }

  let logText = "";
  try {
    logText = await readFile(logPath, "utf8");
  } catch {
    logText = "";
  }

  return { exitCode, logText, runtime };
};

const countAnchorMatches = (cards: CardCountMap, anchors: MemoryScanAnchor[]): number => {
  let matched = 0;
  for (const anchor of anchors) {
    const qty = cards[String(anchor.cardId)];
    if (qty !== undefined && Math.abs(qty - anchor.quantity) <= 2) {
      matched += 1;
    }
  }
  return matched;
};

export const invokeUpstreamExporter = async (
  exporterPath: string,
  anchors: MemoryScanAnchor[],
): Promise<MemoryScanResponse> => {
  const diagnostics: string[] = [];
  if (anchors.length === 0) {
    return {
      scanApiVersion: SCAN_API_VERSION,
      ok: false,
      cards: {},
      diagnostics: ["memory_scan_anchors_missing"],
      metrics: { exitCode: null, anchorsProvided: 0, anchorsMatched: 0 },
    };
  }

  if (process.platform !== "win32") {
    return {
      scanApiVersion: SCAN_API_VERSION,
      ok: false,
      cards: {},
      diagnostics: ["memory_scan_upstream_windows_only"],
      metrics: { exitCode: null, anchorsProvided: anchors.length, anchorsMatched: 0 },
    };
  }

  let workDir: string | null = null;
  let scanConfig: ScanConfig = {};
  try {
    await verifyVendorExporterHash(exporterPath);
    scanConfig = await loadScanConfig();
    const catalog = await loadMtgaLocalCatalog();
    const lookup = buildCatalogLookup(catalog);
    const upstreamAnchors = toUpstreamAnchorsJson(anchors, lookup);

    workDir = await mkdtemp(path.join(os.tmpdir(), "mtga-upstream-scan-"));
    const scanDir = workDir;
    const workExePath = path.join(scanDir, UPSTREAM_EXE_NAME);
    await copyFile(exporterPath, workExePath);
    await writeFile(
      path.join(scanDir, UPSTREAM_ANCHORS_FILE),
      JSON.stringify(upstreamAnchors, null, 2),
      "utf8",
    );

    const mtgaLookup = buildArenaIdLookupFromCatalog(catalog);
    const scryfallLookup = await loadPersistedScryfallArenaLookup(SCRYFALL_ARENA_LOOKUP_PATH);
    const mergedLookup = mergeArenaIdLookups(mtgaLookup, scryfallLookup);
    await writeFile(
      path.join(scanDir, ARENA_ID_LOOKUP_FILE),
      JSON.stringify(mergedLookup),
      "utf8",
    );
    diagnostics.push(`memory_scan_lookup_seeded:${Object.keys(mergedLookup).length}`);

    const usePython = !scanConfig.useExeRuntime && canRunPinnedPython();
    if (scanConfig.useExeRuntime && canRunPinnedPython()) {
      diagnostics.push("memory_scan_forced_exe_runtime");
    }
    if (!usePython && !scanConfig.useExeRuntime) {
      diagnostics.push("memory_scan_python_unavailable");
    }

    const vendorDir = path.dirname(exporterPath);
    const scanStartedAt = Date.now();
    const { exitCode, logText, runtime } = await spawnUpstreamExe(
      workExePath,
      scanDir,
      vendorDir,
      SCAN_TIMEOUT_MS,
      usePython,
    );
    const scanDurationMs = Date.now() - scanStartedAt;

    diagnostics.push(`memory_scan_upstream_runtime:${runtime}`);

    diagnostics.push(`memory_scan_upstream_exit_code:${exitCode ?? "null"}`);
    diagnostics.push(`memory_scan_upstream_duration_ms:${scanDurationMs}`);
    if (logText.trim()) {
      const logLine = logText.trim().replace(/\s+/g, " ").slice(-240);
      diagnostics.push(`memory_scan_upstream_log:${logLine}`);
    }

    const outputPath = path.join(scanDir, UPSTREAM_OUTPUT_FILE);
    let rows: UpstreamCollectionRow[] = [];
    let scanSucceeded = false;
    try {
      rows = parseUpstreamOutput(await readFile(outputPath, "utf8"));
      scanSucceeded = rows.length > 0;
    } catch {
      classifyUpstreamLog(logText).forEach((entry) => diagnostics.push(entry));
      diagnostics.push("memory_scan_upstream_no_output");
      if (scanConfig.debugKeepWorkDir && workDir) {
        diagnostics.push(`memory_scan_debug_workdir:${workDir}`);
      } else if (workDir) {
        try {
          await cp(
            path.join(scanDir, UPSTREAM_LOG_FILE),
            path.join(os.tmpdir(), `mtga-scan-failure-${Date.now()}.log`),
          );
        } catch {
          // best-effort log preservation
        }
      }
      return {
        scanApiVersion: SCAN_API_VERSION,
        ok: false,
        cards: {},
        diagnostics,
        metrics: {
          exitCode,
          anchorsProvided: anchors.length,
          anchorsMatched: 0,
        },
      };
    }

    const cards = mapUpstreamRowsToCardIds(rows, lookup);
    const anchorsMatched = countAnchorMatches(cards, anchors);
    diagnostics.push(`memory_scan_anchors_provided:${anchors.length}`);
    diagnostics.push(`memory_scan_anchors_matched:${anchorsMatched}`);
    diagnostics.push(`memory_scan_upstream_rows:${rows.length}`);
    diagnostics.push(`memory_scan_upstream_cards_mapped:${Object.keys(cards).length}`);

    if (scanConfig.debugCopyOutputTo && scanSucceeded) {
      const debugDir = scanConfig.debugCopyOutputTo;
      await mkdir(debugDir, { recursive: true });
      await cp(outputPath, path.join(debugDir, UPSTREAM_OUTPUT_FILE), { force: true });
      await cp(
        path.join(scanDir, UPSTREAM_ANCHORS_FILE),
        path.join(debugDir, UPSTREAM_ANCHORS_FILE),
        { force: true },
      );
      await cp(
        path.join(scanDir, ARENA_ID_LOOKUP_FILE),
        path.join(debugDir, ARENA_ID_LOOKUP_FILE),
        { force: true },
      );
      diagnostics.push(`memory_scan_debug_copied:${debugDir}`);
    }
    if (scanConfig.debugKeepWorkDir && workDir) {
      diagnostics.push(`memory_scan_debug_workdir:${workDir}`);
    }

    const ok = Object.keys(cards).length > 0;
    if (!ok) {
      diagnostics.push("memory_scan_filtered_empty");
      diagnostics.push("memory_scan_hint:open_collection_and_scroll");
    }

    return {
      scanApiVersion: SCAN_API_VERSION,
      ok,
      cards,
      diagnostics,
      metrics: {
        exitCode,
        anchorsProvided: anchors.length,
        anchorsMatched,
      },
    };
  } catch (error) {
    const message = String(error);
    if (message.includes("memory_scan_timeout")) {
      diagnostics.push(`memory_scan_timeout:${SCAN_TIMEOUT_MS}`);
    } else if (message.includes("memory_scan_vendor_hash_mismatch")) {
      diagnostics.push(message);
    } else {
      diagnostics.push(`memory_scan_spawn_error:${message}`);
    }
    return {
      scanApiVersion: SCAN_API_VERSION,
      ok: false,
      cards: {},
      diagnostics,
      metrics: { exitCode: null, anchorsProvided: anchors.length, anchorsMatched: 0 },
    };
  } finally {
    if (workDir && !scanConfig.debugKeepWorkDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
};
