import { describe, expect, it } from "vitest";
import {
  isBasicLandName,
  resolveCollectibleRarity,
} from "../src/metadata/denominatorStats.js";

describe("resolveCollectibleRarity", () => {
  it("prefers MTGA basic land rarity over Scryfall common", () => {
    expect(resolveCollectibleRarity("1", "Plains", "common")).toBe("land");
  });

  it("classifies basic land names even when Scryfall says common", () => {
    expect(resolveCollectibleRarity("2", "Forest", "common")).toBe("land");
    expect(isBasicLandName("Wastes")).toBe(true);
  });

  it("keeps non-basic cards on Scryfall rarity", () => {
    expect(resolveCollectibleRarity("2", "Lightning Bolt", "common")).toBe("common");
    expect(resolveCollectibleRarity("4", "Leatherhead, Swamp Stalker", "rare")).toBe("rare");
  });
});
