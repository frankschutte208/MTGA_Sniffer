import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { exec } from "node:child_process";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMtgaLocalCatalog } from "../../apps/sync-agent/dist/runtime/mtgaLocalCatalog.js";
import { buildCatalogLookup, toUpstreamAnchorsJson } from "../../apps/sync-agent/dist/runtime/scanner/invokeUpstreamExporter.js";
import { buildArenaIdLookupFromCatalog } from "../../apps/sync-agent/dist/runtime/scanner/arenaIdLookup.js";

const execAsync = promisify(exec);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const exe = path.join(repoRoot, "vendor", "MTGA-collection-exporter", "V1.2", "MTGA-collection-exporter.exe");

const catalog = await loadMtgaLocalCatalog();
const lookup = buildCatalogLookup(catalog);
const anchors = [
  { cardId: 79239, quantity: 1 },
  { cardId: 35573, quantity: 1 },
  { cardId: 77883, quantity: 1 },
  { cardId: 86060, quantity: 1 },
  { cardId: 71397, quantity: 2 },
  { cardId: 51569, quantity: 3 },
  { cardId: 75266, quantity: 3 },
  { cardId: 75799, quantity: 3 },
];
const upstreamAnchors = toUpstreamAnchorsJson(anchors, lookup);
const mergedLookup = buildArenaIdLookupFromCatalog(catalog);

const prepareDir = async (prefix) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const workExe = path.join(dir, "MTGA-collection-exporter.exe");
  await copyFile(exe, workExe);
  await writeFile(path.join(dir, "last_anchors.json"), JSON.stringify(upstreamAnchors, null, 2));
  await writeFile(path.join(dir, "arena_id_lookup.json"), JSON.stringify(mergedLookup));
  return { dir, workExe };
};

const tryCollection = async (dir) => {
  try {
    const raw = await readFile(path.join(dir, "mtga_collection.json"), "utf8");
    return JSON.parse(raw).length;
  } catch {
    return 0;
  }
};

console.log("=== CMD pipe (backup style) ===");
{
  const { dir, workExe } = await prepareDir("mtga-cmd-");
  const logPath = path.join(dir, "upstream.log");
  const command = `(echo Y& echo.& echo.& echo.& echo.& echo.) | "${workExe}" > "${logPath}" 2>&1`;
  await execAsync(command, { cwd: dir, windowsHide: true, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
  const log = await readFile(logPath, "utf8");
  console.log("log tail:", log.slice(-800));
  console.log("collection rows:", await tryCollection(dir));
  console.log("workdir:", dir);
}

console.log("\n=== spawn Y then newlines ===");
{
  const { dir, workExe } = await prepareDir("mtga-spawn-");
  const child = spawn(workExe, [], { cwd: dir, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child.stdin.write("Y\n");
  const pump = setInterval(() => child.stdin?.write("\n"), 1000);
  let out = "";
  child.stdout.on("data", (chunk) => {
    out += chunk.toString();
  });
  await new Promise((resolve) => child.on("close", resolve));
  clearInterval(pump);
  console.log("log tail:", out.slice(-800));
  console.log("collection rows:", await tryCollection(dir));
  console.log("workdir:", dir);
}
