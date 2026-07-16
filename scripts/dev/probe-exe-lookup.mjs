import { copyFile, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMtgaLocalCatalog } from "../../apps/sync-agent/dist/runtime/mtgaLocalCatalog.js";
import {
  buildArenaIdLookupFromCatalog,
  loadPersistedScryfallArenaLookup,
  mergeArenaIdLookups,
} from "../../apps/sync-agent/dist/runtime/scanner/arenaIdLookup.js";
import { SCRYFALL_ARENA_LOOKUP_PATH } from "../../apps/sync-agent/dist/constants.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const exeSrc = path.join(
  repoRoot,
  "vendor",
  "MTGA-collection-exporter",
  "V1.2",
  "MTGA-collection-exporter.exe",
);

const anchors = [
  [79239, 1, "Angelic Purge"],
  [35573, 1, "Death's Shadow"],
  [77883, 1, "Hamza, Guardian of Arashin"],
  [86060, 1, "Devilthorn Fox"],
];

const runCase = async (label, prepare) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), `mtga-probe-${label}-`));
  const workExe = path.join(dir, "MTGA-collection-exporter.exe");
  await copyFile(exeSrc, workExe);
  await writeFile(path.join(dir, "last_anchors.json"), JSON.stringify(anchors, null, 2));
  await prepare(dir);

  const child = spawn(workExe, [], {
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin.write("Y\n");
  const pump = setInterval(() => child.stdin?.write("\n"), 1000);
  let out = "";
  child.stdout.on("data", (chunk) => {
    out += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    out += chunk.toString();
  });
  await new Promise((resolve) => child.on("close", resolve));
  clearInterval(pump);

  let rows = 0;
  try {
    rows = JSON.parse(await readFile(path.join(dir, "mtga_collection.json"), "utf8")).length;
  } catch {
    rows = 0;
  }

  const files = await readdir(dir);
  console.log(`\n=== ${label} ===`);
  console.log("files:", files.join(", "));
  console.log("log:\n", out.trim());
  console.log("collection rows:", rows);
  console.log("workdir:", dir);
};

const catalog = await loadMtgaLocalCatalog();
const mtgaLookup = buildArenaIdLookupFromCatalog(catalog);
const scryfallLookup = await loadPersistedScryfallArenaLookup(SCRYFALL_ARENA_LOOKUP_PATH);
const mergedLookup = mergeArenaIdLookups(mtgaLookup, scryfallLookup);

await runCase("no_lookup", async () => {});
await runCase("empty_lookup", async (dir) => {
  await writeFile(path.join(dir, "arena_id_lookup.json"), "{}");
});
await runCase("tiny_lookup", async (dir) => {
  await writeFile(
    path.join(dir, "arena_id_lookup.json"),
    JSON.stringify({ "79239": "Angelic Purge", "35573": "Death's Shadow" }),
  );
});
await runCase("merged_lookup", async (dir) => {
  await writeFile(path.join(dir, "arena_id_lookup.json"), JSON.stringify(mergedLookup));
});
await runCase("catalog_only_lookup", async (dir) => {
  await writeFile(path.join(dir, "arena_id_lookup.json"), JSON.stringify(mtgaLookup));
});
