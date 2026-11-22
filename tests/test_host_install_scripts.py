"""Desktop plugin install safety and rollback checks."""

import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "windows" / "Manage-DesktopHost.ps1"
PLUGIN = "dsh-control-bridge-host"
POWERSHELL = shutil.which("powershell")


def test_manage_script_is_desktop_only_and_never_kills_processes():
    text = SCRIPT.read_text(encoding="utf-8")
    assert "ValidateSet('Install', 'Upgrade', 'Rollback')" in text
    assert "$ProfileName = 'desktop'" in text
    for forbidden in ("Stop-Process", "taskkill", "Quit-", "CloseMainWindow", "Wait-Process"):
        assert forbidden not in text
    # It must refuse a running Desktop instead of touching it.
    assert "DeepSeek Harness from the tray" in text
    assert "-Code 3" in text


@pytest.mark.skipif(sys.platform != "win32" or POWERSHELL is None, reason="requires Windows PowerShell")
def test_manage_windows_guard_and_verified_rollback(tmp_path):
    home = tmp_path / "isolated home"
    profile = home / "profiles" / "desktop"
    installed = profile / "node_modules" / PLUGIN
    installed.mkdir(parents=True)
    (profile / "package.json").write_text('{"name":"fixture","private":true}', encoding="utf-8")
    patch = b"# current local configuration\n"
    (profile / "cordis.patch.yml").write_bytes(patch)
    data = home / "state" / "desktop-host-local"
    data.mkdir(parents=True)
    (data / "allowlist.json").write_bytes(b'{"fixture":"keep"}')
    (data / "host.secret").write_bytes(b"fixture-secret")
    old_manifest = json.dumps({"name": PLUGIN, "version": "0.1.6", "files": ["index.js"]}).encode()
    (installed / "package.json").write_bytes(old_manifest)
    (installed / "index.js").write_bytes(b"old runtime")

    candidate = tmp_path / "candidate.tgz"
    with tarfile.open(candidate, "w:gz") as archive:
        for name, content in (
            ("package.json", json.dumps({"name": PLUGIN, "version": "0.2.0", "files": ["index.js"]}).encode()),
            ("index.js", b"new runtime"),
        ):
            entry = tarfile.TarInfo(f"package/{name}")
            entry.size = len(content)
            archive.addfile(entry, io.BytesIO(content))
    digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
    backup = tmp_path / "rollback data"

    fake_dsh = tmp_path / "fake-dsh.ps1"
    fake_dsh.write_text(
        """
$ErrorActionPreference = 'Stop'
if (($args[0..3] -join ' ') -ne 'plugin --profile desktop add') { exit 90 }
if ($env:DSH_HOME -ne $env:DSH_FIXTURE_HOME) { exit 91 }
$target = Join-Path $env:DSH_HOME 'profiles/desktop/node_modules/dsh-control-bridge-host'
Add-Content -LiteralPath $env:DSH_FIXTURE_CALLS -Value 1
& tar.exe -xf $args[4] -C $target --strip-components=1
exit $LASTEXITCODE
""",
        encoding="utf-8",
    )
    wrapper = tmp_path / "invoke.ps1"
    wrapper.write_text(
        r"""
param([string]$ProcessState, [string]$Action, [string]$Sha256)
$ErrorActionPreference = 'Stop'
function Get-CimInstance {
  $exe = 'C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe'
  $prefix = '"' + $exe + '"'
  switch ($ProcessState) {
    'opaque' { $line = $null }
    'desktop' { $line = $prefix }
    'quoted' { $line = $prefix + ' "argument --profile superagent --no-open"' }
    'superagent' { $line = $prefix + ' C:\tools\@deepseek-ai\dsh\lib\bin.js --profile superagent --no-open' }
    'unavailable' { throw 'process enumeration unavailable' }
  }
  [pscustomobject]@{ Name = 'DeepSeek Harness.exe'; ExecutablePath = $exe; CommandLine = $line }
}
& $env:DSH_FIXTURE_SCRIPT -Action $Action -DshExe $env:DSH_FIXTURE_EXE -BackupDir $env:DSH_FIXTURE_BACKUP `
  -Package $env:DSH_FIXTURE_PACKAGE -Sha256 $Sha256
exit $LASTEXITCODE
""",
        encoding="utf-8",
    )
    calls = tmp_path / "calls.log"
    env = {
        **os.environ,
        "DSH_HOME": str(home),
        "DSH_FIXTURE_HOME": str(home),
        "DSH_FIXTURE_SCRIPT": str(SCRIPT),
        "DSH_FIXTURE_EXE": str(fake_dsh),
        "DSH_FIXTURE_PACKAGE": str(candidate),
        "DSH_FIXTURE_BACKUP": str(backup),
        "DSH_FIXTURE_CALLS": str(calls),
    }
    # Windows PowerShell builds its own module search path, including Utility.
    env.pop("PSModulePath", None)

    def run(process_state, action="Upgrade", sha256=digest):
        return subprocess.run(
            [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(wrapper),
             process_state, action, sha256],
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=15,
        )

    for state in ("desktop", "opaque", "quoted", "unavailable"):
        result = run(state)
        assert result.returncode == 3, result.stderr
    result = run("superagent", sha256="0" * 64)
    assert result.returncode == 2, result.stderr
    assert not backup.exists()
    assert not calls.exists()

    result = run("superagent")
    assert result.returncode == 0, result.stderr
    assert (installed / "index.js").read_bytes() == b"new runtime"
    saved_archive = backup / "previous-host.tgz"
    saved_bytes = saved_archive.read_bytes()
    receipt = json.loads((backup / "backup.json").read_text(encoding="utf-8-sig"))
    assert receipt["previous_sha256"] == hashlib.sha256(saved_bytes).hexdigest()
    assert sorted(path.name for path in backup.iterdir()) == ["backup.json", "candidate-host.tgz", "previous-host.tgz"]

    saved_archive.write_bytes(saved_bytes + b"tampered")
    result = run("superagent", "Rollback")
    assert result.returncode == 2, result.stderr
    assert calls.read_text().splitlines() == ["1"]
    saved_archive.write_bytes(saved_bytes)
    result = run("superagent", "Rollback")
    assert result.returncode == 0, result.stderr
    assert (installed / "package.json").read_bytes() == old_manifest
    assert (installed / "index.js").read_bytes() == b"old runtime"
    assert (profile / "cordis.patch.yml").read_bytes() == patch
    assert (data / "allowlist.json").read_bytes() == b'{"fixture":"keep"}'
    assert (data / "host.secret").read_bytes() == b"fixture-secret"
