"""Windows fake-dsh self-check. No model call and no real dsh.

On any other operating system this returns ran=false. That is not a pass of
the .cmd file. The PowerShell script is what runs it on Windows.

``success`` is the only business success. ``nofinal``, ``badexit``, timeout,
and cancel are reported as rejections even when the check itself passed.
Process signals go only to a pid this check created. Snapshot pids are used
to confirm those processes exited; they are not a license to scan-and-kill.
"""

from __future__ import annotations

import ctypes
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from ctypes import wintypes
from pathlib import Path

from dsh_control_bridge.adapters.headless_cli import (
    ProcessResult,
    SubprocessRunner,
    build_argv,
    interpret_run,
)
from dsh_control_bridge.errors import AdapterError
from dsh_control_bridge.windows_cmd import plan_launch, popen_kwargs, terminate_tree

REQUIRED_MODES = ("success", "nofinal", "badexit", "timeout", "cancel", "malicious")
_CHILD_ENV = ("PATH", "PATHEXT", "SYSTEMROOT", "COMSPEC", "WINDIR", "TEMP", "TMP", "SYSTEMDRIVE")
_NOT_WINDOWS = (
    "not Windows; fake-dsh.cmd was not executed in this environment. "
    "success, nofinal, badexit, timeout, cancel, and the process tree were not run."
)


def fake_child_env(mode: str) -> dict[str, str]:
    """Environment for fake-dsh only. Desktop credentials and DSH_HOME stay out."""

    env: dict[str, str] = {}
    for name in _CHILD_ENV:
        value = os.environ.get(name)
        if value:
            env[name] = value
    env["DSH_FAKE_MODE"] = mode
    return env


def classify_finished(mode: str, stdout: bytes, returncode: int) -> dict[str, object]:
    """Turn one finished fake process into an explicit accept or reject."""

    interpreted = interpret_run(stdout, returncode)
    if mode == "success":
        accepted = interpreted.ok and interpreted.detail == "completed"
        return {
            "mode": mode,
            "outcome": "accepted" if accepted else "rejected",
            "business_accepted": accepted,
            "ok": accepted,
            "returncode": returncode,
            "detail": interpreted.detail,
        }
    if mode == "nofinal":
        expected = "missing final event"
    elif mode == "badexit":
        expected = f"exit {returncode} is not success"
    else:
        raise ValueError(mode)
    if interpreted.ok:
        return {
            "mode": mode,
            "outcome": "accepted",
            "business_accepted": True,
            "ok": False,
            "returncode": returncode,
            "detail": interpreted.detail,
            "note": "not a business success",
        }
    rejected = interpreted.detail == expected
    return {
        "mode": mode,
        "outcome": "rejected",
        "business_accepted": False,
        "ok": rejected,
        "returncode": returncode,
        "detail": interpreted.detail,
        "note": "not a business success",
    }


def descendant_pids(parents: dict[int, int], root: int) -> list[int]:
    """Pids whose parent chain reaches ``root``, excluding ``root`` and pid <= 4."""

    if root <= 4:
        return []
    children: dict[int, list[int]] = {}
    for pid, parent in parents.items():
        if pid <= 4 or pid == root:
            continue
        children.setdefault(parent, []).append(pid)
    found: list[int] = []
    seen = {root}
    stack = [root]
    while stack:
        current = stack.pop()
        for child in children.get(current, []):
            if child in seen:
                continue
            seen.add(child)
            found.append(child)
            stack.append(child)
    return sorted(found)


def assert_table_sane(table: dict[int, tuple[int, str]], pid: int) -> None:
    """Reject a snapshot that does not even contain this interpreter."""

    if pid <= 4 or pid not in table or len(table) < 2:
        raise OSError("process table failed a sanity check")
    _parent, name = table[pid]
    lowered = name.lower()
    if "python" not in lowered and "pytest" not in lowered:
        raise OSError("process table did not name this interpreter")


def creation_token(pid: int) -> int | None:
    """Creation token for one pid, or None when that process is gone.

    A later pid with a different token is a reuse. Callers must not signal it.
    """

    if pid <= 4:
        raise OSError("refusing to query a system pid")
    if os.name == "nt":
        return _windows_creation_token(pid)
    return _posix_creation_token(pid)


def process_table() -> dict[int, tuple[int, str]]:
    """Read-only pid -> (parent pid, image name). Does not signal any process."""

    if os.name == "nt":
        return _windows_table()
    return _posix_table()


def owned_descendants(root: int) -> list[dict[str, object]]:
    """Descendants of a pid this process created. Read-only."""

    if root <= 4:
        raise OSError("refusing to inspect a system pid")
    table = process_table()
    assert_table_sane(table, os.getpid())
    if root not in table:
        raise OSError("test pid is not in the process table")
    parents = {pid: parent for pid, (parent, _name) in table.items()}
    found = descendant_pids(parents, root)
    if root in found:
        raise OSError("descendant walk included the test root")
    return [{"pid": pid, "name": table[pid][1]} for pid in found]


