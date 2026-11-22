"""Static checks for the Desktop plugin install/upgrade/rollback script."""

import re
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "windows" / "Manage-DesktopHost.ps1"


def test_manage_script_is_desktop_only_and_never_kills_processes():
    text = SCRIPT.read_text(encoding="utf-8")
    assert "ValidateSet('Install', 'Upgrade', 'Rollback')" in text
    assert "$ProfileName = 'desktop'" in text
    for forbidden in ("Stop-Process", "taskkill", "Quit-", "CloseMainWindow", "Wait-Process"):
        assert forbidden not in text
    # It must refuse a running Desktop instead of touching it.
    assert "DeepSeek Harness from the tray" in text
    assert "-Code 3" in text


def test_manage_script_requires_hash_and_backup_and_never_touches_secrets():
    text = SCRIPT.read_text(encoding="utf-8")
    assert "Get-FileHash" in text
    assert "-Algorithm SHA256" in text
    assert "-Sha256" in text
    assert "Backup-Profile" in text
    assert "cordis.patch.yml" in text
    assert "allowlist.json" in text
    # Secrets may be described, but no file command may read, copy or rewrite them.
    for secret in ("host.secret", "bootstrap.secret"):
        assert not re.search(r"(Get-Content|Copy-Item|Set-Content|Add-Content|Remove-Item)[^\n]*" + re.escape(secret), text)
