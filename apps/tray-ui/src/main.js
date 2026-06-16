import { app, BrowserWindow, Menu, Tray, shell, nativeImage, ipcMain, screen } from "electron";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { migrateCollectorDataIfNeeded } from "./collectorDataMigration.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const agentPort = process.env.MTGA_SYNC_PORT ?? "37241";
const apiBase = `http://localhost:${agentPort}`;
const execFileAsync = promisify(execFile);

const ICON_SIZE = 40;
// Portrait overlay backgrounds are 784×1168; match ~2:3 aspect to reduce cropping.
const TOOLTIP_WIDTH = 400;
const TOOLTIP_MIN_HEIGHT = 600;
const TOOLTIP_MAX_HEIGHT = 680;
const OVERLAY_BACKGROUND_ROTATE_MS = 60_000;
const ICON_LEFT_OFFSET = 6;
const ICON_TOP_OFFSET = 52;
const TOOLTIP_ICON_GAP = 8;
const EDGE_PADDING = 8;

const APP_VERSION = JSON.parse(
  readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"),
).version;

let tray = null;
let iconWindow = null;
let tooltipWindow = null;
let anchorConfigWindow = null;
let overlayProbeInFlight = false;
let syncApiServer = null;
let tooltipHideTimer = null;
let memoryScanAvailable = false;
let rescanInFlight = false;
let rescanUiState = "idle";
let rescanUiMessage = "";
let startupErrorMessage = null;
let cachedStatus = "Sync status unknown";
let cachedSummary = "No collection cards seen yet";
let cachedOverlayPayload = {
  statusLine: "Sniffer offline",
  summaryLine: "Waiting for sync agent",
  metadataFreshnessLine: "",
  autoScanLine: "",
  recentChangeDates: [],
  rarityProgress: [],
  rescanState: "idle",
  rescanMessage: "",
};
let lastMtgaState = null;

const fallbackIconDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAQAAAC1QeVaAAAAL0lEQVR4AWNQ0tL6z0AEYBxVSFQwMDD8Z2Bg+M8ABhz+Y8AAiGE4sQDI8A8QAAAz7QnXjNnR9QAAAABJRU5ErkJggg==";

const resolveAppIconPath = () => {
  const candidates = [
    path.resolve(__dirname, "..", "assets", "mtga-sniffer-icon.jpg"),
    path.resolve(__dirname, "..", "assets", "mtga-sniffer-icon.png"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
};

const createTrayIcon = () => {
  const iconPath = resolveAppIconPath();
  if (!existsSync(iconPath)) {
    return nativeImage.createFromDataURL(fallbackIconDataUrl);
  }
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    return nativeImage.createFromDataURL(fallbackIconDataUrl);
  }
  return image.resize({ width: 32, height: 32, quality: "best" });
};

let cachedOverlayBackgroundFileUrls = null;

const loadOverlayBackgroundFileUrls = () => {
  if (cachedOverlayBackgroundFileUrls) {
    return cachedOverlayBackgroundFileUrls;
  }
  const directoryCandidates = [
    path.resolve(__dirname, "..", "assets", "backgrounds"),
    path.resolve(__dirname, "..", "..", "..", "Backgrounds"),
  ];
  for (const directory of directoryCandidates) {
    if (!existsSync(directory)) {
      continue;
    }
    const files = readdirSync(directory)
      .filter((fileName) => /\.(jpe?g|png)$/i.test(fileName))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    if (files.length === 0) {
      continue;
    }
    cachedOverlayBackgroundFileUrls = files.map((fileName) =>
      pathToFileURL(path.join(directory, fileName)).href,
    );
    return cachedOverlayBackgroundFileUrls;
  }
  cachedOverlayBackgroundFileUrls = [];
  return cachedOverlayBackgroundFileUrls;
};

const getOverlayBackgroundsJson = () => JSON.stringify(loadOverlayBackgroundFileUrls());

let cachedAppIconDataUrl = null;

const getAppIconDataUrl = () => {
  if (cachedAppIconDataUrl) {
    return cachedAppIconDataUrl;
  }
  const iconPath = resolveAppIconPath();
  if (!existsSync(iconPath)) {
    return "";
  }
  const extension = path.extname(iconPath).toLowerCase();
  const mimeType = extension === ".png" ? "image/png" : "image/jpeg";
  cachedAppIconDataUrl = `data:${mimeType};base64,${readFileSync(iconPath).toString("base64")}`;
  return cachedAppIconDataUrl;
};

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
  process.exit(0);
}

const mtgaDataDirectory = path.join(
  os.homedir(),
  "AppData",
  "LocalLow",
  "Wizards Of The Coast",
  "MTGA",
);

const resolveEmbeddedAgentPaths = () => {
  const distRootCandidates = app.isPackaged
    ? [
        path.resolve(__dirname, "..", "embedded-agent"),
        path.join(process.resourcesPath, "app.asar.unpacked", "embedded-agent"),
        path.join(process.resourcesPath, "embedded-agent"),
      ]
    : [path.resolve(__dirname, "..", "embedded-agent")];

  const exporterCandidates = app.isPackaged
    ? [
        path.join(
          process.resourcesPath,
          "app.asar.unpacked",
          "embedded-agent",
          "vendor",
          "MTGA-collection-exporter",
          "V1.2",
          "MTGA-collection-exporter.exe",
        ),
        path.join(
          process.resourcesPath,
          "embedded-agent",
          "vendor",
          "MTGA-collection-exporter",
          "V1.2",
          "MTGA-collection-exporter.exe",
        ),
        path.resolve(
          __dirname,
          "..",
          "embedded-agent",
          "vendor",
          "MTGA-collection-exporter",
          "V1.2",
          "MTGA-collection-exporter.exe",
        ),
      ]
    : [
        path.resolve(
          __dirname,
          "..",
          "embedded-agent",
          "vendor",
          "MTGA-collection-exporter",
          "V1.2",
          "MTGA-collection-exporter.exe",
        ),
        path.resolve(
          __dirname,
          "..",
          "..",
          "vendor",
          "MTGA-collection-exporter",
          "V1.2",
          "MTGA-collection-exporter.exe",
        ),
      ];

  const distRoot = distRootCandidates.find((root) => {
    const hasSyncService = existsSync(path.join(root, "dist", "runtime", "syncService.js"));
    const hasApi = existsSync(path.join(root, "dist", "api", "server.js"));
    return hasSyncService && hasApi;
  });

  const memoryScanScriptPath = exporterCandidates.find((exporterPath) => existsSync(exporterPath));

  if (!distRoot) {
    throw new Error(`Embedded sync dist not found. Checked: ${distRootCandidates.join(" | ")}`);
  }

  return {
    distRoot: path.join(distRoot, "dist"),
    memoryScanScriptPath: memoryScanScriptPath ?? exporterCandidates[0],
  };
};

