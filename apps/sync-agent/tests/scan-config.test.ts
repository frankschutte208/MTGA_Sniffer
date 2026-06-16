import { describe, expect, it } from "vitest";
import { loadScanConfig } from "../src/runtime/scanner/scanConfig.js";

describe("loadScanConfig", () => {
  it("returns empty config when file is missing", async () => {
    const original = process.env.USERPROFILE;
    process.env.USERPROFILE = "C:\\nonexistent-mtga-sniffer-test-user";
    try {
      await expect(loadScanConfig()).resolves.toEqual({});
    } finally {
      process.env.USERPROFILE = original;
    }
  });
});
