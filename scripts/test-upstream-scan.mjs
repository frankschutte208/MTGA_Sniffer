import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exeName = "MTGA-collection-exporter.exe";
const exe = path.join(
  repoRoot,
  "vendor",
  "MTGA-collection-exporter",
  "V1.2",
  exeName,
);
const anchors = [
  [35573, 1, "Death's Shadow"],
  [77883, 1, "Hamza, Guardian of Arashin"],
  [67256, 1, "Devilthorn Fox"],
  [66654, 1, "Angelic Purge"],
  [78901, 2, "Marit Lage's Slumber"],
  [37972, 3, "Worldspine Wurm"],
  [70123, 3, "King Narfi's Betrayal"],
  [61234, 3, "Barricade Breaker"],
];

const dir = await mkdtemp(path.join(os.tmpdir(), "mtga-test-"));
await copyFile(exe, path.join(dir, exeName));
await writeFile(path.join(dir, "last_anchors.json"), JSON.stringify(anchors));

const child = spawn(path.join(dir, exeName), [], {
  cwd: dir,
  stdio: ["pipe", "ignore", "ignore"],
  windowsHide: true,
});

child.stdin.write("\n\n\n");
child.stdin.end();

await new Promise((resolve) => child.on("close", resolve));

console.log("exit", child.exitCode);
try {
  const raw = await readFile(path.join(dir, "mtga_collection.json"), "utf8");
  const rows = JSON.parse(raw);
  console.log("output_rows", rows.length);
} catch (error) {
  console.log("no_output", String(error));
}

await rm(dir, { recursive: true, force: true });
