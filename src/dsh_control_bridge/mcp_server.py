"""Minimal stdio MCP server. It speaks Content-Length JSON-RPC and calls the bridge.

This is the tool server. docs/mcp-tools.json is the same catalog, not a second runtime.
Dispatch still defaults to draft. A send requires an operator mandate in the tool arguments.
"""

from __future__ import annotations

import json
import sys
from typing import Any, BinaryIO

from dsh_control_bridge import __version__
from dsh_control_bridge.bridge import Bridge
from dsh_control_bridge.diagnose import diagnose
from dsh_control_bridge.errors import BridgeError
from dsh_control_bridge.mcp_tools import tool_catalog
from dsh_control_bridge.models import parse_mandate
from dsh_control_bridge.preflight import preflight

PROTOCOL = "2024-11-05"


def serve_stdio(bridge: Bridge, inbound: BinaryIO | None = None, outbound: BinaryIO | None = None) -> None:
    reader = inbound or sys.stdin.buffer
    writer = outbound or sys.stdout.buffer
    while True:
        message = _read_message(reader)
        if message is None:
            return
        if "id" not in message:
            continue
        response = _handle(bridge, message)
        _write_message(writer, response)


def _handle(bridge: Bridge, message: dict[str, Any]) -> dict[str, Any]:
    method = message.get("method")
    request_id = message.get("id")
    params = message.get("params") or {}
    try:
        if method == "initialize":
            result = {
                "protocolVersion": PROTOCOL,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "dsh-control-bridge", "version": __version__},
                "instructions": "connected_to_harness is false. dispatch defaults to draft.",
            }
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = tool_catalog()
        elif method == "tools/call":
            result = _call(bridge, params)
        else:
            return _error(request_id, -32601, "method not found")
    except BridgeError as exc:
        return _error(request_id, -32000, str(exc))
    except (TypeError, ValueError) as exc:
        return _error(request_id, -32602, str(exc))
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _call(bridge: Bridge, params: dict[str, Any]) -> dict[str, Any]:
    name = params.get("name")
    arguments = params.get("arguments") or {}
    if not isinstance(arguments, dict):
        raise ValueError("arguments must be an object")
    if name == "inbox":
        payload = bridge.inbox(
            instance_id=arguments.get("instance_id"),
            workspace=arguments.get("workspace"),
        )
    elif name == "acknowledge":
        payload = bridge.acknowledge(str(arguments["event_id"]))
    elif name == "status":
        payload = bridge.status(str(arguments["task_id"]))
    elif name == "cancel":
        task = bridge.cancel(str(arguments["task_id"]), str(arguments["reason"]))
        payload = task.to_dict()
    elif name == "dispatch":
        payload = _dispatch(bridge, arguments).to_dict()
    elif name == "diagnose":
        payload = diagnose(bridge.config)
        payload["preflight"] = preflight(None)
    else:
        raise ValueError(f"unknown tool {name}")
    return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}], "isError": False}


def _dispatch(bridge: Bridge, arguments: dict[str, Any]):
    mode = arguments.get("mode") or "draft"
    mandate = None
    if mode == "send":
        if not isinstance(arguments.get("mandate"), dict):
            raise BridgeError("mode=send requires a mandate object from the operator")
        mandate = parse_mandate(arguments["mandate"])
    elif arguments.get("mandate") is not None:
        raise BridgeError("a draft must not carry a mandate")
    return bridge.dispatch(
        instance_id=arguments.get("instance_id"),
        workspace=arguments.get("workspace"),
        executor=arguments.get("executor"),
        title=arguments.get("title"),
        objective=arguments.get("objective"),
        scope=arguments.get("scope") or "",
        acceptance=arguments.get("acceptance") or "",
        mode=mode,
        mandate=mandate,
        mandate_source="mcp_tool",
        task_id=arguments.get("task_id"),
    )


def _error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def _read_message(stream: BinaryIO) -> dict[str, Any] | None:
    headers: dict[str, str] = {}
    while True:
        line = stream.readline()
        if line == b"":
            return None
        if line in (b"\r\n", b"\n"):
            break
        decoded = line.decode("ascii", errors="replace")
        if ":" not in decoded:
            continue
        name, value = decoded.split(":", 1)
        headers[name.strip().lower()] = value.strip()
    length = int(headers.get("content-length", "0"))
    if length <= 0 or length > 1_000_000:
        raise ValueError("invalid content-length")
    payload = stream.read(length)
    return json.loads(payload.decode("utf-8"))


def _write_message(stream: BinaryIO, payload: dict[str, Any]) -> None:
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    stream.write(f"Content-Length: {len(raw)}\r\n\r\n".encode("ascii") + raw)
    stream.flush()
