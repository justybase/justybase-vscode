#!/usr/bin/env python3
"""Verify a pinned SQL corpus tree without the canonical repository or dependencies."""
from __future__ import annotations

import hashlib
import json
import pathlib
import sys


def verify(root: pathlib.Path) -> None:
    manifest = json.loads((root / "snapshot.json").read_text(encoding="utf-8-sig"))
    hashes = manifest["files"]
    actual = {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()
              and "__pycache__" not in p.parts}
    if actual != set(hashes) | {"snapshot.json"}:
        raise ValueError("snapshot files are missing or unexpected")
    for name, digest in hashes.items():
        path = (root / name).resolve()
        if not path.is_relative_to(root.resolve()):
            raise ValueError("snapshot path escapes fixture directory")
        if hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest() != digest:
            raise ValueError(f"snapshot content hash mismatch: {name}")
    digest = hashlib.sha256(json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if digest != manifest["contentHash"]:
        raise ValueError("snapshot manifest hash mismatch")
    ids = [json.loads(line)["id"] for name in hashes if name.endswith(".jsonl")
           for line in (root / name).read_text(encoding="utf-8-sig").splitlines() if line.strip()]
    if len(ids) != manifest["caseCount"] or len(set(ids)) != len(ids):
        raise ValueError("snapshot case count/identity mismatch")


if __name__ == "__main__":
    verify(pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else pathlib.Path(__file__).resolve().parent)
    print("SQL corpus snapshot verified")
