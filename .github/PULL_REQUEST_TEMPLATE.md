## Summary
- 

## Test Plan
- [ ] `npm run -w @mtga/sync-agent test`
- [ ] `npm run -w @mtga/tray-ui test`
- [ ] `node scripts/preflight-memory-scan.mjs`

## Scanner Change Checklist (required if scanner paths changed)

See [docs/scanner-governance.md](../docs/scanner-governance.md).

- [ ] Owner approval obtained
- [ ] `vendor/MTGA-collection-exporter/**` unchanged or version bump + manifest sha256 updated
- [ ] No reintroduction of `mtga_memory_scan.py`
- [ ] Risk documented (what could regress in scan results)
- [ ] Fixture/golden outputs updated or confirmed unchanged
- [ ] `SCAN_API_VERSION` reviewed (bumped if contract changed)
- [ ] `node scripts/preflight-memory-scan.mjs` passes
- [ ] Before/after diagnostics captured for anchors missing, low matches, and success path
- [ ] Live test: MTGA Collection tab + ~30s scroll + Force Memory Scan
- [ ] Migration continuity verified (`collectorDataMigration` test passes)
