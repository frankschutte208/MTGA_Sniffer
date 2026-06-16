import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { migrateCollectorDataIfNeeded } from "../src/collectorDataMigration.js";

test("migrates anchors and scryfall files from legacy collector directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mtga-sniffer-migrate-"));
  const legacy = path.join(root, "legacy");
  const target = path.join(root, "target");
  await mkdir(path.join(legacy, "scryfall"), { recursive: true });
  await mkdir(target, { recursive: true });

  await writeFile(path.join(legacy, "memory_anchors.json"), '[{"name":"Test","quantity":2}]', "utf8");
  await writeFile(path.join(legacy, "scryfall", "scryfall_cache.json"), '{"ok":true}', "utf8");

  await migrateCollectorDataIfNeeded({
    legacyCollectorDirectory: legacy,
    collectorDataDirectory: target,
    existsSyncImpl: existsSync,
  });

  assert.equal(existsSync(path.join(target, "memory_anchors.json")), true);
  assert.equal(existsSync(path.join(target, "scryfall", "scryfall_cache.json")), true);
  const anchors = await readFile(path.join(target, "memory_anchors.json"), "utf8");
  assert.match(anchors, /"quantity":2/);
});

