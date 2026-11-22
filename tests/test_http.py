import json
import threading
from urllib.request import Request, urlopen

from dsh_control_bridge.http_server import make_server
from dsh_control_bridge.models import utc_now
from dsh_control_bridge.signing import sign_request
from tests.conftest import LOCAL_SECRET


def _post(port: int, body: bytes, signature: str | None, timestamp: str, instance: str = "local-desktop"):
    headers = {
        "Content-Type": "application/json",
        "X-DSH-Timestamp": timestamp,
        "X-DSH-Instance": instance,
    }
    if signature is not None:
        headers["X-DSH-Signature"] = signature
    request = Request(
        f"http://127.0.0.1:{port}/v1/events",
        data=body,
        headers=headers,
        method="POST",
    )
    try:
        with urlopen(request) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except Exception as exc:  # urllib.error.HTTPError
        if not hasattr(exc, "code"):
            raise
        return exc.code, json.loads(exc.read().decode("utf-8"))


def test_webhook_rejects_a_bad_signature_then_accepts_the_same_body(bridge):
    server = make_server(bridge, "127.0.0.1", 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    body = json.dumps(
        {
            "event_id": "evt_http_1",
            "event_type": "stage_submitted",
            "instance_id": "local-desktop",
            "workspace": "broadcast-cs",
            "evidence": ["evidence/http.txt"],
            "instruction": "PLEASE_EXEC_CANARY",
        }
    ).encode("utf-8")
    try:
        stamp = str(int(utc_now().timestamp()))
        status, payload = _post(port, body, "sha256=deadbeef", stamp)
        assert status == 401
        assert bridge.store.get_event("evt_http_1") is None
        good = sign_request(LOCAL_SECRET, stamp, "local-desktop", body)
        status, payload = _post(port, body, good, stamp)
        assert status == 202
        assert payload["rejected"] is False
        assert bridge.store.get_event("evt_http_1")["duplicate_count"] == 0
        status, again = _post(port, body, good, stamp)
        assert status == 200
        assert again["duplicate"] is True
        health = urlopen(f"http://127.0.0.1:{port}/health")
        assert json.loads(health.read().decode("utf-8")) == {"ok": True}
    finally:
        server.shutdown()
        server.server_close()