const getCollectorDataDirectory = () =>
  process.env.MTGA_COLLECTOR_DATA_PATH ??
  path.join(os.homedir(), "AppData", "LocalLow", "MTGA Sniffer");

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const formatMetadataFreshness = (lastRefreshedAt) => {
  if (!lastRefreshedAt) {
    return "unknown";
  }
  const ts = new Date(lastRefreshedAt);
  if (Number.isNaN(ts.getTime())) {
    return "unknown";
  }
  const now = Date.now();
  const ageMinutes = Math.max(0, Math.floor((now - ts.getTime()) / 60000));
  if (ageMinutes < 1) {
    return "just now";
  }
  if (ageMinutes < 60) {
    return `${ageMinutes}m ago`;
  }
  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 24) {
    return `${ageHours}h ago`;
  }
  const ageDays = Math.floor(ageHours / 24);
  return `${ageDays}d ago`;
};

const applyCircularShape = (win, size) => {
  if (typeof win.setShape !== "function") {
    return;
  }
  const radius = size / 2;
  const rects = [];
  for (let y = 0; y < size; y += 1) {
    const dy = y + 0.5 - radius;
    const chordHalf = Math.sqrt(Math.max(0, radius * radius - dy * dy));
    const xStart = Math.floor(radius - chordHalf);
    const xEnd = Math.ceil(radius + chordHalf);
    rects.push({
      x: xStart,
      y,
      width: Math.max(1, xEnd - xStart),
      height: 1,
    });
  }
  win.setShape(rects);
};

const formatRescanFailureMessage = (status) => {
  const diagnostics = Array.isArray(status?.diagnostics) ? status.diagnostics : [];
  const findDiagnostic = (needle) => diagnostics.find((entry) => entry.includes(needle));
  if (findDiagnostic("memory_scan_skipped:already_running")) {
    return "Rescan failed: scan already in progress";
  }
  if (findDiagnostic("memory_scan_upstream_crash:unicode_stdout")) {
    return "Rescan failed: upstream scanner encoding error (retry after update)";
  }
  if (findDiagnostic("memory_scan_upstream_crash")) {
    return "Rescan failed: upstream scanner crashed";
  }
  if (findDiagnostic("memory_scan_upstream_no_blocks")) {
    return "Rescan failed: found anchor hits but no collection block (retry from Collection tab)";
  }
  if (findDiagnostic("memory_scan_error:mtga_not_running")) {
    return "Rescan failed: MTGA not running (launch MTGA first)";
  }
  if (findDiagnostic("memory_scan_upstream_anchors_not_found")) {
    return "Rescan failed: anchors not in MTGA memory — open Collection, scroll slowly top to bottom, retry";
  }
  if (findDiagnostic("memory_scan_hint:open_collection_and_scroll")) {
    return "Rescan failed: collection not loaded in memory — open Collection and scroll, then retry";
  }
  if (findDiagnostic("memory_scan_filtered_empty")) {
    return "Rescan failed: no valid cards found";
  }
  if (findDiagnostic("memory_scan_rejected:partial_block:")) {
    const partialEntry = findDiagnostic("memory_scan_rejected:partial_block:");
    const partial = partialEntry?.match(/partial_block:(\d+)_of_(\d+)/);
    if (partial) {
      return `Rescan failed: partial scan (${partial[1]} of ${partial[2]} cards)`;
    }
    return "Rescan failed: partial scan rejected";
  }
  if (findDiagnostic("mtga_not_running")) {
    return "Rescan failed: MTGA not running";
  }
  if (findDiagnostic("memory_scan_exit_code:2")) {
    const matchedEntry = findDiagnostic("memory_scan_anchors_matched:");
    const providedEntry = findDiagnostic("memory_scan_anchors_provided:");
    const matched = matchedEntry?.match(/anchors_matched:(\d+)/)?.[1];
    const provided = providedEntry?.match(/anchors_provided:(\d+)/)?.[1];
    if (matched && provided) {
      return `Rescan failed: anchor validation (${matched}/${provided} matched)`;
    }
    return "Rescan failed: anchor validation";
  }
  const exitCodeEntry = findDiagnostic("memory_scan_exit_code:");
  if (exitCodeEntry) {
    const exitCode = exitCodeEntry.match(/exit_code:(\d+)/)?.[1];
    if (exitCode && exitCode !== "0") {
      return `Rescan failed (exit code ${exitCode})`;
    }
  }
  return "Rescan failed";
};

const getLaunchAtLogin = () =>
  process.platform === "win32" && app.getLoginItemSettings().openAtLogin;

const setLaunchAtLogin = (enabled) => {
  if (process.platform !== "win32") {
    return;
  }
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
  });
};

