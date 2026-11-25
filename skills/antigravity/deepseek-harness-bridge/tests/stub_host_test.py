"""Behaviour test for the Antigravity additions of this skill. Uses a stub Host on loopback and a dummy
secret: it never contacts the real Host and never reads the real credential.

    python tests/stub_host_test.py

Exit code 0 means every check passed. Run it again after replacing the upstream files or editing
scripts/send_brief.py, scripts/sessions_table.py.
"""

from __future__ import annotations

import http.server
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
DUMMY = "d" * 64
received: list[dict] = []
reply = {"status": 202, "body": {"ok": True, "accepted": True, "phase": "accepted", "completed": False}}


class Stub(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/v1/health":
            self._send(200, {"ok": True, "outbox_enabled": False})
        else:
            self._send(404, {"ok": False})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length).decode("utf-8"))
        received.append({"path": self.path, "auth_ok": self.headers.get("Authorization") == f"Bearer {DUMMY}",
                         "content_type": self.headers.get("Content-Type"), "body": body})
        self._send(reply["status"], reply["body"])


def check(label, condition, detail=""):
    print(("PASS  " if condition else "FAIL  ") + label + (f"  [{detail}]" if detail and not condition else ""))
    return bool(condition)


def main() -> int:
    ok = True
    with tempfile.TemporaryDirectory(prefix="dsh-bridge-skill-test-") as temporary:
        scratch = Path(temporary)
        (scratch / "dummy.secret").write_text(DUMMY, encoding="utf-8")
        port_file = scratch / "port"
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        port = server.server_address[1]
        port_file.write_text(str(port))
        env = {**os.environ, "DSH_BRIDGE_SECRET_FILE": str(scratch / "dummy.secret"), "PYTHONUTF8": "1"}

        def send(*args, stdin=None):
            return subprocess.run([sys.executable, str(SKILL / "scripts" / "send_brief.py"), *args, "--port", str(port)],
                                  input=stdin, capture_output=True, env=env)

        brief = (
            "# 任务：测试\n\n"
            "工作目录是 `D:\\new\\table\\u0394`，含 \"双引号\" 和 '单引号'。\n"
            "路径 C:\\Users\\name\\.dsh 不要读。\n\n"
            "第二段：emoji 🚀、制表符\t、JSON 花括号 {\"a\": 1}、反斜杠结尾 \\\n"
        )
        (scratch / "brief.md").write_bytes(brief.encode("utf-8"))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            result = send("--session", "session-test-1", "--brief", str(scratch / "brief.md"))
            ok &= check("send_brief: exit 0 on an accepted resume", result.returncode == 0,
                        result.stderr.decode("utf-8", "replace"))
            ok &= check("send_brief: exactly one resume reached the Host",
                        len(received) == 1 and received[0]["path"] == "/v1/resume")
            sent = received[-1]["body"]
            ok &= check("send_brief: bearer comes from the configured secret file", received[-1]["auth_ok"])
            ok &= check("send_brief: content type is JSON", received[-1]["content_type"] == "application/json")
            ok &= check("send_brief: text equals the brief (escapes, quotes, emoji, tabs)", sent.get("text") == brief,
                        repr(sent.get("text"))[:120])
            ok &= check("send_brief: session_id is the one given", sent.get("session_id") == "session-test-1")
            request_id = sent.get("request_id", "")
            ok &= check("send_brief: fresh request_id has the documented shape",
                        bool(re.fullmatch(r"agy-\d{8}T\d{6}Z-[0-9a-f]{8}", request_id)), request_id)
            ok &= check("send_brief: request_id is printed on stderr",
                        f"request_id={request_id}" in result.stderr.decode("utf-8", "replace"))
            ok &= check("send_brief: body carries only our keys plus upstream's async flag",
                        sorted(sent) == ["request_id", "session_id", "text", "wait"] and sent["wait"] is False,
                        str(sorted(sent)))

            send("--session", "session-test-1", "--brief", str(scratch / "brief.md"), "--request-id", "fixed-id-7")
            ok &= check("send_brief: --request-id is reused verbatim", received[-1]["body"].get("request_id") == "fixed-id-7")

            result = send("--session", "session-test-1", "--brief", "-", stdin=brief.encode("utf-8"))
            ok &= check("send_brief: a brief on stdin is sent intact",
                        result.returncode == 0 and received[-1]["body"].get("text") == brief)

            (scratch / "crlf.md").write_bytes(brief.replace("\n", "\r\n").encode("utf-8"))
            send("--session", "session-test-1", "--brief", str(scratch / "crlf.md"))
            ok &= check("send_brief: a CRLF file sends the same LF text", received[-1]["body"].get("text") == brief)

            (scratch / "bom.md").write_bytes(b"\xef\xbb\xbf" + brief.encode("utf-8"))
            send("--session", "session-test-1", "--brief", str(scratch / "bom.md"))
            ok &= check("send_brief: a UTF-8 BOM is stripped", received[-1]["body"].get("text") == brief)

            before = len(received)
            (scratch / "empty.md").write_text("  \n\t\n", encoding="utf-8")
            ok &= check("send_brief: an empty brief is refused, nothing is sent",
                        send("--session", "session-test-1", "--brief", str(scratch / "empty.md")).returncode == 2
                        and len(received) == before)
            ok &= check("send_brief: a missing brief is refused, nothing is sent",
                        send("--session", "session-test-1", "--brief", str(scratch / "no-such-file.md")).returncode == 2
                        and len(received) == before)

            reply.update(status=409, body={"ok": False, "reason": "busy", "started_task": False})
            result = send("--session", "session-test-1", "--brief", str(scratch / "brief.md"))
            ok &= check("send_brief: a Host refusal (409 busy) exits 1 without the tracking hint",
                        result.returncode == 1 and b'"reason": "busy"' in result.stdout
                        and b"accepted for tracking" not in result.stderr)
            reply.update(status=500, body={"ok": False, "reason": "request_persist_failed"})
            ok &= check("send_brief: a Host error (500) exits 1",
                        send("--session", "session-test-1", "--brief", str(scratch / "brief.md")).returncode == 1)

            def table(document, *extra):
                return subprocess.run([sys.executable, str(SKILL / "scripts" / "sessions_table.py"), *extra],
                                      input=json.dumps(document).encode("utf-8"), capture_output=True, env=env)

            granted = {"http_status": 200, "sessions": [
                {"session_id": "session-a", "workspace_id": "ws-1-aaaa", "title": "甲 " * 20, "cwd": "D:\\work\\one",
                 "access": "write", "running": False, "busy": True, "agent_available": True,
                 "model_next": {"reasoningEffort": "high"}},
                {"session_id": "session-b", "workspace_id": "ws-2-bbbb", "title": "乙", "cwd": "D:\\work\\two",
                 "access": "read", "running": False, "busy": False, "agent_available": False, "model_next": None}]}
            result = table(granted)
            out = result.stdout.decode("utf-8")
            ok &= check("sessions_table: granted rows show access, state and decoded text",
                        result.returncode == 0 and "session-a" in out and "busy" in out and "write" in out and "甲" in out)
            ok &= check("sessions_table: raw ASCII escapes are gone", "\\u" not in out)
            result = table(granted, "--cwd", "WORK/TWO")
            out = result.stdout.decode("utf-8")
            ok &= check("sessions_table: --cwd is a case-insensitive, slash-agnostic directory filter",
                        "session-b" in out and "session-a" not in out and "ws ws-2-bbb = ws-2-bbbb  D:\\work\\two" in out, out)
            result = table(granted, "--idle")
            ok &= check("sessions_table: --idle drops running or busy sessions",
                        "session-b" in result.stdout.decode("utf-8") and "session-a" not in result.stdout.decode("utf-8"))
            result = table(granted, "--limit", "1")
            ok &= check("sessions_table: --limit caps the rows", result.stdout.decode("utf-8").count("session-") == 1)

            discover = {"http_status": 200, "ok": True, "total": 444, "offset": 0, "limit": 20,
                        "workspaces": [{"id": "ws-9-zzzz", "path": "D:\\projects\\demo", "sessions_total": 3}],
                        "items": [{"session_id": "session-c", "workspace_id": "", "title": "丙", "cwd": "D:\\other",
                                   "kind": "top", "status": "unknown", "agent_available": False}]}
            result = table(discover, "--cwd", "projects/demo")
            out = result.stdout.decode("utf-8")
            ok &= check("sessions_table: discover keeps a matching workspace in the legend with no matching row",
                        "ws ws-9-zzz = ws-9-zzzz  D:\\projects\\demo" in out and "444 in all" in out, out)
            result = table(discover)
            ok &= check("sessions_table: discover reports the server page", "server page offset 0 limit 20, 444 in all"
                        in result.stdout.decode("utf-8"))

            result = table({"ok": False, "reason": "bridge_transport_error"})
            ok &= check("sessions_table: an error document is printed readably with exit 1",
                        result.returncode == 1 and '"bridge_transport_error"' in result.stdout.decode("utf-8"))
            result = table([1, 2, 3])
            ok &= check("sessions_table: a non-object document exits 2", result.returncode == 2)
            result = subprocess.run([sys.executable, str(SKILL / "scripts" / "sessions_table.py")], input=b"not json",
                                    capture_output=True, env=env)
            ok &= check("sessions_table: non-JSON input exits 2 with a hint",
                        result.returncode == 2 and b"pipe the output of desktop.py" in result.stderr)
        finally:
            server.shutdown()
            server.server_close()
    print("RESULT:", "ALL PASS" if ok else "SOMETHING FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