def checks_passed(checks: list[dict[str, object]]) -> bool:
    """A full pass needs every required mode, and only success is accepted."""

    if [item.get("mode") for item in checks] != list(REQUIRED_MODES):
        return False
    accepted = {item["mode"] for item in checks if item.get("business_accepted") is True}
    return all(item.get("ok") is True for item in checks) and accepted == {"success"}


def malicious_rejection_check(workdir: Path, executable: Path) -> dict[str, object]:
    """Reject hostile argv before any spawn. The sentinel file must stay absent."""

    sentinel = workdir / "side-effect.txt"
    attempts = (
        lambda: build_argv(str(executable), "session-abc&calc.exe"),
        lambda: build_argv(str(executable), "session-%COMSPEC%"),
        lambda: plan_launch([str(executable) + "&calc.exe", "--profile", "headless", "--json", "-"]),
        lambda: plan_launch([str(executable), "--profile", "headless&calc", "--json", "-"]),
        lambda: plan_launch([str(executable), "--session-id", "bad id", "--json", "-"]),
    )
    rejected = 0
    for attempt in attempts:
        try:
            attempt()
        except AdapterError:
            rejected += 1
    return {
        "mode": "malicious",
        "outcome": "rejected",
        "business_accepted": False,
        "ok": rejected == len(attempts) and not sentinel.exists(),
        "rejected": rejected,
        "attempted": len(attempts),
        "side_effect": sentinel.exists(),
        "spawned": False,
        "detail": "malicious session and path rejected before spawn",
        "note": "not a business success",
    }


def format_report(report: dict[str, object]) -> str:
    if report.get("ran") is not True:
        return str(report.get("reason", "not run"))
    lines = [
        f"python={report.get('python')} version={report.get('python_version')}",
        "spawn=false real_dsh=false model_request=false",
        "business success requires exit 0 and final.reason.kind=completed.",
    ]
    checks = report.get("checks")
    if isinstance(checks, list):
        for item in checks:
            if not isinstance(item, dict):
                continue
            suffix = ""
            if item.get("mode") != "success":
                suffix = " — not a business success"
            children = item.get("child_pids")
            extra = ""
            if children is not None:
                extra = f" root={item.get('root_pid')} children={children} still_alive={item.get('still_alive')}"
            if item.get("mode") == "malicious":
                extra = f" side_effect={item.get('side_effect')} spawned={item.get('spawned')}"
            lines.append(
                f"{item.get('mode')}: {item.get('outcome')} "
                f"business_accepted={item.get('business_accepted')} "
                f"check_ok={item.get('ok')} detail={item.get('detail')}{extra}{suffix}"
            )
    lines.append("self-check passed" if report.get("ok") is True else "self-check failed")
    lines.append("only the success check is a business success")
    lines.append("report_json=" + json.dumps(report, sort_keys=True, default=str))
    return "\n".join(lines)


def windows_fake_self_check(repo_root: Path | None = None) -> dict[str, object]:
    if os.name != "nt":
        return {"ran": False, "reason": _NOT_WINDOWS, "ok": False}
    root = repo_root or Path(__file__).resolve().parents[2]
    source = root / "scripts" / "windows" / "fake-dsh.cmd"
    if not source.is_file():
        return {"ran": False, "reason": "fake-dsh.cmd is missing", "ok": False}
    with tempfile.TemporaryDirectory(prefix="dsh-fake-") as temporary:
        workdir = Path(temporary)
        spaced = workdir / "tools with spaces"
        spaced.mkdir()
        executable = spaced / "fake-dsh.cmd"
        shutil.copyfile(source, executable)
        sentinel = workdir / "side-effect.txt"
        stdin = f"run the checks & echo pwned> {sentinel}\n".encode()
        checks = [
            _run_finished(executable, "success", stdin, workdir, sentinel),
            _run_finished(executable, "nofinal", stdin, workdir, sentinel),
            _run_finished(executable, "badexit", stdin, workdir, sentinel),
            _exercise_controlled(executable, "hang", workdir, timeout=8, cancel=False),
            _exercise_controlled(executable, "tree", workdir, timeout=20, cancel=True),
            malicious_rejection_check(workdir, executable),
        ]
    report: dict[str, object] = {
        "ran": True,
        "ok": checks_passed(checks),
        "checks": checks,
        "python": sys.executable,
        "python_version": ".".join(str(part) for part in sys.version_info[:3]),
        "spawn": False,
        "real_dsh": False,
        "model_request": False,
        "path_has_space": True,
        "executable_name": executable.name,
    }
    return report


