import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePlayerLogLine } from "../src/parsers/playerLogParser.js";
import { parseSnapshotContent } from "../src/parsers/snapshotParser.js";

describe("log parsers", () => {
  it("extracts collection payloads from player.log lines", () => {
    const fixturePath = path.resolve(process.cwd(), "tests", "fixtures", "player.log");
    const lines = readFileSync(fixturePath, "utf8").split(/\r?\n/);
    const events = lines.map(parsePlayerLogLine).filter(Boolean);

    expect(events).toHaveLength(1);
    expect(events[0]?.cards["67321"]).toBe(4);
    expect(events[0]?.cards["888"]).toBe(1);
  });

  it("parses full collection snapshot payloads", () => {
    const event = parseSnapshotContent(JSON.stringify({ cards: { "123": 3, "124": 1 } }));
    expect(event?.source).toBe("snapshot-file");
    expect(event?.cards["123"]).toBe(3);
  });
});
