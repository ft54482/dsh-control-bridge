"""Command-line planning and real-process tree control. No dsh and no network."""

from __future__ import annotations

import os
import stat
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

from dsh_control_bridge.adapters.headless_cli import SubprocessRunner, build_argv, interpret_run
from dsh_control_bridge.errors import AdapterError
from dsh_control_bridge.windows_cmd import plan_launch, terminate_tree, unquoted_operators
from dsh_control_bridge.windows_selfcheck import (
    assert_table_sane,
    checks_passed,
    classify_finished,
    creation_token,
    descendant_pids,
    fake_child_env,
    format_report,
    malicious_rejection_check,
    owned_descendants,
    windows_fake_self_check,
)


def test_spaced_executable_stays_one_quoted_token():
    path = r"C:\Program Files\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
    plan = plan_launch(build_argv(path, None))
    rendered = str(plan["command_line"])
    assert rendered.startswith('"C:\\Program Files\\DeepSeek Harness\\')
    assert rendered.endswith("--profile headless --json -")
    assert "run the checks" not in rendered
    assert unquoted_operators(rendered) == ""
    assert plan["shell"] is False
    assert plan["os_may_route_batch_through_cmd"] is True


def test_malicious_session_id_and_executable_never_reach_a_command_line():
    with pytest.raises(AdapterError):
        build_argv(r"C:\Tools\dsh.cmd", "session-abc&calc.exe")
    with pytest.raises(AdapterError):
        build_argv(r"C:\Tools\dsh.cmd", "session-%COMSPEC%")
    with pytest.raises(AdapterError):
        plan_launch([r"C:\Tools\a&b\dsh.cmd", "--profile", "headless", "--json", "-"])
    with pytest.raises(AdapterError):
        plan_launch([r"C:\Tools\dsh.cmd", "--profile", "headless & calc", "--json", "-"])


def test_timeout_kills_a_real_process_and_does_not_accept_a_final(tmp_path: Path):
    script = tmp_path / "sleep.py"
    script.write_text("import time\ntime.sleep(30)\n", encoding="utf-8")
    runner = SubprocessRunner()
    with pytest.raises(AdapterError, match="no accepted final"):
        runner.run(
            task_id="task_timeout",
            argv=["python3", str(script)],
            cwd=str(tmp_path),
            env={"PATH": os.environ.get("PATH", "")},
            stdin=b"ignored\n",
            timeout=1,
        )