def _run_finished(
    executable: Path,
    mode: str,
    stdin: bytes,
    workdir: Path,
    sentinel: Path,
) -> dict[str, object]:
    argv = [str(executable), "--profile", "headless", "--json", "-"]
    plan = plan_launch(argv)
    command = str(plan["command_line"])
    if plan["shell"] is not False or "&" in command or "pwned" in command:
        return _failed(mode, "launch plan is not safe")
    process = subprocess.Popen(
        argv,
        cwd=str(workdir),
        env=fake_child_env(mode),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        **popen_kwargs(),
    )
    root = int(process.pid)
    try:
        stdout, stderr = process.communicate(stdin, timeout=15)
    except subprocess.TimeoutExpired:
        if root > 4:
            terminate_tree(root)
        process.wait(timeout=5)
        return _failed(mode, "finished-mode process exceeded 15s", root=root)
    item = classify_finished(mode, stdout, int(process.returncode))
    leaked = sentinel.exists() or b"pwned" in stdout or b"pwned" in stderr
    item["side_effect"] = leaked
    item["root_pid"] = root
    if leaked:
        item["ok"] = False
        item["business_accepted"] = False
        item["detail"] = "task metacharacters produced a side effect"
    return item


def _exercise_controlled(
    executable: Path,
    fake_mode: str,
    workdir: Path,
    *,
    timeout: int,
    cancel: bool,
) -> dict[str, object]:
    mode = "cancel" if cancel else "timeout"
    argv = [str(executable), "--profile", "headless", "--json", "-"]
    try:
        plan_launch(argv)
    except AdapterError as exc:
        return _failed(mode, str(exc))
    runner = SubprocessRunner()
    task_id = f"selfcheck-{mode}"
    holder: dict[str, object] = {}
    observed: dict[str, object] = {"root": None, "root_name": "", "children": []}

    def invoke() -> None:
        try:
            holder["result"] = runner.run(
                task_id=task_id,
                argv=argv,
                cwd=str(workdir),
                env=fake_child_env(fake_mode),
                stdin=b"self-check\n",
                timeout=timeout,
            )
        except AdapterError as exc:
            holder["error"] = str(exc)

    worker = threading.Thread(target=invoke)
    worker.start()
    deadline = time.monotonic() + min(timeout, 10)
    while time.monotonic() < deadline and not observed["children"]:
        pid = runner.live_pid(task_id)
        if pid and pid > 4:
            observed["root"] = pid
            try:
                table = process_table()
                assert_table_sane(table, os.getpid())
                observed["root_name"] = table.get(pid, (0, ""))[1]
                observed["root_token"] = creation_token(pid)
                observed["children"] = _stamped(owned_descendants(pid))
            except OSError as exc:
                holder["table_error"] = str(exc)
        time.sleep(0.05)
    cancel_ok = None
    if cancel and isinstance(observed["root"], int):
        cancel_ok = runner.cancel(task_id)
    worker.join(timeout + 12)
    if worker.is_alive():
        pid = runner.live_pid(task_id)
        if isinstance(pid, int) and pid > 4:
            runner.cancel(task_id)
        worker.join(5)
    root = observed["root"] if isinstance(observed["root"], int) else None
    children = [item for item in observed["children"] if isinstance(item, dict)]
    still = _still_same_processes(root, observed.get("root_token"), children)
    if still:
        _reap_same_processes(root, observed.get("root_token"), children)
        deadline = time.monotonic() + 2
        while still and time.monotonic() < deadline:
            time.sleep(0.05)
            still = _still_same_processes(root, observed.get("root_token"), children)
    error = holder.get("error")
    result = holder.get("result")
    business = False
    detail = str(holder.get("table_error") or "")
    if isinstance(result, ProcessResult):
        interpreted = interpret_run(result.stdout, result.returncode)
        business = interpreted.ok
        detail = interpreted.detail
    elif isinstance(error, str):
        detail = error
    elif not detail:
        detail = "process did not finish"
    child_pids = [int(item["pid"]) for item in children]
    base_ok = (
        root is not None
        and bool(children)
        and not still
        and not business
        and not worker.is_alive()
    )
    if business:
        ok = False
        outcome = "accepted"
    elif cancel:
        ok = base_ok and cancel_ok is True
        outcome = "cancelled"
    else:
        ok = (
            base_ok
            and result is None
            and isinstance(error, str)
            and "no accepted final" in error
        )
        outcome = "rejected"
    if ok and cancel:
        detail = f"cancelled; test process tree exited; {detail}"
    elif ok:
        detail = "timed out with no accepted final; test process tree exited"
    if not ok and "table_error" in holder and "process table" in detail:
        detail = str(holder["table_error"])
    return {
        "mode": mode,
        "fake_mode": fake_mode,
        "outcome": outcome,
        "business_accepted": business,
        "ok": bool(ok),
        "detail": detail,
        "note": "not a business success",
        "root_pid": root,
        "child_pids": child_pids,
        "child_names": [str(item.get("name")) for item in children],
        "still_alive": still,
        "cancel_confirmed": cancel_ok,
    }


