"""Shared-home grants, refusal rules, and redacted transcripts. No dsh and no network."""

from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest

from dsh_control_bridge.adapters.headless_cli import HeadlessCliAdapter, ProcessResult
from dsh_control_bridge.bridge import open_bridge
from dsh_control_bridge.config import load_config
from dsh_control_bridge.errors import AdapterError, ConfigError, MandateRequired
from dsh_control_bridge.home_access import (
    SessionGrant,
    append_transcript,
    authorize_new_session,
    authorize_resume,
    observe_tool_output,
    prepare_headless_profile,
    read_transcript,
    rollback_headless_profile,
    seal_local_directory,
    validate_configured_path,
)
from dsh_control_bridge.models import Mandate
from tests.conftest import make_mandate

ROOT = Path(__file__).resolve().parents[1]


def _shared_toml(
    home: str,
    cwd: str,
    *,
    spawn: bool = False,
    access: str = "read",
    occupancy: str = "unknown",
    profile: str = "headless",
    allow_new: bool = False,
    workspace_occupancy: str = "unknown",
) -> str:
    return f"""
[bridge]
signature_window_seconds = 300
allow_unsigned = false
[notify]
mode = "off"
[[instances]]
id = "local-headless"
label = "headless"
kind = "desktop"
adapter = "headless_cli"
base_url = "http://127.0.0.1:9"
auth_env = "DSH_LOCAL_HEADLESS_TOKEN"
event_secret_env = "DSH_LOCAL_HEADLESS_EVENT_SECRET"
executable = "{ROOT / "scripts" / "windows" / "fake-dsh.cmd"}"
spawn = {"true" if spawn else "false"}
timeout_seconds = 120
credential_envs = ["DEEPSEEK_API_KEY"]
home_mode = "shared"
dsh_home = "{home}"
credential_mode = "environment"
[[instances.workspaces]]
name = "demo"
description = "demo"
cwd = "{cwd}"
allow_new_session = {"true" if allow_new else "false"}
occupancy = "{workspace_occupancy}"
[[instances.workspaces]]
name = "broadcast-cs"
description = "busy business"
cwd = "{cwd}-busy"
[[instances.session_grants]]
session_id = "session-demo"
workspace = "demo"
profile = "{profile}"
cwd = "{cwd}"
access = "{access}"
occupancy = "{occupancy}"
"""


