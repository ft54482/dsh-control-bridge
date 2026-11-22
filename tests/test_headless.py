"""Fake-process regression for the headless CLI adapter. No real dsh and no network."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from dsh_control_bridge.adapters.headless_cli import (
    HeadlessCliAdapter,
    ProcessResult,
    build_argv,
    interpret_run,
)
from dsh_control_bridge.config import load_config
from dsh_control_bridge.adapters.base import CancelRequest, DispatchRequest
from dsh_control_bridge.errors import AdapterError, ConfigError

ROOT = Path(__file__).resolve().parents[1]


class RecordingRunner:
    def __init__(self, result: ProcessResult):
        self.result = result
        self.calls: list[dict] = []

    def run(self, *, task_id, argv, cwd, env, stdin, timeout):
        self.calls.append(
            {"task_id": task_id, "argv": argv, "cwd": cwd, "env": env, "stdin": stdin, "timeout": timeout}
        )
        return self.result

    def cancel(self, task_id: str) -> bool:
        return False


def _config(tmp_path: Path) -> object:
    body = f"""
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
auth_env = "DSH_HEADLESS_TOKEN"
event_secret_env = "DSH_HEADLESS_EVENT_SECRET"
executable = "/opt/dsh/dsh"
spawn = true
timeout_seconds = 30
credential_envs = ["DEEPSEEK_API_KEY"]
[[instances.workspaces]]
name = "broadcast-cs"
description = "one"
cwd = "{(tmp_path / 'broadcast-cs').as_posix()}"
[[instances.workspaces]]
name = "auto-video"
description = "two"
cwd = "{(tmp_path / 'auto-video').as_posix()}"
"""
    path = tmp_path / "bridge.toml"
    path.write_text(body, encoding="utf-8")
    return load_config(path)


def _adapter(tmp_path: Path, runner: RecordingRunner, monkeypatch: pytest.MonkeyPatch) -> HeadlessCliAdapter:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-testsecretvalue")
    monkeypatch.setenv("DSH_HOME", "/home/desktop-secrets")
    config = _config(tmp_path)
    return HeadlessCliAdapter(
        config.instances["local-headless"],
        tmp_path / "state.json",
        runner=runner,
        data_dir=tmp_path / "data",
    )


def _request(**kwargs) -> DispatchRequest:
    values = dict(
        task_id="task_abc",
        instance_id="local-headless",
        workspace="broadcast-cs",
        executor="ordinary_session",
        title="t",
        objective="run the checks",
        scope="scope",
        acceptance="acceptance",
        session_id=None,
        parent_task_id=None,
    )
    values.update(kwargs)
    return DispatchRequest(**values)


def _stream(session_id: str = "session-abc", kind: str | None = "completed", error: bool = False) -> bytes:
    lines = [
        {"type": "session", "sessionId": session_id},
        {"type": "status", "text": "running"},
        {"type": "text", "text": "partial"},
        {"type": "thinking", "text": "think"},
        {"type": "tool_call", "name": "shell"},
        {"type": "tool_result", "name": "shell"},
    ]
    if error:
        lines.append({"type": "error", "message": "boom"})
    else:
        reason = None if kind is None else {"kind": kind}
        lines.append({"type": "final", "sessionId": session_id, "reason": reason, "text": "answer"})
    return b"\n".join(json.dumps(item).encode() for item in lines) + b"\n"


def test_success_requires_exit_zero_and_completed_reason():
    assert interpret_run(_stream(), 0).ok
    assert not interpret_run(_stream(kind="aborted"), 0).ok
    assert not interpret_run(_stream(), 1).ok
    assert not interpret_run(_stream(kind=None), 0).ok
    failed = interpret_run(_stream(error=True), 1)
    assert not failed.ok
    assert "without final" in failed.detail


def test_argv_puts_the_task_on_stdin_and_keeps_a_safe_session_id(tmp_path, monkeypatch):
    runner = RecordingRunner(ProcessResult(0, _stream(), b""))
    adapter = _adapter(tmp_path, runner, monkeypatch)
    result = adapter.dispatch(_request(objective="run the checks & calc"))
    assert result.session_id == "session-abc"
    call = runner.calls[0]
    assert call["argv"] == ["/opt/dsh/dsh", "--profile", "headless", "--json", "-"]
    assert "run the checks & calc" not in " ".join(call["argv"])
    assert call["stdin"] == b"run the checks & calc\n"
    assert Path(call["cwd"]) == tmp_path / "broadcast-cs"
    assert call["env"]["DEEPSEEK_API_KEY"] == "sk-testsecretvalue"
    assert call["env"]["DSH_HOME"] != "/home/desktop-secrets"
    assert "desktop-secrets" not in call["env"]["DSH_HOME"]
    again = adapter.dispatch(_request(task_id="task_next", session_id="session-abc", objective="continue"))
    assert again.session_id == "session-abc"
    assert runner.calls[1]["argv"] == [
        "/opt/dsh/dsh",
        "--profile",
        "headless",
        "--json",
        "--session-id",
        "session-abc",
        "-",
    ]
    assert Path(runner.calls[1]["cwd"]) == tmp_path / "broadcast-cs"


def test_unknown_session_and_cwd_mismatch_do_not_spawn(tmp_path, monkeypatch):
    runner = RecordingRunner(ProcessResult(0, _stream(), b""))
    adapter = _adapter(tmp_path, runner, monkeypatch)
    with pytest.raises(AdapterError, match="unknown session"):
        adapter.dispatch(_request(session_id="session-missing"))
    adapter.dispatch(_request())
    adapter._sessions["session-abc"]["cwd"] = str(tmp_path / "auto-video")
    with pytest.raises(AdapterError, match="cwd"):
        adapter.dispatch(_request(task_id="task_other", session_id="session-abc"))
    assert len(runner.calls) == 1


def test_superagent_and_disabled_spawn_do_not_spawn(tmp_path, monkeypatch):
    from dataclasses import replace

    runner = RecordingRunner(ProcessResult(0, _stream(), b""))
    adapter = _adapter(tmp_path, runner, monkeypatch)
    with pytest.raises(AdapterError, match="superagent"):
        adapter.dispatch(_request(executor="superagent"))
    adapter.instance = replace(adapter.instance, spawn=False)
    with pytest.raises(AdapterError, match="disabled"):
        adapter.dispatch(_request())
    assert runner.calls == []


def test_unsafe_session_id_is_rejected_before_spawn():
    with pytest.raises(AdapterError):
        build_argv("/opt/dsh/dsh", "session-abc&calc")


def test_desktop_profile_config_is_rejected(tmp_path: Path):
    text = (ROOT / "examples" / "headless-cli.example.toml").read_text(encoding="utf-8")
    text = text.replace('executable = "C:/Tools/dsh.cmd"', 'profile = "desktop"\nexecutable = "C:/Tools/dsh.cmd"')
    path = tmp_path / "bridge.toml"
    path.write_text(text, encoding="utf-8")
    with pytest.raises(ConfigError, match="desktop"):
        load_config(path)


def test_example_headless_config_does_not_spawn():
    config = load_config(ROOT / "examples" / "headless-cli.example.toml")
    instance = config.instances["local-headless"]
    assert instance.spawn is False
    assert instance.workspaces["broadcast-cs"].cwd != instance.workspaces["auto-video"].cwd
    source = (ROOT / "src" / "dsh_control_bridge" / "windows_cmd.py").read_text(encoding="utf-8")
    assert "17300" not in source
    assert "49290" not in source
    assert "3082" not in source
    assert '"shell": False' in source


def test_cancel_waits_and_does_not_resume_early(tmp_path, monkeypatch):
    import threading

    class BlockingRunner:
        def __init__(self):
            self.started = threading.Event()
            self.released = threading.Event()
            self.cancel_finished = threading.Event()
            self.calls = 0

        def run(self, **kwargs):
            self.calls += 1
            self.started.set()
            assert self.released.wait(2)
            assert self.cancel_finished.is_set()
            return ProcessResult(1, _stream(error=True), b"")

        def cancel(self, task_id: str) -> bool:
            self.released.set()
            self.cancel_finished.set()
            return True

    runner = BlockingRunner()
    adapter = _adapter(tmp_path, runner, monkeypatch)
    error: list[BaseException] = []

    def work():
        try:
            adapter.dispatch(_request())
        except AdapterError as exc:
            error.append(exc)

    thread = threading.Thread(target=work)
    thread.start()
    assert runner.started.wait(2)
    result = adapter.cancel(
        CancelRequest(
            task_id="task_abc",
            instance_id="local-headless",
            workspace="broadcast-cs",
            executor="ordinary_session",
            session_id=None,
            ticket_id=None,
            run_id=None,
            reason="stop",
        )
    )
    thread.join(2)
    assert result.confirmed
    assert error
    assert runner.calls == 1
