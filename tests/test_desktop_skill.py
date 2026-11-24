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


def test_preset_creation_stops_before_post_on_older_host(invoke_client):
    result, requests = invoke_client(
        [(200, "application/json", b'{"ok":true,"outbox_enabled":false}')],
        ["create-session", "--data", "-"], b'{"workspace_id":"w"}',
    )
    assert result.returncode == 1
    assert [item[:2] for item in requests] == [("GET", "/v1/health")]
    assert json.loads(result.stdout)["reason"] == "preset_creation_unavailable"


@pytest.mark.parametrize("change", [
    {}, {"agent_preset_source": "request"}, {"workspace_id": "other"}, {"session_id": "unexpected"},
    {"grant": None}, {"grant": {"session_id": "fresh", "workspace_id": "w", "access": "read"}},
])
def test_preset_creation_requires_an_identity_bound_receipt(invoke_client, change):
    body = {"workspace_id": "w", "agent_preset": "another-preset", "access": "write"}
    receipt = {"ok": True, "session_id": "fresh", "workspace_id": "w", "agent_preset": "another-preset",
               "grant": {"session_id": "fresh", "workspace_id": "w", "access": "write"},
               "agent_preset_source": "session_projection", "started_task": False, **change}
    result, requests = invoke_client(
        [(200, "application/json", b'{"ok":true,"preset_create_verified":true}'),
         (200, "application/json", json.dumps(receipt).encode())],
        ["create-session", "--data", "-"], json.dumps(body).encode(),
    )
    assert [item[:2] for item in requests] == [("GET", "/v1/health"), ("POST", "/v1/sessions")]
    assert json.loads(requests[-1][3]) == body
    output = json.loads(result.stdout)
    assert output["session_id"] == receipt["session_id"]
    assert result.returncode == int(bool(change))
    if change:
        assert output["reason"] == "agent_preset_unverified"
        assert output["manual_reconcile"] is True


def test_new_task_in_existing_workspace_defaults_to_master_control(invoke_client):
    receipt = {"ok": True, "session_id": "fresh", "workspace_id": "w", "agent_preset": "master-control",
               "grant": {"session_id": "fresh", "workspace_id": "w", "access": "read"},
               "agent_preset_source": "session_projection", "started_task": False}
    result, requests = invoke_client(
        [(200, "application/json", b'{"ok":true,"preset_create_verified":true}'),
         (200, "application/json", json.dumps(receipt).encode())],
        ["create-session", "--data", "-"], b'{"workspace_id":"w"}',
    )
    assert result.returncode == 0
    assert json.loads(requests[1][3]) == {"workspace_id": "w", "agent_preset": "master-control"}


EFFECTIVE = {"ok": True, "preset_create_verified": True,
             "workspace_autonomy": {"configured": True, "enabled": True, "effective": True, "reason": None}}


def workspace_receipt(**change):
    receipt = {
        "ok": True, "workspace_id": "w1", "path": "/tmp/project",
        "workspace": {"id": "w1", "title": "project", "path": "/tmp/project"},
        "grant": {"workspace_id": "w1", "path": "/tmp/project"},
        "started_task": False,
    }
    receipt.update(change)
    return receipt


def test_create_workspace_with_a_task_requires_an_effective_policy(invoke_client):
    request = {"path": "/tmp/project", "task_id": "task-1", "purpose": "build"}
    result, requests = invoke_client(
        [(200, "application/json", json.dumps({"ok": True, "preset_create_verified": True,
                                              "workspace_autonomy": {"configured": True, "enabled": True,
                                                                     "effective": False, "reason": "allowlist_file_missing"}}).encode())],
        ["create-workspace", "--data", "-"], json.dumps(request).encode(),
    )
    assert [item[:2] for item in requests] == [("GET", "/v1/health")]
    assert result.returncode == 1
    assert json.loads(result.stdout)["reason"] == "workspace_autonomy_not_effective"


@pytest.mark.parametrize("change, ok", [
    ({}, True),
    ({"started_task": True}, False),
    ({"workspace": {"id": "other", "path": "/tmp/project"}}, False),
    ({"grant": {"workspace_id": "other"}}, False),
    ({"path": "/tmp/elsewhere"}, False),
    ({"workspace_id": ""}, False),
])
def test_create_workspace_receipt_must_name_one_workspace(invoke_client, change, ok):
    request = {"path": "/tmp/project", "task_id": "task-1", "purpose": "build"}
    result, requests = invoke_client(
        [(200, "application/json", json.dumps(EFFECTIVE).encode()),
         (200, "application/json", json.dumps(workspace_receipt(**change)).encode())],
        ["create-workspace", "--data", "-"], json.dumps(request).encode(),
    )
    assert [item[:2] for item in requests] == [("GET", "/v1/health"), ("POST", "/v1/workspaces")]
    assert json.loads(requests[1][3]) == request
    assert result.returncode == int(not ok)
    output = json.loads(result.stdout)
    if not ok:
        assert output["reason"] == "workspace_receipt_unverified"
        assert output["manual_reconcile"] is True
    else:
        assert output["workspace_id"] == "w1"


