#!/usr/bin/env python3
"""Package the vendored img2threejs checkout into site/forge.zip for Pyodide.

Usage:
    python scripts/build_forge_bundle.py            # uses vendor/img2threejs
    python scripts/build_forge_bundle.py --update   # re-clone upstream first (needs git)

Only what the browser pipeline reads is shipped: forge/ (without tests), docs/, grimoire/,
SKILL.md, README.md and LICENSE. Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor" / "img2threejs"
OUT = ROOT / "site" / "forge.zip"
MANIFEST = ROOT / "site" / "forge-manifest.json"
UPSTREAM = "https://github.com/img2threejs/img2threejs.git"

INCLUDE_DIRS = ("forge", "docs", "grimoire")
INCLUDE_FILES = ("SKILL.md", "README.md", "LICENSE", "CHANGELOG.md")
SKIP_PARTS = {"tests", "__pycache__", ".git", ".img2threejs"}


def update_vendor() -> None:
    tmp = ROOT / "vendor" / "_upstream"
    if tmp.exists():
        shutil.rmtree(tmp)
    subprocess.run(["git", "clone", "--depth", "1", UPSTREAM, str(tmp)], check=True)
    commit = subprocess.run(["git", "-C", str(tmp), "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
    shutil.rmtree(tmp / ".git", ignore_errors=True)
    if VENDOR.exists():
        shutil.rmtree(VENDOR)
    tmp.rename(VENDOR)
    (ROOT / "vendor" / "IMG2THREEJS_COMMIT").write_text(commit + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--update", action="store_true", help="re-clone img2threejs upstream first")
    args = parser.parse_args()
    if args.update:
        update_vendor()
    if not VENDOR.exists():
        print(f"missing {VENDOR}; run with --update", file=sys.stderr)
        return 1

    files: list[str] = []
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for name in INCLUDE_FILES:
            path = VENDOR / name
            if path.exists():
                zf.write(path, name)
                files.append(name)
        for directory in INCLUDE_DIRS:
            for path in sorted((VENDOR / directory).rglob("*")):
                rel = path.relative_to(VENDOR)
                if path.is_dir() or SKIP_PARTS & set(rel.parts) or path.suffix in {".pyc", ".png", ".jpg", ".glb"}:
                    continue
                zf.write(path, rel.as_posix())
                files.append(rel.as_posix())

    commit_file = ROOT / "vendor" / "IMG2THREEJS_COMMIT"
    commit = commit_file.read_text(encoding="utf-8").strip() if commit_file.exists() else "unknown"
    MANIFEST.write_text(
        json.dumps({"upstream": UPSTREAM, "commit": commit, "files": files}, indent=1),
        encoding="utf-8",
    )
    print(f"{OUT} ({OUT.stat().st_size // 1024} KB, {len(files)} files, commit {commit[:10]})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
