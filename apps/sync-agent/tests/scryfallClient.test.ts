import { describe, expect, it } from "vitest";
import {
  buildCardsFromScryfallBulk,
  isBulkDataNewer,
  parseJsonlCards,
  resolveBulkDownloadUri,
  toScryfallCardLite,
} from "../src/metadata/scryfallClient.js";

describe("scryfallClient helpers", () => {
  it("prefers jsonl_download_uri over legacy download_uri", () => {
    expect(
      resolveBulkDownloadUri({
        type: "default_cards",
        updated_at: "2026-07-21T00:00:00.000Z",
        download_uri: "https://example.test/default-cards.json",
        jsonl_download_uri: "https://example.test/default-cards.jsonl.gz",
      }),
    ).toBe("https://example.test/default-cards.jsonl.gz");
  });

  it("detects when remote bulk is newer than cache", () => {
    expect(isBulkDataNewer("2026-07-21T00:00:00.000Z", "2026-07-20T00:00:00.000Z")).toBe(true);
    expect(isBulkDataNewer("2026-07-20T00:00:00.000Z", "2026-07-21T00:00:00.000Z")).toBe(false);
    expect(isBulkDataNewer("2026-07-20T00:00:00.000Z", "2026-07-20T00:00:00.000Z")).toBe(false);
    expect(isBulkDataNewer(null, "2026-07-20T00:00:00.000Z")).toBe(true);
  });

  it("parses JSONL card lines", () => {
    const cards = parseJsonlCards(
      [
        '{"name":"Bolt","arena_id":67321,"set":"mkm","collector_number":"157","rarity":"common"}',
        "",
        '{"name":"Forest","arena_id":888,"set":"blb","collector_number":"280","rarity":"common"}',
      ].join("\n"),
    );
    expect(cards).toHaveLength(2);
    expect(cards[0]?.name).toBe("Bolt");
  });

  it("maps bulk cards into lite cards and arena lookup", () => {
    const built = buildCardsFromScryfallBulk([
      {
        name: "Lightning Bolt",
        arena_id: 67321,
        set: "MKM",
        collector_number: "157",
        rarity: "common",
        legalities: { standard: "not_legal", historic: "legal" },
      },
    ]);
    expect(built.cards).toHaveLength(1);
    expect(built.cards[0]).toMatchObject({
      arenaId: 67321,
      setCode: "mkm",
      collectorNumber: "157",
      rarity: "common",
    });
    expect(built.arenaIdLookup["67321"]).toBe("Lightning Bolt");
    expect(toScryfallCardLite({ set: "mkm" })).toBeNull();
  });
});
