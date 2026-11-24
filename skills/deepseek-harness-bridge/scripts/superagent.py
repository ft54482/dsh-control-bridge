"""Read a local SuperAgent profile: state, sources, tickets, todo inbox.

Every request is a GET with `x-orchestrator-request: 1`, so these commands are
safe against a profile whose tickets must not be touched. `state`, `sources`,
`tickets` and `ticket` keep the metadata-only projections; `inbox` (alias
`todos`) and `detail` add the fields an operator needs to decide whether to
reply, retry, stop or wait, and to read a historical ticket that has no local
dispatch plan on this machine.

Three states are kept apart on purpose:

* `stop` ends a ticket as `stopped` by a human. It is not a pass.
* `decision.outcome == "accept"` records an authorization to start work. It is
  not a delivery.
* `inputs[].delivered == true` with `deliveredTo` naming this ticket's
  Assignment (or the ticket) is "Delivered to Ticket". A new Decision is not
  required for delivery.

See references/superagent.md for the command list and the lifecycle table.
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import re
from pathlib import Path
from urllib.parse import quote, urlencode

from desktop import emit


STAGES = ("open", "person", "working", "idle", "ended")
RUNNING_STATES = ("pending", "running")
TRIAGE_VALUES = ("review_ready", "review_reported", "blocked_missing_info",
                 "retryable_failed", "running", "unknown", "ended")
MAX_ALL_SCAN = 5000
API_HEADERS = {"x-orchestrator-request": "1"}
ISSUE_URL_RE = re.compile(r"/issues/(\d+)(?:$|[?#])")
PULL_URL_RE = re.compile(r"/pull/(\d+)(?:$|[?#])")


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

class ApiError(RuntimeError):
    """A management API answer that is not HTTP 200."""

    def __init__(self, status: int) -> None:
        super().__init__(f"SuperAgent API returned HTTP {status}")
        self.status = status


def api(port: int, path: str, timeout: float = 15.0) -> dict | list:
    """GET one management API path. Raises ApiError on a non-200 answer."""
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        connection.request("GET", f"/orchestrator/api/{path}", headers=API_HEADERS)
        with connection.getresponse() as response:
            raw = response.read()
            if response.status != 200:
                raise ApiError(response.status)
            return json.loads(raw.decode("utf-8", "replace"))
    finally:
        connection.close()


def state_root() -> Path:
    """Local skill state root. Read-only here; the reply/verdict writers live in github_source.py."""
    configured = os.environ.get("DSH_BRIDGE_SKILL_STATE")
    return Path(configured).expanduser() if configured else Path.home() / ".codex" / "state" / "deepseek-harness-bridge"


# --------------------------------------------------------------------------- #
# Small projections
# --------------------------------------------------------------------------- #

def clip(value: object, limit: int = 400) -> str | None:
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())
    if not text:
        return None
    return text if len(text) <= limit else text[: max(0, limit - 3)] + "..."


def fields(data: dict, names: str) -> dict:
    return {key: data[key] for key in names.split() if key in data}


def ticket_view(ticket: dict) -> dict:
    result = fields(ticket, "id state stage action sessionId createdAt updatedAt")
    if isinstance(ended := ticket.get("ended"), dict):
        result["ended"] = fields(ended, "at outcome by")
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


# --------------------------------------------------------------------------- #
# Ticket detail helpers (shared with github_source.py)
# --------------------------------------------------------------------------- #

def ticket_detail(port: int, ticket_id: str) -> dict:
    body = api(port, "tickets/" + quote(str(ticket_id), safe=""))
    if isinstance(body, dict) and isinstance(body.get("ticket"), dict):
        return body["ticket"]
    if not isinstance(body, dict):
        raise RuntimeError("ticket detail is not an object")
    return body


def assignment_rows(detail: dict) -> list[dict]:
    """Detail views carry assignment objects; list rows carry only a count."""
    rows = detail.get("assignments")
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def assignment_view(row: dict) -> dict:
    report = row.get("report") if isinstance(row.get("report"), dict) else {}
    state = row.get("state")
    report_state = report.get("state")
    turn_ended = row.get("turnEndedAt")
    # A running Assignment whose worker already reported a non-progress state and
    # whose turn ended is not running any more, even while `state` says running.
    stale = state == "running" and bool(turn_ended) and report_state not in (None, "progress")
    return {
        "id": row.get("id"),
        "state": state,
        "state_effective": "ended" if stale else state,
        "stale_running_ignored": stale,
        "report_state": report_state,
        "report_at": report.get("at"),
        "report_summary": clip(report.get("summary"), 700),
        "ref": row.get("ref"),
        "created_at": row.get("createdAt"),
        "started_at": row.get("startedAt"),
        "ended_at": row.get("endedAt") or row.get("idleAt"),
        "ended_reason": row.get("endedReason"),
        "turn_ended_at": turn_ended,
    }


def newest_assignment(rows: list[dict]) -> dict | None:
    """The latest Assignment by `createdAt` (falling back to `startedAt`)."""
    if not rows:
        return None

    def key(row: dict) -> tuple[str, str]:
        stamp = row.get("createdAt") or row.get("startedAt") or ""
        return (str(stamp), str(row.get("id") or ""))

    return max(rows, key=key)


def triage_of(detail: dict, latest: dict | None = None) -> tuple[str, str]:
    """Classify what the operator has to do next, and why.

    Order matters: a ready report is reviewable even when the Assignment still
    says `running`, so `review_ready` must be decided before `running`.
    """
    actions = detail.get("actions") if isinstance(detail.get("actions"), dict) else {}
    rows = assignment_rows(detail)
    any_ready = any(isinstance(row.get("report"), dict) and row["report"].get("state") == "ready" for row in rows)
    ended = detail.get("ended") if isinstance(detail.get("ended"), dict) else None
    if ended and ended.get("outcome"):
        by = f" by {ended.get('by')}" if ended.get("by") else ""
        return "ended", f"ticket ended: {ended.get('outcome')}{by}"
    if latest is None:
        latest = assignment_view(newest_assignment(rows)) if rows else None
    if latest is None:
        if detail.get("stage") == "working":
            return "running", "no assignment yet; the ticket is queued for an executor"
        return "unknown", "no assignment on this ticket"
    report_state = latest.get("report_state")
    effective = latest.get("state_effective")
    undelivered = int(detail.get("undelivered") or 0)
    if report_state == "ready":
        if undelivered == 0:
            return "review_ready", "worker report ready; nothing is undelivered"
        return "review_reported", f"worker report ready but {undelivered} input(s) are not delivered yet"
    if effective in ("ended", "idle") and report_state == "failed" and actions.get("retry"):
        return "retryable_failed", "latest assignment ended failed and actions.retry is true"
    if report_state in (None, "waiting") and not any_ready and effective not in RUNNING_STATES:
        return "blocked_missing_info", "latest assignment has no worker report yet"
    if report_state == "progress" and effective in RUNNING_STATES:
        return "running", "worker is still working"
    if effective in RUNNING_STATES:
        return "running", f"assignment state_effective is {effective}"
    if report_state == "blocked":
        return "blocked_missing_info", "worker reported blocked and waits for the person"
    return "unknown", f"unclassified assignment state {latest.get('state')!r} with report {report_state!r}"


def delivery_view(detail: dict) -> dict:
    inputs = [item for item in detail.get("inputs") or [] if isinstance(item, dict)]
    pending = [item for item in inputs if not item.get("delivered")]
    delivered = [item for item in inputs if item.get("delivered")]
    last = max(delivered, key=lambda item: str(item.get("at") or "")) if delivered else None
    return {
        "undelivered": int(detail.get("undelivered") or 0),
        "inputs": len(inputs),
        "pending_inputs": len(pending),
        "pending_input_ids": [item.get("id") for item in pending],
        "last_delivered_to": last.get("deliveredTo") if last else None,
        "last_delivered_at": last.get("at") if last else None,
    }


def delivery_targets(detail: dict) -> tuple[set[str], set[str]]:
    """(ticket names, assignment names) that count as 'this ticket took the input'.

    The upstream API records the Assignment id in `inputs[].deliveredTo` (measured
    5/5 on a live profile); the ticket id is accepted too so the check does not
    depend on one id shape. A worker session `ref` is accepted as an assignment
    name for the same reason.
    """
    ticket_names = {str(detail.get("id") or "")} - {""}
    assignment_names = {str(row.get("id") or "") for row in assignment_rows(detail)} - {""}
    assignment_names |= {str(row.get("ref") or "") for row in assignment_rows(detail)} - {""}
    return ticket_names, assignment_names


def delivered_to_ticket(detail: dict, marker: str | None = None) -> dict:
    """Proof that a message reached this ticket, with or without a new Decision.

    `undelivered == 0` alone is not proof: a ticket with no inputs also reports
    zero. It is returned for corroboration only.
    """
    ticket_names, assignment_names = delivery_targets(detail)
    matches = []
    for item in detail.get("inputs") or []:
        if not isinstance(item, dict) or not item.get("delivered"):
            continue
        target = str(item.get("deliveredTo") or "")
        if not target:
            continue
        if target in ticket_names:
            kind = "ticket"
        elif target in assignment_names:
            kind = "assignment"
        else:
            continue
        if marker and marker not in str(((item.get("trigger") or {}).get("preview")) or ""):
            continue
        matches.append((item, kind))
    if not matches:
        return {"delivered": False, "delivered_to_ticket": False,
                "undelivered": int(detail.get("undelivered") or 0)}
    item, kind = max(matches, key=lambda pair: str(pair[0].get("at") or ""))
    return {
        "delivered": True,
        "delivered_to_ticket": True,
        "delivered_to": item.get("deliveredTo"),
        "delivered_to_kind": kind,
        "input_id": item.get("id"),
        "delivered_at": item.get("at"),
        "read_at": item.get("readAt"),
        "undelivered": int(detail.get("undelivered") or 0),
    }


def thread_view(detail: dict) -> list[dict]:
    rows = []
    for thread in detail.get("threads") or []:
        if not isinstance(thread, dict):
            continue
        url = str(thread.get("url") or "")
        issue = ISSUE_URL_RE.search(url)
        pull = PULL_URL_RE.search(url)
        latest = thread.get("latest") if isinstance(thread.get("latest"), dict) else {}
        rows.append({
            "key": thread.get("key"),
            "source": thread.get("source"),
            "title": thread.get("title"),
            "url": url or None,
            "issue_number": int(issue.group(1)) if issue else None,
            "pull_number": int(pull.group(1)) if pull else None,
            "stage": thread.get("stage"),
            "subscriptions": thread.get("subscriptions"),
            "last_at": thread.get("lastAt"),
            "latest": {"at": latest.get("at"), "preview": clip(latest.get("preview"), 200)} if latest else None,
        })
    return rows


def source_thread(detail: dict) -> dict | None:
    """The Issue thread a reply belongs on. A Pull Request thread is never it."""
    mandate = detail.get("mandate") if isinstance(detail.get("mandate"), dict) else {}
    basis = mandate.get("basis") if isinstance(mandate.get("basis"), dict) else {}
    scope = basis.get("scope") if isinstance(basis.get("scope"), dict) else {}
    number = scope.get("number")
    issues = [row for row in thread_view(detail) if row["issue_number"] and not row["pull_number"]]
    if not issues:
        return None
    chosen = None
    if isinstance(number, int):
        chosen = next((row for row in issues if row["issue_number"] == number), None)
    chosen = chosen or issues[0]
    return {key: chosen[key] for key in ("key", "title", "url", "issue_number", "stage", "subscriptions")}


def pull_requests(detail: dict) -> list[dict]:
    seen, rows = set(), []
    for row in thread_view(detail):
        number = row.get("pull_number")
        if not number or number in seen:
            continue
        seen.add(number)
        rows.append({"number": number, "url": row.get("url"), "thread_key": row.get("key"), "stage": row.get("stage")})
    return sorted(rows, key=lambda item: item["number"])


def local_reply_plans(ticket_id: str) -> list[dict]:
    """Local reply plans written by `github_source.py reply prepare`, newest last."""
    directory = state_root() / "reply" / "plans"
    found: list[dict] = []
    if not directory.is_dir():
        return found
    for path in sorted(directory.glob("*.json")):
        try:
            plan = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(plan, dict) or str(plan.get("ticket")) != str(ticket_id):
            continue
        found.append({
            "marker": plan.get("marker"),
            "status": plan.get("status"),
            "created_at": plan.get("created_at"),
            "sent_at": plan.get("sent_at"),
            "issue_url": plan.get("issue_url"),
            "plan": str(path),
        })
    found.sort(key=lambda item: str(item.get("created_at") or ""))
    return found


# --------------------------------------------------------------------------- #
# Inbox and detail
# --------------------------------------------------------------------------- #

def question_of(detail: dict, latest: dict | None) -> tuple[str | None, str | None]:
    attention = detail.get("attention") if isinstance(detail.get("attention"), dict) else {}
    note = detail.get("note") if isinstance(detail.get("note"), dict) else {}
    for value, label in ((attention.get("question"), "attention.question"), (note.get("text"), "note.text")):
        text = clip(value, 600)
        if text:
            return text, label
    summary = clip((latest or {}).get("report_summary"), 600) or clip(detail.get("summary"), 600)
    if summary:
        return summary, "report.summary"
    return None, None


def inbox_entry(detail: dict) -> dict:
    rows = assignment_rows(detail)
    views = [assignment_view(row) for row in rows]
    latest = assignment_view(newest_assignment(rows)) if rows else None
    triage, reason = triage_of(detail, latest)
    question, question_source = question_of(detail, latest)
    return {
        "id": detail.get("id"),
        "state": detail.get("state"),
        "stage": detail.get("stage"),
        "action": detail.get("action"),
        "title": detail.get("title"),
        "updatedAt": detail.get("updatedAt"),
        "latest_assignment": latest,
        "assignments": views,
        "report_summary": (latest or {}).get("report_summary"),
        "question": question,
        "question_source": question_source,
        "source_thread": source_thread(detail),
        "pull_requests": pull_requests(detail),
        "actions": detail.get("actions") if isinstance(detail.get("actions"), dict) else {},
        "delivery": delivery_view(detail),
        "triage": triage,
        "triage_reason": reason,
    }


def next_actions(detail: dict, triage: str, source: dict | None, plans: list[dict]) -> list[dict]:
    """Executable next steps. `allowed` follows the Ticket's own actions and stage."""
    actions = detail.get("actions") if isinstance(detail.get("actions"), dict) else {}
    ended = bool(detail.get("ended"))
    latest_plan = plans[-1] if plans else None
    reply_allowed = bool(source) and not ended
    if not source:
        reply_why = "no_source_thread: this ticket has no GitHub Issue thread to reply on"
    elif ended:
        reply_why = "ticket ended: a reply would have to resume it under an unchanged mandate"
    else:
        reply_why = f"reply on {source.get('url')}"
    reconcile_allowed = bool(latest_plan and latest_plan.get("status") in ("unknown", "sending", "sent"))
    wait_allowed = triage in ("running", "review_reported") or bool(latest_plan and latest_plan.get("status") in ("prepared", "sending"))
    return [
        {"action": "reply", "allowed": reply_allowed, "why": reply_why},
        {"action": "retry", "allowed": bool(actions.get("retry")),
         "why": "actions.retry is true" if actions.get("retry") else "actions.retry is false or absent"},
        {"action": "stop", "allowed": bool(actions.get("stop")),
         "why": ("actions.stop is true; a stop ends the ticket as stopped_by_human, never a pass"
                 if actions.get("stop") else "actions.stop is false or absent")},
        {"action": "wait", "allowed": wait_allowed,
         "why": f"triage is {triage}" + (f"; local reply plan status {latest_plan.get('status')}" if latest_plan else "")},
        {"action": "reconcile", "allowed": reconcile_allowed,
         "why": (f"read-only reconcile of local reply plan {latest_plan.get('marker')} ({latest_plan.get('status')})"
                 if reconcile_allowed else "no local reply plan in unknown/sent state")},
    ]


