"""Command-line planning and real-process tree control. No dsh and no network."""

from __future__ import annotations

import os
import stat
import textwrap
import time
from pathlib import Path

import pytest

from dsh_control_bridge.adapters.headless_cli import SubprocessRunner, build_argv
from dsh_control_bridge.errors import AdapterError
from dsh_control_bridge.windows_cmd import plan_launch, unquoted_operators
from dsh_control_bridge.windows_selfcheck import windows_fake_self_check


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
    else:
        assert report["ran"] is False
        assert "not Windows" in str(report["reason"])
