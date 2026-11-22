"""Write and re-read release sidecars so a hash file cannot lag the bytes."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


def file_record(path: Path) -> dict[str, object]:
    data = path.read_bytes()
    return {
        "name": path.name,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def write_manifest(directory: Path, names: list[str], *, version: str) -> dict[str, object]:
    records = []
    for name in names:
        path = directory / name
        if not path.is_file():
            raise FileNotFoundError(name)
        record = file_record(path)
        sidecar = directory / f"{name}.sha256"
        sidecar.write_text(f"{record['sha256']}  {name}\n", encoding="utf-8")
        records.append(record)
    manifest = {"version": version, "files": records}
    (directory / "MANIFEST.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    verify_manifest(directory, names, version=version)
    return manifest


def verify_manifest(directory: Path, names: list[str], *, version: str) -> None:
    manifest = json.loads((directory / "MANIFEST.json").read_text(encoding="utf-8"))
    if manifest.get("version") != version:
        raise RuntimeError("manifest version does not match the package version")
    by_name = {item["name"]: item for item in manifest["files"]}
    for name in names:
        path = directory / name
        actual = file_record(path)
        listed = by_name.get(name)
        sidecar = (directory / f"{name}.sha256").read_text(encoding="utf-8").split()[0]
        if listed is None or listed["sha256"] != actual["sha256"] or listed["bytes"] != actual["bytes"]:
            raise RuntimeError(f"manifest does not match {name}")
        if sidecar != actual["sha256"]:
            raise RuntimeError(f"sidecar does not match {name}")
