# MTGA Sniffer — collection data for external apps

**Audience:** Developers building a separate app (for example a web collection browser) that reads the player's MTGA collection tracked by MTGA Sniffer.

**Read this file only** — it is the single integration reference for where data lives, what it contains, and how to consume it.

---

## Quick start (recommended)

| What you need | Where to get it |
|---------------|-----------------|
| Owned cards + counts | `%USERPROFILE%\AppData\LocalLow\MTGA Sniffer\latest_collection.json` |
| Card names for Arena IDs | `%USERPROFILE%\AppData\LocalLow\MTGA Sniffer\scryfall\arena_id_lookup_scryfall.json` |
| Set / rarity / format metadata | `%USERPROFILE%\AppData\LocalLow\MTGA Sniffer\scryfall\arena_metadata_index.json` |

**Prerequisite:** MTGA Sniffer must be installed and have run at least once (`MTGA-Sniffer-*.exe` in the system tray). Data updates while you play MTGA or when you use **Manual resync** / **Force memory scan** from the tray menu.

---

## Data directory

All sniffer-owned files live here (Windows):

```
%USERPROFILE%\AppData\LocalLow\MTGA Sniffer\
```

Expanded example:

```
C:\Users\<you>\AppData\LocalLow\MTGA Sniffer\
├── collection.sqlite              # source of truth (SQLite)
├── latest_collection.json         # JSON export (easiest for consumers)
├── sync_history.log               # one JSON object per line
├── memory_anchors.json            # memory-scan validation (not needed for browsing)
└── scryfall\
    ├── arena_id_lookup_scryfall.json   # Arena ID → card name
    ├── arena_metadata_index.json       # set, rarity, Standard/Historic flags
    ├── denominator_stats.json          # set/rarity totals for progress UI
    └── scryfall_cache.json             # raw Scryfall bulk cache (large; usually skip)
```

Override paths only when debugging (same machine as the sniffer):

| Environment variable | Default |
|---------------------|---------|
| `MTGA_COLLECTOR_DATA_PATH` | `%USERPROFILE%\AppData\LocalLow\MTGA Sniffer` |
| `MTGA_EXPORT_JSON_PATH` | `<collector>\latest_collection.json` |
| `MTGA_SQLITE_PATH` | `<collector>\collection.sqlite` |
| `MTGA_SCRYFALL_ARENA_LOOKUP_PATH` | `<collector>\scryfall\arena_id_lookup_scryfall.json` |
| `MTGA_ARENA_METADATA_INDEX_PATH` | `<collector>\scryfall\arena_metadata_index.json` |

---

## How to read data from a web app

Browsers **cannot** read arbitrary paths on disk. Pick one approach:

### Option A — Copy or symlink JSON (simplest)

1. Point your web project's dev server at a copy of `latest_collection.json` (and optionally the `scryfall\` sidecars).
2. Re-copy when the collection changes, or watch the file with a small Node script that copies on change.

### Option B — Localhost API (live, while sniffer runs)

When MTGA Sniffer is running, the embedded sync agent listens on:

```
http://localhost:37241
```

Port override: `MTGA_SYNC_PORT` (default `37241`).

CORS is enabled. Example:

```http
GET http://localhost:37241/collection
```

Returns enriched cards (names, set codes, Scryfall image URLs when available). Best for a dev server on `localhost` that fetches on load or on a timer.

### Option C — File picker

Let the user choose `latest_collection.json` once per session (`<input type="file">`). No server required; user re-picks after updates.

### Option D — Backend proxy

