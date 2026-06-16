import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeScanPayload } from "../src/runtime/scanner/contract.js";
import { filterScannedCards } from "../src/runtime/scanner/filter.js";

interface FixtureInput {
  stdout: unknown;
  stderr: string;
  exitCode: number | null;
}

const fixtureRoot = path.join(process.cwd(), "tests", "fixtures", "memory-scan");

const readJson = async <T>(fileName: string): Promise<T> =>
  JSON.parse(await readFile(path.join(fixtureRoot, fileName), "utf8")) as T;

describe("memory scan contract fixtures", () => {
  const cases = [
    "anchors-missing",
    "insufficient-anchor-match",
    "successful-selection",
  ];

  for (const caseName of cases) {
    it(`matches golden output for ${caseName}`, async () => {
      const input = await readJson<FixtureInput>(`${caseName}.input.json`);
      const expected = await readJson<unknown>(`${caseName}.expected.json`);
      const actual = normalizeScanPayload(
        input.stdout as Record<string, unknown>,
        input.stderr,
        input.exitCode,
      );
      expect(actual).toEqual(expected);
    });
  }
});

describe("memory scan filter behavior", () => {
  it("keeps only known card ids and valid quantity range", () => {
    const filtered = filterScannedCards(
      {
        "1001": 4,
        "1002": 0,
        "1003": 201,
        "999999": 2,
      },
      new Set(["1001", "1002", "1003"]),
    );
    expect(filtered).toEqual({
      "1001": 4,
    });
  });
});

