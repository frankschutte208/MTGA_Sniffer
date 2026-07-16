# Integration troubleshooting and lessons learned

**Audience:** Maintainers and agents working on MTGA Sniffer integration glue (not the frozen upstream scanner).

This document records real failures from the v0.1.6–v0.1.10 stabilization work: what broke, how it was fixed, and what **not** to do again.

---

## Golden rules

1. **Verify on the target machine before claiming a fix.** Unit tests and preflight pass do not prove a memory scan works with MTGA running.
2. **Never guess failure reasons from scan duration.** A scan that finishes in &lt;1s is not proof that MTGA is closed.
3. **Do not edit `vendor/MTGA-collection-exporter/**` or reimplement scan logic in TypeScript/Python.**
4. **Integration changes** (`invokeUpstreamExporter.ts`, `syncService.ts`, spawn/error mapping) need owner awareness — see [scanner-governance.md](scanner-governance.md).
5. **Bump `apps/tray-ui/package.json` version** on each portable build so users can tell which exe they are running (`MTGA-Sniffer-<version>.exe`).

---

## Memory scan runtime selection

### Symptom

- Overlay shows **MTGA running**
- Rescan fails immediately (~0.5–1s)
- Diagnostics show `memory_scan_upstream_runtime:exe` and `Database init failed`, or `memory_scan_upstream_runtime:python` with `MTG Arena not found`

### Root cause

Two different upstream runtimes behave differently on a dev machine with **Python + pymem** installed:

| Runtime | When used (current) | Observed behaviour on owner PC |
|---------|---------------------|------------------------------|
| **Pinned `mtg.py` via Python** | Default when `py -3` + `pymem` import succeeds | **Works** — ~17k cards, anchors match |
| **Bundled `MTGA-collection-exporter.exe` (V1.2)** | Fallback when Python unavailable, or when `useExeRuntime: true` | **Fails** — `Database init failed` after pre-seeded `arena_id_lookup.json`; without seed, local MTGA file scan + Scryfall download also fail |

The pinned exe internally reports **v2.0** and is **not behaviour-identical** to the hash-pinned `mtg.py` in the same vendor folder. Treat “V1.2 folder” as a release bundle, not proof that exe ≡ mtg.py.

### What we tried (avoid repeating)

| Change | Why it failed |
|--------|----------------|
| Force bundled exe always (v0.1.7) | Exe path cannot initialize card DB with our seeded lookup |
| Replace `exec` shell pipe with `spawn` stdin pump without live test | Unnecessary churn; not the primary bug |
| `requestedExecutionLevel: requireAdministrator` | Workaround for wrong runtime/diagnostics; not documented |
| Map all fast scans to `mtga_not_running` | **Wrong UI** — game was running |

### Current behaviour (v0.1.10+)

```
usePython = !scanConfig.useExeRuntime && canRunPinnedPython()
```

- **Default:** Python + pinned `mtg.py` when pymem is available on the PC
- **Fallback:** bundled exe when Python/pymem is missing (e.g. clean machine with no Python)
- **Diagnostics only:** `"useExeRuntime": true` in `%LocalLow%/MTGA Sniffer/scan-config.json` forces exe

Spawn contract (unchanged): shell stdin automation per [upstream-batch-feature-request.md](upstream-batch-feature-request.md):

```text
(echo Y& echo.& echo.& echo.& echo.& echo.) | "<workExeOrPy>" > upstream.log 2>&1
```

### Manual parity checks

```powershell
# Full app path (after npm run -w @mtga/sync-agent build)
node -e "import { invokeUpstreamExporter } from './apps/sync-agent/dist/runtime/scanner/invokeUpstreamExporter.js'; ..."

# Upstream-only probe (no seed)
node scripts/dev/probe-exe-no-seed.mjs

# Lookup seed matrix
node scripts/dev/probe-exe-lookup.mjs

# cmd pipe vs spawn comparison
node scripts/dev/test-scan-spawn.mjs

# Owner manual path
python scripts/dev/run-pinned-mtg.py --seed-lookup --work-dir ./scan-work
```

