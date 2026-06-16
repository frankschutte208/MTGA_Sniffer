import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const sharedTypesPath = path.join(repoRoot, "packages", "shared-types", "src", "index.ts");
const scannerConfigPath = path.join(
  repoRoot,
  "apps",
  "sync-agent",
  "src",
  "runtime",
  "scanner",
  "config.ts",
);
const vendorDir = path.join(repoRoot, "vendor", "MTGA-collection-exporter", "V1.2");
const vendorManifestPath = path.join(vendorDir, "manifest.json");
const vendorExePath = path.join(vendorDir, "MTGA-collection-exporter.exe");
const vendorMtgPath = path.join(vendorDir, "mtg.py");
const bannedScanFork = path.join(repoRoot, "apps", "sync-agent", "scripts", "mtga_memory_scan.py");

const parseVersion = (content, pattern, label) => {
  const match = content.match(pattern);
  if (!match) {
    throw new Error(`preflight_missing_${label}_version`);
  }
  return Number(match[1]);
};

const runNpm = (args) => {
  const result = spawnSync("npm", args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`preflight_npm_failed:${args.join(" ")}`);
  }
};

const assertNoPymemForks = async () => {
  const scriptsDir = path.join(repoRoot, "apps", "sync-agent", "scripts");
  let entries = [];
  try {
    entries = await readdir(scriptsDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".py")) {
      continue;
    }
    const fullPath = path.join(scriptsDir, entry);
    const content = await readFile(fullPath, "utf8");
    if (/pymem|pattern_scan_all|find_blocks/.test(content)) {
      throw new Error(`preflight_custom_scan_python_forbidden:${entry}`);
    }
  }
};

const main = async () => {
  if (await readFile(bannedScanFork, "utf8").then(() => true).catch(() => false)) {
    throw new Error("preflight_mtga_memory_scan_py_forbidden");
  }
  await assertNoPymemForks();

  const [sharedContent, scannerConfigContent, manifestRaw, exeBytes, mtgBytes] = await Promise.all([
    readFile(sharedTypesPath, "utf8"),
    readFile(scannerConfigPath, "utf8"),
    readFile(vendorManifestPath, "utf8"),
    readFile(vendorExePath),
    readFile(vendorMtgPath),
  ]);

  const sharedVersion = parseVersion(
    sharedContent,
    /export const SCAN_API_VERSION = (\d+);/,
    "shared_types",
  );
  const syncAgentVersion = parseVersion(
    scannerConfigContent,
    /export const SCAN_API_VERSION = (\d+);/,
    "sync_agent_scanner",
  );
  if (sharedVersion !== syncAgentVersion) {
    throw new Error(
      `preflight_scan_api_version_mismatch:shared=${sharedVersion}:sync_agent=${syncAgentVersion}`,
    );
  }

  const manifest = JSON.parse(manifestRaw);
  const actualExeHash = createHash("sha256").update(exeBytes).digest("hex");
  const expectedExeHash = String(manifest.sha256 ?? "").toLowerCase();
  if (!expectedExeHash || actualExeHash !== expectedExeHash) {
    throw new Error(
      `preflight_vendor_exe_hash_mismatch:expected=${expectedExeHash || "missing"}:actual=${actualExeHash}`,
    );
  }

  const actualMtgHash = createHash("sha256").update(mtgBytes).digest("hex");
  const expectedMtgHash = String(manifest.mtgPySha256 ?? "").toLowerCase();
  if (!expectedMtgHash || actualMtgHash !== expectedMtgHash) {
    throw new Error(
      `preflight_vendor_mtg_py_hash_mismatch:expected=${expectedMtgHash || "missing"}:actual=${actualMtgHash}`,
    );
  }

  runNpm(["run", "-w", "@mtga/sync-agent", "test"]);
  runNpm(["run", "-w", "@mtga/tray-ui", "test"]);
  console.log(
    `memory scan preflight ok (scanApiVersion=${sharedVersion}, vendor=${manifest.version}, exe=${actualExeHash.slice(0, 12)}..., mtg.py=${actualMtgHash.slice(0, 12)}...)`,
  );
};

await main();