def detail_result(port: int, ticket_id: str) -> dict:
    detail = ticket_detail(port, ticket_id)
    entry = inbox_entry(detail)
    decision = detail.get("decision") if isinstance(detail.get("decision"), dict) else {}
    mandate = detail.get("mandate") if isinstance(detail.get("mandate"), dict) else {}
    basis = mandate.get("basis") if isinstance(mandate.get("basis"), dict) else {}
    scope = basis.get("scope") if isinstance(basis.get("scope"), dict) else {}
    ended = detail.get("ended") if isinstance(detail.get("ended"), dict) else None
    plans = local_reply_plans(ticket_id)
    threads = thread_view(detail)
    return {
        **entry,
        "summary": clip(detail.get("summary"), 4000),
        "report_summary": entry["report_summary"],
        "latest_assignment": entry["latest_assignment"],
        "all_assignments": entry["assignments"],
        "summary_truncated": bool(isinstance(detail.get("summary"), str) and len(detail["summary"]) > 4000),
        "report_present": bool(entry["report_summary"]),
        "threads": threads,
        "subscriptions": [{"key": row["key"], "subscriptions": row["subscriptions"], "stage": row["stage"],
                           "url": row["url"]} for row in threads],
        "channels": [{"source": row.get("source"), "url": row.get("url"),
                      "label": row.get("label")} for row in detail.get("channels") or [] if isinstance(row, dict)],
        "decision": {
            "id": decision.get("id"),
            "kind": decision.get("kind"),
            "outcome": decision.get("outcome"),
            "at": decision.get("at"),
            "strength": decision.get("strength"),
            "thread": decision.get("thread"),
            "trigger_ids": decision.get("triggerIds") or [],
            "preview": clip(decision.get("preview"), 400),
        } if decision else None,
        "acceptance": {
            "accepted": decision.get("outcome") == "accept",
            "decision_outcome": decision.get("outcome"),
            "decision_at": decision.get("at"),
            "note": "acceptance.accepted records an authorization to start work; it is not a delivery",
        },
        "mandate": {
            "strength": mandate.get("strength") or detail.get("strength"),
            "sender": basis.get("sender"),
            "source": basis.get("source"),
            "via": basis.get("via"),
            "scope": scope or None,
        },
        "ended": ended,
        "createdAt": detail.get("createdAt"),
        "updatedAt": detail.get("updatedAt"),
        "local_reply": {"plans": plans, "latest": plans[-1] if plans else None},
        "next_actions": next_actions(detail, entry["triage"], entry["source_thread"], plans),
    }