const updateMenu = () => {
  if (!tray) {
    return;
  }

  const menu = Menu.buildFromTemplate([
    { label: cachedStatus, enabled: false },
    { label: cachedSummary, enabled: false },
    {
      label: "Open Collection Web App",
      click: () => {
        void shell.openExternal("http://localhost:5173");
      },
    },
    {
      label: "Manual Resync",
      click: async () => {
        await fetch(`${apiBase}/resync`, { method: "POST" });
        await refreshStatus();
      },
    },
    {
      label: "Force Memory Scan",
      enabled: memoryScanAvailable,
      click: async () => {
        await fetch(`${apiBase}/memory-scan`, { method: "POST" });
        await refreshStatus();
      },
    },
    {
      label: "Configure Memory Anchors",
      click: () => {
        void openAnchorConfigWindow();
      },
    },
    { type: "separator" },
    ...(process.platform === "win32"
      ? [
          {
            label: "Start with Windows",
            type: "checkbox",
            checked: getLaunchAtLogin(),
            click: (menuItem) => {
              setLaunchAtLogin(menuItem.checked);
            },
          },
        ]
      : []),
    {
      label: "Quit",
      click: () => app.quit(),
    },
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip(cachedStatus);
};

const refreshStatus = async () => {
  try {
    const [response, insightsResponse, metadataResponse] = await Promise.all([
      fetch(`${apiBase}/overlay-status`),
      fetch(`${apiBase}/overlay-insights`),
      fetch(`${apiBase}/metadata-status`),
    ]);
    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }
    const insights = insightsResponse.ok
      ? await insightsResponse.json()
      : { recentChangeDates: [], rarityProgress: [] };
    const metadata = metadataResponse.ok
      ? await metadataResponse.json()
      : { source: "unavailable", stale: true };
    startupErrorMessage = null;
    const data = await response.json();
    const mtgaState = data.isMtgaRunning ? "MTGA running" : "MTGA not running";
    const lastSync = data.lastSyncAt
      ? `last sync ${new Date(data.lastSyncAt).toLocaleTimeString()}`
      : "never synced";
    cachedStatus = `${mtgaState} • ${lastSync}`;
    cachedSummary =
      data.totalCopies > 0
        ? `${Number(data.totalCopies).toLocaleString()} copies • ${Number(data.nonZeroCards).toLocaleString()} unique`
        : "No collection cards seen yet";
    const metadataFreshness = formatMetadataFreshness(metadata.lastRefreshedAt);
    const metadataStaleNote = metadata.stale ? " (stale)" : "";
    cachedOverlayPayload = {
      statusLine: mtgaState,
      summaryLine:
        data.totalCopies > 0
          ? `${Number(data.totalCopies).toLocaleString()} cards • ${Number(data.nonZeroCards).toLocaleString()} unique`
          : data.statusDetail
            ? `Zero cards yet. ${String(data.statusDetail).replace(/^.*memory_scan_/, "scan: ")}`
            : "Zero collection cards seen yet",
      autoScanLine: `Auto memory scan: ${String(data.autoScanStatus || "inactive (manual rescan only)")}`,
      metadataFreshnessLine: `Metadata updated: ${metadataFreshness}${metadataStaleNote}`,
      recentChangeDates: Array.isArray(insights.recentChangeDates) ? insights.recentChangeDates : [],
      rarityProgress: Array.isArray(insights.rarityProgress) ? insights.rarityProgress : [],
      rescanState: rescanUiState,
      rescanMessage: rescanUiMessage,
    };
  } catch {
    cachedStatus = "Sync agent offline";
    cachedSummary = startupErrorMessage ?? "Waiting for sync agent";
    cachedOverlayPayload = {
      statusLine: startupErrorMessage ? "Startup error" : "Sniffer offline",
      summaryLine: startupErrorMessage ?? "Waiting for sync agent",
      metadataFreshnessLine: "Metadata updated: unknown",
      autoScanLine: "Auto memory scan: inactive",
      recentChangeDates: [],
      rarityProgress: [],
      rescanState: rescanUiState,
      rescanMessage: rescanUiMessage,
    };
  }
  updateMenu();
  pushOverlayPayload();
};

const fetchMemoryAnchors = async () => {
  const response = await fetch(`${apiBase}/memory-anchors`);
  if (!response.ok) {
    throw new Error(`status ${response.status}`);
  }
  const data = await response.json();
  return Array.isArray(data.anchors) ? data.anchors : [];
};

const saveMemoryAnchors = async (anchors) => {
  const response = await fetch(`${apiBase}/memory-anchors`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ anchors }),
  });
  if (!response.ok) {
    throw new Error(`status ${response.status}`);
  }
};

