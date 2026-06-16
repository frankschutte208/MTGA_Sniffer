# MTGA Sniffer

Tracks your MTGA collection in the background while you play. It reads local game logs (and optionally MTGA memory), keeps your collection in SQLite, exports JSON for other apps, and shows status from the system tray and an in-game overlay when MTGA is focused.

**Repository:** [github.com/frankschutte208/MTGA_Sniffer](https://github.com/frankschutte208/MTGA_Sniffer)

---

## Install (Windows)

1. Copy the portable app to a permanent folder, for example:

   ```
   %LOCALAPPDATA%\MTGA Sniffer\MTGA-Sniffer-0.1.0.exe
   ```

   Build output from this repo:

   ```
   apps\tray-ui\dist\MTGA-Sniffer-0.1.0.exe
   ```

2. Run the exe once. It stays in the system tray — no terminal or npm required.

3. Enable **Start with Windows** from the tray icon menu so the sniffer is already running before you launch MTGA.

   Alternative: press `Win + R`, type `shell:startup`, and place a shortcut to the exe in that folder.

---

## Daily use

- Launch MTGA as normal. The sniffer watches `Player.log` automatically.
- When MTGA is focused, a small overlay icon appears in the top-right of the game window. Hover for collection stats.
- Right-click the system tray icon for:
  - Manual resync
  - Force memory scan
  - Configure memory anchors
  - Start with Windows
  - Quit

---

## Memory scan fallback

Logs do not always include full per-card counts. The sniffer can read collection data from MTGA memory using the bundled [MTGA-collection-exporter](https://github.com/NthPhantom10/MTGA-collection-exporter) binary (no Python install required for the packaged app).

**Before scanning:**

1. Open **Collection** (or Decks) in MTGA.
2. Scroll through the collection for about **30 seconds** so cards load into memory.
3. Use **Force Memory Scan** from the tray menu or overlay.

The scan uses anchor cards you own to verify it found the correct memory block. Configure anchors from the tray menu, or let the sniffer derive them from your existing collection.

For development from source, the upstream exe is pinned under `vendor/MTGA-collection-exporter/V1.2/`. See [scanner governance](docs/scanner-governance.md).

---

## Where data is stored

```
%USERPROFILE%\AppData\LocalLow\MTGA Sniffer\
```

| File / folder | Purpose |
|---------------|---------|
| `collection.sqlite` | Collection database (source of truth) |
| `latest_collection.json` | JSON export — **use this for external apps** |
| `sync_history.log` | Sync history (one JSON line per sync) |
| `memory_anchors.json` | Anchor cards for memory scan validation |
| `scryfall/` | Card names, set metadata, progress denominators |

### External apps (web collection browser, etc.)

**→ [docs/collection-data-integration.md](docs/collection-data-integration.md)**

Single reference for paths, JSON schemas, SQLite layout, and the localhost API (`http://localhost:37241`).

---

## Requirements

- Windows
- MTGA installed

---

## For developers

End users should run the packaged exe, not npm.

```bash
npm install
npm test
npm run -w @mtga/tray-ui dist:win
```

Output: `apps/tray-ui/dist/MTGA-Sniffer-<version>.exe`

| Doc | Purpose |
|-----|---------|
| [Collection data integration](docs/collection-data-integration.md) | **Consumer apps** — where data lives and how to read it |
| [Sync agent](apps/sync-agent/README.md) | Embedded API, sync behaviour |
| [Scanner governance](docs/scanner-governance.md) | Memory scan change process |
| [Card styles research](docs/card-styles-research.md) | Deferred research; not on roadmap |

### Backup to Git

Run `backup_to_git.bat` from the repo root. It shows the current version tag, prompts for a new version and description, commits, tags, and pushes.

Build outputs (`apps/tray-ui/dist/`, `dist-new/`) are gitignored — never commit Electron builds.

---

## Acknowledgments

The memory scan uses the pinned [MTGA-collection-exporter](https://github.com/NthPhantom10/MTGA-collection-exporter) release exe (`vendor/MTGA-collection-exporter/V1.2/`). No custom scan Python lives in this repo.
