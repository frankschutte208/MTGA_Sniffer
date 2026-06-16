# Upstream feature request: headless batch mode

**Target repo:** [NthPhantom10/MTGA-collection-exporter](https://github.com/NthPhantom10/MTGA-collection-exporter)

MTGA Sniffer integrates the pinned V1.2 release exe via stdin automation (`last_anchors.json` + piped `\n`). A first-class batch API would remove brittle prompt handling.

## Proposed CLI

```text
MTGA-collection-exporter.exe --batch ^
  --anchors last_anchors.json ^
  --out-dir %TEMP% ^
  --no-pause
```

## Proposed behavior

- Read anchors file format: `[[grpId, quantity, "Card Name"], ...]` (existing `last_anchors.json` format).
- Run the same scan path as interactive mode (no algorithm changes).
- Write:
  - `mtga_collection.json` — existing human-oriented export
  - `mtga_collection_raw.json` — `{ "35573": 1, ... }` grpId → count map for integrators
- Exit codes:
  - `0` — success, collection written
  - `1` — MTGA not running
  - `2` — anchors not found in memory
  - `3` — other failure
- `--no-pause` — skip all `input()` prompts (for automation).

## Why

- Integrators (MTGA Sniffer) can drop stdin hacks.
- Stable contract for grpId maps without reverse lookup from name/set.
- Scan logic stays entirely in upstream; we only bump the pinned exe version.

## Issue text (copy/paste for GitHub)

Title: **Feature request: `--batch` headless mode with raw grpId JSON export**

Body: use the sections above.