def test_cancel_reaps_the_process_tree(tmp_path: Path):
    if os.name != "posix":
        pytest.skip("process-group kill is exercised on POSIX; Windows uses taskkill /T")
    script = tmp_path / "tree.py"
    child_pid = tmp_path / "child.pid"
    script.write_text(
        textwrap.dedent(
            f"""
            import os, pathlib, time
            child = os.fork()
            if child == 0:
                time.sleep(30)
                os._exit(0)
            pathlib.Path({str(child_pid)!r}).write_text(str(child))
            time.sleep(30)
            """
        ),
        encoding="utf-8",
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    runner = SubprocessRunner()
    import threading

    def work():
        try:
            runner.run(
                task_id="task_tree",
                argv=["python3", str(script)],
                cwd=str(tmp_path),
                env={"PATH": os.environ.get("PATH", "")},
                stdin=b"",
                timeout=20,
            )
        except Exception:
            return

    thread = threading.Thread(target=work)
    thread.start()
    for _ in range(50):
        if child_pid.exists():
            break
        time.sleep(0.05)
    assert child_pid.exists()
    grandchild = int(child_pid.read_text(encoding="utf-8"))
    live = runner.live_pid("task_tree")
    assert live is not None and live > 4 and live != os.getpid()
    assert runner.cancel("task_tree") is True
    thread.join(5)
    assert not thread.is_alive()
    for _ in range(20):
        try:
            os.kill(grandchild, 0)
        except ProcessLookupError:
            return
        time.sleep(0.05)
    pytest.fail("descendant process was still alive after cancel")


def test_fake_cmd_self_check_is_not_executed_here():
    report = windows_fake_self_check()
    if os.name == "nt":
        assert report["ran"] is True
        assert report["ok"] is True
        text = format_report(report)
        assert "not a business success" in text
    else:
        assert report["ran"] is False
        assert report["ok"] is False
        reason = str(report["reason"])
        assert "not Windows" in reason
        assert "timeout" in reason
        assert "cancel" in reason


_SUCCESS = (
    b'{"type":"session","sessionId":"session-fake"}\n'
    b'{"type":"status","text":"fake"}\n'
    b'{"type":"final","sessionId":"session-fake","reason":{"kind":"completed"},"text":"fake-no-model"}\n'
)
_NOFINAL = b'{"type":"session","sessionId":"session-fake"}\n'
_BADEXIT = (
    b'{"type":"session","sessionId":"session-fake"}\n'
    b'{"type":"final","sessionId":"session-fake","reason":{"kind":"completed"},"text":"fake-no-model"}\n'
)


def test_nofinal_and_badexit_are_rejections_not_business_success():
    success = classify_finished("success", _SUCCESS, 0)
    nofinal = classify_finished("nofinal", _NOFINAL, 0)
    badexit = classify_finished("badexit", _BADEXIT, 1)
    assert success["business_accepted"] is True
    assert success["outcome"] == "accepted"
    assert nofinal["ok"] is True
    assert nofinal["business_accepted"] is False
    assert nofinal["outcome"] == "rejected"
    assert nofinal["detail"] == "missing final event"
    assert badexit["ok"] is True
    assert badexit["business_accepted"] is False
    assert badexit["detail"] == "exit 1 is not success"
    partial = interpret_run(_NOFINAL, 1)
    assert partial.ok is False


def test_three_checks_do_not_count_as_the_full_self_check():
    partial = [
        {"mode": "success", "ok": True, "business_accepted": True},
        {"mode": "nofinal", "ok": True, "business_accepted": False},
        {"mode": "badexit", "ok": True, "business_accepted": False},
    ]
    assert checks_passed(partial) is False
    full = [
        {"mode": mode, "ok": True, "business_accepted": mode == "success"}
        for mode in ("success", "nofinal", "badexit", "timeout", "cancel", "malicious")
    ]
    assert checks_passed(full) is True
    wrongly_accepted = [dict(item) for item in full]
    wrongly_accepted[1]["business_accepted"] = True
    assert checks_passed(wrongly_accepted) is False


def test_report_names_rejections_as_not_business_success():
    report = {
        "ran": True,
        "ok": True,
        "python": "C:/Python312/python.exe",
        "python_version": "3.12.14",
        "checks": [
            {"mode": "success", "outcome": "accepted", "business_accepted": True, "ok": True, "detail": "completed"},
            {
                "mode": "nofinal",
                "outcome": "rejected",
                "business_accepted": False,
                "ok": True,
                "detail": "missing final event",
            },
        ],
    }
    text = format_report(report)
    assert "nofinal: rejected business_accepted=False" in text
    assert "not a business success" in text
    assert "only the success check is a business success" in text


def test_descendant_pids_ignore_unrelated_processes():
    parents = {10: 1, 11: 10, 12: 11, 20: 1, 21: 20}
    assert descendant_pids(parents, 10) == [11, 12]
    assert 21 not in descendant_pids(parents, 10)
    assert 1 not in descendant_pids(parents, 10)
    assert descendant_pids(parents, 0) == []
    assert descendant_pids(parents, 4) == []
    assert descendant_pids(parents, -3) == []


def test_table_sanity_refuses_a_snapshot_that_is_not_this_interpreter():
    assert_table_sane({os.getpid(): (os.getppid(), "python"), 20: (1, "other")}, os.getpid())
    with pytest.raises(OSError):
        assert_table_sane({123: (1, "explorer.exe")}, 123)
    with pytest.raises(OSError):
        assert_table_sane({1: (0, "init")}, 1)


def test_owned_descendants_include_only_the_spawned_tree(tmp_path: Path):
    if os.name == "nt":
        pytest.skip("the /proc walker is the POSIX half of the same filter")
    script = tmp_path / "child.py"
    child_pid = tmp_path / "child.pid"
    script.write_text(
        textwrap.dedent(
            f"""
            import os, pathlib, time
            child = os.fork()
            if child == 0:
                time.sleep(30)
                os._exit(0)
            pathlib.Path({str(child_pid)!r}).write_text(str(child))
            time.sleep(30)
            """
        ),
        encoding="utf-8",
    )
    other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], start_new_session=True)
    process = subprocess.Popen([sys.executable, str(script)], start_new_session=True)
    try:
        for _ in range(50):
            if child_pid.exists():
                break
            time.sleep(0.05)
        assert child_pid.exists()
        grandchild = int(child_pid.read_text(encoding="utf-8"))
        records = owned_descendants(process.pid)
        found = {int(item["pid"]) for item in records}
        assert grandchild in found
        assert other.pid not in found
        assert 1 not in found
        assert process.pid not in found
    finally:
        if process.pid > 4:
            terminate_tree(process.pid)
        if other.pid > 4:
            terminate_tree(other.pid)
        process.wait(timeout=5)
        other.wait(timeout=5)


