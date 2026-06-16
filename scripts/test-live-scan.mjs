import { loadMtgaLocalCatalog } from "../apps/sync-agent/dist/runtime/mtgaLocalCatalog.js";
import {
  buildCatalogLookup,
  invokeUpstreamExporter,
  toUpstreamAnchorsJson,
} from "../apps/sync-agent/dist/runtime/scanner/invokeUpstreamExporter.js";
import { MEMORY_SCAN_EXPORTER_PATH } from "../apps/sync-agent/dist/constants.js";

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

const anchors = anchorNames.map(([name, quantity]) => {
  const match = [...lookup.nameByCardId.entries()].find(([, n]) => n.toLowerCase() === name.toLowerCase());
  return { cardId: Number(match?.[0] ?? 0), quantity };
}).filter((a) => a.cardId > 0);

console.log("anchors", toUpstreamAnchorsJson(anchors, lookup));
const result = await invokeUpstreamExporter(MEMORY_SCAN_EXPORTER_PATH, anchors);
console.log("ok", result.ok);
console.log("cards", Object.keys(result.cards).length);
console.log("diagnostics", result.diagnostics.join("\n"));
