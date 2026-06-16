import { exec, spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const vendor = path.resolve("vendor/MTGA-collection-exporter/V1.2");
const dir = await mkdtemp(path.join(os.tmpdir(), "mtga-upstream-scan-"));
await copyFile(path.join(vendor, "mtg.py"), path.join(dir, "mtg.py"));
await writeFile(path.join(dir, "last_anchors.json"), JSON.stringify([[35573, 1, "Death's Shadow"]]));
const logPath = path.join(dir, "upstream.log");
const mtgPy = path.join(dir, "mtg.py");
const command = `(echo Y& echo.& echo.& echo.& echo.& echo.) | py -3 "${mtgPy}" > "${logPath}" 2>&1`;
console.log("cmd", command);
const code = await new Promise((resolve) => {
  exec(command, { cwd: dir, windowsHide: true }, (error) => {
    resolve(error?.code ?? 0);
  });
});
console.log("exec exit", code);
console.log(await readFile(logPath, "utf8").catch(() => "no log"));

const code2 = await new Promise((resolve) => {
  const child = spawn("cmd.exe", ["/d", "/s", "/c", command], {
    cwd: dir,
    windowsHide: false,
    stdio: "ignore",
  });
  child.on("close", resolve);
});
console.log("spawn visible exit", code2);
