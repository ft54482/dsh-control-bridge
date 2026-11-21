import json
from pathlib import Path

import pytest

from dsh_control_bridge.config import load_config
from dsh_control_bridge.credentials import credentials_report
from dsh_control_bridge.errors import ConfigError, TargetRejected
from dsh_control_bridge.models import parse_mandate

ROOT = Path(__file__).resolve().parents[1]


def test_example_config_loads():
    config = load_config(ROOT / "examples" / "config.example.toml")
    assert set(config.instances) == {"local-desktop", "lab-server"}
    local = config.instances["local-desktop"]
    assert local.kind == "desktop"
    assert local.adapter == "fake"
    assert set(local.workspaces) == {"broadcast-cs", "auto-video"}
    assert config.instances["lab-server"].kind == "remote"
    assert config.instances["lab-server"].base_url != local.base_url
    assert config.settings.allow_unsigned is False
    with pytest.raises(TargetRejected):
        config.require_target("local-desktop", "not-declared")
    with pytest.raises(TargetRejected):
        config.require_target("missing-host", "broadcast-cs")


def test_same_workspace_name_is_allowed_on_two_instances():
    config = load_config(ROOT / "examples" / "config.example.toml")
    assert "broadcast-cs" in config.instances["local-desktop"].workspaces
    assert "broadcast-cs" in config.instances["lab-server"].workspaces
    with pytest.raises(TargetRejected) as caught:
        config.require_target("lab-server", "auto-video")
    assert "auto-video" in str(caught.value)


def test_inline_secret_is_rejected(tmp_path: Path):
    path = tmp_path / "bridge.toml"
    path.write_text(
        (ROOT / "examples" / "config.example.toml").read_text(encoding="utf-8")
        + '\ntoken = "do-not-commit"\n',
        encoding="utf-8",
    )
    with pytest.raises(ConfigError) as caught:
        load_config(path)
    assert "token" in str(caught.value)


def test_auto_send_is_rejected(tmp_path: Path):
    text = (ROOT / "examples" / "config.example.toml").read_text(encoding="utf-8")
    text = text.replace(
        'webhook_secret_env = "DSH_BRIDGE_WEBHOOK_SECRET"',
        'webhook_secret_env = "DSH_BRIDGE_WEBHOOK_SECRET"\nauto_send = true',
    )
    path = tmp_path / "bridge.toml"
    path.write_text(text, encoding="utf-8")
    with pytest.raises(ConfigError) as caught:
        load_config(path)
    assert "auto_send" in str(caught.value)


def test_duplicate_base_url_is_rejected(tmp_path: Path):
    text = (ROOT / "examples" / "config.example.toml").read_text(encoding="utf-8")
    text = text.replace("http://127.0.0.1:10", "http://127.0.0.1:9")
    path = tmp_path / "bridge.toml"
    path.write_text(text, encoding="utf-8")
    with pytest.raises(ConfigError) as caught:
        load_config(path)
    assert "own instance" in str(caught.value)


def test_example_mandate_shape():
    raw = __import__("tomllib").loads((ROOT / "examples" / "mandate.example.toml").read_text(encoding="utf-8"))
    mandate = parse_mandate(raw)
    assert "dispatch" in mandate.allowed_actions
    assert mandate.budget_cap == "fake-adapter-only"


def test_credentials_inside_repo_are_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    leaked = ROOT / "credentials.toml"
    leaked.write_text(
        '[instances.local-desktop]\ntoken = "not-a-real-secret"\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("DSH_CREDENTIALS_FILE", str(leaked))
    try:
        with pytest.raises(ConfigError) as caught:
            credentials_report()
        assert "work tree" in str(caught.value)
    finally:
        leaked.unlink(missing_ok=True)


def test_private_credentials_report_hides_values(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    path = tmp_path / "credentials.toml"
    secret = "local-only-value"
    path.write_text(
        "\n".join(
            [
                "[webhook]",
                f'shared_secret = "{secret}"',
                "",
                "[instances.local-desktop]",
                'token = "replace-with-token"',
                "",
                "[instances.lab-server]",
                f'token = "{secret}"',
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("DSH_CREDENTIALS_FILE", str(path))
    report = credentials_report()
    encoded = json.dumps(report)
    assert secret not in encoded
    assert report["instances"]["local-desktop"] == "placeholder"
    assert report["instances"]["lab-server"] == "configured"
    assert report["webhook"] == "configured"