def test_malicious_argv_is_rejected_without_a_side_effect(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    def boom(*_args, **_kwargs):
        raise AssertionError("malicious check spawned a process")

    monkeypatch.setattr(subprocess, "Popen", boom)
    monkeypatch.setattr(subprocess, "run", boom)
    executable = tmp_path / "tools with spaces" / "fake-dsh.cmd"
    report = malicious_rejection_check(tmp_path, executable)
    assert report["ok"] is True
    assert report["business_accepted"] is False
    assert report["outcome"] == "rejected"
    assert report["spawned"] is False
    assert report["side_effect"] is False
    assert not (tmp_path / "side-effect.txt").exists()


def test_fake_child_env_drops_desktop_credentials(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-should-not-pass")
    monkeypatch.setenv("DEEPSEEK_BASE_URL", "https://example.invalid")
    monkeypatch.setenv("DSH_HOME", "/desktop/home")
    monkeypatch.setenv("LOCALAPPDATA", r"C:\Users\someone\AppData\Local")
    monkeypatch.setenv("APPDATA", r"C:\Users\someone\AppData\Roaming")
    monkeypatch.setenv("PATH", "/usr/bin")
    env = fake_child_env("hang")
    assert env["DSH_FAKE_MODE"] == "hang"
    assert env["PATH"] == "/usr/bin"
    assert "DEEPSEEK_API_KEY" not in env
    assert "DEEPSEEK_BASE_URL" not in env
    assert "DSH_HOME" not in env
    assert "LOCALAPPDATA" not in env
    assert "APPDATA" not in env


def test_creation_token_identifies_only_the_spawned_process():
    if os.name == "nt":
        pytest.skip("POSIX start-time token; Windows GetProcessTimes is still untested here")
    with pytest.raises(OSError):
        creation_token(1)
    process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], start_new_session=True)
    try:
        first = creation_token(process.pid)
        second = creation_token(process.pid)
        assert isinstance(first, int) and first == second and first > 0
    finally:
        if process.pid > 4:
            terminate_tree(process.pid)
        process.wait(timeout=5)
    later = creation_token(process.pid)
    assert later is None or later != first


def test_terminate_tree_does_not_signal_system_pids(monkeypatch: pytest.MonkeyPatch):
    calls: list[object] = []
    monkeypatch.setattr(os, "killpg", lambda *args: calls.append(args))
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: calls.append(args))
    for pid in (0, 1, 4, -8):
        terminate_tree(pid)
    assert calls == []


def test_windows_scripts_do_not_pip_or_write_localappdata():
    root = Path(__file__).resolve().parents[1] / "scripts" / "windows"
    install = (root / "Install-DshBridge.ps1").read_text(encoding="utf-8")
    tester = (root / "Test-FakeDsh.ps1").read_text(encoding="utf-8")
    starter = (root / "Start-DshBridge.ps1").read_text(encoding="utf-8")
    for text in (install, tester, starter):
        assert "$env:LOCALAPPDATA" not in text
        assert "SetEnvironmentVariable" not in text
        assert "pip" not in text.lower()
        assert "PythonExe" in text
    assert "Destination" in install
    assert "venv" not in install.lower()
    assert "Copy-Item" not in install
    assert "persistent PATH" in tester
    assert "dsh.cmd" not in starter
