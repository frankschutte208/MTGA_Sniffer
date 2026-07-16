# MTGA Sync Agent

Background service embedded inside the MTGA Sniffer tray app. It watches MTGA log files, merges collection state, persists SQLite + JSON, refreshes Scryfall metadata, and serves a localhost HTTP API.

**You do not run this separately in production.** Launch `MTGA-Sniffer-*.exe` — the sync agent starts inside it.

**External consumers:** see [collection data integration](../../docs/collection-data-integration.md) for file paths, schemas, and integration patterns.

---

## What it watches

| Source | Path |
|--------|------|
| Player log | `%USERPROFILE%\AppData\LocalLow\Wizards Of The Coast\MTGA\Player.log` |
| Collection snapshot | same folder, `collection_snapshot.json` |

Override with `MTGA_PLAYER_LOG_PATH` and `MTGA_COLLECTION_SNAPSHOT_PATH`.

---

## Data files

All under `%USERPROFILE%\AppData\LocalLow\MTGA Sniffer\` (override: `MTGA_COLLECTOR_DATA_PATH`):

| File | Purpose |
|------|---------|
| `collection.sqlite` | Persistent collection (`collection_cards` table) |
| `latest_collection.json` | JSON export after each sync — **primary handoff for other apps** |
| `sync_history.log` | One JSON line per successful sync |
| `memory_anchors.json` | Anchor cards for memory scan validation |
| `scryfall/arena_id_lookup_scryfall.json` | Arena ID → name |
| `scryfall/arena_metadata_index.json` | Set, rarity, format flags per card |
| `scryfall/denominator_stats.json` | Rarity/set totals for progress UI |

Full schemas: [docs/collection-data-integration.md](../../docs/collection-data-integration.md).

---

## Localhost API

Default base URL: `http://localhost:37241` (`MTGA_SYNC_PORT`).

CORS enabled for browser apps on localhost.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | `{ ok: true }` |
| GET | `/collection` | Enriched cards + sync status |
| GET | `/cards` | Card array only |
| GET | `/sync-status` | Last sync, parser version, MTGA running |
| GET | `/overlay-status` | Overlay summary counts |
| GET | `/overlay-insights` | Recent changes, rarity progress |
| GET | `/metadata-status` | Scryfall cache freshness |
| GET | `/set-format-stats` | Per-set Standard/Historic denominators |
| GET | `/sync-history?limit=25` | Recent sync log entries |
| GET | `/debug-lines` | Parser diagnostics |
| POST | `/resync` | Force re-read log/snapshot |
| POST | `/memory-scan` | Run memory scan (MTGA must be open) |
| GET | `/memory-anchors` | Current anchor list |
| POST | `/memory-anchors` | `{ "anchors": [{ "name": "...", "quantity": 4 }] }` |

Tray menu actions call these endpoints internally.

Auto memory scan runs every 45 seconds when MTGA is running, the collection is empty, and anchors are configured.

---

## Card identity

- `cardId` in storage and API = **MTGA Arena ID** (grpId), string decimal.
- Counts are integers (owned copies). Filter `count > 0` for owned cards.

---

## Memory scan fallback

Uses pinned [MTGA-collection-exporter](https://github.com/NthPhantom10/MTGA-collection-exporter) via integration glue in `invokeUpstreamExporter.ts`.

| Runtime | When |
|---------|------|
| **Python + pinned `mtg.py`** | Default when `py -3` and `pymem` are available |
| **Bundled vendor exe** | Fallback when Python/pymem is missing |

**Before scanning:** open **Collection** in MTGA, scroll ~30 seconds, then **Force Memory Scan** from the tray menu or overlay.

**Diagnostics:** `GET /sync-status` → `diagnostics` array. Look for `memory_scan_upstream_runtime:python|exe` and `memory_scan_upstream_rows:N`. Do not trust UI text alone — see [integration troubleshooting](../../docs/integration-troubleshooting.md#error-message-mapping-do-not-mislead-users).

Optional owner `scan-config.json` keys: `debugKeepWorkDir`, `debugCopyOutputTo`, `useExeRuntime` (force exe — diagnostics only). See [scanner governance](../../docs/scanner-governance.md).

---

## Overlay rarity progress

**Land** counts use MTGA basic-land rules (rarity code `1` and basic land names), not Scryfall’s `common` label for basics. Denominator for lands is derived from the MTGA local catalog. Details: [integration troubleshooting](../../docs/integration-troubleshooting.md#rarity-progress-basic-lands-counted-as-common).

---

## For developers

Standalone during development:

```bash
npm run -w @mtga/sync-agent dev
```

The tray app's `npm run dev:tray` embeds the built agent and is the usual dev path.

Tests:

```bash
npm run -w @mtga/sync-agent test
```

---

## Changing the memory scanner

The scanner is owner-locked. Do not modify casually — see [scanner governance](../../docs/scanner-governance.md).
