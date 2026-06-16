import { describe, expect, it } from "vitest";
import {
  buildArenaIdLookupFromCatalog,
  cleanArenaCardName,
  mergeArenaIdLookups,
} from "../src/runtime/scanner/arenaIdLookup.js";

describe("arenaIdLookup", () => {
  it("cleans MTGA localization markup from card names", () => {
    expect(cleanArenaCardName('<sprite="SpriteSheet_MiscIcons" name="arena_a">Death-Priest of Myrkul')).toBe(
      "Death-Priest of Myrkul",
    );
    expect(cleanArenaCardName("<nobr>Amber-Plate</nobr> Ainok")).toBe("Amber-Plate Ainok");
  });

  it("builds lookup from local catalog grpIds", () => {
    const catalog = new Map([
      ["81213", { name: '<sprite name="arena_a">Death-Priest of Myrkul', setCode: "afr" }],
      ["100069", { name: "Azorius Signet", setCode: "rvr" }],
    ]);
    expect(buildArenaIdLookupFromCatalog(catalog)).toEqual({
      "81213": "Death-Priest of Myrkul",
      "100069": "Azorius Signet",
    });
  });

  it("merges with MTGA winning on collision", () => {
    const mtga = { "81213": "Death-Priest of Myrkul (Arena)", "100069": "Azorius Signet" };
    const scryfall = { "77200": "Death-Priest of Myrkul", "81213": "Wrong Name" };
    expect(mergeArenaIdLookups(mtga, scryfall)).toEqual({
      "77200": "Death-Priest of Myrkul",
      "81213": "Death-Priest of Myrkul (Arena)",
      "100069": "Azorius Signet",
    });
  });
});
