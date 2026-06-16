import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMtgaLocalCatalog } from "../apps/sync-agent/dist/runtime/mtgaLocalCatalog.js";
import {
  buildCatalogLookup,
  toUpstreamAnchorsJson,
} from "../apps/sync-agent/dist/runtime/scanner/invokeUpstreamExporter.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exeName = "MTGA-collection-exporter.exe";
const exe = path.join(repoRoot, "vendor", "MTGA-collection-exporter", "V1.2", exeName);

const anchorNames = [
  ["Death's Shadow", 1],
  ["Hamza, Guardian of Arashin", 1],
  ["Devilthorn Fox", 1],
  ["Angelic Purge", 1],
  ["Marit Lage's Slumber", 2],
  ["Worldspine Wurm", 3],
  ["King Narfi's Betrayal", 3],
  ["Barricade Breaker", 3],
];

const catalog = await loadMtgaLocalCatalog();
const lookup = buildCatalogLookup(catalog);

const pickOwned = (name, qty) => {
  const normalized = name.trim().toLowerCase();
  const candidates = [...lookup.nameByCardId.entries()]
    .filter(([, cardName]) => cardName.trim().toLowerCase() === normalized)
    .map(([cardId]) => cardId);
  const owned = candidates.filter((cardId) => {
    const count = Number(catalog.get(cardId)?.owned ?? 0);
    return count > 0 && count === qty;
  });
  if (owned.length === 1) return owned[0];
  const anyOwned = candidates.filter((cardId) => Number(catalog.get(cardId)?.owned ?? 0) > 0);
  return anyOwned[0] ?? candidates[0] ?? null;
};

const anchors = [];
for (const [name, qty] of anchorNames) {
  const cardId = pickOwned(name, qty);
  console.log("anchor", name, "qty", qty, "=>", cardId, catalog.get(String(cardId))?.setCode);
  if (!cardId) {
    console.error("missing anchor", name);
    process.exit(2);
  }
  anchors.push({ cardId: Number(cardId), quantity: qty });
}

const upstreamAnchors = toUpstreamAnchorsJson(anchors, lookup);
const dir = await mkdtemp(path.join(os.tmpdir(), "mtga-diag-"));
await copyFile(exe, path.join(dir, exeName));
await writeFile(path.join(dir, "last_anchors.json"), JSON.stringify(upstreamAnchors, null, 2));

const child = spawn(path.join(dir, exeName), [], {
  cwd: dir,
  stdio: ["pipe", "ignore", "ignore"],
  windowsHide: true,
});
const pump = setInterval(() => {
  if (child.stdin && !child.stdin.destroyed) child.stdin.write("\n");
}, 1000);
child.stdin.write("\n");
await new Promise((resolve) => child.on("close", resolve));
clearInterval(pump);
console.log("workdir", dir);
console.log("exit", child.exitCode);
try {
  const raw = await readFile(path.join(dir, "mtga_collection.json"), "utf8");
  const rows = JSON.parse(raw);
  console.log("output_rows", rows.length);
} catch (error) {
  console.log("no_collection_json", String(error));
}

await rm(dir, { recursive: true, force: true });
