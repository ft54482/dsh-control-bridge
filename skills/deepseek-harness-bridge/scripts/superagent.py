"""Read metadata from the official local SuperAgent management API."""

from __future__ import annotations

import argparse
import http.client
import json
from urllib.parse import quote, urlencode

from desktop import emit


STAGES = ("open", "person", "working", "idle", "ended")


def fields(data: dict, names: str) -> dict:
    return {key: data[key] for key in names.split() if key in data}


def ticket_view(ticket: dict) -> dict:
    result = fields(ticket, "id state stage action sessionId createdAt updatedAt")
    if isinstance(ended := ticket.get("ended"), dict):
        result["ended"] = fields(ended, "at outcome")
    assignments = ticket.get("assignments")
    if isinstance(assignments, int):
        result["assignments"] = assignments
    elif isinstance(assignments, list):
        result["assignments"] = []
        for assignment in assignments:
            item = fields(assignment, "id state createdAt startedAt endedAt ref")
            if isinstance(report := assignment.get("report"), dict):
                item["report"] = fields(report, "state at")
            result["assignments"].append(item)
    return result


def project(command: str, body: dict | list) -> dict:
    if command == "sources":
        return {"sources": [fields(source, "id installed enabled state") for source in body]}
    if command == "state":
        return {
            **fields(body, "paused"),
            "load": fields(body["load"], "running queued maxWorkers"),
            "health": {key: value.get("state") for key, value in body["health"].items()},
            "setup_problem": bool(body["setup"].get("problem")),
        }
    if command == "tickets":
        return {**fields(body, "total next_offset"), "items": [ticket_view(row) for row in body["items"]]}
    return ticket_view(body["ticket"] if "ticket" in body else body)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=3082)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("state")
    commands.add_parser("sources")
    tickets = commands.add_parser("tickets")
    tickets.add_argument("--state", choices=STAGES, default="open")
    tickets.add_argument("--limit", type=int, default=20)
    tickets.add_argument("--offset", type=int, default=0)
    commands.add_parser("ticket").add_argument("ticket_id")
    args = parser.parse_args()
    if not 0 < args.port < 65536:
        parser.error("invalid loopback port")
    route = args.command
    if route == "tickets":
        if not 0 < args.limit <= 1000 or args.offset < 0:
            parser.error("invalid limit or offset")
        route += "?" + urlencode({"state": args.state, "limit": args.limit, "offset": args.offset})
    elif route == "ticket":
        route = "tickets/" + quote(args.ticket_id, safe="")

    connection = http.client.HTTPConnection("127.0.0.1", args.port, timeout=15)
    try:
        connection.request("GET", f"/orchestrator/api/{route}", headers={"x-orchestrator-request": "1"})
        with connection.getresponse() as response:
            if response.status != 200:
                emit({"ok": False, "http_status": response.status, "reason": "superagent_query_failed"})
                return 1
            data = project(args.command, json.loads(response.read()))
            emit({"ok": True, **data})
            return 0
    except (OSError, UnicodeError, ValueError, http.client.HTTPException, AttributeError, KeyError, TypeError):
        emit({"ok": False, "reason": "superagent_unavailable_or_incompatible"})
        return 2
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