A small local service (Node, Python, etc.) reads `%LocalLow%\MTGA Sniffer\` and exposes REST to your frontend. Use this for production desktop wrappers or when you need SQLite queries.

---

## Primary file: `latest_collection.json`

Written after every successful sync (log parse, snapshot read, or memory scan). Regenerated from SQLite; safe to treat as a **read-only snapshot**.

### Schema

```json
{
  "generatedAt": "2026-06-16T12:34:56.789Z",
  "cards": [
    {
      "cardId": "67321",
      "count": 4,
      "name": "Lightning Bolt",
      "setCode": "MKM",
      "rarity": "common",
      "updatedAt": "2026-06-16T12:30:00.000Z"
    }
  ]
}
```

| Field | Type | Meaning |
|-------|------|---------|
| `generatedAt` | ISO 8601 string | When this export was written |
| `cards` | array | One row per Arena card ID ever seen |
| `cards[].cardId` | string | **MTGA Arena ID** (grpId), decimal string |
| `cards[].count` | number | Owned copies (0 = seen in logs but none owned, or cleared) |
| `cards[].name` | string? | Often empty in JSON; join lookup if missing |
| `cards[].setCode` | string? | Set code when known |
| `cards[].rarity` | string? | Raw rarity when known |
| `cards[].updatedAt` | string | Last time this row changed |

**Filter for collection browser:** use rows where `count > 0`.

**Card identity:** `cardId` is the MTGA internal printing ID (same as grpId in memory scans). It is stable for a given Arena printing.

---

## Enrichment: `scryfall/arena_id_lookup_scryfall.json`

Maps Arena ID → English card name. Refreshed about every 24 hours while the sniffer runs.

```json
{
  "fetchedAt": "2026-06-15T08:00:00.000Z",
  "lookup": {
    "67321": "Lightning Bolt",
    "888": "Forest"
  }
}
```

Join in code:

```javascript
const name = lookup[card.cardId] ?? card.name ?? `Arena ${card.cardId}`;
```

MTGA local install data wins over Scryfall when the sniffer merges lookups internally; the persisted file is the merged Scryfall sidecar used for name resolution.

---

## Enrichment: `scryfall/arena_metadata_index.json`

Per-card metadata for filters and progress bars.

```json
{
  "updatedAt": "2026-06-15T08:00:00.000Z",
  "source": "scryfall+local",
  "cards": [
    {
      "cardId": "67321",
      "setCode": "MKM",
      "collectorNumber": "157",
      "rarity": "common",
      "isCollectible": true,
      "inStandard": false,
      "inHistoric": true
    }
  ]
}
```

| Field | Values |
|-------|--------|
| `rarity` | `mythic`, `rare`, `uncommon`, `common`, `land` |
| `source` | `scryfall+local`, `local_fallback`, or `unavailable` |

Build a `Map` keyed by `cardId` for O(1) joins with `latest_collection.json`.

---

## Optional: `scryfall/denominator_stats.json`

Aggregated totals for “X / Y rares” style UI.

```json
{
  "updatedAt": "2026-06-15T08:00:00.000Z",
  "source": "scryfall+local",
  "rarityDenominators": {
    "mythic": 120,
    "rare": 340,
    "uncommon": 410,
    "common": 520,
    "land": 80
  },
  "setFormatStats": [
    {
      "setCode": "MKM",
      "totalCollectible": 281,
      "standardCount": 0,
      "historicCount": 281
    }
  ]
}
```

---

## SQLite: `collection.sqlite`

Same data as `latest_collection.json`, normalized for queries.

### Table `collection_cards`

| Column | Type | Notes |
|--------|------|-------|
| `card_id` | TEXT PK | Arena ID |
| `count` | INTEGER | Owned copies |
| `name` | TEXT | Often NULL |
| `set_code` | TEXT | Often NULL |
| `rarity` | TEXT | Often NULL |
| `updated_at` | TEXT | ISO timestamp |

Example query:

```sql
SELECT card_id, count, updated_at
FROM collection_cards
WHERE count > 0
ORDER BY card_id;
```

Use SQL.js, better-sqlite3, or any SQLite driver. Prefer `latest_collection.json` unless you need SQL.

---

## Localhost HTTP API

Base URL: `http://localhost:37241` (only when MTGA Sniffer tray app is running).

| Method | Path | Response |
|--------|------|----------|
| GET | `/health` | `{ "ok": true }` |
| GET | `/collection` | `{ "cards": [...], "status": {...} }` — cards match enriched `CollectionRecord` |
| GET | `/cards` | Same card array as `/collection` |
| GET | `/sync-status` | Last sync time, parser version, MTGA running flag |
| GET | `/overlay-insights` | Recent change dates, rarity progress (see below) |
| GET | `/metadata-status` | Scryfall cache freshness |
| GET | `/set-format-stats` | `{ "sets": [...] }` |
| GET | `/sync-history?limit=25` | Recent sync log entries |
| POST | `/resync` | Force re-read of log/snapshot |
| POST | `/memory-scan` | Trigger memory scan (requires MTGA open) |

### Enriched card shape (`GET /collection`)