def collect_person(port: int, limit: int, offset: int, everything: bool) -> dict:
    """Read person tickets, following `next_offset` when `everything` is set."""
    items: list[dict] = []
    seen: set[str] = set()
    scanned = 0
    total = None
    next_offset = None
    cursor = 0 if everything else offset
    while True:
        page = api(port, "tickets?" + urlencode({"state": "person", "limit": limit, "offset": cursor}))
        if not isinstance(page, dict):
            raise RuntimeError("ticket list is not an object")
        rows = [row for row in page.get("items") or [] if isinstance(row, dict)]
        scanned += len(rows)
        for row in rows:
            key = str(row.get("id") or "")
            if key and key not in seen:
                seen.add(key)
                items.append(row)
        total = page.get("total", total)
        next_offset = page.get("next_offset")
        if not everything or not rows or next_offset in (None, "", 0):
            break
        following = int(next_offset)
        if following <= cursor or scanned >= MAX_ALL_SCAN:
            break
        cursor = following
    return {"items": items, "scanned": scanned, "total": total, "next_offset": next_offset}


def inbox(args) -> dict:
    page = collect_person(args.port, args.limit, args.offset, args.all)
    entries, failures = [], []
    for row in page["items"]:
        ticket_id = str(row.get("id") or "")
        try:
            detail = ticket_detail(args.port, ticket_id)
        except (OSError, RuntimeError, ValueError) as error:
            failures.append({"id": ticket_id, "reason": "detail_unreadable", "detail": clip(str(error), 200)})
            detail = row
        entry = inbox_entry(detail)
        if not assignment_rows(detail):
            entry["triage_reason"] = "list row only; assignment detail unavailable"
        entries.append(entry)
    entries.sort(key=lambda item: str(item.get("updatedAt") or ""), reverse=True)
    return {
        "port": args.port,
        "state": "person",
        "total": page["total"],
        "scanned": page["scanned"],
        "shown": len(entries),
        "offset": 0 if args.all else args.offset,
        "limit": args.limit,
        "next_offset": None if args.all else page["next_offset"],
        "all": bool(args.all),
        "detail_failures": failures,
        "items": entries,
    }


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def add_port(target: argparse.ArgumentParser) -> None:
    # SUPPRESS keeps the root --port when the flag is not repeated after the command.
    target.add_argument("--port", type=int, default=argparse.SUPPRESS, help="override the root --port")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("--port", type=int, default=3082)
    commands = root.add_subparsers(dest="command", required=True)
    for name in ("state", "sources"):
        add_port(commands.add_parser(name))
    tickets = commands.add_parser("tickets")
    tickets.add_argument("--state", choices=STAGES, default="open")
    tickets.add_argument("--limit", type=int, default=20)
    tickets.add_argument("--offset", type=int, default=0)
    add_port(tickets)
    ticket = commands.add_parser("ticket")
    ticket.add_argument("ticket_id")
    add_port(ticket)
    detail = commands.add_parser("detail")
    detail.add_argument("ticket_id")
    add_port(detail)
    for name in ("inbox", "todos"):
        command = commands.add_parser(name, help="person tickets that wait for a human, with triage")
        command.add_argument("--limit", type=int, default=50, help="page size")
        command.add_argument("--offset", type=int, default=0)
        command.add_argument("--all", action="store_true", help="follow next_offset to the last page")
        command.add_argument("--json", action="store_true", help="output is JSON already; accepted for scripts")
        add_port(command)
    return root


def main() -> int:
    root = parser()
    args = root.parse_args()
    if not 0 < args.port < 65536:
        root.error("invalid loopback port")
    command = args.command
    try:
        if command in ("inbox", "todos"):
            if not 0 < args.limit <= 1000 or args.offset < 0:
                root.error("invalid limit or offset")
            emit({"ok": True, **inbox(args)})
            return 0
        if command == "detail":
            emit({"ok": True, **detail_result(args.port, args.ticket_id)})
            return 0
        if command == "tickets":
            if not 0 < args.limit <= 1000 or args.offset < 0:
                root.error("invalid limit or offset")
            route = "tickets?" + urlencode({"state": args.state, "limit": args.limit, "offset": args.offset})
        elif command == "ticket":
            route = "tickets/" + quote(args.ticket_id, safe="")
        else:
            route = command
        data = project(command, api(args.port, route))
        emit({"ok": True, **data})
        return 0
    except ApiError as error:
        emit({"ok": False, "http_status": error.status, "reason": "superagent_query_failed"})
        return 1
    except (OSError, UnicodeError, ValueError, http.client.HTTPException, AttributeError, KeyError, TypeError, RuntimeError):
        emit({"ok": False, "reason": "superagent_unavailable_or_incompatible"})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