const startSyncAgent = async () => {
  const { distRoot, memoryScanScriptPath } = resolveEmbeddedAgentPaths();
  const syncServiceModulePath = path.join(distRoot, "runtime", "syncService.js");
  const apiModulePath = path.join(distRoot, "api", "server.js");

  const syncServiceModuleUrl = pathToFileURL(syncServiceModulePath).href;
  const apiModuleUrl = pathToFileURL(apiModulePath).href;
  const [{ SyncService }, { createApiServer }] = await Promise.all([
    import(syncServiceModuleUrl),
    import(apiModuleUrl),
  ]);

  const collectorDataDirectory = getCollectorDataDirectory();
  await mkdir(collectorDataDirectory, { recursive: true });
  const legacyCollectorDirectories = [
    path.join(app.getPath("userData"), "collector"),
    path.join(os.homedir(), "AppData", "LocalLow", "MTGA Sniffer"),
  ];
  if (!app.isPackaged) {
    legacyCollectorDirectories.push(path.resolve(__dirname, "..", "..", "sync-agent", "data"));
  }
  for (const legacyCollectorDirectory of legacyCollectorDirectories) {
    await migrateCollectorDataIfNeeded({
      legacyCollectorDirectory,
      collectorDataDirectory,
      existsSyncImpl: existsSync,
    });
  }
  const scryfallDataDirectory = path.join(collectorDataDirectory, "scryfall");

  memoryScanAvailable = existsSync(memoryScanScriptPath);

  const syncService = new SyncService({
    playerLogPath: process.env.MTGA_PLAYER_LOG_PATH ?? path.join(mtgaDataDirectory, "Player.log"),
    snapshotPath:
      process.env.MTGA_COLLECTION_SNAPSHOT_PATH ??
      path.join(mtgaDataDirectory, "collection_snapshot.json"),
    sqlitePath: process.env.MTGA_SQLITE_PATH ?? path.join(collectorDataDirectory, "collection.sqlite"),
    exportJsonPath:
      process.env.MTGA_EXPORT_JSON_PATH ?? path.join(collectorDataDirectory, "latest_collection.json"),
    syncHistoryLogPath:
      process.env.MTGA_SYNC_HISTORY_LOG_PATH ??
      path.join(collectorDataDirectory, "sync_history.log"),
    memoryScanScriptPath,
    memoryAnchorsPath:
      process.env.MTGA_MEMORY_ANCHORS_PATH ??
      path.join(collectorDataDirectory, "memory_anchors.json"),
    scryfallCachePath:
      process.env.MTGA_SCRYFALL_CACHE_PATH ??
      path.join(scryfallDataDirectory, "scryfall_cache.json"),
    scryfallArenaLookupPath:
      process.env.MTGA_SCRYFALL_ARENA_LOOKUP_PATH ??
      path.join(scryfallDataDirectory, "arena_id_lookup_scryfall.json"),
    arenaMetadataIndexPath:
      process.env.MTGA_ARENA_METADATA_INDEX_PATH ??
      path.join(scryfallDataDirectory, "arena_metadata_index.json"),
    denominatorStatsPath:
      process.env.MTGA_DENOMINATOR_STATS_PATH ??
      path.join(scryfallDataDirectory, "denominator_stats.json"),
  });
  await syncService.start();

  const api = createApiServer(syncService);
  syncApiServer = await new Promise((resolve, reject) => {
    const server = api.listen(Number(agentPort), () => resolve(server));
    server.on("error", reject);
  });
};

const iconHtml = () => {
  const iconImage = getAppIconDataUrl();
  const iconMarkup = iconImage
    ? `<img src="${iconImage}" alt="" draggable="false" />`
    : "i";
  const iconTextStyles = iconImage
    ? ""
    : `
      color: #ffffff;
      font-family: "Segoe UI", system-ui, sans-serif;
      font-size: 19px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;`;
  const iconImageStyles = iconImage
    ? `
    .icon img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      pointer-events: none;
    }`
    : "";
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body {
      margin: 0;
      width: ${ICON_SIZE}px;
      height: ${ICON_SIZE}px;
      background: transparent;
      overflow: hidden;
    }
    .icon {
      width: ${ICON_SIZE}px;
      height: ${ICON_SIZE}px;
      border-radius: 50%;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.85);
      background: rgba(16, 20, 30, 0.72);
      box-sizing: border-box;
      user-select: none;
      cursor: default;${iconTextStyles}
    }${iconImageStyles}
  </style>
</head>
<body>
  <div id="icon" class="icon">${iconMarkup}</div>
  <script>
    const { ipcRenderer } = require("electron");
    const icon = document.getElementById("icon");
    icon.addEventListener("mouseenter", () => ipcRenderer.send("overlay-icon-enter"));
    icon.addEventListener("mouseleave", () => ipcRenderer.send("overlay-icon-leave"));
  </script>
