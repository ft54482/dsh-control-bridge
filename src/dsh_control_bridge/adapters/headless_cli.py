"""Headless CLI adapter for one ordinary task.

The invocation follows the published headless contract: ``dsh --profile headless
--json -`` with the task on stdin. The task text is never placed in argv.
``desktop`` is not a bootable profile. A run counts as success only when the
process exits 0 and the terminal ``final.reason.kind`` is ``completed``.

This module does not read credential files and does not call the SuperAgent
management port.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from dsh_control_bridge.adapters.base import CancelRequest, CancelResult, DispatchRequest, DispatchResult
from dsh_control_bridge.config import Instance
from dsh_control_bridge.errors import AdapterError
from dsh_control_bridge.windows_cmd import plan_launch, popen_kwargs, terminate_tree

_PROFILE = "headless"
_SAFE_ARG = re.compile(r"^[A-Za-z0-9_.:-]{1,200}$")
_BOOTSTRAP = (
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "COMSPEC",
    "WINDIR",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "LANG",
    "LC_ALL",
)


@dataclass(frozen=True)
class ProcessResult:
    returncode: int
    stdout: bytes
    stderr: bytes


class ProcessRunner(Protocol):
    def run(
        self,
        *,
        task_id: str,
        argv: list[str],
        cwd: str,
        env: dict[str, str],
        stdin: bytes,
        timeout: int,
    ) -> ProcessResult: ...

    def cancel(self, task_id: str) -> bool: ...


class SubprocessRunner:
    """Spawn with shell disabled. The task stays on stdin."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._live: dict[str, subprocess.Popen[bytes]] = {}

    def run(
        self,
        *,
        task_id: str,
        argv: list[str],
        cwd: str,
        env: dict[str, str],
        stdin: bytes,
        timeout: int,
    ) -> ProcessResult:
        process = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            **popen_kwargs(),
        )
        with self._lock:
            self._live[task_id] = process
        try:
            stdout, stderr = process.communicate(stdin, timeout=timeout)
        except subprocess.TimeoutExpired:
            terminate_tree(process.pid)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            raise AdapterError("headless process timed out with no accepted final") from None
        finally:
            with self._lock:
                self._live.pop(task_id, None)
        if process.poll() is None:
            raise AdapterError("headless process did not exit")
        return ProcessResult(process.returncode, stdout, stderr)

    def live_pid(self, task_id: str) -> int | None:
        """Pid of a process this runner started, or None when it is not live."""

        with self._lock:
            process = self._live.get(task_id)
        if process is None or process.poll() is not None:
            return None
        return int(process.pid)

    def cancel(self, task_id: str) -> bool:
        with self._lock:
            process = self._live.get(task_id)
        if process is None or process.poll() is not None:
            return False
        terminate_tree(process.pid)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            return False
        return process.poll() is not None


