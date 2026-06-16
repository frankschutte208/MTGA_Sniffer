import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const trayRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(trayRoot, "..", "..");
const syncAgentRoot = path.resolve(trayRoot, "..", "sync-agent");
const sharedTypesRoot = path.resolve(repoRoot, "packages", "shared-types");
const embeddedRoot = path.resolve(trayRoot, "embedded-agent");
const embeddedSharedTypesRoot = path.join(
  embeddedRoot,
  "node_modules",
  "@mtga",
  "shared-types",
);

const copyTargets = [
  { from: path.join(syncAgentRoot, "dist"), to: path.join(embeddedRoot, "dist") },
  {
    from: path.join(repoRoot, "vendor", "MTGA-collection-exporter"),
    to: path.join(embeddedRoot, "vendor", "MTGA-collection-exporter"),
  },
  { from: path.join(sharedTypesRoot, "dist"), to: path.join(embeddedSharedTypesRoot, "dist") },
  { from: path.join(sharedTypesRoot, "package.json"), to: path.join(embeddedSharedTypesRoot, "package.json") },
];

await rm(embeddedRoot, { recursive: true, force: true });
await mkdir(embeddedRoot, { recursive: true });
await mkdir(embeddedSharedTypesRoot, { recursive: true });

for (const target of copyTargets) {
  await cp(target.from, target.to, { recursive: true, force: true });
}

console.log(`Embedded sync agent prepared at ${embeddedRoot}`);
