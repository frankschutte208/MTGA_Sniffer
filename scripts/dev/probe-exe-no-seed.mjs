import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execAsync = promisify(exec);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const exeSrc = path.join(
  repoRoot,
  "vendor",
  "MTGA-collection-exporter",
  "V1.2",
  "MTGA-collection-exporter.exe",
);
const anchors = [
  [79239, 1, "Angelic Purge"],
  [35573, 1, "Death's Shadow"],
  [77883, 1, "Hamza, Guardian of Arashin"],
  [86060, 1, "Devilthorn Fox"],
];

const dir = await mkdtemp(path.join(os.tmpdir(), "mtga-no-seed-"));
const workExe = path.join(dir, "MTGA-collection-exporter.exe");
await copyFile(exeSrc, workExe);
await writeFile(path.join(dir, "last_anchors.json"), JSON.stringify(anchors));
const logPath = path.join(dir, "upstream.log");
const command = `(echo Y& echo.& echo.& echo.& echo.& echo.) | "${workExe}" > "${logPath}" 2>&1`;
await execAsync(command, { cwd: dir, windowsHide: true, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
const log = await readFile(logPath, "utf8");
let rows = 0;
try {
  rows = JSON.parse(await readFile(path.join(dir, "mtga_collection.json"), "utf8")).length;
} catch {
  rows = 0;
}
console.log("rows", rows);
console.log(log);
