"""Behaviour test for the skill launcher against the upstream control plane. Loopback only.

    python tests/serve_test.py <checkout> <scratch-dir>

<checkout> is a dsh-control-bridge git checkout; <scratch-dir> receives the bridge's SQLite data.
The test starts `serve` in a child process and terminates it in `finally`. Exit code 0 means every
check passed. Run it again after moving the checkout to another version.
"""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

LAUNCHER = Path(__file__).resolve().parents[1] / "dsh-bridge.py"
LOCAL_SECRET, LAB_SECRET = "skill-test-local-secret", "skill-test-lab-secret"
env = {**os.environ, "DSH_LOCAL_DESKTOP_EVENT_SECRET": LOCAL_SECRET, "DSH_LAB_SERVER_EVENT_SECRET": LAB_SECRET,
       "PYTHONUTF8": "1"}


def check(label, condition, detail=""):
    print(("PASS  " if condition else "FAIL  ") + label + (f"  [{detail}]" if detail and not condition else ""))
    return bool(condition)


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def main() -> int:
    checkout, scratch = Path(sys.argv[1]), Path(sys.argv[2])
    scratch.mkdir(parents=True, exist_ok=True)
    port = free_port()
    base = [sys.executable, str(LAUNCHER), "--repo", str(checkout),
            "--config", str(checkout / "examples" / "config.example.toml"), "--data-dir", str(scratch / "data")]

    def bridge(*args, stdin=None):
        return subprocess.run(base + list(args), input=stdin, capture_output=True, env=env)

    def wait_port(timeout=20):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=1):
                    return True
            except OSError:
                time.sleep(0.2)
        return False

    def post(headers, body):
        request = urllib.request.Request(f"http://127.0.0.1:{port}/v1/events", data=body, method="POST",
                                         headers={"Content-Type": "application/json", **headers})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            raw = error.read()
            try:
                return error.code, json.loads(raw)
            except ValueError:
                return error.code, {"raw": raw[:120].decode("utf-8", "replace")}

    def signed(body, secret):
        out = subprocess.run(base + ["sign", "--instance", "local-desktop"], input=body, capture_output=True,
                             env={**env, "DSH_LOCAL_DESKTOP_EVENT_SECRET": secret})
        return dict(line.split(": ", 1) for line in out.stdout.decode().splitlines() if ": " in line)

    ok = check("launcher prints the upstream version",
               re.fullmatch(r"dsh-bridge \d+\.\d+\.\d+", bridge("--version").stdout.decode().strip()) is not None)
    server = subprocess.Popen(base + ["serve", "--port", str(port)], stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, env=env)
    try:
        ok &= check("serve listens on loopback", wait_port())
        draft = bridge("--json", "dispatch", "--instance", "local-desktop", "--workspace", "broadcast-cs",
                       "--executor", "ordinary_session", "--title", "入口测试", "--objective", "走 HTTP 入口。")
        task = json.loads(draft.stdout)["task_id"]
        ok &= check("a draft does not send", json.loads(draft.stdout).get("delivery") == "drafted")
        ok &= check("send without a mandate is refused", bridge("dispatch", "--task", task, "--mode", "send").returncode == 2)
        sent = bridge("--json", "dispatch", "--task", task, "--mode", "send",
                      "--mandate", str(checkout / "examples" / "mandate.example.toml"))
        ok &= check("send with a mandate starts the task", json.loads(sent.stdout).get("status") == "running")

        body = json.dumps({"event_id": f"evt_skill_{os.urandom(6).hex()}", "event_type": "stage_submitted",
                           "instance_id": "local-desktop", "workspace": "broadcast-cs",
                           "executor": "ordinary_session", "task_id": task,
                           "evidence": ["evidence/serve.txt"]}).encode()
        status, payload = post(signed(body, LOCAL_SECRET), body)
        ok &= check("a signed event is applied (HTTP 202)",
                    status == 202 and payload.get("applied") is True and payload.get("status") == "awaiting_review",
                    f"{status} {payload}")
        status, payload = post(signed(body, LOCAL_SECRET), body)
        ok &= check("a replayed event_id is a duplicate, not a second transition",
                    payload.get("duplicate") is True and payload.get("applied") is False, str(payload))

        rejected = [
            ("an unsigned request", {}, body),
            ("a body changed after signing", signed(body, LOCAL_SECRET), body.replace(b"evidence/serve.txt", b"evidence/other.txt")),
        ]
        wrong = signed(body, LAB_SECRET)
        wrong["X-DSH-Instance"] = "local-desktop"
        rejected.append(("another instance's secret", wrong, body))
        for label, headers, payload_body in rejected:
            status, payload = post(headers, payload_body)
            ok &= check(f"{label} is rejected with 401", status == 401 and not payload.get("applied"), f"{status} {payload}")

        final = bridge("--json", "status", task)
        ok &= check("the task rests in awaiting_review until a person accepts it",
                    json.loads(final.stdout)["task"]["status"] == "awaiting_review")
        accepted = bridge("--json", "accept", task)
        ok &= check("accept moves it to done", json.loads(accepted.stdout).get("status") == "done")
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=10)
    ok &= check("the serve process has exited", server.poll() is not None)
    print("RESULT:", "ALL PASS" if ok else "SOMETHING FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