Check diagnostics for `memory_scan_upstream_runtime:python|exe` and `memory_scan_upstream_rows:N`.

Failure logs (when output missing): `%TEMP%/mtga-scan-failure-*.log`

---

## Error message mapping (do not mislead users)

### Symptom

Red overlay text: **“Rescan failed: MTGA not running”** while header says **“MTGA running”**.

### Root cause

`classifyUpstreamLog` used a **duration heuristic** (`scanDurationMs < 8000` → `mtga_not_running`). Upstream often exits quickly on unrelated errors (database init, attach failure).

### Fix (v0.1.9+)

Classify from **upstream log text only**:

| Log signal | Diagnostic code |
|------------|-----------------|
| `database init failed` | `memory_scan_upstream_database_init_failed` |
| `scryfall download failed` | `memory_scan_upstream_scryfall_failed` |
| `error scanning local files` / `charmap` | `memory_scan_upstream_local_catalog_failed` |
| `mtg arena not found` / `please start the game` | `memory_scan_error:attach_failed` (not “not running”) |
| `no valid collection data` | `memory_scan_upstream_no_blocks` |
| `collection not found` | `memory_scan_upstream_anchors_not_found` |
| (none of the above) | `memory_scan_upstream_unclassified_failure` |

Tray UI (`formatRescanFailureMessage`):

- If `isMtgaRunning === true` and attach failed → **“scanner could not attach to MTGA process”**
- Only show **“MTGA not running”** when `isMtgaRunning === false`
- For unclassified failures, surface a snippet from `memory_scan_upstream_log:`

**Never reintroduce** duration-based guessing.

Tests: `apps/sync-agent/tests/invoke-upstream-exporter.test.ts` → `classifyUpstreamLog`.

---

## Rarity progress: basic lands counted as common

### Symptom

Overlay **Land: 25 / 34** when the player owns hundreds of unique basic land printings.

### Root cause

- MTGA local catalog uses rarity code **`1`** for basic lands
- Scryfall bulk metadata labels the same cards **`common`**
- `buildArenaMetadataIndex` preferred Scryfall → almost all basics bucketed as **common**
- Land denominator came from stale/wrong metadata index (~34) instead of MTGA catalog (~1,298 collectible basics)

### Fix (v0.1.10+)

`resolveCollectibleRarity()` in `denominatorStats.ts`:

- If MTGA rarity is `1` / `land` / `basic`, **or** name is Plains/Island/Swamp/Mountain/Forest/Wastes → **`land`**
- Otherwise use Scryfall rarity, then MTGA rarity

Overlay land denominator uses `countCollectibleBasicLands(localCatalog)` so it stays correct even when Scryfall metadata is stale.

Tests: `apps/sync-agent/tests/denominatorStats.test.ts`

### What to avoid

- Do not let Scryfall `common` override MTGA rarity `1` for basic lands
- Do not assume `arena_metadata_index.json` land totals are authoritative for basics — prefer MTGA catalog for land denominators

---

## Agent / debug hygiene

**Do not commit:**

- `fetch()` calls to local debug ingest URLs inside `syncService.ts`
- `requestedExecutionLevel: requireAdministrator` without owner sign-off
- Replaced spawn algorithms without `node scripts/dev/test-scan-spawn.mjs` on a machine with MTGA running

**Always:**

- Run `npm test` and `node scripts/preflight-memory-scan.mjs`
- Build with `npm run -w @mtga/tray-ui dist:win` (bumps embedded agent via `prepare:agent`)
- Confirm version in filename matches `apps/tray-ui/package.json`

---

## Related docs

| Doc | Topic |
|-----|--------|
| [scanner-governance.md](scanner-governance.md) | Frozen vs integration zones |
| [upstream-batch-feature-request.md](upstream-batch-feature-request.md) | Desired headless upstream API |
| [collection-data-integration.md](collection-data-integration.md) | External consumer schemas |
| [apps/sync-agent/README.md](../apps/sync-agent/README.md) | API and sync behaviour |
