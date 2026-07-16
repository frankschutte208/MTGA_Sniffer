import { describe, expect, it } from "vitest";
import {
  buildCatalogLookup,
  classifyUpstreamLog,
  mapUpstreamRowsToCardIds,
  toUpstreamAnchorsJson,
} from "../src/runtime/scanner/invokeUpstreamExporter.js";

describe("invokeUpstreamExporter helpers", () => {
  const catalog = new Map([
    ["35573", { name: "Death's Shadow", setCode: "wwk", collectorNumber: "57" }],
    ["62171", { name: "Kozilek, the Great Distortion", setCode: "ogw", collectorNumber: "4" }],
    ["79239", { name: "Angelic Purge", setCode: "j21", collectorNumber: "5" }],
  ]);
  const lookup = buildCatalogLookup(catalog);

  it("builds upstream anchor tuples with catalog names", () => {
    expect(toUpstreamAnchorsJson([{ cardId: 35573, quantity: 1 }], lookup)).toEqual([
      [35573, 1, "Death's Shadow"],
    ]);
  });

  it("maps upstream rows to grpIds by name set and collector number", () => {
    const cards = mapUpstreamRowsToCardIds(
      [
        { count: 1, name: "Death's Shadow", set: "WWK", cn: "57" },
        { count: 2, name: "Angelic Purge", set: "J21", cn: "5" },
      ],
      lookup,
    );
    expect(cards).toEqual({
      "35573": 1,
      "79239": 2,
    });
  });

  it("maps upstream rows with grpId id field directly", () => {
    const cards = mapUpstreamRowsToCardIds(
      [{ count: 3, name: "Worldspine Wurm", id: 51569 }],
      lookup,
    );
    expect(cards).toEqual({ "51569": 3 });
  });

  it("merges duplicate upstream rows for the same grpId", () => {
    const cards = mapUpstreamRowsToCardIds(
      [
        { count: 1, name: "Death's Shadow", set: "wwk", cn: "57" },
        { count: 1, name: "Death's Shadow", set: "wwk", cn: "57" },
      ],
      lookup,
    );
    expect(cards).toEqual({ "35573": 2 });
  });
});

describe("classifyUpstreamLog", () => {
  it("maps attach failures without claiming MTGA is closed", () => {
    expect(
      classifyUpstreamLog(
        "Attaching to MTGA.exe...\nMTG Arena not found. Please start the game.",
      ),
    ).toEqual(["memory_scan_error:attach_failed"]);
  });

  it("maps database init failures from bundled exe", () => {
    expect(classifyUpstreamLog("Loading cached database...\nDatabase init failed.")).toEqual([
      "memory_scan_upstream_database_init_failed",
    ]);
  });

  it("does not guess mtga_not_running from fast scans", () => {
    expect(classifyUpstreamLog("unexpected upstream output")).toEqual([
      "memory_scan_upstream_unclassified_failure",
    ]);
  });

  it("maps scryfall and local catalog init failures", () => {
    expect(classifyUpstreamLog("Scryfall download failed: 'download_uri'")).toEqual([
      "memory_scan_upstream_scryfall_failed",
    ]);
    expect(
      classifyUpstreamLog("Error scanning local files: 'charmap' codec can't encode characters"),
    ).toEqual(["memory_scan_upstream_local_catalog_failed"]);
  });
});
