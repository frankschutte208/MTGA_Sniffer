# Card styles — research notes (deferred)

**Status:** Investigated May 2026. **Not planned for development** — owner chose to focus on other work. This document preserves findings if the topic is revisited later.

For consuming collection data in another app, see [collection-data-integration.md](collection-data-integration.md).

## What MTGA Sniffer captures today

| Data | Captured? | Source |
|------|-----------|--------|
| Owned card copies per **grpId** (printings) | Yes | Memory scan via pinned [MTGA-collection-exporter](https://github.com/NthPhantom10/MTGA-collection-exporter) V1.2 |
| Alternate-art **printings** (separate grpIds, e.g. Death-Priest A vs B) | Yes | Same inventory memory block |
| **Card styles** (purchased skins: parallax, borderless, event frames) | **No** | — |

The collection scanner walks dense **`grpId + quantity`** integer pairs in process memory. It does not parse JSON, strings, or cosmetic unlock records. See `vendor/MTGA-collection-exporter/V1.2/mtg.py` (`find_candidate_blocks`).

## Printings vs styles (do not conflate)

Arena treats these differently, especially after Wizards’ [**Any Card, Any Style**](https://magic.wizards.com/en/news/mtg-arena/upcoming-improvements-to-reprints) change:

| Concept | Meaning | In memory scan? |
|---------|---------|-----------------|
| **Printing** | A specific grpId / card art in your collection | Yes |
| **Style unlock** | Account-owned cosmetic (parallax, borderless, etc.) applicable to any printing of that card name | No |
| **Applied style in a deck** | Deckbuilder state (blue pips) | No |

Owning a styled **printing** (extra grpId) is not the same as owning a **style** you can apply across printings.

## Why Player.log is not the primary path for this project

MTGA Sniffer exists partly because logs became unreliable for full collection data:

- `GetPlayerCardsV3` and similar endpoints were removed in the **August 2021** log breaking change.
- Per-card counts are not delivered reliably through the log API layer; memory scan is the approach that works for collection.

`StartHook` → `InventoryInfo` can still include a `Cosmetics.ArtStyles` array (see below), but that is **session-dependent**, may be truncated in long log lines, and has been cut or changed before. Using it as the main architecture would repeat the same reliability problem the sniffer was built to avoid.

`apps/sync-agent/src/parsers/playerLogParser.ts` only extracts numeric grpId → count maps; it does not parse `ArtStyles`.

## Card style data model (when it appears)

From community log captures ([mtgap issue #263](https://github.com/Razviar/mtgap/issues/263)):

```json
"Cosmetics": {
  "ArtStyles": [
    {
      "Type": "ArtStyle",
      "Id": "127296.DA",
      "ArtId": 127296,
      "Variant": "DA"
    }
  ]
}
```

- **`ArtId`** — style catalog identifier (ties to card art / style product).
- **`Variant`** — short code (e.g. `DA`).
- **`Id`** — composite key `"ArtId.Variant"`.

This is an **unlock list**, not a grpId/qty map. It would need separate storage (e.g. `owned_art_styles.json`), not merge into `collection.sqlite` counts.

## Upstream and community tools (survey)

| Project | Approach | Card styles? |
|---------|----------|--------------|
| [NthPhantom10/MTGA-collection-exporter](https://github.com/NthPhantom10/MTGA-collection-exporter) | pymem grpId/qty block (our vendor) | **No** — collection only |
| [frcaton/mtga-tracker-daemon](https://github.com/frcaton/mtga-tracker-daemon) | UnitySpy / Mono memory; HTTP API | **`GET /cards`** (grpId, owned), **`GET /inventory`** (gems, gold) — **no art-styles endpoint** |
| [Echozun/mtg-arena-collection-exporter](https://github.com/Echozun/mtg-arena-collection-exporter) | Wraps tracker-daemon + Scryfall | Collection only |
| [Razviar/mtgap](https://github.com/Razviar/mtgap) (MTGA Pro Tracker) | Log + later memory for collection | Collection tracking evolved after 2021 log cuts ([issue #266](https://github.com/Razviar/mtgap/issues/266)); **no published read-only “scan all owned styles” API** |
| [BobJr23/MTGA_Swapper](https://github.com/BobJr23/MTGA_Swapper) | Edits local MTGA DB / Unity asset tags | **Modifies** visuals ([tags.md](https://github.com/BobJr23/MTGA_Swapper/blob/main/tags.md)); not inventory tracking; out of scope for a read-only sniffer |

**Conclusion:** No drop-in upstream or community tool provides owned card styles in the same way our collection exporter provides grpIds. A styles feature would require **new reverse-engineering**, likely separate from the frozen collection scanner.

## Memory scan for styles — feasibility

**In principle:** Style unlocks almost certainly live in the MTGA process while the client runs.

**In practice for this repo:**

- Unlikely to sit in the same flat grpId/qty block the collection scanner uses.
- Likely a different region or Unity/Mono object graph (structured runtime inspection, not heuristic block walk).
- Layout stability across Arena patches is unknown.
- Tracker developers have described memory vs log work as vastly harder (~order-of-magnitude) than log parsing.

**Explicit non-goals if ever revisited:**

- Do **not** extend `find_candidate_blocks()` / collection anchor logic to “also guess styles” — high false-positive risk.
- Do **not** edit frozen vendor `mtg.py` / exe for styles without a deliberate upstream fork.
- Do **not** use Player.log as sole source without proving completeness across restarts and patches.

## Local `.mtga` catalog

`loadMtgaLocalCatalog()` reads Wizards **card printing** metadata (grpId, name, set) from install `Raw/*.mtga` files. It does **not** enumerate owned style unlocks. MTGA_Swapper “tags” are Unity visual effect IDs for asset editing, not an ownership inventory.

## If revisited later (not scheduled)

Bounded **Phase 0 research only** — read-only, no changes to the collection scanner ([scanner-governance.md](scanner-governance.md)):

1. Ground truth: note 5–10 styles you own in the client.
2. Grep `Player.log` for `ArtStyles` after login; compare count and IDs to in-game ownership.
3. Optional pymem search for `"ArtId.Variant"` strings with known owned styles.
4. Document whether signal survives restart and matches UI.

**Phase 1** (only if Phase 0 proves a reliable signal): separate script (e.g. `mtga_style_scan.py`), separate storage and API, isolated from `SCAN_API_VERSION` / collection contract. Requires explicit owner approval per memory-scan lockdown rules.

## Related docs

- [Scanner governance](scanner-governance.md) — collection memory scan boundaries
- [Upstream batch feature request](upstream-batch-feature-request.md) — grpId export only