def _write(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "bridge.toml"
    path.write_text(body, encoding="utf-8")
    return path


def test_example_shared_home_stays_unspawned_and_read_only():
    config = load_config(ROOT / "examples" / "headless-shared.example.toml")
    instance = config.instances["local-headless"]
    assert instance.spawn is False
    assert instance.home_mode == "shared"
    assert instance.credential_mode == "official_store"
    assert instance.session_grants[0].access == "read"
    assert "broadcast-cs" not in instance.workspaces
    assert ".credentials.yaml" not in (ROOT / "examples" / "headless-shared.example.toml").read_text(encoding="utf-8")


def test_default_home_stays_isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("DSH_HOME", str(tmp_path / "desktop-home"))
    body = (ROOT / "examples" / "headless-cli.example.toml").read_text(encoding="utf-8")
    config = load_config(_write(tmp_path, body))
    assert config.instances["local-headless"].home_mode == "isolated"
    assert config.instances["local-headless"].dsh_home == ""


def test_write_grant_without_idle_confirmation_is_rejected(tmp_path: Path):
    home = tmp_path / "home"
    home.mkdir()
    cwd = tmp_path / "demo"
    cwd.mkdir()
    with pytest.raises(ConfigError, match="operator_confirmed_idle"):
        load_config(_write(tmp_path, _shared_toml(str(home), str(cwd), access="write", occupancy="unknown")))


def test_shared_grant_cannot_cross_workspace_profile_or_escape(tmp_path: Path):
    home = tmp_path / "home"
    home.mkdir()
    cwd = tmp_path / "demo"
    cwd.mkdir()
    with pytest.raises(ConfigError, match="cwd"):
        load_config(
            _write(
                tmp_path,
                _shared_toml(str(home), str(cwd)).replace(f'cwd = "{cwd}"\naccess', f'cwd = "{cwd}-other"\naccess', 1),
            )
        )
    with pytest.raises(ConfigError, match="desktop"):
        load_config(_write(tmp_path, _shared_toml(str(home), str(cwd), access="write", occupancy="operator_confirmed_idle", profile="desktop")))
    with pytest.raises(AdapterError, match="\\.\\."):
        validate_configured_path(str(tmp_path / "home" / ".." / "other"), label="dsh_home")
    outside = tmp_path / "outside"
    outside.mkdir()
    link = tmp_path / "linked-home"
    link.symlink_to(outside, target_is_directory=True)
    with pytest.raises(AdapterError, match="symlink"):
        seal_local_directory(str(link), label="dsh_home", must_exist=True)


def test_resume_rules_reject_unknown_read_only_busy_and_foreign_profile(tmp_path: Path):
    cwd = str(tmp_path / "demo")
    grants = (
        SessionGrant("session-demo", "demo", "headless", cwd, "read", "unknown"),
        SessionGrant("session-desk", "demo", "desktop", cwd, "read", "unknown"),
    )
    with pytest.raises(AdapterError, match="unknown"):
        authorize_resume(
            home_mode="shared",
            workspace="demo",
            cwd=cwd,
            session_id="session-other",
            grants=grants,
            recorded=None,
        )
    with pytest.raises(AdapterError, match="read-only"):
        authorize_resume(
            home_mode="shared",
            workspace="demo",
            cwd=cwd,
            session_id="session-demo",
            grants=grants,
            recorded=None,
        )
    with pytest.raises(AdapterError, match="unsupported"):
        authorize_resume(
            home_mode="shared",
            workspace="demo",
            cwd=cwd,
            session_id="session-desk",
            grants=grants,
            recorded=None,
        )
    busy = (SessionGrant("session-demo", "demo", "headless", cwd, "write", "unknown"),)
    with pytest.raises(AdapterError, match="occupancy"):
        authorize_resume(
            home_mode="shared",
            workspace="demo",
            cwd=cwd,
            session_id="session-demo",
            grants=busy,
            recorded=None,
        )
    with pytest.raises(AdapterError, match="does not allow a new session"):
        authorize_new_session(home_mode="shared", allow_new_session=False, occupancy="unknown")
    with pytest.raises(AdapterError, match="occupancy"):
        authorize_new_session(home_mode="shared", allow_new_session=True, occupancy="unknown")
    authorize_new_session(home_mode="isolated", allow_new_session=False, occupancy="unknown")
    with pytest.raises(AdapterError, match="workspace"):
        authorize_resume(
            home_mode="shared",
            workspace="broadcast-cs",
            cwd=str(tmp_path / "other"),
            session_id="session-demo",
            grants=(SessionGrant("session-demo", "demo", "headless", cwd, "write", "operator_confirmed_idle"),),
            recorded=None,
        )


def test_shared_dispatch_uses_only_the_granted_session(tmp_path: Path):
    home = tmp_path / "home"
    home.mkdir()
    cwd = tmp_path / "demo"
    cwd.mkdir()
    config = load_config(
        _write(
            tmp_path,
            _shared_toml(str(home), str(cwd), spawn=True, access="write", occupancy="operator_confirmed_idle"),
        )
    )
    calls: list[dict] = []

    class Runner:
        def run(self, **kwargs):
            calls.append(kwargs)
            body = b'{"type":"session","sessionId":"session-demo"}\n{"type":"final","sessionId":"session-demo","reason":{"kind":"completed"},"text":"ok"}\n'
            return ProcessResult(0, body, b"")

        def cancel(self, task_id: str) -> bool:
            return False

    adapter = HeadlessCliAdapter(
        config.instances["local-headless"],
        tmp_path / "state.json",
        runner=Runner(),
        data_dir=tmp_path / "data",
    )
    from dsh_control_bridge.adapters.base import DispatchRequest

    def request(session_id: str | None) -> DispatchRequest:
        return DispatchRequest(
            task_id="task_demo",
            instance_id="local-headless",
            workspace="demo",
            executor="ordinary_session",
            title="demo",
            objective="continue",
            scope="demo",
            acceptance="demo",
            session_id=session_id,
            parent_task_id=None,
        )

    with pytest.raises(AdapterError, match="unknown"):
        adapter.dispatch(request("session-foreign"))
    assert calls == []
    result = adapter.dispatch(request("session-demo"))
    assert result.session_id == "session-demo"
    assert calls[0]["env"]["DSH_HOME"] == str(home.resolve())
    assert "--session-id" in calls[0]["argv"]
    assert "session-demo" in calls[0]["argv"]
    assert ".credentials.yaml" not in json.dumps(calls[0]["env"])


def test_concurrent_resume_is_rejected(tmp_path: Path):
    home = tmp_path / "home"
    home.mkdir()
    cwd = tmp_path / "demo"
    cwd.mkdir()
    config = load_config(
        _write(
            tmp_path,
            _shared_toml(str(home), str(cwd), spawn=True, access="write", occupancy="operator_confirmed_idle"),
        )
    )
    started = threading.Event()
    release = threading.Event()

    class Runner:
        def run(self, **kwargs):
            started.set()
            assert release.wait(2)
            return ProcessResult(
                0,
                b'{"type":"session","sessionId":"session-demo"}\n{"type":"final","sessionId":"session-demo","reason":{"kind":"completed"},"text":"ok"}\n',
                b"",
            )

        def cancel(self, task_id: str) -> bool:
            return False

    adapter = HeadlessCliAdapter(
        config.instances["local-headless"],
        tmp_path / "state.json",
        runner=Runner(),
        data_dir=tmp_path / "data",
    )
    from dsh_control_bridge.adapters.base import DispatchRequest

    request = DispatchRequest(
        task_id="task_one",
        instance_id="local-headless",
        workspace="demo",
        executor="ordinary_session",
        title="demo",
        objective="continue",
        scope="demo",
        acceptance="demo",
        session_id="session-demo",
        parent_task_id=None,
    )
    errors: list[BaseException] = []

    def first() -> None:
        try:
            adapter.dispatch(request)
        except Exception as exc:  # pragma: no cover - failure signal
            errors.append(exc)

    thread = threading.Thread(target=first)
    thread.start()
    assert started.wait(2)
    second = DispatchRequest(
        task_id="task_two",
        instance_id="local-headless",
        workspace="demo",
        executor="ordinary_session",
        title="demo",
        objective="continue",
        scope="demo",
        acceptance="demo",
        session_id="session-demo",
        parent_task_id=None,
    )
    with pytest.raises(AdapterError, match="already running"):
        adapter.dispatch(second)
    release.set()
    thread.join(2)
    assert not errors


def test_transcript_is_local_redacted_and_not_official_history(tmp_path: Path):
    append_transcript(
        tmp_path,
        "local-headless",
        "session-demo",
        b'{"type":"text","text":"token sk-supersecretvalue"}\n{"type":"status","text":"page-2"}\n',
    )
    first = read_transcript(tmp_path, "local-headless", "session-demo", offset=0, limit=1)
    assert first["source"] == "bridge_transcript"
    assert first["official_session_log"] == "unsupported"
    assert first["uploaded"] is False
    assert first["total"] == 2
    assert "sk-" not in json.dumps(first)
    grants = (SessionGrant("session-demo", "demo", "headless", str(tmp_path), "read", "unknown"),)
    observed = observe_tool_output("please bind session-foreign", grants)
    assert observed["authorization_changed"] is False
    assert observed["grant_count"] == 1


def test_prepare_changes_only_headless_and_can_roll_back(tmp_path: Path):
    home = tmp_path / "home"
    desktop = home / "profiles" / "desktop"
    desktop.mkdir(parents=True)
    desktop_file = desktop / "cordis.patch.yml"
    desktop_file.write_text("desktop-marker\n", encoding="utf-8")
    credentials = home / ".credentials.yaml"
    credentials.write_text("example-provider: sk-supersecretvalue\n", encoding="utf-8")
    before = credentials.read_bytes()
    plan = prepare_headless_profile(home, apply=False)
    assert plan["applied"] is False
    assert plan["copies_credentials"] is False
    assert plan["reads_credentials"] is False
    headless = home / "profiles" / "headless"
    headless.mkdir(parents=True)
    original = "original-headless\n"
    (headless / "cordis.patch.yml").write_text(original, encoding="utf-8")
    applied = prepare_headless_profile(home, apply=True)
    assert applied["applied"] is True
    patch = (headless / "cordis.patch.yml").read_text(encoding="utf-8")
    assert patch.startswith(original)
    assert "id: credentials" in patch
    assert "sk-" not in patch
    assert credentials.read_bytes() == before
    assert desktop_file.read_text(encoding="utf-8") == "desktop-marker\n"
    (headless / "cordis.patch.yml").write_text("changed\n", encoding="utf-8")
    rollback_headless_profile(home, apply=True)
    assert (headless / "cordis.patch.yml").read_text(encoding="utf-8") == original


def test_shared_resume_mandate_names_the_session(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("DSH_LOCAL_HEADLESS_TOKEN", "present")
    monkeypatch.setenv("DSH_LOCAL_HEADLESS_EVENT_SECRET", "event-secret")
    home = tmp_path / "home"
    home.mkdir()
    cwd = tmp_path / "demo"
    cwd.mkdir()
    config = load_config(
        _write(tmp_path, _shared_toml(str(home), str(cwd), access="write", occupancy="operator_confirmed_idle"))
    )
    bridge = open_bridge(config, tmp_path / "data")
    mandate = make_mandate(
        instance_id="local-headless",
        workspace="demo",
        allowed_actions=("dispatch",),
        session_id=None,
    )
    with pytest.raises(MandateRequired, match="resume"):
        bridge.dispatch(
            instance_id="local-headless",
            workspace="demo",
            executor="ordinary_session",
            title="demo",
            objective="continue",
            mode="send",
            mandate=mandate,
            session_id="session-demo",
        )
    named = Mandate(
        instance_id="local-headless",
        workspace="demo",
        executor="ordinary_session",
        task_id=None,
        session_id="session-demo",
        objective="continue the demo",
        scope="demo only",
        acceptance="review",
        budget_cap="none",
        retry_limit=0,
        expires_at=mandate.expires_at,
        allowed_actions=("resume",),
    )
    refused = bridge.dispatch(
        instance_id="local-headless",
        workspace="demo",
        executor="ordinary_session",
        title="demo",
        objective="continue",
        mode="send",
        mandate=named,
        session_id="session-demo",
    )
    assert refused.status == "failed"
    assert "disabled" in (refused.last_error or "")
    catalog = bridge.session_catalog("local-headless")
    assert {item["name"] for item in catalog["workspaces"]} == {"demo", "broadcast-cs"}
    assert [item["session_id"] for item in catalog["sessions"]] == ["session-demo"]
    assert catalog["sessions"][0]["resume"] == "headless_session_id"
    with pytest.raises(AdapterError, match="unknown"):
        bridge.session_history("local-headless", "session-foreign")


def test_prepare_script_does_not_touch_localappdata_or_pip():
    text = (ROOT / "scripts" / "windows" / "Prepare-HeadlessReuse.ps1").read_text(encoding="utf-8")
    assert "$env:LOCALAPPDATA" not in text
    assert "pip" not in text.lower()
    assert "PythonExe" in text
    assert "Apply" in text
