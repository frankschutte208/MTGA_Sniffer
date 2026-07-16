# Memory scanner governance

The memory scanner is **[MTGA-collection-exporter](https://github.com/NthPhantom10/MTGA-collection-exporter)** (pinned V1.2 bundle). The folder contains a hash-pinned **`mtg.py`** and a bundled **exe** — on some machines they are **not behaviour-identical** (exe reports internal v2.0). See [integration troubleshooting](integration-troubleshooting.md).

**Runtime selection (v0.1.10+):** default to **pinned `mtg.py` via Python** when `py -3` and `pymem` are available; fall back to bundled exe when Python is absent. Optional `"useExeRuntime": true` in owner `scan-config.json` forces exe for diagnostics only.

## Three zones

### Frozen (never edit)

| Path | Role |
|------|------|
| `vendor/MTGA-collection-exporter/V1.2/MTGA-collection-exporter.exe` | Production scan runtime |
| `vendor/MTGA-collection-exporter/V1.2/mtg.py` | Pinned upstream source (manual diagnostics) |
| `vendor/MTGA-collection-exporter/V1.2/manifest.json` | SHA256 for exe + mtg.py |

### Integration (owner approval)

| Path | Role |
|------|------|
| `apps/sync-agent/src/runtime/scanner/invokeUpstreamExporter.ts` | Spawn adapter |
| `apps/sync-agent/src/runtime/scanner/arenaIdLookup.ts` | Pre-seed arena_id_lookup.json |
| `apps/sync-agent/src/runtime/scanner/runner.ts` | Calls adapter |
| `apps/sync-agent/src/runtime/scanner/scanConfig.ts` | Reads owner `scan-config.json` |
| `apps/sync-agent/src/runtime/syncService.ts` | Anchor resolution, merge |
| `apps/sync-agent/tests/fixtures/memory-scan/**` | Golden fixtures |
| `scripts/preflight-memory-scan.mjs` | Vendor hash + ban custom pymem forks |

### Safe to edit

| Path | Role |
|------|------|
| `%LocalLow%/MTGA Sniffer/scan-config.json` | Debug paths (see below) |
| `scripts/dev/run-pinned-mtg.py` | Manual launcher (subprocess only) |
| `apps/tray-ui/src/main.js` | Error messages / UI hints |
| README files | User docs |
| `docs/collection-data-integration.md` | External app integration (collection browser, etc.) |

**Do not reintroduce:** `apps/sync-agent/scripts/mtga_memory_scan.py`

## Owner scan-config.json

Optional file at `%USERPROFILE%/AppData/LocalLow/MTGA Sniffer/scan-config.json`:

```json
{
  "debugKeepWorkDir": false,
  "debugCopyOutputTo": "C:/Users/you/MTGA-scan-debug",
  "useExeRuntime": false
}
```

- `debugKeepWorkDir` — preserve temp scan folder; path appears in diagnostics
- `debugCopyOutputTo` — copy `mtga_collection.json`, `last_anchors.json`, and `arena_id_lookup.json` after successful scan
- `useExeRuntime` — **diagnostics only:** force bundled vendor exe even when Python+pymem is installed (often fails with `Database init failed` on owner PC — see [integration-troubleshooting.md](integration-troubleshooting.md))

No scan algorithm belongs in this file.

## Arena ID lookup seeding (integration glue)

Before each scan, the app writes a merged `arena_id_lookup.json` into the temp scan directory so upstream can name grpIds that Scryfall bulk omits:

- **MTGA local catalog** (`loadMtgaLocalCatalog`) — authoritative for Wizards grpIds (~25k)
- **Scryfall sidecar** (`%LocalLow%/MTGA Sniffer/scryfall/arena_id_lookup_scryfall.json`) — refreshed with metadata cache (~24h)

MTGA keys win on collision. Vendor `mtg.py` / exe is unchanged; it loads the pre-seeded file instead of fetching Scryfall when present. Diagnostic: `memory_scan_lookup_seeded:N`.

Manual parity: `python scripts/dev/run-pinned-mtg.py --seed-lookup --work-dir ./scan-work`

## Manual diagnostics (pinned mtg.py)

```powershell
py -3 -m pip install pymem
python scripts/dev/run-pinned-mtg.py --seed-lookup --work-dir ./scan-work
```

1. Open **Collection** in MTGA and scroll ~30 seconds
2. Run the launcher; follow interactive prompts
3. Output: `scan-work/mtga_collection.json`

The launcher copies pinned `vendor/.../mtg.py` into the work dir — it does not import or modify scan functions.

## Parity test (manual vs app)

Use the same anchor set for both paths:

1. **Manual:** run `scripts/dev/run-pinned-mtg.py` → note row count in `mtga_collection.json`
2. **App:** Force Memory Scan from tray → check diagnostics for `memory_scan_upstream_rows:N`
3. **Compare:** row counts should be in the same ballpark (mapping to grpIds may differ slightly by printing)

Enable `debugCopyOutputTo` in `scan-config.json` to keep app artifacts for diffing.

## Release gate

```bash
node scripts/preflight-memory-scan.mjs
npm run -w @mtga/tray-ui dist:win
```

Preflight verifies exe + mtg.py hashes and fails if custom pymem scan Python reappears under `apps/sync-agent/scripts/`.

## Maintainer troubleshooting

See **[integration-troubleshooting.md](integration-troubleshooting.md)** for:

- Memory scan runtime selection (Python vs exe)
- Why **not** to map fast scans to “MTGA not running”
- Basic land rarity bucket fixes
- Dev probe scripts under `scripts/dev/`

## Out of scope (deferred)

**Card styles** (purchased parallax/borderless/event skins) are not captured by the collection scanner and are **not planned** for this project. Research notes, upstream survey, and rationale: [card-styles-research.md](card-styles-research.md).

## Upstream reference

- [README](https://github.com/NthPhantom10/MTGA-collection-exporter/blob/main/README.md)
- [Batch mode request](upstream-batch-feature-request.md)
