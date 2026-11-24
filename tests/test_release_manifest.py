"""Sidecar hashes are rewritten from the bytes and checked again."""

import json
from pathlib import Path
import runpy
import tomllib
import zipfile

import pytest

from dsh_control_bridge import __version__
from dsh_control_bridge.release_manifest import verify_manifest, write_manifest


def test_runtime_and_published_package_versions_match():
    root = Path(__file__).resolve().parents[1]
    project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    host = json.loads((root / "plugins/dsh-control-bridge-host/package.json").read_text(encoding="utf-8"))
    assert __version__ == project["project"]["version"] == host["version"]


def test_skill_archive_is_installable_and_omits_local_pairing_files(tmp_path):
    root = Path(__file__).resolve().parents[1]
    builder = runpy.run_path(str(root / "scripts" / "build_release.py"))
    skill_dir = tmp_path / "installed"
    public = ("SKILL.md", "references/desktop.md", "references/superagent.md",
              "scripts/desktop.py", "scripts/superagent.py", "scripts/github_source.py")
    for relative in (*public, "connection.json", "private-notes.md", "scripts/__pycache__/cache.pyc"):
        path = skill_dir / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(relative.encode())
    archive = builder["build_skill_zip"](tmp_path, "test", skill_dir)
    with zipfile.ZipFile(archive) as packed:
        assert sorted(packed.namelist()) == sorted(f"deepseek-harness-bridge/{p}" for p in public)
        for relative in public:
            assert packed.read(f"deepseek-harness-bridge/{relative}") == relative.encode()


def test_plugin_runtime_modules_are_all_declared_for_packaging():
    root = Path(__file__).resolve().parents[1]
    plugin = root / "plugins" / "dsh-control-bridge-host"
    manifest = json.loads((plugin / "package.json").read_text(encoding="utf-8"))
    declared = set(manifest["files"])
    # Every top-level runtime module must ship; a new import without a manifest
    # entry would otherwise produce a package that fails only on install.
    runtime = {path.name for path in plugin.glob("*.js")}
    assert runtime <= declared, sorted(runtime - declared)
    assert "paths.js" in declared


def test_manifest_matches_bytes_and_rejects_a_stale_sidecar(tmp_path: Path):
    payload = tmp_path / "dsh-control-bridge-portable.zip"
    payload.write_bytes(b"new-bytes")
    plugin = tmp_path / "dsh-control-bridge-host-0.1.1.tgz"
    plugin.write_bytes(b"plugin-bytes")
    stale = tmp_path / "dsh-control-bridge-portable.zip.sha256"
    stale.write_text("923d2b542de5a80e576f4f45937e0a738d7a0d3c5c5f06e0e9b67b85e9ac677b  dsh-control-bridge-portable.zip\n", encoding="utf-8")
    write_manifest(tmp_path, [payload.name, plugin.name], version="0.1.1")
    verify_manifest(tmp_path, [payload.name, plugin.name], version="0.1.1")
    assert not stale.read_text(encoding="utf-8").startswith("923d2b54")
    stale.write_text("923d2b542de5a80e576f4f45937e0a738d7a0d3c5c5f06e0e9b67b85e9ac677b  dsh-control-bridge-portable.zip\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="sidecar"):
        verify_manifest(tmp_path, [payload.name, plugin.name], version="0.1.1")
