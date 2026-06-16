#!/usr/bin/env python3
"""Launch pinned upstream mtg.py for manual diagnostics.

This script contains no scan logic — it only copies the pinned vendor script into a
work directory and runs it via subprocess. Edit freely for launcher ergonomics.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
VENDOR_DIR = REPO_ROOT / "vendor" / "MTGA-collection-exporter" / "V1.2"
PINNED_MTG = VENDOR_DIR / "mtg.py"
MANIFEST = VENDOR_DIR / "manifest.json"
DEFAULT_WORK_DIR = REPO_ROOT / "scan-work"
SNIFFER_DIR = Path.home() / "AppData" / "LocalLow" / "MTGA Sniffer"
SNIFFER_ANCHORS = SNIFFER_DIR / "memory_anchors.json"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_pinned_mtg() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    expected = str(manifest.get("mtgPySha256", "")).lower()
    actual = sha256_file(PINNED_MTG)
    if not expected or actual != expected:
        raise SystemExit(
            f"Pinned mtg.py hash mismatch.\n expected={expected}\n actual={actual}\n"
            "Do not edit vendor/mtg.py — bump manifest via owner PR."
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="Run pinned upstream mtg.py interactively.")
    parser.add_argument(
        "--work-dir",
        type=Path,
        default=DEFAULT_WORK_DIR,
        help=f"Folder for scan outputs (default: {DEFAULT_WORK_DIR})",
    )
    parser.add_argument(
        "--copy-last-anchors",
        type=Path,
        help="Copy this last_anchors.json into the work directory before launch",
    )
    parser.add_argument(
        "--seed-lookup",
        action="store_true",
        help="Run scripts/dev/seed-arena-lookup.mjs to pre-write arena_id_lookup.json (app parity)",
    )
    args = parser.parse_args()

    verify_pinned_mtg()

    work_dir = args.work_dir.resolve()
    work_dir.mkdir(parents=True, exist_ok=True)

    if args.seed_lookup:
        seed_script = REPO_ROOT / "scripts" / "dev" / "seed-arena-lookup.mjs"
        print(f"Seeding lookup via: node {seed_script.relative_to(REPO_ROOT)}")
        seed = subprocess.run(
            ["node", str(seed_script), "--work-dir", str(work_dir)],
            cwd=REPO_ROOT,
            check=False,
        )
        if seed.returncode != 0:
            print("Lookup seed failed (run npm run build in apps/sync-agent first).")
            return seed.returncode

    target_mtg = work_dir / "mtg.py"
    shutil.copy2(PINNED_MTG, target_mtg)

    if args.copy_last_anchors:
        shutil.copy2(args.copy_last_anchors.resolve(), work_dir / "last_anchors.json")
    elif (work_dir / "last_anchors.json").exists():
        pass
    elif SNIFFER_ANCHORS.exists():
        print(
            "Note: memory_anchors.json uses {name, quantity} format.\n"
            "Place a resolved last_anchors.json in the work dir, or pass --copy-last-anchors.\n"
            "The app adapter writes last_anchors.json during Force Memory Scan when debugKeepWorkDir is enabled."
        )

    print(f"Work dir: {work_dir}")
    print(f"Running: {sys.executable} {target_mtg.name}")
    print("Open MTGA Collection, scroll ~30s, then follow prompts.\n")

    completed = subprocess.run([sys.executable, str(target_mtg)], cwd=work_dir, check=False)
    output = work_dir / "mtga_collection.json"
    if output.exists():
        rows = json.loads(output.read_text(encoding="utf-8"))
        print(f"\nWrote {output} ({len(rows)} rows)")
    else:
        print("\nNo mtga_collection.json produced.")
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
