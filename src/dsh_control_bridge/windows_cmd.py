"""Windows command-line checks for launching dsh.cmd.

CPython documents that a ``.cmd`` file may be started by the operating system
in a shell even when ``shell`` is false, and that Python then does not add
cmd.exe escaping. See the subprocess security notes and gh-114539.

The launch plan therefore keeps ``shell=False``, never places the task text in
argv, and refuses any argument that contains a cmd metacharacter. Spaces in
the executable path are allowed; ``subprocess.list2cmdline`` quotes that one
token. This module does not execute ``dsh.cmd``.
"""

from __future__ import annotations

import os
import signal
import subprocess
from pathlib import Path

from dsh_control_bridge.errors import AdapterError

# cmd.exe operators and expansions. ``%`` expands inside quotes as well.
_CMD_META = set("%&|<>^!\"\r\n")
_UNQUOTED_SPLIT = set("&|<>^")


def is_batch(executable: str) -> bool:
    return Path(executable).suffix.lower() in {".cmd", ".bat"}


def reject_cmd_metacharacters(value: str, label: str) -> None:
    found = sorted({char for char in value if char in _CMD_META})
    if found:
        raise AdapterError(f"{label} contains a cmd metacharacter and will not be passed to a batch file")


def command_line(argv: list[str]) -> str:
    """The string CreateProcess receives. Matches CPython's list2cmdline."""

    return subprocess.list2cmdline(argv)


def unquoted_operators(cmdline: str) -> str:
    """cmd.exe operators that sit outside double quotes, plus every percent sign."""

    quoted = False
    found: list[str] = []
    for char in cmdline:
        if char == '"':
            quoted = not quoted
            continue
        if char == "%":
            found.append(char)
        elif not quoted and char in _UNQUOTED_SPLIT:
            found.append(char)
    return "".join(found)


def plan_launch(argv: list[str]) -> dict[str, object]:
    """Validate argv and describe how it will be started. Does not spawn."""

    if not argv or not isinstance(argv[0], str) or not argv[0].strip():
        raise AdapterError("executable is required")
    reject_cmd_metacharacters(argv[0], "executable path")
    for index, arg in enumerate(argv[1:], start=1):
        if not isinstance(arg, str):
            raise AdapterError("arguments must be strings")
        reject_cmd_metacharacters(arg, f"argument {index}")
        if any(char.isspace() for char in arg):
            raise AdapterError(f"argument {index} contains whitespace and will not be passed to a batch file")
    rendered = command_line(argv)
    operators = unquoted_operators(rendered)
    if operators:
        raise AdapterError("planned command line still has an unquoted cmd operator")
    return {
        "argv": list(argv),
        "shell": False,
        "batch": is_batch(argv[0]),
        "os_may_route_batch_through_cmd": is_batch(argv[0]),
        "command_line": rendered,
        "task_in_argv": False,
    }


def popen_kwargs() -> dict[str, object]:
    """Process-group flags so cancel can reap the child and its descendants.

    On Windows also hide the child console: a CLI launched from the bridge must
    not flash a visible window (CREATE_NO_WINDOW), while the process group stays
    available for the documented ``taskkill /T`` cleanup.
    """

    if os.name == "nt":
        flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        return {"shell": False, "creationflags": flags}
    return {"shell": False, "start_new_session": True}


def terminate_tree(pid: int) -> None:
    """Signal pid and its descendants. The owner must wait for the exit.

    Windows uses documented ``taskkill /F /T``. POSIX signals the process
    group created with ``start_new_session``. This does not start dsh.

    ``pid`` must be a process the caller created. Values ``<= 4`` are ignored
    so this cannot target the idle or system process, or POSIX init.
    """

    if pid <= 4:
        return
    if os.name == "nt":
        system_root = os.environ.get("SystemRoot", r"C:\Windows")
        killer = str(Path(system_root) / "System32" / "taskkill.exe")
        subprocess.run(
            [killer, "/F", "/T", "/PID", str(pid)],
            shell=False,
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            return