</body>
</html>`;
};

const tooltipHtml = () => `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body {
      margin: 0;
      width: ${TOOLTIP_WIDTH}px;
      height: ${TOOLTIP_MIN_HEIGHT}px;
      background: transparent;
      overflow: hidden;
      font-family: "Segoe UI", system-ui, sans-serif;
    }
    .card {
      position: relative;
      width: ${TOOLTIP_WIDTH - 2}px;
      height: calc(100% - 2px);
      margin: 1px;
      border-radius: 12px;
      border: 1px solid rgba(255, 210, 130, 0.38);
      background: rgba(10, 12, 18, 0.92);
      color: #f8f4ea;
      box-sizing: border-box;
      padding: 10px 12px;
      line-height: 1.25;
      display: flex;
      flex-direction: column;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.48);
      overflow: hidden;
    }
    .card-bg {
      position: absolute;
      inset: 0;
      border-radius: 11px;
      background-size: cover;
      background-position: center center;
      background-repeat: no-repeat;
      opacity: 1;
      transition: opacity 0.55s ease;
      z-index: 0;
      pointer-events: none;
    }
    .card-bg::after {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: 11px;
      background: linear-gradient(
        180deg,
        rgba(8, 10, 18, 0.28) 0%,
        rgba(8, 10, 18, 0.72) 52%,
        rgba(8, 10, 18, 0.92) 100%
      );
    }
    .card-content {
      position: relative;
      z-index: 1;
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
    }
    .status {
      font-weight: 700;
      font-size: 14px;
      margin-bottom: 4px;
      color: #fff8ea;
      text-shadow: 0 1px 4px rgba(0, 0, 0, 0.9);
    }
    .summary {
      color: #efe6d2;
      font-size: 13px;
      margin-bottom: 4px;
      text-shadow: 0 1px 4px rgba(0, 0, 0, 0.9);
    }
    .meta {
      color: #dccfb8;
      font-size: 12px;
      margin-bottom: 6px;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.85);
    }
    .meta-tight {
      color: #dccfb8;
      font-size: 12px;
      margin-bottom: 3px;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.85);
    }
    .scroll-content {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      min-height: 70px;
      padding: 8px 8px 6px;
      margin-top: 2px;
      border-radius: 8px;
      background: rgba(8, 10, 16, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.06);
      transition: background 0.28s ease, border-color 0.28s ease;
    }
    .scroll-content:hover {
      background: rgba(8, 10, 16, 0.58);
      border-color: rgba(255, 255, 255, 0.08);
    }
    .section-title {
      margin-top: 6px;
      margin-bottom: 4px;
      font-size: 12px;
      color: #f0d9a8;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.85);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      margin-bottom: 6px;
    }
    th, td {
      padding: 2px 4px;
      text-align: left;
      color: #f1ead8;
    }
    th {
      color: #e2c992;
      font-weight: 600;
      border-bottom: 1px solid rgba(255, 255, 255, 0.14);
    }
    .rarity-row {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      color: #f1ead8;
      margin: 1px 0;
    }
    .empty {
      font-size: 12px;
      color: #c8bcaa;
      margin-bottom: 4px;
    }
    .actions { display: flex; justify-content: flex-end; margin-top: 8px; }
    .rescan-status {
      font-size: 12px;
      color: #c8d8f8;
      min-height: 14px;
      margin-top: 4px;
      margin-bottom: 2px;
    }
    .rescan-status.ok { color: #8dd9a8; }
    .rescan-status.running { color: #9ec7ff; }
    .rescan-status.error { color: #f4a3a3; }
    .rescan-btn {
      border: 1px solid rgba(255, 210, 130, 0.45);
      background: rgba(120, 88, 28, 0.55);
      color: #fff8ea;
      border-radius: 6px;
      font-size: 12px;
      padding: 3px 10px;
      cursor: pointer;
      margin-right: 6px;
    }
    .rescan-btn:hover { background: rgba(150, 110, 36, 0.72); }
    .exit-btn {
      border: 1px solid rgba(255, 255, 255, 0.28);
      background: rgba(255, 255, 255, 0.1);
      color: #fff8ea;
      border-radius: 6px;
      font-size: 12px;
      padding: 3px 10px;
      cursor: pointer;
    }
    .exit-btn:hover { background: rgba(255, 255, 255, 0.2); }
    .version-tag {
      font-size: 10px;
      color: #c8bcaa;
      text-align: right;
      margin-top: 6px;
      opacity: 0.8;
      letter-spacing: 0.3px;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
    }
  </style>
</head>
<body>
  <div id="card" class="card">
    <div id="cardBg" class="card-bg" aria-hidden="true"></div>
    <div class="card-content">
    <div id="status" class="status">Sniffer offline</div>
    <div id="summary" class="summary">Waiting for sync agent</div>
    <div id="metaFreshness" class="meta-tight">Metadata updated: unknown</div>
    <div id="autoScan" class="meta">Auto memory scan: inactive</div>
    <div id="contentScroll" class="scroll-content">
      <div class="section-title">Recent Changes</div>
      <div id="changesEmpty" class="empty">No recent ownership changes</div>
      <table id="changesTable" style="display:none">
        <thead>
          <tr>
            <th>Date</th>
            <th>Cards Δ</th>
            <th>Unique Δ</th>
            <th>Last</th>
          </tr>
        </thead>
        <tbody id="changesBody"></tbody>
      </table>
      <div class="section-title">Rarity Unique Owned</div>
      <div id="rarityBody"></div>
      <div id="rescanStatus" class="rescan-status"></div>
    </div>
    <div class="actions">
      <button id="rescanBtn" class="rescan-btn" type="button">Rescan</button>
      <button id="exitBtn" class="exit-btn" type="button">Exit</button>
    </div>
    <div id="versionTag" class="version-tag">v${APP_VERSION}</div>
    </div>
  </div>
  <script>
    const { ipcRenderer } = require("electron");
    const card = document.getElementById("card");
    const cardBg = document.getElementById("cardBg");
    const overlayBackgrounds = ${getOverlayBackgroundsJson()};
    let overlayBackgroundIndex = 0;
    const applyOverlayBackground = (index) => {
      if (!cardBg || overlayBackgrounds.length === 0) {
        return;
      }
      cardBg.style.backgroundImage = 'url("' + overlayBackgrounds[index] + '")';
    };
    if (overlayBackgrounds.length > 0) {
      overlayBackgroundIndex = Math.floor(Math.random() * overlayBackgrounds.length);
      applyOverlayBackground(overlayBackgroundIndex);
      if (overlayBackgrounds.length > 1) {
        setInterval(() => {
          overlayBackgroundIndex = (overlayBackgroundIndex + 1) % overlayBackgrounds.length;
          cardBg.style.opacity = "0";
          setTimeout(() => {
            applyOverlayBackground(overlayBackgroundIndex);
            cardBg.style.opacity = "1";
          }, 280);
        }, ${OVERLAY_BACKGROUND_ROTATE_MS});
      }
    }
    const status = document.getElementById("status");
    const summary = document.getElementById("summary");
    const metaFreshness = document.getElementById("metaFreshness");
    const autoScan = document.getElementById("autoScan");
    const changesTable = document.getElementById("changesTable");
    const changesBody = document.getElementById("changesBody");
    const changesEmpty = document.getElementById("changesEmpty");
    const rarityBody = document.getElementById("rarityBody");
    const rescanStatus = document.getElementById("rescanStatus");
    const rescanBtn = document.getElementById("rescanBtn");
    const exitBtn = document.getElementById("exitBtn");
    card.addEventListener("mouseenter", () => ipcRenderer.send("overlay-tooltip-enter"));
    card.addEventListener("mouseleave", () => ipcRenderer.send("overlay-tooltip-leave"));
    rescanBtn.addEventListener("click", () => ipcRenderer.send("overlay-rescan-clicked"));
    exitBtn.addEventListener("click", () => ipcRenderer.send("overlay-exit-clicked"));
    const formatDelta = (value) => {
      const num = Number(value || 0);
      if (num > 0) return "+" + num.toLocaleString();
      if (num < 0) return num.toLocaleString();
      return "0";
    };
    const formatTime = (iso) => {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return "--";
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    };
    window.__setOverlay = (payload) => {
      status.textContent = payload.statusLine;
      summary.textContent = payload.summaryLine;
      metaFreshness.textContent = String(payload.metadataFreshnessLine || "");
      autoScan.textContent = String(payload.autoScanLine || "");
      const recent = Array.isArray(payload.recentChangeDates) ? payload.recentChangeDates : [];
      changesBody.innerHTML = "";
      if (recent.length === 0) {
        changesTable.style.display = "none";
        changesEmpty.style.display = "block";
      } else {
        changesTable.style.display = "table";
        changesEmpty.style.display = "none";
        for (const row of recent.slice(0, 5)) {
          const tr = document.createElement("tr");
          tr.innerHTML =
            "<td>" + String(row.date || "--") + "</td>" +
            "<td>" + formatDelta(row.cardsDelta) + "</td>" +
            "<td>" + formatDelta(row.uniqueDelta) + "</td>" +
            "<td>" + formatTime(row.lastUpdateAt) + "</td>";
          changesBody.appendChild(tr);
        }
      }

      const rarityRows = Array.isArray(payload.rarityProgress) ? payload.rarityProgress : [];
      rarityBody.innerHTML = "";
      if (rarityRows.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No rarity data available";
        rarityBody.appendChild(empty);
      } else {
        for (const row of rarityRows) {
          const line = document.createElement("div");
          line.className = "rarity-row";
          line.innerHTML =
            "<span>" + String(row.rarity) + "</span>" +
            "<span>" + Number(row.ownedUnique || 0).toLocaleString() + " / " + Number(row.totalCollectible || 0).toLocaleString() + "</span>";
          rarityBody.appendChild(line);
        }
      }

      const rescanState = String(payload.rescanState || "idle");
      const rescanMessage = String(payload.rescanMessage || "");
      rescanBtn.disabled = rescanState === "running";
      rescanBtn.textContent = rescanState === "running" ? "Scanning..." : "Rescan";
      rescanStatus.className = "rescan-status";
      if (rescanState === "running") {
        rescanStatus.classList.add("running");
      } else if (rescanState === "ok") {
        rescanStatus.classList.add("ok");
      } else if (rescanState === "error") {
        rescanStatus.classList.add("error");
      }
      rescanStatus.textContent = rescanMessage;
    };
    window.__measureOverlayHeight = () => {
      const card = document.getElementById("card");
      return Math.ceil(card.scrollHeight) + 2;
    };
  </script>
</body>
</html>`;

const anchorConfigHtml = (prefillText) => `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { margin: 0; font-family: "Segoe UI", system-ui, sans-serif; background: #0d1220; color: #eef2ff; }
    .wrap { padding: 14px; }
    .title { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
    .hint { font-size: 12px; color: #c7cff1; margin-bottom: 10px; }
    textarea { width: 100%; height: 180px; resize: none; box-sizing: border-box; border-radius: 8px; border: 1px solid #3b4568; background: #131a2c; color: #f2f5ff; padding: 10px; font-size: 12px; font-family: "Consolas", monospace; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
    button { border-radius: 6px; border: 1px solid #4f5a82; background: #1f2942; color: #f2f5ff; padding: 4px 10px; font-size: 12px; cursor: pointer; }
    button:hover { background: #2a3553; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="title">Memory Scan Anchors</div>
    <div class="hint">Enter one anchor per line: Card Name | Quantity (5 recommended). Before scanning: open Collection in MTGA and scroll ~30 seconds.</div>
    <textarea id="anchors">${prefillText}</textarea>
    <div class="actions">
      <button id="cancelBtn" type="button">Cancel</button>
      <button id="saveBtn" type="button">Save</button>
    </div>
  </div>
  <script>
    const { ipcRenderer } = require("electron");
    const textarea = document.getElementById("anchors");
    document.getElementById("cancelBtn").addEventListener("click", () => ipcRenderer.send("anchors-cancel"));
    document.getElementById("saveBtn").addEventListener("click", () => {
      const lines = textarea.value.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean);
      const anchors = [];
      for (const line of lines) {
        const parts = line.split("|");
        if (parts.length < 2) continue;
        const name = parts[0].trim();
        const quantity = Number(parts[1].trim());
        if (!name || !Number.isFinite(quantity) || quantity <= 0) continue;
        anchors.push({ name, quantity: Math.floor(quantity) });
      }
      ipcRenderer.send("anchors-save", anchors);
    });
  </script>
</body>
</html>`;

const ensureIconWindow = () => {
  if (iconWindow && !iconWindow.isDestroyed()) {
    return iconWindow;
  }
  iconWindow = new BrowserWindow({
    width: ICON_SIZE,
    height: ICON_SIZE,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    thickFrame: false,
    roundedCorners: false,
    webPreferences: {
      devTools: false,
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: true,
    },
  });
  iconWindow.setAlwaysOnTop(true, "screen-saver");
  iconWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  applyCircularShape(iconWindow, ICON_SIZE);
  void iconWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(iconHtml())}`);
  iconWindow.on("closed", () => {
    iconWindow = null;
  });
  return iconWindow;
};

const ensureTooltipWindow = () => {
  if (tooltipWindow && !tooltipWindow.isDestroyed()) {
    return tooltipWindow;
  }
  tooltipWindow = new BrowserWindow({
    width: TOOLTIP_WIDTH,
    height: TOOLTIP_MIN_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      devTools: false,
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: true,
      webSecurity: false,
    },
  });
  tooltipWindow.setAlwaysOnTop(true, "screen-saver");
  tooltipWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const backgroundCount = loadOverlayBackgroundFileUrls().length;
  void tooltipWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(tooltipHtml())}`);
  tooltipWindow.webContents.on("did-finish-load", () => {
    if (tooltipWindow?.isDestroyed()) {
      return;
    }
    tooltipWindow.webContents
      .executeJavaScript(
        `console.log("overlay backgrounds loaded: ${backgroundCount}, version: v${APP_VERSION}");`,
        true,
      )
      .catch(() => {});
  });
  tooltipWindow.on("closed", () => {
    tooltipWindow = null;
  });
  return tooltipWindow;
};

const closeAnchorConfigWindow = () => {
  if (anchorConfigWindow && !anchorConfigWindow.isDestroyed()) {
    anchorConfigWindow.close();
  }
  anchorConfigWindow = null;
};

const openAnchorConfigWindow = async () => {
  if (anchorConfigWindow && !anchorConfigWindow.isDestroyed()) {
    anchorConfigWindow.show();
    return;
  }
  let anchors = [];
  try {
    anchors = await fetchMemoryAnchors();
  } catch {
    anchors = [];
  }
  const prefillText = anchors
    .map((anchor) => `${String(anchor.name)} | ${String(anchor.quantity)}`)
    .join("\n");

  anchorConfigWindow = new BrowserWindow({
    width: 430,
    height: 340,
    show: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    title: "Configure Memory Anchors",
    webPreferences: {
      devTools: false,
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: true,
    },
  });
  void anchorConfigWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(anchorConfigHtml(prefillText))}`,
  );
  anchorConfigWindow.on("closed", () => {
    anchorConfigWindow = null;
  });
};

const hideTooltipNow = () => {
  if (tooltipHideTimer) {
    clearTimeout(tooltipHideTimer);
    tooltipHideTimer = null;
  }
  if (tooltipWindow && !tooltipWindow.isDestroyed()) {
    tooltipWindow.hide();
  }
};

const scheduleTooltipHide = () => {
  if (tooltipHideTimer) {
    clearTimeout(tooltipHideTimer);
  }
  tooltipHideTimer = setTimeout(() => {
    hideTooltipNow();
  }, 180);
};

const showTooltip = () => {
  if (tooltipHideTimer) {
    clearTimeout(tooltipHideTimer);
    tooltipHideTimer = null;
  }
  if (!lastMtgaState || !lastMtgaState.running || !lastMtgaState.focused) {
    return;
  }
  const win = ensureTooltipWindow();
  const display = screen.getDisplayNearestPoint({ x: lastMtgaState.x, y: lastMtgaState.y });
  const workArea = display.workArea;
  const availableHeight = Math.max(180, workArea.height - EDGE_PADDING * 2);
  const currentHeight = clamp(
    Math.max(TOOLTIP_MIN_HEIGHT, win.getBounds().height || TOOLTIP_MIN_HEIGHT),
    180,
    availableHeight,
  );
  const mtgaMinX = lastMtgaState.x + EDGE_PADDING;
  const mtgaMaxX = lastMtgaState.x + lastMtgaState.width - TOOLTIP_WIDTH - EDGE_PADDING;
  const preferredX = lastMtgaState.x + ICON_LEFT_OFFSET;
  const clampedInMtgaX = clamp(preferredX, mtgaMinX, mtgaMaxX);
  const x = clamp(clampedInMtgaX, workArea.x + EDGE_PADDING, workArea.x + workArea.width - TOOLTIP_WIDTH - EDGE_PADDING);
  const preferredY = lastMtgaState.y + ICON_TOP_OFFSET + ICON_SIZE + TOOLTIP_ICON_GAP;
  const y = clamp(
    preferredY,
    workArea.y + EDGE_PADDING,
    workArea.y + workArea.height - currentHeight - EDGE_PADDING,
  );
  win.setBounds({ x, y, width: TOOLTIP_WIDTH, height: currentHeight }, false);
  if (!win.isVisible()) {
    win.showInactive();
  }
};

const pushOverlayPayload = () => {
  const win = ensureTooltipWindow();
  if (win.isDestroyed()) {
    return;
  }
  const payload = JSON.stringify(cachedOverlayPayload);
  void win.webContents.executeJavaScript(
    `window.__setOverlay && window.__setOverlay(${payload});`,
    true,
  );
  void adjustTooltipHeight();
};

const adjustTooltipHeight = async () => {
  const win = ensureTooltipWindow();
  if (win.isDestroyed()) {
    return;
  }
  try {
    const current = win.getBounds();
    const display = screen.getDisplayNearestPoint({
      x: current.x + Math.floor(current.width / 2),
      y: current.y + Math.floor(current.height / 2),
    });
    const availableHeight = Math.max(180, display.workArea.height - EDGE_PADDING * 2);
    const measured = await win.webContents.executeJavaScript(
      "window.__measureOverlayHeight ? window.__measureOverlayHeight() : null;",
      true,
    );
    const targetHeight = clamp(
      Number(measured || TOOLTIP_MIN_HEIGHT),
      180,
      Math.min(TOOLTIP_MAX_HEIGHT, availableHeight),
    );
    if (Math.abs(current.height - targetHeight) > 2) {
      win.setBounds({ ...current, height: targetHeight }, false);
      if (win.isVisible()) {
        showTooltip();
      }
    }
  } catch {
    // Ignore temporary measurement failures while renderer initializes.
  }
};

const readMtgaWindowState = async () => {
  const command = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Win32WindowApi {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@;
$proc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like "MTGA*" } | Select-Object -First 1;
if (-not $proc) {
  [pscustomobject]@{ running=$false; focused=$false; x=0; y=0; width=0; height=0 } | ConvertTo-Json -Compress;
  exit 0;
}
$rect = New-Object Win32WindowApi+RECT;
[void][Win32WindowApi]::GetWindowRect($proc.MainWindowHandle, [ref]$rect);
$fg = [Win32WindowApi]::GetForegroundWindow();
$focused = ($fg -eq $proc.MainWindowHandle);
[pscustomobject]@{
  running=$true;
  focused=$focused;
  x=$rect.Left;
  y=$rect.Top;
  width=($rect.Right - $rect.Left);
  height=($rect.Bottom - $rect.Top)
} | ConvertTo-Json -Compress
`.trim();

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      { windowsHide: true, timeout: 1200, maxBuffer: 256 * 1024 },
    );
    return JSON.parse(stdout.trim());
  } catch {
    return { running: false, focused: false, x: 0, y: 0, width: 0, height: 0 };
  }
};

const syncOverlayPlacement = async () => {
  if (overlayProbeInFlight) {
    return;
  }
  overlayProbeInFlight = true;
  const state = await readMtgaWindowState();
  lastMtgaState = state;
  const icon = ensureIconWindow();
  try {
    if (!state.running || !state.focused || state.width <= 0 || state.height <= 0) {
      icon.hide();
      hideTooltipNow();
      return;
    }
    const display = screen.getDisplayNearestPoint({ x: state.x, y: state.y });
    const workArea = display.workArea;
    const preferredX = state.x + ICON_LEFT_OFFSET;
    const preferredY = state.y + ICON_TOP_OFFSET;
    const x = clamp(preferredX, workArea.x + EDGE_PADDING, workArea.x + workArea.width - ICON_SIZE - EDGE_PADDING);
    const y = clamp(preferredY, workArea.y + EDGE_PADDING, workArea.y + workArea.height - ICON_SIZE - EDGE_PADDING);
    icon.setBounds({ x, y, width: ICON_SIZE, height: ICON_SIZE }, false);
    if (!icon.isVisible()) {
      icon.showInactive();
    }
    if (tooltipWindow && !tooltipWindow.isDestroyed() && tooltipWindow.isVisible()) {
      showTooltip();
    }
  } finally {
    overlayProbeInFlight = false;
  }
};

app.whenReady().then(async () => {
  tray = new Tray(createTrayIcon());

  ipcMain.on("overlay-icon-enter", () => {
    showTooltip();
  });
  ipcMain.on("overlay-icon-leave", () => {
    scheduleTooltipHide();
  });
  ipcMain.on("overlay-tooltip-enter", () => {
    showTooltip();
  });
  ipcMain.on("overlay-tooltip-leave", () => {
    scheduleTooltipHide();
  });
  ipcMain.on("overlay-exit-clicked", () => {
    app.quit();
  });
  ipcMain.on("overlay-rescan-clicked", async () => {
    if (rescanInFlight) {
      return;
    }
    rescanInFlight = true;
    rescanUiState = "running";
    rescanUiMessage = "Rescan in progress...";
    await refreshStatus();
    try {
      const response = await fetch(`${apiBase}/memory-scan`, { method: "POST" });
      const data = response.ok ? await response.json() : null;
      const cardCount = Number(data?.cardCount ?? 0);
      const ok = Boolean(data?.ok);
      rescanUiState = ok ? "ok" : "error";
      rescanUiMessage = ok
        ? `Rescan finished (${cardCount.toLocaleString()} cards matched)`
        : formatRescanFailureMessage(data?.status);
      await refreshStatus();
    } catch {
      rescanUiState = "error";
      rescanUiMessage = "Rescan failed";
      cachedOverlayPayload = {
        ...cachedOverlayPayload,
        statusLine: "Rescan failed",
        summaryLine: "Could not trigger memory scan",
      };
      pushOverlayPayload();
    } finally {
      rescanInFlight = false;
    }
  });
  ipcMain.on("anchors-cancel", () => {
    closeAnchorConfigWindow();
  });
  ipcMain.on("anchors-save", async (_event, anchors) => {
    try {
      await saveMemoryAnchors(Array.isArray(anchors) ? anchors : []);
      await refreshStatus();
    } catch {
      cachedOverlayPayload = {
        statusLine: "Anchor save failed",
        summaryLine: "Could not save memory anchors",
      };
      pushOverlayPayload();
    } finally {
      closeAnchorConfigWindow();
    }
  });

  try {
    await startSyncAgent();
  } catch (error) {
    startupErrorMessage = String(error).slice(0, 120);
    cachedStatus = "Sync agent failed to start";
    cachedSummary = startupErrorMessage;
    cachedOverlayPayload = {
      statusLine: "Startup error",
      summaryLine: startupErrorMessage,
    };
  }

  ensureIconWindow();
  ensureTooltipWindow();
  updateMenu();
  await refreshStatus();
  await syncOverlayPlacement();
  setInterval(() => {
    void refreshStatus();
  }, 10_000).unref();
  setInterval(() => {
    void syncOverlayPlacement();
  }, 1_000).unref();
});

app.on("before-quit", () => {
  hideTooltipNow();
  if (syncApiServer) {
    try {
      syncApiServer.close();
    } catch {
      // Ignore shutdown errors during app exit.
    }
  }
  if (tooltipWindow && !tooltipWindow.isDestroyed()) {
    tooltipWindow.close();
  }
  if (anchorConfigWindow && !anchorConfigWindow.isDestroyed()) {
    anchorConfigWindow.close();
  }
  if (iconWindow && !iconWindow.isDestroyed()) {
    iconWindow.close();
  }
});

app.on("second-instance", () => {
  if (iconWindow && !iconWindow.isDestroyed()) {
    iconWindow.showInactive();
  }
});