```json
{
  "cardId": "67321",
  "count": 4,
  "name": "Lightning Bolt",
  "setCode": "MKM",
  "collectorNumber": "157",
  "rarity": "common",
  "imageUrl": "https://api.scryfall.com/cards/MKM/157?format=image&version=normal",
  "updatedAt": "2026-06-16T12:30:00.000Z"
}
```

`imageUrl` is built when `setCode` and `collectorNumber` are known from the MTGA local catalog.

### Overlay insights (`GET /overlay-insights`)

```json
{
  "recentChangeDates": [{ "date": "2026-07-16", "cardsDelta": 24, "uniqueDelta": 3, "lastUpdateAt": "..." }],
  "rarityProgress": [
    { "rarity": "Mythic", "ownedUnique": 1264, "totalCollectible": 1844 },
    { "rarity": "Land", "ownedUnique": 832, "totalCollectible": 1298 }
  ]
}
```

**Land bucket:** basic lands (Plains, Island, Swamp, Mountain, Forest, Wastes) use MTGA rarity code `1`, not Scryfall’s `common` label. Consumer apps mirroring overlay progress should apply the same rule — see [integration-troubleshooting.md](integration-troubleshooting.md#rarity-progress-basic-lands-counted-as-common).

---

## Sync history: `sync_history.log`

Append-only; one JSON object per line (newline-delimited JSON).

```json
{
  "syncedAt": "2026-06-16T12:30:00.000Z",
  "source": "C:\\Users\\you\\AppData\\LocalLow\\Wizards Of The Coast\\MTGA\\Player.log",
  "uniqueCardsTracked": 15234,
  "nonZeroCards": 4200,
  "totalCopies": 9800,
  "parserVersion": "v1",
  "mtgaRunning": true
}
```

Useful for “last updated” labels in your browser UI.

---

## When data updates

| Event | What refreshes |
|-------|----------------|
| MTGA writes collection lines to `Player.log` | Counts within ~500 ms debounce |
| `collection_snapshot.json` changes (MTGA folder) | Full snapshot merge |
| Manual resync (tray) | Re-read log + snapshot |
| Memory scan | Replaces counts from MTGA RAM |
| Scryfall metadata job (~24 h) | `scryfall/*` sidecars |

**Polling suggestion for a web UI:** re-read `latest_collection.json` every 30–60 s while sniffer is running, or call `GET /collection` on the same interval.

---

## Minimal integration example (Node)

```javascript
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const root = path.join(
  os.homedir(),
  "AppData",
  "LocalLow",
  "MTGA Sniffer",
);

const [collectionRaw, lookupRaw] = await Promise.all([
  readFile(path.join(root, "latest_collection.json"), "utf8"),
  readFile(path.join(root, "scryfall", "arena_id_lookup_scryfall.json"), "utf8"),
]);

const { generatedAt, cards } = JSON.parse(collectionRaw);
const { lookup } = JSON.parse(lookupRaw);

const owned = cards
  .filter((c) => c.count > 0)
  .map((c) => ({
    arenaId: c.cardId,
    name: lookup[c.cardId] ?? c.name ?? `Arena ${c.cardId}`,
    count: c.count,
  }));

console.log({ generatedAt, ownedCount: owned.length });
```

---

## Minimal integration example (browser + localhost API)

```javascript
const res = await fetch("http://localhost:37241/collection");
const { cards, status } = await res.json();

const owned = cards.filter((c) => c.count > 0);
console.log(status.lastSyncAt, owned.length);
```

---

## Files you can ignore

| File | Reason |
|------|--------|
| `memory_anchors.json` | Memory-scan validation only |
| `scan-config.json` | Owner debug paths for scanner |
| `scryfall/scryfall_cache.json` | Large raw bulk; use `arena_metadata_index.json` instead |
| `vendor/MTGA-collection-exporter/**` | Scanner binary in repo; not collection output |

---

## Related docs (MTGA Sniffer repo)

| Doc | Purpose |
|-----|---------|
| [README.md](../README.md) | Install and daily use |
| [apps/sync-agent/README.md](../apps/sync-agent/README.md) | Sync agent and API summary |
| [scanner-governance.md](scanner-governance.md) | Memory scanner change policy |
| [integration-troubleshooting.md](integration-troubleshooting.md) | Maintainer lessons (scan runtime, errors, lands) |

---

## Versioning

- Parser version in sync status: `v1` (`PARSER_VERSION` in sync-agent).
- Export shape has been stable since early releases; breaking changes will bump parser version and this document.