class HeadlessCliAdapter:
    supports_send = True
    probe_items = ()

    def __init__(
        self,
        instance: Instance,
        state_path: Path,
        *,
        runner: ProcessRunner | None = None,
        data_dir: Path | None = None,
    ):
        self.instance_id = instance.id
        self.instance = instance
        self.state_path = state_path
        self.runner = runner or SubprocessRunner()
        self.data_dir = data_dir
        self._sessions: dict[str, dict[str, str]] = {}
        self._by_task: dict[str, str] = {}
        self._load()

    def dispatch(self, request: DispatchRequest) -> DispatchResult:
        if request.instance_id != self.instance_id:
            raise AdapterError("headless adapter refused a different instance")
        if request.executor != "ordinary_session":
            raise AdapterError("headless CLI refuses superagent; that binding is not verified")
        if not self.instance.spawn:
            raise AdapterError("headless spawn is disabled")
        if not request.objective.strip():
            raise AdapterError("headless task text is empty")
        workspace = self.instance.workspaces[request.workspace]
        cwd = workspace.cwd
        session_id = request.session_id or self._by_task.get(request.task_id)
        if session_id:
            self._require_resumable(session_id, cwd)
        argv = build_argv(self.instance.executable, session_id)
        env = build_child_env(
            self.instance.credential_envs,
            dsh_home=self._dsh_home(),
        )
        result = self.runner.run(
            task_id=request.task_id,
            argv=argv,
            cwd=cwd,
            env=env,
            stdin=task_stdin(request.objective),
            timeout=self.instance.timeout_seconds,
        )
        interpreted = interpret_run(result.stdout, result.returncode)
        self._remember(request.task_id, interpreted.session_id, cwd)
        if not interpreted.ok:
            raise AdapterError(interpreted.detail)
        if not interpreted.session_id:
            raise AdapterError("headless run completed without a session id")
        return DispatchResult(acked=True, session_id=interpreted.session_id)

    def cancel(self, request: CancelRequest) -> CancelResult:
        if request.executor != "ordinary_session":
            return CancelResult(confirmed=False, detail="headless cancel does not apply to superagent")
        stopped = self.runner.cancel(request.task_id)
        if not stopped:
            return CancelResult(
                confirmed=False,
                detail="no live headless process; resume stays blocked until a process exit is observed",
            )
        return CancelResult(confirmed=True, detail="headless process exited before any resume")

    def _require_resumable(self, session_id: str, cwd: str) -> None:
        if not _SAFE_ARG.match(session_id):
            raise AdapterError("session id is not safe to pass as an argument")
        recorded = self._sessions.get(session_id)
        if recorded is None:
            raise AdapterError("unknown session id")
        if recorded.get("cwd") != cwd or recorded.get("profile") != _PROFILE:
            raise AdapterError("session cwd or profile does not match this workspace")

    def _remember(self, task_id: str, session_id: str | None, cwd: str) -> None:
        if not session_id or not _SAFE_ARG.match(session_id):
            return
        self._sessions[session_id] = {"cwd": cwd, "profile": _PROFILE}
        self._by_task[task_id] = session_id
        self._save()

    def _dsh_home(self) -> str:
        root = (self.data_dir or self.state_path.parent) / "dsh-home" / self.instance_id
        root.mkdir(parents=True, exist_ok=True)
        return str(root)

    def _load(self) -> None:
        if not self.state_path.is_file():
            return
        data = json.loads(self.state_path.read_text(encoding="utf-8"))
        sessions = data.get("sessions")
        tasks = data.get("tasks")
        if isinstance(sessions, dict):
            self._sessions = {str(key): dict(value) for key, value in sessions.items()}
        if isinstance(tasks, dict):
            self._by_task = {str(key): str(value) for key, value in tasks.items()}

    def _save(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"sessions": self._sessions, "tasks": self._by_task}
        temporary = self.state_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
        temporary.replace(self.state_path)


@dataclass(frozen=True)
class InterpretedRun:
    ok: bool
    session_id: str | None
    detail: str


def build_argv(executable: str, session_id: str | None) -> list[str]:
    argv = [executable, "--profile", _PROFILE, "--json"]
    if session_id:
        if not _SAFE_ARG.match(session_id):
            raise AdapterError("session id is not safe to pass as an argument")
        argv.extend(["--session-id", session_id])
    argv.append("-")
    plan_launch(argv)
    return argv


def task_stdin(objective: str) -> bytes:
    if "\x00" in objective:
        raise AdapterError("task text contains NUL")
    text = objective if objective.endswith("\n") else objective + "\n"
    return text.encode("utf-8")


def build_child_env(credential_envs: tuple[str, ...], *, dsh_home: str) -> dict[str, str]:
    env: dict[str, str] = {}
    for name in _BOOTSTRAP:
        value = os.environ.get(name)
        if value:
            env[name] = value
    for name in credential_envs:
        value = os.environ.get(name)
        if value:
            env[name] = value
    env["DSH_HOME"] = dsh_home
    return env


def interpret_run(stdout: bytes, returncode: int) -> InterpretedRun:
    events: list[dict] = []
    for line in stdout.splitlines():
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            return InterpretedRun(False, None, "headless stdout is not NDJSON")
        if isinstance(item, dict):
            events.append(item)
    session_id = None
    for event in events:
        if event.get("type") == "session" and isinstance(event.get("sessionId"), str):
            session_id = event["sessionId"]
            break
        if event.get("type") == "session" and isinstance(event.get("id"), str):
            session_id = event["id"]
            break
    final = next((event for event in reversed(events) if event.get("type") == "final"), None)
    errored = any(event.get("type") == "error" for event in events)
    reason = final.get("reason") if isinstance(final, dict) else None
    kind = reason.get("kind") if isinstance(reason, dict) else None
    if returncode == 0 and final is not None and kind == "completed" and not errored:
        return InterpretedRun(True, session_id, "completed")
    if errored and final is None:
        return InterpretedRun(False, session_id, "process error without final")
    if final is None:
        return InterpretedRun(False, session_id, "missing final event")
    if kind != "completed":
        return InterpretedRun(False, session_id, "final reason is not completed")
    return InterpretedRun(False, session_id, f"exit {returncode} is not success")
