import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
from threading import Thread

import pytest


CLIENT = (Path(__file__).resolve().parents[1] / "skills" / "deepseek-harness-bridge"
          / "scripts" / "desktop.py")
SUPERAGENT = CLIENT.with_name("superagent.py")
SECRET = "desktop-skill-test-secret"


@pytest.fixture
def invoke_client(tmp_path):
    secret_file = tmp_path / "host.secret"
    secret_file.write_text(SECRET, encoding="utf-8")

    def invoke(replies, arguments, body=None, *, client=CLIENT):
        observed = []

        class Handler(BaseHTTPRequestHandler):
            def handle_request(self):
                size = int(self.headers.get("Content-Length", 0))
                observed.append((self.command, self.path, dict(self.headers), self.rfile.read(size)))
                status, content_type, payload = replies.pop(0)
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.end_headers()
                self.wfile.write(payload)

            do_GET = handle_request
            do_POST = handle_request

        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                result = subprocess.run(
                    [sys.executable, str(client), "--port", str(server.server_port), *arguments],
                    input=body, capture_output=True, timeout=10,
                    env={**os.environ, "DSH_BRIDGE_SECRET_FILE": str(secret_file)},
                    check=False,
                )
            finally:
                server.shutdown()
                thread.join()
        assert SECRET.encode() not in result.stdout + result.stderr
        if client == CLIENT:
            assert all(request[2]["Authorization"] == f"Bearer {SECRET}" for request in observed)
        else:
            assert all(request[2]["x-orchestrator-request"] == "1" for request in observed)
            assert all("Authorization" not in request[2] for request in observed)
        return result, observed

    return invoke


@pytest.mark.parametrize("modern", [False, True])
def test_dispatch_uses_one_post_and_preserves_request_id_and_unicode(invoke_client, modern):
    health = {"ok": True, **({"outbox_enabled": False} if modern else {})}
    request = {"request_id": "example-1", "session_id": "s1", "text": "复核\n第二行"}
    result, requests = invoke_client(
        [(200, "application/json", json.dumps(health).encode()),
         (202, "application/json", b'{"accepted":true,"phase":"accepted"}')],
        ["resume", "--data", "-"], json.dumps(request, ensure_ascii=False).encode("utf-8"),
    )
    assert result.returncode == 0
    assert [(method, path) for method, path, _, _ in requests] == [
        ("GET", "/v1/health"), ("POST", "/v1/resume"),
    ]
    assert json.loads(requests[1][3]) == {**request, **({"wait": False} if modern else {})}
    assert json.loads(result.stdout)["phase"] == "accepted"


def test_sse_resume_retains_frame_cursor_and_ignores_heartbeats(invoke_client):
    result, requests = invoke_client(
        [(200, "text/event-stream", b': heartbeat\n\nid: 42\nevent: request\ndata: {"seq":42}\n\n'
          b'event: end\ndata: {"phase":"terminal","completed":false}\n\n')],
        ["stream", "--request-id", "case/2", "--last-event-id", "41"],
    )
    assert result.returncode == 0
    assert requests[0][1] == "/v1/requests/case%2F2/stream"
    assert requests[0][2]["Last-Event-ID"] == "41"
    frames = [json.loads(line) for line in result.stdout.splitlines()]
    assert frames[0] == {"event": "request", "id": "42", "data": {"seq": 42}}
    assert frames[1]["event"] == "end"
    assert frames[1]["data"]["completed"] is False


def test_secret_is_redacted_even_if_reflected_and_denial_is_preserved(invoke_client):
    result, requests = invoke_client(
        [(403, "application/json", json.dumps({"ok": False, "reason": SECRET}).encode())],
        ["history", "--param", "session_id=a&b"],
    )
    assert len(requests) == 1
    assert requests[0][1] == "/v1/history?session_id=a%26b"
    assert result.returncode == 1
    assert json.loads(result.stdout) == {
        "http_status": 403, "ok": False, "reason": "[REDACTED_SECRET]",
    }


def test_superagent_reads_official_ids_and_omits_private_ticket_content(invoke_client):
    ticket = {
        "id": "t1", "state": "ended", "title": "private project",
        "assignments": [{
            "id": "a1", "state": "ended", "ref": "worker-session",
            "report": {"state": "ready", "summary": "private report"},
        }],
    }
    result, requests = invoke_client(
        [(200, "application/json", json.dumps(ticket).encode())],
        ["ticket", "t1"], client=SUPERAGENT,
    )
    assert requests[0][:2] == ("GET", "/orchestrator/api/tickets/t1")
    assert result.returncode == 0
    assert b"private" not in result.stdout
    assert json.loads(result.stdout)["assignments"] == [{
        "id": "a1", "state": "ended", "ref": "worker-session", "report": {"state": "ready"},
    }]
