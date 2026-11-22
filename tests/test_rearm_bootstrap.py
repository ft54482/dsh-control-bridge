"""Re-arm script: it must arm only the one-time window and never rotate the host secret.

The script is PowerShell, so these tests skip when no PowerShell host is
available. They are script-level tests, not a live Desktop pass.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "windows" / "Rearm-DesktopHostBootstrap.ps1"


def _powershell() -> str | None:
    for name in ("pwsh", "powershell"):
        found = shutil.which(name)
        if found:
            return found
    if os.name == "nt":
        fallback = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
        if fallback.is_file():
            return str(fallback)
    return None


POWERSHELL = _powershell()
pytestmark = pytest.mark.skipif(POWERSHELL is None, reason="no PowerShell host available")

HOST_SECRET = "a" * 64
ALLOWLIST = {"version": 1, "workspaceAllowlist": [], "sessionAllowlist": []}


def _run(root: Path, *extra: str) -> subprocess.CompletedProcess[str]:
    command = [POWERSHELL or "powershell", "-NoProfile", "-NonInteractive"]
    if os.name == "nt":
        command += ["-ExecutionPolicy", "Bypass"]
    command += ["-File", str(SCRIPT), "-Root", str(root), *extra]
    return subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)


def _host_dir(tmp_path: Path) -> Path:
    here = tmp_path / "desktop-host-local"
    here.mkdir()
    (here / "host.secret").write_text(HOST_SECRET, encoding="utf-8")
    (here / "allowlist.json").write_text(json.dumps(ALLOWLIST), encoding="utf-8")
    return here


def _window(here: Path) -> dict:
    return json.loads((here / "bootstrap.json").read_text(encoding="utf-8"))


def test_rearm_creates_a_short_lived_window_and_preserves_long_lived_state(tmp_path: Path):
    here = _host_dir(tmp_path)
    host_before = (here / "host.secret").read_bytes()
    allowlist_before = (here / "allowlist.json").read_bytes()
    started = time.time()

    completed = _run(tmp_path, "-Minutes", "1")
    assert completed.returncode == 0, completed.stderr
    assert "host.secret" in completed.stdout

    window = _window(here)
    assert window["consumed"] is False
    assert window["version"] == 1
    assert len(window["secret"]) == 64
    int(window["secret"], 16)
    timeout_at = window["expiresAt"] / 1000
    assert timeout_at - started <= 90
    assert timeout_at > time.time() - 5
    assert (here / "bootstrap.secret").read_text(encoding="utf-8").strip() == window["secret"]

    assert (here / "host.secret").read_bytes() == host_before
    assert (here / "allowlist.json").read_bytes() == allowlist_before


def test_rearm_twice_rotates_the_window_but_not_the_host_secret(tmp_path: Path):
    here = _host_dir(tmp_path)
    host_before = (here / "host.secret").read_bytes()
    allowlist_before = (here / "allowlist.json").read_bytes()
    assert _run(tmp_path).returncode == 0
    first = _window(here)["secret"]
    assert _run(tmp_path).returncode == 0
    second = _window(here)["secret"]

    assert first != second
    assert (here / "bootstrap.secret").read_text(encoding="utf-8").strip() == second
    assert (here / "host.secret").read_bytes() == host_before
    assert (here / "allowlist.json").read_bytes() == allowlist_before


def test_rearm_refuses_a_missing_host_secret_and_creates_no_window(tmp_path: Path):
    here = tmp_path / "desktop-host-local"
    here.mkdir()
    (here / "allowlist.json").write_text(json.dumps(ALLOWLIST), encoding="utf-8")

    completed = _run(tmp_path)
    assert completed.returncode != 0
    assert not (here / "bootstrap.json").exists()
    assert not (here / "bootstrap.secret").exists()
    assert not (here / "host.secret").exists()
    assert json.loads((here / "allowlist.json").read_text(encoding="utf-8")) == ALLOWLIST


def test_rearm_refuses_an_unreadable_allowlist(tmp_path: Path):
    here = _host_dir(tmp_path)
    (here / "allowlist.json").write_text('{"workspaceAllowlist": [', encoding="utf-8")
    before = (here / "allowlist.json").read_bytes()

    completed = _run(tmp_path)
    assert completed.returncode != 0
    assert not (here / "bootstrap.json").exists()
    assert (here / "allowlist.json").read_bytes() == before


def test_rearm_refuses_an_out_of_range_window(tmp_path: Path):
    here = _host_dir(tmp_path)

    completed = _run(tmp_path, "-Minutes", "61")
    assert completed.returncode != 0
    assert not (here / "bootstrap.json").exists()
    assert not (here / "bootstrap.secret").exists()


def test_pair_desktop_prints_the_granted_entry_not_the_first_allowlist_row(tmp_path: Path, monkeypatch, capsys):
    from dsh_control_bridge import pair_desktop

    secret_file = tmp_path / "bootstrap.secret"
    secret_file.write_text("b" * 64, encoding="utf-8")
    catalog = {
        "session_status": "ok",
        "sessions": [
            {"session_id": "session-a", "title": "A", "cwd": "C:/x", "busy": False},
            {"session_id": "session-b", "title": "B", "cwd": "C:/y", "busy": False},
        ],
    }
    selected = {
        "ok": True,
        # The server returns the grant that was written; the allowlist itself is
        # in insertion order, so allowlist[0] is an older entry here.
        "granted": {"session_id": "session-a", "access": "write", "title": "A", "cwd": "C:/x"},
        "allowlist": {
            "sessionAllowlist": [
                {"sessionId": "session-b", "access": "read", "title": "B", "cwd": "C:/y"},
                {"sessionId": "session-a", "access": "write", "title": "A", "cwd": "C:/x"},
            ]
        },
    }

    def fake_call(url, _secret, method, payload=None):
        return catalog if url.endswith("/v1/bootstrap/catalog") else selected

    monkeypatch.setattr(pair_desktop, "_call", fake_call)
    code = pair_desktop.main([
        "--bootstrap-secret-file", str(secret_file),
        "--index", "1",
        "--access", "write",
    ])
    out = capsys.readouterr().out
    assert code == 0
    assert "已写入一条授权: A" in out
    assert "权限: write" in out
    assert "已写入一条授权: B" not in out
