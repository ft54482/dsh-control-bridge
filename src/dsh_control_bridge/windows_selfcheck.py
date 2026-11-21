"""Windows-only fake dsh.cmd self-check. No model call.

On any other operating system this returns ran=false. That is not a pass of
the .cmd file; the PowerShell script is what runs it on Windows.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def windows_fake_self_check(repo_root: Path | None = None) -> dict[str, object]:
    if os.name != "nt":
        return {
            "ran": False,
            "reason": "not Windows; fake-dsh.cmd was not executed in this environment",
        }
    root = repo_root or Path(__file__).resolve().parents[2]
    source = root / "scripts" / "windows" / "fake-dsh.cmd"
    if not source.is_file():
        return {"ran": False, "reason": "fake-dsh.cmd is missing"}
    with tempfile.TemporaryDirectory(prefix="dsh-fake-") as temporary:
        spaced = Path(temporary) / "tools with spaces"
        spaced.mkdir()
        executable = spaced / "fake-dsh.cmd"
        shutil.copyfile(source, executable)
        checks = [
            _run(executable, "success", b"run the checks & calc\n", 0),
            _run(executable, "nofinal", b"task\n", 0),
            _run(executable, "badexit", b"task\n", 1),
        ]
    failed = [item for item in checks if not item["ok"]]
    return {"ran": True, "checks": checks, "ok": not failed}


def _run(executable: Path, mode: str, stdin: bytes, expect: int) -> dict[str, object]:
    env = os.environ.copy()
    env["DSH_FAKE_MODE"] = mode
    completed = subprocess.run(
        [str(executable), "--profile", "headless", "--json", "-"],
        input=stdin,
        capture_output=True,
        env=env,
        shell=False,
        timeout=15,
        check=False,
    )
    text = completed.stdout.decode("utf-8", errors="replace")
    has_final = '"type":"final"' in text or '"type": "final"' in text
    ok = completed.returncode == expect
    if mode == "success":
        ok = ok and has_final and "completed" in text and b"&" not in completed.stdout
    if mode == "nofinal":
        ok = ok and not has_final
    if mode == "badexit":
        ok = ok and has_final and completed.returncode != 0
    return {"mode": mode, "returncode": completed.returncode, "ok": ok}


if __name__ == "__main__":
    report = windows_fake_self_check()
    if report.get("ran") is not True:
        print(report["reason"])
        sys.exit(0)
    if report.get("ok") is not True:
        print(report)
        sys.exit(1)
    print("windows fake-dsh self-check: ok")