def test_revoke_workspace_posts_one_request_and_checks_the_receipt(invoke_client):
    request = {"workspace_id": "w1"}
    result, requests = invoke_client(
        [(200, "application/json", json.dumps({"ok": True, "workspace_id": "w1",
                                              "revoked": {"workspace": True, "sessions": 2},
                                              "directory_intact": True, "started_task": False}).encode())],
        ["revoke-workspace", "--data", "-"], json.dumps(request).encode(),
    )
    assert [item[:2] for item in requests] == [("POST", "/v1/workspaces/revoke")]
    assert json.loads(requests[0][3]) == request
    assert result.returncode == 0
    assert json.loads(result.stdout)["revoked"] == {"workspace": True, "sessions": 2}


@pytest.mark.parametrize("receipt", [
    {"ok": True, "workspace_id": "other", "started_task": False},
    {"ok": True, "workspace_id": "w1", "started_task": True},
    {"ok": False, "workspace_id": "w1", "started_task": False},
])
def test_revoke_workspace_rejects_a_mismatched_receipt(invoke_client, receipt):
    result, requests = invoke_client(
        [(200, "application/json", json.dumps(receipt).encode())],
        ["revoke-workspace", "--data", "-"], b'{"workspace_id":"w1"}',
    )
    assert [item[:2] for item in requests] == [("POST", "/v1/workspaces/revoke")]
    assert result.returncode == 1
    assert json.loads(result.stdout)["reason"] == "revoke_receipt_unverified"


def test_revoke_workspace_needs_a_workspace_id_before_contacting_host(invoke_client):
    result, requests = invoke_client([], ["revoke-workspace", "--data", "-"], b'{"workspace_id":""}')
    assert result.returncode != 0
    assert not requests


def test_task_scoped_session_receipts_must_carry_that_task(invoke_client):
    request = {"path": "/tmp/project", "task_id": "task-1", "purpose": "build",
               "agent_preset": "master-control", "access": "write"}
    receipt = {"ok": True, "session_id": "s1", "workspace_id": "w1", "agent_preset": "master-control",
               "grant": {"session_id": "s1", "workspace_id": "w1", "access": "write"},
               "agent_preset_source": "session_projection", "started_task": False,
               "task_id": "task-1", "purpose": "build", "workspace_created": True, "deduplicated": False}
    result, requests = invoke_client(
        [(200, "application/json", json.dumps(EFFECTIVE).encode()),
         (200, "application/json", json.dumps(receipt).encode())],
        ["create-session", "--data", "-"], json.dumps(request).encode(),
    )
    assert [item[:2] for item in requests] == [("GET", "/v1/health"), ("POST", "/v1/sessions")]
    assert result.returncode == 0
    assert json.loads(result.stdout)["task_id"] == "task-1"

    wrong = dict(receipt, task_id="task-other")
    failed, _ = invoke_client(
        [(200, "application/json", json.dumps(EFFECTIVE).encode()),
         (200, "application/json", json.dumps(wrong).encode())],
        ["create-session", "--data", "-"], json.dumps(request).encode(),
    )
    assert failed.returncode == 1
    assert json.loads(failed.stdout)["reason"] == "task_receipt_unverified"


def test_a_deduplicated_session_receipt_still_proves_grant_consistency(invoke_client):
    request = {"path": "/tmp/project", "task_id": "task-1", "purpose": "build",
               "agent_preset": "master-control", "access": "write", "client_request_key": "key-0001"}
    consistent = {"ok": True, "session_id": "s1", "workspace_id": "w1", "agent_preset": "master-control",
                  "grant": {"session_id": "s1", "workspace_id": "w1", "access": "write"},
                  "agent_preset_source": "session_projection", "started_task": False,
                  "task_id": "task-1", "deduplicated": True}
    result, _ = invoke_client(
        [(200, "application/json", json.dumps(EFFECTIVE).encode()),
         (200, "application/json", json.dumps(consistent).encode())],
        ["create-session", "--data", "-"], json.dumps(request).encode(),
    )
    assert result.returncode == 0
    assert json.loads(result.stdout)["deduplicated"] is True

    broken = dict(consistent, grant={"session_id": "s1", "workspace_id": "other", "access": "write"})
    failed, _ = invoke_client(
        [(200, "application/json", json.dumps(EFFECTIVE).encode()),
         (200, "application/json", json.dumps(broken).encode())],
        ["create-session", "--data", "-"], json.dumps(request).encode(),
    )
    assert failed.returncode == 1
    assert json.loads(failed.stdout)["reason"] == "agent_preset_unverified"


def test_fresh_create_rejects_caller_id_before_contacting_host(invoke_client):
    result, requests = invoke_client([], ["create-session", "--data", "-"],
                                     b'{"workspace_id":"w","session_id":"existing"}')
    assert result.returncode != 0
    assert not requests


def test_ambiguous_failure_after_creation_post_requires_reconciliation(invoke_client):
    result, requests = invoke_client(
        [(200, "application/json", b'{"ok":true,"preset_create_verified":true}'),
         (502, "application/json", b'{"ok":false,"reason":"gateway/internal","session_id":"minted"}')],
        ["create-session", "--data", "-"], b'{"workspace_id":"w"}',
    )
    assert result.returncode == 1
    assert [item[:2] for item in requests] == [("GET", "/v1/health"), ("POST", "/v1/sessions")]
    assert json.loads(result.stdout)["manual_reconcile"] is True
    assert json.loads(result.stdout)["session_id"] == "minted"


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
