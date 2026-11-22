"""Sidecar hashes are rewritten from the bytes and checked again."""

import json
from pathlib import Path

import pytest

from dsh_control_bridge.release_manifest import verify_manifest, write_manifest


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
