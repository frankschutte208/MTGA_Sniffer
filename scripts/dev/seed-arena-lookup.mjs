#!/usr/bin/env node
/** Write merged arena_id_lookup.json for manual upstream runs (parity with app scan). */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCRYFALL_ARENA_LOOKUP_PATH } from "../../apps/sync-agent/dist/constants.js";
import { loadMtgaLocalCatalog } from "../../apps/sync-agent/dist/runtime/mtgaLocalCatalog.js";
import {
  ARENA_ID_LOOKUP_FILE,
  buildArenaIdLookupFromCatalog,
  loadPersistedScryfallArenaLookup,
  mergeArenaIdLookups,
} from "../../apps/sync-agent/dist/runtime/scanner/arenaIdLookup.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workDir = process.argv.includes("--work-dir")
  ? path.resolve(process.argv[process.argv.indexOf("--work-dir") + 1])
  : path.join(repoRoot, "scan-work");

const catalog = await loadMtgaLocalCatalog();
const mtgaLookup = buildArenaIdLookupFromCatalog(catalog);
const scryfallLookup = await loadPersistedScryfallArenaLookup(SCRYFALL_ARENA_LOOKUP_PATH);
const merged = mergeArenaIdLookups(mtgaLookup, scryfallLookup);

await mkdir(workDir, { recursive: true });
const outPath = path.join(workDir, ARENA_ID_LOOKUP_FILE);
await writeFile(outPath, JSON.stringify(merged), "utf8");

console.log(`Wrote ${outPath}`);
console.log(`  MTGA catalog entries: ${Object.keys(mtgaLookup).length}`);
console.log(`  Scryfall sidecar entries: ${Object.keys(scryfallLookup).length}`);
console.log(`  Merged lookup entries: ${Object.keys(merged).length}`);
