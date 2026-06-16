import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadMtgaLocalCatalog } from "../apps/sync-agent/dist/runtime/mtgaLocalCatalog.js";

const exportPath = path.join(os.homedir(), "AppData", "LocalLow", "MTGA Sniffer", "latest_collection.json");
const raw = JSON.parse(await readFile(exportPath, "utf8"));
const counts = Object.fromEntries(raw.cards.map((c) => [String(c.cardId), c.count]));
const catalog = await loadMtgaLocalCatalog();

const anchors = [
  ["Death's Shadow", 1],
  ["Hamza, Guardian of Arashin", 1],
  ["Devilthorn Fox", 1],
  ["Angelic Purge", 1],
  ["Marit Lage's Slumber", 2],
  ["Worldspine Wurm", 3],
  ["King Narfi's Betrayal", 3],
  ["Barricade Breaker", 3],
];

for (const [name, qty] of anchors) {
  const matches = [...catalog.entries()].filter(([, m]) => m.name?.toLowerCase() === name.toLowerCase());
  const owned = matches
    .map(([id, m]) => ({ id, set: m.setCode, count: counts[id] ?? 0 }))
    .filter((x) => x.count > 0);
  console.log(name, "target qty", qty, "owned printings:", owned);
}