def _stamped(records: list[dict[str, object]]) -> list[dict[str, object]]:
    stamped: list[dict[str, object]] = []
    for item in records:
        pid = int(item["pid"])
        if pid <= 4:
            continue
        stamped.append({**item, "token": creation_token(pid)})
    return stamped


def _identity(pid: object, token: object) -> str:
    if not isinstance(pid, int) or pid <= 4 or not isinstance(token, int):
        return "unknown"
    try:
        current = creation_token(pid)
    except OSError:
        return "unknown"
    if current is None:
        return "gone"
    if current == token:
        return "same"
    return "reused"


def _still_same_processes(root: int | None, root_token: object, children: list[dict[str, object]]) -> list[int]:
    alive: list[int] = []
    if isinstance(root_token, int) and _identity(root, root_token) in {"same", "unknown"}:
        alive.append(int(root))
    for item in children:
        if isinstance(item.get("token"), int) and _identity(item.get("pid"), item.get("token")) in {"same", "unknown"}:
            alive.append(int(item["pid"]))
    return alive


def _reap_same_processes(root: int | None, root_token: object, children: list[dict[str, object]]) -> None:
    """Signal a recorded pid only when its creation token still matches."""

    if _identity(root, root_token) == "same":
        terminate_tree(int(root))
        return
    for item in children:
        pid = item.get("pid")
        if _identity(pid, item.get("token")) == "same":
            terminate_tree(int(pid))


def _failed(mode: str, detail: str, root: int | None = None) -> dict[str, object]:
    return {
        "mode": mode,
        "outcome": "rejected" if mode != "success" else "not accepted",
        "business_accepted": False,
        "ok": False,
        "detail": detail,
        "note": "not a business success",
        "root_pid": root,
    }


def _posix_creation_token(pid: int) -> int | None:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    fields = stat[stat.rfind(")") + 2 :].split()
    try:
        return int(fields[19])
    except (IndexError, ValueError) as exc:
        raise OSError("process stat has no creation token") from exc


def _windows_creation_token(pid: int) -> int | None:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetProcessTimes.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
    ]
    kernel32.GetProcessTimes.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    handle = kernel32.OpenProcess(0x1000, False, pid)
    if not handle:
        if ctypes.get_last_error() == 5:
            raise OSError("cannot query process creation time")
        return None
    created = wintypes.FILETIME()
    exited = wintypes.FILETIME()
    kernel = wintypes.FILETIME()
    user = wintypes.FILETIME()
    try:
        if not kernel32.GetProcessTimes(
            handle,
            ctypes.byref(created),
            ctypes.byref(exited),
            ctypes.byref(kernel),
            ctypes.byref(user),
        ):
            raise OSError("GetProcessTimes failed")
        return (int(created.dwHighDateTime) << 32) | int(created.dwLowDateTime)
    finally:
        kernel32.CloseHandle(handle)


def _posix_table() -> dict[int, tuple[int, str]]:
    table: dict[int, tuple[int, str]] = {}
    proc = Path("/proc")
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / "stat").read_text(encoding="utf-8", errors="replace")
            open_paren = stat.find("(")
            close_paren = stat.rfind(")")
            fields = stat[close_paren + 2 :].split()
            parent = int(fields[1])
            name = stat[open_paren + 1 : close_paren]
        except (OSError, ValueError, IndexError):
            continue
        table[int(entry.name)] = (parent, name)
    return table


def _windows_table() -> dict[int, tuple[int, str]]:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", wintypes.LONG),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * 260),
        ]

    kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.Process32FirstW.restype = wintypes.BOOL
    kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.Process32NextW.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    snapshot = kernel32.CreateToolhelp32Snapshot(0x00000002, 0)
    invalid = ctypes.c_void_p(-1).value
    if not snapshot or snapshot == invalid:
        raise OSError("CreateToolhelp32Snapshot failed")
    entry = PROCESSENTRY32W()
    entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
    table: dict[int, tuple[int, str]] = {}
    try:
        ok = kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
        if not ok:
            raise OSError("Process32FirstW failed")
        while ok:
            table[int(entry.th32ProcessID)] = (int(entry.th32ParentProcessID), str(entry.szExeFile))
            ok = kernel32.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snapshot)
    return table


if __name__ == "__main__":
    report = windows_fake_self_check()
    print(format_report(report))
    if report.get("ran") is not True:
        sys.exit(0)
    sys.exit(0 if report.get("ok") is True else 1)
