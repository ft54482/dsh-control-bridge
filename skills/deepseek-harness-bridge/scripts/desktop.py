"""Small JSON/SSE client for the installed Desktop bridge."""

from __future__ import annotations

import argparse
import http.client
import json
import os
import sys
from pathlib import Path
from urllib.parse import quote, urlencode


READ = {
    "health": "health",
    "granted": "granted",
    "workspaces": "workspaces",
    "sessions": "sessions",
    "history": "history",
    "models": "models",
    "request": "requests",
    "membership": "guard/membership",
    "discover": "discover",
    "model-catalog": "model-catalog",
    "outbox": "outbox",
}
WRITE = {
    "resume": "resume",
    "cancel": "cancel",
    "stop-wait": "wait/stop",
    "set-model": "model",
    "set-access": "access",
    "create-workspace": "workspaces",
    "create-session": "sessions",
    "open": "open",
}
OBSERVE = {"wait", "events", "stream"}
DEFAULT_SECRET = Path.home() / ".dsh" / "state" / "desktop-host-local" / "host.secret"
LOCAL_CONFIG = Path(__file__).resolve().parents[1] / "connection.json"


def object_from(raw: bytes) -> dict:
    value = json.loads(raw.decode("utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError("expected a JSON object")
    return value


def load_secret() -> str:
    path = os.environ.get("DSH_BRIDGE_SECRET_FILE")
    if not path and LOCAL_CONFIG.exists():
        path = object_from(LOCAL_CONFIG.read_bytes()).get("secret_file")
        if not isinstance(path, str) or not path:
            raise ValueError("missing secret_file in local connection.json")
    secret = (Path(path).expanduser() if path else DEFAULT_SECRET).read_text(encoding="utf-8-sig").strip()
    if not secret or any(not 33 <= ord(char) <= 126 for char in secret):
        raise ValueError("invalid local bridge secret")
    return secret


def emit(value: dict, secret: str = "") -> None:
    output = json.dumps(value, ensure_ascii=True)
    if secret:
        escaped_secret = json.dumps(secret, ensure_ascii=True)[1:-1]
        if escaped_secret in output:
            output = output.replace(escaped_secret, "[REDACTED_SECRET]")
    print(output, flush=True)


def print_stream(response: http.client.HTTPResponse, secret: str) -> int:
    event = "message"
    event_id = None
    data: list[str] = []
    for raw in response:
        line = raw.decode("utf-8").rstrip("\r\n")
        if not line:
            if data:
                emit({"event": event, "id": event_id, "data": json.loads("\n".join(data))}, secret)
                if event in {"end", "error"}:
                    return int(event == "error")
            event, event_id, data = "message", None, []
            continue
        key, _, value = line.partition(":")
        value = value.removeprefix(" ")
        if key == "event":
            event = value
        elif key == "id":
            event_id = value
        elif key == "data":
            data.append(value)
    emit({"ok": False, "reason": "stream_disconnected"})
    return 2


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=[*READ, *WRITE, *sorted(OBSERVE)])
    parser.add_argument("--param", action="append", default=[], metavar="KEY=VALUE")
    parser.add_argument("--request-id", help="required with wait, events or stream")
    parser.add_argument("--last-event-id", type=int, default=0, help="SSE continuation cursor")
    parser.add_argument("--data", help="UTF-8 JSON file or - for stdin")
    parser.add_argument("--port", type=int, default=8765, help="loopback port")
    parser.add_argument("--timeout", type=float, default=135, help="socket timeout in seconds")
    args = parser.parse_args()
    command = args.command
    if bool(args.data) != (command in WRITE):
        parser.error("write commands require --data; read commands do not take it")
    if bool(args.request_id) != (command in OBSERVE):
        parser.error("--request-id is required for wait, events and stream only")
    if args.last_event_id < 0 or (args.last_event_id and command != "stream"):
        parser.error("--last-event-id requires stream and a non-negative cursor")
    if not 0 < args.port < 65536 or not 0 < args.timeout <= 3600:
        parser.error("invalid port or timeout")
    params = [item.split("=", 1) for item in args.param]
    if any(len(pair) != 2 or not pair[0] for pair in params) or (params and args.data):
        parser.error("--param KEY=VALUE applies to read commands")

    request_id = args.request_id
    try:
        if command in OBSERVE:
            route = f"requests/{quote(request_id, safe='')}/{command}"
        else:
            route = READ.get(command) or WRITE[command]
        path = f"/v1/{route}"
        if params:
            path += "?" + urlencode([tuple(pair) for pair in params])
        body = None
        if args.data:
            body = object_from(sys.stdin.buffer.read() if args.data == "-" else Path(args.data).read_bytes())
            if command == "set-access" and body.get("access") not in ("read", "write"):
                parser.error("set-access requires an explicit read or write access value")
            if command == "resume":
                request_id = body.get("request_id")
                if not isinstance(request_id, str) or not request_id.strip():
                    parser.error("resume requires a nonempty request_id in the JSON body")
        secret = load_secret()
    except (OSError, UnicodeError, ValueError):
        emit({"ok": False, "reason": "invalid_local_input", "detail": "check the local secret file and UTF-8 JSON input"})
        return 2

    headers = {"Authorization": f"Bearer {secret}", "Accept": "application/json"}
    connection = http.client.HTTPConnection("127.0.0.1", args.port, timeout=args.timeout)
    try:
        if body is not None:
            headers["Content-Type"] = "application/json"
        if command == "resume" and "wait" not in body and "wait_ms" not in body:
            connection.request("GET", "/v1/health", headers=headers)
            probe = connection.getresponse()
            health = object_from(probe.read())
            if probe.status != 200 or health.get("ok") is not True:
                emit({"http_status": probe.status, **health}, secret)
                return 1
            if "outbox_enabled" in health:
                body["wait"] = False
        if command == "stream":
            headers["Accept"] = "text/event-stream"
            headers["Last-Event-ID"] = str(args.last_event_id)
        data = json.dumps(body).encode("utf-8") if body is not None else None
        connection.request("POST" if body is not None else "GET", path, body=data, headers=headers)
        with connection.getresponse() as response:
            if command == "stream" and response.status == 200 and response.headers.get_content_type() == "text/event-stream":
                return print_stream(response, secret)
            result = object_from(response.read())
            emit({"http_status": response.status, **result}, secret)
            return int(response.status >= 400 or result.get("ok") is False)
    except (OSError, UnicodeError, http.client.HTTPException, ValueError):
        emit({"ok": False, "reason": "bridge_transport_error", "request_id": request_id}, secret)
        return 2
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
