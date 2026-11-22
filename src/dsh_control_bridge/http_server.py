"""Small webhook server. It checks a signature, then stores an event."""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from dsh_control_bridge.bridge import MAX_BODY_BYTES, Bridge
from dsh_control_bridge.errors import BridgeError, PayloadError, SignatureError


def make_server(bridge: Bridge, host: str, port: int) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        server_version = "dsh-control-bridge/0.1"

        def do_GET(self) -> None:  # noqa: N802
            if self.path.split("?", 1)[0] != "/health":
                self._json(404, {"ok": False, "error": "not found"})
                return
            self._json(200, {"ok": True})

        def do_POST(self) -> None:  # noqa: N802
            if self.path.split("?", 1)[0] != "/v1/events":
                self._json(404, {"ok": False, "error": "not found"})
                return
            length = self.headers.get("Content-Length")
            if length is None or not length.isdigit():
                self._json(411, {"ok": False, "error": "content-length is required"})
                return
            size = int(length)
            if size > MAX_BODY_BYTES:
                self._json(413, {"ok": False, "error": "body is too large"})
                return
            body = self.rfile.read(size)
            try:
                result = bridge.ingest_bytes(
                    body,
                    signature=self.headers.get("X-DSH-Signature"),
                    timestamp=self.headers.get("X-DSH-Timestamp"),
                    instance_id=self.headers.get("X-DSH-Instance"),
                )
            except SignatureError as exc:
                self._json(401, {"ok": False, "error": str(exc)})
                return
            except PayloadError as exc:
                self._json(400, {"ok": False, "error": str(exc)})
                return
            except BridgeError as exc:
                self._json(400, {"ok": False, "error": str(exc)})
                return
            code = 422 if result.rejected and not result.duplicate else 200 if result.duplicate else 202
            self._json(code, result.to_dict())

        def log_message(self, fmt: str, *args: object) -> None:
            return

        def _json(self, code: int, payload: dict) -> None:
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    return ThreadingHTTPServer((host, port), Handler)


def serve(bridge: Bridge, host: str, port: int) -> None:
    if host not in {"127.0.0.1", "localhost"}:
        raise SignatureError("the quick-start listener only binds 127.0.0.1 or localhost")
    server = make_server(bridge, host, port)
    try:
        server.serve_forever()
    finally:
        server.server_close()
