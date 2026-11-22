"""Build the release artifacts and verify them byte for byte.

Produces, inside ``--dist``:
- ``dsh-control-bridge-<version>-portable.zip``  (source tree, no secrets)
- ``MANIFEST.json`` and ``<artifact>.sha256`` for every artifact
- a verification pass that unpacks both artifacts and compares per-file SHA256
  against the source tree and against the packed manifest

The plugin ``.tgz`` is produced by the package manager (``pnpm pack``) and is
only verified here, because a hand-built npm tarball would not prove the
package manager accepts it.

Usage:
    python scripts/build_release.py --dist dist [--skip-tgz]

Nothing outside ``--dist`` is written. The source tree is never modified.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import tarfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "dsh-control-bridge-host"
SKIP_DIRS = {".git", ".pytest_cache", "__pycache__", "dist", "node_modules", ".mypy_cache"}
SKIP_SUFFIXES = {".pyc", ".pyo"}
SKIP_NAMES = {"bridge.secret", "host.secret", "bootstrap.secret", ".credentials.yaml"}
PACKAGE_TOP = ["README.md", "LICENSE", "pyproject.toml", "Makefile", "CONTRIBUTING.md", "SECURITY.md"]
PACKAGE_DIRS = ["src", "scripts", "examples", "docs", "plugins", "tests"]


def plugin_version() -> str:
    return json.loads((PLUGIN / "package.json").read_text(encoding="utf-8"))["version"]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def included_files() -> list[Path]:
    files: list[Path] = []
    for name in PACKAGE_TOP:
        candidate = ROOT / name
        if candidate.is_file():
            files.append(candidate)
    for name in PACKAGE_DIRS:
        base = ROOT / name
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if not path.is_file():
                continue
            if any(part in SKIP_DIRS for part in path.relative_to(ROOT).parts):
                continue
            if path.suffix in SKIP_SUFFIXES or path.name in SKIP_NAMES:
                continue
            files.append(path)
    return sorted(files)


def build_zip(dist: Path, version: str) -> Path:
    target = dist / f"dsh-control-bridge-{version}-portable.zip"
    prefix = f"dsh-control-bridge-{version}"
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in included_files():
            info = zipfile.ZipInfo(f"{prefix}/{path.relative_to(ROOT).as_posix()}")
            info.date_time = (1980, 1, 1, 0, 0, 0)
            info.external_attr = 0o644 << 16
            archive.writestr(info, path.read_bytes())
    return target


def verify_zip(target: Path, version: str) -> list[str]:
    prefix = f"dsh-control-bridge-{version}/"
    problems: list[str] = []
    checked = 0
    with zipfile.ZipFile(target) as archive:
        for info in archive.infolist():
            relative = info.filename[len(prefix):]
            source = ROOT / relative
            if not source.is_file():
                problems.append(f"zip has an unexpected entry: {info.filename}")
                continue
            if sha256(archive.read(info)) != sha256(source.read_bytes()):
                problems.append(f"zip entry differs from source: {relative}")
            checked += 1
    expected = {path.relative_to(ROOT).as_posix() for path in included_files()}
    packed = {info.filename[len(prefix):] for info in zipfile.ZipFile(target).infolist()}
    for missing in sorted(expected - packed):
        problems.append(f"zip is missing: {missing}")
    return [f"{checked} entries compared", *problems]


def verify_tgz(target: Path) -> list[str]:
    problems: list[str] = []
    checked = 0
    normalized = 0
    present: set[str] = set()
    with tarfile.open(target, "r:gz") as archive:
        for member in archive.getmembers():
            if not member.isfile():
                continue
            relative = member.name.split("/", 1)[1] if "/" in member.name else member.name
            present.add(relative)
            source = PLUGIN / relative
            if not source.is_file():
                problems.append(f"tgz has an unexpected entry: {member.name}")
                continue
            handle = archive.extractfile(member)
            if handle is None:
                problems.append(f"tgz entry unreadable: {member.name}")
                continue
            packed = handle.read()
            if relative == "package.json":
                # pnpm re-serializes the manifest (LF, no trailing newline), so
                # this one file is compared as parsed JSON.
                try:
                    same = json.loads(packed) == json.loads(source.read_bytes())
                except ValueError:
                    same = False
                normalized += 1
            else:
                same = sha256(packed) == sha256(source.read_bytes())
            if not same:
                problems.append(f"tgz entry differs from source: {relative}")
            checked += 1
    # The reverse direction: every runtime file the manifest declares must be in
    # the tarball. Without this, a missing import (e.g. a new module not listed
    # in `files`) ships a package that only fails on install.
    try:
        declared = json.loads((PLUGIN / "package.json").read_text(encoding="utf-8")).get("files", [])
    except (OSError, ValueError):
        declared = []
        problems.append("package.json could not be read to check the runtime file list")
    for relative in declared:
        if relative not in present:
            problems.append(f"tgz is missing a declared runtime file: {relative}")
    summary = f"{checked - normalized} byte-identical, {normalized} JSON-equal (package.json)"
    return [summary, *problems]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build and verify the release artifacts.")
    parser.add_argument("--dist", type=Path, default=ROOT / "dist")
    parser.add_argument("--skip-tgz", action="store_true", help="verify only, without the plugin tarball")
    args = parser.parse_args(argv)
    args.dist.mkdir(parents=True, exist_ok=True)
    version = plugin_version()
    print(f"version: {version}")

    names: list[str] = []
    tgz = args.dist / f"dsh-control-bridge-host-{version}.tgz"
    if tgz.is_file():
        names.append(tgz.name)
        report = verify_tgz(tgz)
        print(f"tgz: {tgz.name} -> {report[0]}")
        if len(report) > 1:
            print("\n".join(report[1:]))
            return 1
    elif not args.skip_tgz:
        print(f"missing plugin tarball: {tgz}")
        return 2

    zip_path = build_zip(args.dist, version)
    names.append(zip_path.name)
    report = verify_zip(zip_path, version)
    print(f"zip: {zip_path.name} -> {report[0]}")
    if len(report) > 1:
        print("\n".join(report[1:]))
        return 1

    from dsh_control_bridge.release_manifest import write_manifest, verify_manifest

    manifest = write_manifest(args.dist, names, version=version)
    verify_manifest(args.dist, names, version=version)
    for record in manifest["files"]:
        print(f"{record['sha256']}  {record['bytes']:>9}  {record['name']}")
    print("manifest and sidecars verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
