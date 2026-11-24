"""Offline tests for the SuperAgent todo inbox, thread replies and local verdicts.

The management API and `gh` are fakes: no network, no GitHub write, no profile
change. They prove the measured shapes that matter:

* a newest Assignment still `running` with `report.state=ready` and
  `turnEndedAt` is the effective one and is `review_ready`;
* `inputs[].deliveredTo` names the Assignment (measured 5/5 on a live profile)
  or the Ticket, and either is "Delivered to Ticket";
* `stop` is a human stop, an accepted Decision is not a delivery;
* a duplicate marker, a timed-out send and a repeated poll change nothing.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import pytest

SKILL = Path(__file__).resolve().parents[1] / "skills" / "deepseek-harness-bridge"
SUPERAGENT = SKILL / "scripts" / "superagent.py"
GITHUB = SKILL / "scripts" / "github_source.py"
REPO = "example/prototype"
AGENT = "example-agent"
ACTOR = "example-actor"
MARKER = "dsb-20260101T000000Z-abcdef12"
ISSUE = 7


# --------------------------------------------------------------------------- #
# Fixtures that mirror the measured management API shapes
# --------------------------------------------------------------------------- #
def assignment(aid: str, *, state: str = "running", report_state: str | None = "ready",
               created: str = "2026-01-01T00:00:01Z", started: str = "2026-01-01T00:00:02Z",
               report_at: str | None = "2026-01-01T00:05:00Z", turn_ended: str | None = None,
               ended: str | None = None, reason: str | None = None, summary: str = "worker report",
               ref: str = "worker-session-1") -> dict:
    row = {"id": aid, "state": state, "ref": ref, "createdAt": created, "startedAt": started}
    if report_state is not None:
        row["report"] = {"state": report_state, "summary": summary, "at": report_at}
    if turn_ended:
        row["turnEndedAt"] = turn_ended
    if ended:
        row["endedAt"] = ended
    if reason:
        row["endedReason"] = reason
    return row


def ticket_input(iid: str, *, delivered: bool = True, delivered_to: str | None = "assignment-2",
                 at: str = "2026-01-01T00:03:00Z", read_at: str | None = "2026-01-01T00:03:10Z",
                 preview: str = "@agent request") -> dict:
    return {"id": iid, "kind": "trigger", "at": at, "human": True, "readAt": read_at,
            "deliveredTo": delivered_to, "delivered": delivered,
            "trigger": {"id": "trigger-1", "human": True, "preview": preview,
                        "thread": f"github:{ISSUE}"}}


def threads(*, issue: int = ISSUE, pull: int | None = 136) -> list[dict]:
    rows = [{"key": f"github:{issue}", "source": "github", "title": f"#{issue} work",
             "url": f"https://github.com/{REPO}/issues/{issue}", "stage": "subscribed",
             "subscriptions": 1, "lastAt": "2026-01-01T00:03:00Z",
             "latest": {"at": "2026-01-01T00:03:00Z", "preview": "@agent request"}}]
    if pull:
        rows.append({"key": f"github:{pull}", "source": "github", "title": f"github:{pull}",
                     "url": f"https://github.com/{REPO}/pull/{pull}", "stage": "subscribed",
                     "subscriptions": 1, "lastAt": "2026-01-01T00:05:00Z"})
    return rows


def ticket(tid: str, *, state: str = "open", stage: str = "person", action: str = "review",
           assignments: list[dict] | None = None, inputs: list[dict] | None = None,
           undelivered: int = 0, ended: dict | None = None, actions: dict | None = None,
           decision: dict | None = None, threads_rows: list[dict] | None = None,
           updated: str = "2026-01-01T00:05:00Z", title: str = "work item",
           summary: str = "worker report", issue: int = ISSUE) -> dict:
    rows = assignments if assignments is not None else [
        assignment("assignment-2", turn_ended="2026-01-01T00:05:00Z")]
    return {
        "id": tid,
        "title": title,
        "state": state,
        "stage": stage,
        "action": action,
        "actions": actions if actions is not None else {"retry": False, "stop": state != "ended"},
        "strength": "explicit",
        "assignments": rows,
        "inputs": inputs if inputs is not None else [ticket_input("input-1")],
        "undelivered": undelivered,
        "sessionId": "worker-session-1",
        "directory": "C:/work",
        "summary": summary,
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": updated,
        "threads": threads_rows if threads_rows is not None else threads(issue=issue),
        "mandate": {"strength": "explicit", "basis": {"source": "github", "sender": ACTOR,
                                                      "via": "addressed",
                                                      "scope": {"number": issue, "isPr": False,
                                                                "kind": "issue"}}},
        "paused": False,
        "channels": [{"source": "github", "url": f"https://github.com/{REPO}/issues/{issue}",
                      "label": {"zh": f"GitHub #{issue}", "en": f"GitHub #{issue}"}}],
        "decision": decision if decision is not None else {
            "id": "decision-1", "kind": "accept", "outcome": "accept", "at": "2026-01-01T00:00:00Z",
            "strength": "explicit", "triggerIds": ["trigger-1"], "thread": f"github:{issue}",
            "preview": "@agent request"},
        "ended": ended,
        "environment": [],
    }


def list_row(detail: dict) -> dict:
    """The list view carries counts, not Assignment objects, plus title and threads."""
    return {
        "id": detail["id"], "title": detail["title"], "state": detail["state"],
        "stage": detail["stage"], "action": detail["action"], "actions": detail["actions"],
        "strength": detail["strength"], "assignments": len(detail["assignments"]),
        "inputs": len(detail["inputs"]), "undelivered": detail["undelivered"],
        "summary": detail["summary"], "createdAt": detail["createdAt"],
        "updatedAt": detail["updatedAt"], "threads": detail["threads"],
        "ended": detail["ended"],
    }


@pytest.fixture
def world(tmp_path):
    """One fake management API and one fake gh, shared by both scripts."""
    data = {
        "repository": REPO,
        "tickets": {},
        "order": [],
        "comments": tmp_path / "comments.json",
        "log": tmp_path / "gh.log",
        "state": tmp_path / "state",
    }
    data["comments"].write_text("[]", encoding="utf-8")
    data["state"].mkdir()

    def add(detail: dict) -> dict:
        data["tickets"][detail["id"]] = detail
        data["order"].append(detail["id"])
        return detail

    data["add"] = add

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            path, _, query = self.path.partition("?")
            params = dict(part.split("=", 1) for part in query.split("&") if "=" in part)
            if path.endswith("/state"):
                payload = {
                    "setup": {"problem": None,
                              "accounts": {"repository": data["repository"], "agent": AGENT,
                                           "feishu": None}},
                    "load": {"running": 0, "queued": 0, "maxWorkers": 4},
                    "paused": False,
                    "health": {"github": {"state": "ready"}},
                }
            elif path.endswith("/sources"):
                payload = [{"id": "github", "installed": True, "enabled": True, "state": "ready"}]
            elif path.endswith("/settings"):
                payload = {"blocks": {"policy": {"value": {"sources": {
                    "github": {"allowed": [{"id": ACTOR}]}}}}}}
            elif path.endswith("/tickets"):
                limit = int(params.get("limit", 20))
                offset = int(params.get("offset", 0))
                ids = [tid for tid in data["order"]
                       if data["tickets"][tid]["state"] != "ended"]
                window = ids[offset:offset + limit]
                following = offset + len(window)
                payload = {"items": [list_row(data["tickets"][tid]) for tid in window],
                           "total": len(ids),
                           "next_offset": following if following < len(ids) else None}
            elif "/tickets/" in path:
                tid = path.rsplit("/", 1)[-1]
                payload = data["tickets"].get(tid, {})
            else:
                payload = {}
            body = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    fake_gh = tmp_path / "fake_gh.py"
    template = textwrap.dedent(r'''
        import json, os, re, sys, time
        args = sys.argv[1:]
        with open(__LOG__, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(args) + "\n")
        comments_file = __COMMENTS__

        def comments():
            return json.load(open(comments_file, encoding="utf-8"))

        def post(body):
            rows = comments()
            row = {"id": 901 + len(rows),
                   "html_url": f"https://github.com/__REPO__/issues/7#issuecomment-{901 + len(rows)}",
                   "user": {"login": __ACTOR__}, "body": body,
                   "created_at": "2026-01-01T00:10:00Z", "updated_at": "2026-01-01T00:10:00Z"}
            rows.append(row)
            json.dump(rows, open(comments_file, "w", encoding="utf-8"))
            print(json.dumps(row))
            return 0

        def endpoint():
            for item in args:
                if item.startswith("repos/") or item.startswith("search/"):
                    return item.split("?", 1)[0]
            return ""

        if args[:3] == ["api", "user", "--jq"]:
            print(__ACTOR__); raise SystemExit(0)
        if args[:2] == ["api", "graphql"]:
            print(json.dumps({"data": {"repository": {"pullRequest": {
                "number": 136, "url": "https://github.com/__REPO__/pull/136", "state": "OPEN",
                "merged": False, "isDraft": False, "mergeStateStatus": "CLEAN",
                "reviewDecision": None, "baseRefName": "main", "headRefOid": "sha-136"}}}}))
            raise SystemExit(0)
        if args[:2] == ["pr", "checks"]:
            print("[]"); raise SystemExit(0)
        target = endpoint()
        method = "POST" if "--method" in args and args[args.index("--method") + 1] == "POST" else "GET"
        if method == "POST" and target.endswith("/comments"):
            if float(os.environ.get("FAKE_GH_DELAY", "0")):
                time.sleep(float(os.environ["FAKE_GH_DELAY"]))
            body = next((item.split("=", 1)[1] for item in args if item.startswith("body=")), "")
            raise SystemExit(post(body))
        if "--paginate" in args and target.endswith("/comments"):
            print(json.dumps(comments())); raise SystemExit(0)
        if target.startswith("search/"):
            print(json.dumps({"items": []})); raise SystemExit(0)
        if re.fullmatch(r"repos/[^/]+/[^/]+", target):
            print(json.dumps({"permissions": {"push": True}, "has_issues": True, "private": False}))
            raise SystemExit(0)
        if re.search(r"/pulls/\d+$", target):
            print(json.dumps({"number": 136, "html_url": "https://github.com/__REPO__/pull/136",
                              "state": "open", "merged": False, "draft": False,
                              "mergeable_state": "clean", "reviewDecision": None,
                              "base": {"ref": "main"}, "head": {"sha": "sha-136"}}))
            raise SystemExit(0)
        if re.search(r"/commits/[^/]+/check-runs$", target):
            print(json.dumps({"total_count": 0, "check_runs": []})); raise SystemExit(0)
        if re.search(r"/commits/[^/]+/status$", target):
            print(json.dumps({"state": "success", "total_count": 0})); raise SystemExit(0)
        if re.search(r"/issues/\d+$", target):
            print(json.dumps({"number": 7, "title": "Issue", "state": "open",
                              "html_url": "https://github.com/__REPO__/issues/7",
                              "user": {"login": __ACTOR__},
                              "created_at": "2026-01-01T00:00:00Z",
                              "updated_at": "2026-01-01T00:11:00Z",
                              "body": "@__AGENT__ [dsh-bridge:__MARKER__] request"}))
            raise SystemExit(0)
        print("{}"); raise SystemExit(0)
    ''')
    fake_gh.write_text(
        template.replace("__LOG__", repr(str(data["log"])))
                .replace("__COMMENTS__", repr(str(data["comments"])))
                .replace("__REPO__", REPO)
                .replace("__ACTOR__", repr(ACTOR))
                .replace("__AGENT__", AGENT)
                .replace("__MARKER__", MARKER),
        encoding="utf-8",
    )

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    Thread(target=server.serve_forever, daemon=True).start()
    data["port"] = server.server_port

    def run(script: Path, *arguments, env=None):
        environment = {**os.environ, "FAKE_GH_COMMENTS": str(data["comments"]),
                       "FAKE_GH_LOG": str(data["log"]),
                       "DSH_BRIDGE_SKILL_STATE": str(data["state"]), **(env or {})}
        result = subprocess.run(
            [sys.executable, str(script), "--gh", f"{sys.executable} {fake_gh}", *arguments],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
            env=environment, check=False,
        )
        return result

    def superagent(*arguments, env=None):
        environment = {**os.environ, "DSH_BRIDGE_SKILL_STATE": str(data["state"]), **(env or {})}
        return subprocess.run(
            [sys.executable, str(SUPERAGENT), "--port", str(server.server_port), *arguments],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
            env=environment, check=False,
        )

    try:
        yield data, run, superagent
    finally:
        server.shutdown()
        server.server_close()


def payload(result):
    return json.loads(result.stdout)


def gh_log(world) -> str:
    path = world["log"]
    return path.read_text(encoding="utf-8") if path.is_file() else ""


def comments_rows(world) -> list:
    return json.loads(world["comments"].read_text(encoding="utf-8"))


# --------------------------------------------------------------------------- #
# R5.1  old failed/retried + new running with a ready report
# --------------------------------------------------------------------------- #
def test_latest_assignment_wins_over_a_retried_one_and_is_review_ready(world):
    data, _, superagent = world
    data["add"](ticket("ticket-1", assignments=[
        assignment("assignment-1", state="ended", report_state="failed", summary="LlmError: terminated",
                   created="2026-01-01T00:00:01Z", ended="2026-01-01T00:10:00Z", reason="retried"),
        assignment("assignment-2", state="running", report_state="ready", summary="PR #136 ready",
                   created="2026-01-01T00:10:01Z", report_at="2026-01-01T00:20:00Z",
                   turn_ended="2026-01-01T00:20:00Z"),
    ]))
    result = superagent("inbox", "--all")
    assert result.returncode == 0, result.stdout + result.stderr
    item = payload(result)["items"][0]
    assert item["latest_assignment"]["id"] == "assignment-2"
    assert item["latest_assignment"]["state"] == "running"
    assert item["latest_assignment"]["state_effective"] == "ended"
    assert item["latest_assignment"]["stale_running_ignored"] is True
    assert item["latest_assignment"]["report_state"] == "ready"
    assert item["triage"] == "review_ready"
    assert item["report_summary"] == "PR #136 ready"
    assert item["actions"] == {"retry": False, "stop": True}
    assert item["source_thread"]["issue_number"] == ISSUE
    assert [pr["number"] for pr in item["pull_requests"]] == [136]

    detail = superagent("detail", "ticket-1")
    assert detail.returncode == 0
    full = payload(detail)
    assert [row["id"] for row in full["all_assignments"]] == ["assignment-1", "assignment-2"]
    assert full["latest_assignment"]["id"] == "assignment-2"
    assert full["triage"] == "review_ready"
    actions = {row["action"]: row["allowed"] for row in full["next_actions"]}
    assert actions["reply"] is True and actions["stop"] is True and actions["retry"] is False
    assert full["local_reply"]["plans"] == []


# --------------------------------------------------------------------------- #
# Every triage value is pinned here, not only in an audit probe
# --------------------------------------------------------------------------- #
def inbox_item(superagent, ticket_id: str) -> dict:
    result = superagent("inbox", "--all")
    assert result.returncode == 0, result.stdout + result.stderr
    return next(item for item in payload(result)["items"] if item["id"] == ticket_id)


def test_triage_review_reported_when_a_ready_report_has_undelivered_inputs(world):
    data, _, superagent = world
    data["add"](ticket("reported-1", undelivered=2, inputs=[
        ticket_input("input-1", delivered=False, delivered_to=None, read_at=None),
        ticket_input("input-2", delivered=False, delivered_to=None, read_at=None),
    ]))
    item = inbox_item(superagent, "reported-1")
    assert item["triage"] == "review_reported"
    assert item["latest_assignment"]["report_state"] == "ready"
    assert item["delivery"]["undelivered"] == 2
    assert item["delivery"]["pending_inputs"] == 2
    assert "not delivered" in item["triage_reason"]


def test_triage_retryable_failed_needs_a_failed_report_and_retry(world):
    data, _, superagent = world
    data["add"](ticket("failed-1", actions={"retry": True, "stop": True}, inputs=[], assignments=[
        assignment("assignment-1", state="ended", report_state="failed",
                   summary="two acceptance cases still fail", ended="2026-01-01T00:10:00Z")]))
    item = inbox_item(superagent, "failed-1")
    assert item["triage"] == "retryable_failed"
    assert item["latest_assignment"]["state_effective"] == "ended"
    assert item["latest_assignment"]["report_state"] == "failed"
    assert item["actions"]["retry"] is True
    assert "actions.retry is true" in item["triage_reason"]


def test_triage_running_only_while_the_turn_is_open(world):
    data, _, superagent = world
    data["add"](ticket("running-1", inputs=[], assignments=[
        assignment("assignment-1", state="running", report_state="progress",
                   report_at="2026-01-01T00:04:00Z")]))
    item = inbox_item(superagent, "running-1")
    assert item["triage"] == "running"
    assert item["latest_assignment"]["state_effective"] == "running"
    assert item["latest_assignment"]["stale_running_ignored"] is False


def test_triage_blocked_missing_info_when_no_report_exists(world):
    data, _, superagent = world
    data["add"](ticket("missing-1", inputs=[], assignments=[
        assignment("assignment-1", state="ended", report_state=None,
                   ended="2026-01-01T00:10:00Z")]))
    item = inbox_item(superagent, "missing-1")
    assert item["triage"] == "blocked_missing_info"
    assert item["latest_assignment"]["report_state"] is None
    assert item["report_summary"] is None
    assert "no worker report" in item["triage_reason"]


def test_triage_ended_wins_over_retryable_failed(world):
    data, _, superagent = world
    data["add"](ticket("ended-1", state="ended", stage="ended", action=None, inputs=[],
                       actions={"retry": True, "stop": False},
                       ended={"at": "2026-01-01T00:30:00Z", "by": "executor", "outcome": "completed"},
                       assignments=[assignment("assignment-1", state="ended", report_state="failed",
                                              summary="an earlier attempt failed",
                                              ended="2026-01-01T00:20:00Z")]))
    # A terminal ticket is not a person ticket, so `detail` is how it is read.
    assert "ended-1" not in [item["id"] for item in payload(superagent("inbox", "--all"))["items"]]
    result = superagent("detail", "ended-1")
    assert result.returncode == 0, result.stdout + result.stderr
    full = payload(result)
    assert full["triage"] == "ended"
    assert full["triage"] != "retryable_failed"
    assert full["actions"]["retry"] is True
    assert "completed" in full["triage_reason"]


def test_triage_unknown_for_a_failed_report_that_cannot_be_retried(world):
    data, _, superagent = world
    data["add"](ticket("odd-1", inputs=[], assignments=[
        assignment("assignment-1", state="ended", report_state="failed",
                   ended="2026-01-01T00:10:00Z")]))
    item = inbox_item(superagent, "odd-1")
    assert item["triage"] == "unknown"
    assert item["actions"]["retry"] is False
    assert "unclassified" in item["triage_reason"]


def test_triage_ended_record_without_outcome_stays_terminal_not_retryable(world):
    data, _, superagent = world
    # Older data: an ended record with terminal evidence but no outcome, plus a
    # failed, retryable Assignment. It must not read as retryable_failed.
    data["add"](ticket("legacy-1", state="ended", stage="ended", action=None, inputs=[],
                       actions={"retry": True, "stop": False},
                       ended={"at": "2026-01-01T00:30:00Z", "by": "executor"},
                       assignments=[assignment("assignment-1", state="ended", report_state="failed",
                                              summary="an earlier attempt failed",
                                              ended="2026-01-01T00:20:00Z")]))
    # Control: with an outcome the same shape still reports `ended` first.
    data["add"](ticket("legacy-2", state="ended", stage="ended", action=None, inputs=[],
                       actions={"retry": True, "stop": False},
                       ended={"at": "2026-01-01T00:30:00Z", "by": "executor", "outcome": "completed"},
                       assignments=[assignment("assignment-1", state="ended", report_state="failed",
                                              summary="an earlier attempt failed",
                                              ended="2026-01-01T00:20:00Z")]))

    missing = payload(superagent("detail", "legacy-1"))
    assert missing["triage"] == "unknown"
    assert missing["triage"] != "retryable_failed"
    reason = missing["triage_reason"]
    assert "without outcome" in reason
    assert "at=2026-01-01T00:30:00Z" in reason
    assert "by=executor" in reason
    assert missing["ended"] == {"at": "2026-01-01T00:30:00Z", "by": "executor"}
    assert missing["actions"]["retry"] is True

    control = payload(superagent("detail", "legacy-2"))
    assert control["triage"] == "ended"
    assert "completed" in control["triage_reason"]


# --------------------------------------------------------------------------- #
# R5.2  paging follows every next_offset
# --------------------------------------------------------------------------- #
def test_inbox_all_follows_every_next_offset_page(world):
    data, _, superagent = world
    for index in range(6):
        data["add"](ticket(f"ticket-{index}", updated=f"2026-01-01T00:0{index}:00Z",
                           title=f"item {index}", issue=ISSUE + index))
    first = superagent("inbox", "--limit", "2")
    assert first.returncode == 0
    page = payload(first)
    assert page["shown"] == 2 and page["scanned"] == 2 and page["next_offset"] == 2
    assert page["total"] == 6

    second = superagent("inbox", "--limit", "2", "--offset", "2")
    assert [item["id"] for item in payload(second)["items"]] == ["ticket-3", "ticket-2"]
    assert payload(second)["next_offset"] == 4

    everything = superagent("inbox", "--limit", "2", "--all", "--json")
    assert everything.returncode == 0
    full = payload(everything)
    assert full["scanned"] == 6 and full["shown"] == 6
    assert full["next_offset"] is None and full["all"] is True
    assert [item["id"] for item in full["items"]] == [
        "ticket-5", "ticket-4", "ticket-3", "ticket-2", "ticket-1", "ticket-0"]


# --------------------------------------------------------------------------- #
# R5.3  a historical ticket without a local plan is readable
# --------------------------------------------------------------------------- #
def test_historical_ticket_without_local_plan_is_readable(world):
    data, _, superagent = world
    data["add"](ticket("history-1", title="historical work", issue=120))
    result = superagent("detail", "history-1")
    assert result.returncode == 0, result.stdout + result.stderr
    full = payload(result)
    assert full["id"] == "history-1" and full["title"] == "historical work"
    assert full["source_thread"]["url"].endswith("/issues/120")
    assert full["local_reply"] == {"plans": [], "latest": None}
    inbox = superagent("inbox", "--all")
    assert [item["id"] for item in payload(inbox)["items"]] == ["history-1"]
    # Reading a historical ticket writes nothing locally.
    assert not list(data["state"].rglob("*"))


# --------------------------------------------------------------------------- #
# R5.4  stop is not a pass; acceptance is not a delivery
# --------------------------------------------------------------------------- #
def test_stop_is_not_a_pass_and_acceptance_is_not_delivery(world):
    data, run, superagent = world
    data["add"](ticket("stopped-1", state="ended", stage="ended", action=None,
                       ended={"at": "2026-01-01T00:30:00Z", "by": "human", "outcome": "stopped"},
                       threads_rows=threads()))
    refused = run(GITHUB, "verdict", "set", "--port", str(data["port"]),
                  "--ticket", "stopped-1", "--result", "pass", "--evidence", "report.md")
    assert refused.returncode == 2
    stopped = payload(refused)
    assert stopped["reason"] == "engine_state_stopped_by_human"
    assert stopped["engine_state"]["label"] == "stopped_by_human"
    assert stopped["engine_state"]["stopped_by_human"] is True
    assert not data["state"].joinpath("local", "verdicts.jsonl").exists()

    accepted = ticket("accepted-1", stage="working", action=None, assignments=[
        assignment("assignment-1", state="running", report_state="progress", report_at=None,
                   summary="")], inputs=[ticket_input("input-1", delivered=False, delivered_to=None,
                                                     read_at=None)])
    data["add"](accepted)
    not_delivered = run(GITHUB, "verdict", "set", "--port", str(data["port"]),
                        "--ticket", "accepted-1", "--result", "pass", "--evidence", "report.md")
    assert not_delivered.returncode == 2
    body = payload(not_delivered)
    assert body["reason"] == "delivery_not_proven"
    assert body["engine_state"]["acceptance"]["accepted"] is True
    assert body["engine_state"]["delivery_proven"] is False

    hold = run(GITHUB, "verdict", "set", "--port", str(data["port"]),
               "--ticket", "accepted-1", "--result", "hold", "--evidence", "notes.md",
               "--note", "waiting for the worker report")
    assert hold.returncode == 0, hold.stdout + hold.stderr
    record = payload(hold)
    assert record["local_verdict"] == "hold"
    assert record["engine_state"]["acceptance"]["accepted"] is True
    assert "acceptance_is_not_delivery" in record["record"]["warnings"]
    assert record["record"]["writer"].startswith("deepseek-harness-bridge local verdict")

    listed = run(GITHUB, "verdict", "list")
    assert listed.returncode == 0
    assert [row["ticket"] for row in payload(listed)["items"]] == ["accepted-1"]


# --------------------------------------------------------------------------- #
# R5.5  a subscribed thread delivers to the ticket without a new Decision
# --------------------------------------------------------------------------- #
def test_subscribed_thread_delivery_marks_delivered_to_ticket_without_new_decision(world):
    data, run, _ = world
    # Measured shape: deliveredTo names the Assignment.
    data["add"](ticket("assign-1", inputs=[ticket_input("input-1", delivered_to="assignment-2")]))
    # The other accepted shape: deliveredTo names the Ticket.
    data["add"](ticket("ticket-1", inputs=[ticket_input("input-2", delivered_to="ticket-1")]))

    by_assignment = run(GITHUB, "reply", "trace", "--port", str(data["port"]), "--ticket", "assign-1")
    assert by_assignment.returncode == 0, by_assignment.stdout + by_assignment.stderr
    first = payload(by_assignment)
    assert first["delivery"] == "delivered_to_ticket"
    assert first["delivered_to"]["delivered_to_kind"] == "assignment"
    assert first["stage"] == "delivered"
    assert first["new_decision_after_input"] is False
    assert first["delivery_scope"]["assignments"][0]["id"] == "assignment-2"
    assert first["delivery_scope"]["threads"][0]["key"] == f"github:{ISSUE}"
    assert "a new Decision is not required" in first["rule"]

    by_ticket = run(GITHUB, "reply", "trace", "--port", str(data["port"]), "--ticket", "ticket-1")
    assert by_ticket.returncode == 0
    assert payload(by_ticket)["delivered_to"]["delivered_to_kind"] == "ticket"


# --------------------------------------------------------------------------- #
# R5.6  the same cursor reports nothing new
# --------------------------------------------------------------------------- #
def test_repeated_poll_with_the_same_cursor_reports_nothing_new(world):
    data, run, _ = world
    data["add"](ticket("poll-1", inputs=[ticket_input("input-1")]))
    first = run(GITHUB, "reply", "poll", "--port", str(data["port"]), "--ticket", "poll-1", "--resume")
    assert first.returncode == 0, first.stdout + first.stderr
    opening = payload(first)
    assert opening["changed"] is True
    assert opening["new"] == ["delivered", "worker_read", "report_new"]
    cursor = data["state"] / "reply" / "cursors" / "poll-1.json"
    assert cursor.is_file()
    saved = json.loads(cursor.read_text(encoding="utf-8"))
    assert saved["delivered_input_id"] == "input-1"

    second = run(GITHUB, "reply", "poll", "--port", str(data["port"]), "--ticket", "poll-1")
    assert second.returncode == 0
    repeat = payload(second)
    assert repeat["changed"] is False and repeat["new"] == []
    assert repeat["cursor"]["delivered_input_id"] == "input-1"
    assert json.loads(cursor.read_text(encoding="utf-8"))["delivered_input_id"] == "input-1"


# --------------------------------------------------------------------------- #
# R5.7  a timed-out send is unknown and reconcile never resends
# --------------------------------------------------------------------------- #
def test_timed_out_reply_send_is_unknown_and_reconcile_never_resends(world):
    data, run, _ = world
    data["add"](ticket("reply-1"))
    prepared = run(GITHUB, "reply", "prepare", "--port", str(data["port"]),
                   "--ticket", "reply-1", "--request", "please add the missing test",
                   "--marker", MARKER)
    assert prepared.returncode == 0, prepared.stdout + prepared.stderr
    plan = payload(prepared)["plan"]
    assert payload(prepared)["target_issue_url"].endswith(f"/issues/{ISSUE}")
    assert not comments_rows(data)

    unknown = run(GITHUB, "reply", "send", "--plan", plan, "--yes", "--timeout", "0.5",
                  env={"FAKE_GH_DELAY": "3"})
    assert unknown.returncode == 3
    assert payload(unknown)["reason"] == "send_unknown"

    retried = run(GITHUB, "reply", "send", "--plan", plan, "--yes")
    assert retried.returncode == 3
    assert payload(retried)["reason"] == "previous_send_unknown"
    assert not comments_rows(data)

    # The comment did land after all: reconcile reads and never posts.
    data["comments"].write_text(json.dumps([{
        "id": 902, "html_url": f"https://github.com/{REPO}/issues/{ISSUE}#issuecomment-902",
        "user": {"login": ACTOR}, "body": f"@{AGENT} [dsh-bridge:{MARKER}] please add the missing test",
        "created_at": "2026-01-01T00:10:00Z", "updated_at": "2026-01-01T00:10:00Z"}]), encoding="utf-8")
    before = gh_log(data).count('"POST"')
    reconciled = run(GITHUB, "reply", "send", "--plan", plan, "--yes", "--reconcile")
    assert reconciled.returncode == 0, reconciled.stdout + reconciled.stderr
    assert payload(reconciled)["reason"] == "reconciled_without_resend"
    assert gh_log(data).count('"POST"') == before
    assert len(comments_rows(data)) == 1


# --------------------------------------------------------------------------- #
# R5.8  a duplicate marker is not commented twice
# --------------------------------------------------------------------------- #
def test_duplicate_marker_is_not_commented_twice(world):
    data, run, _ = world
    data["add"](ticket("reply-2"))
    prepared = run(GITHUB, "reply", "prepare", "--port", str(data["port"]),
                   "--ticket", "reply-2", "--request", "please rerun the audit",
                   "--marker", MARKER)
    assert prepared.returncode == 0, prepared.stdout + prepared.stderr
    plan = payload(prepared)["plan"]
    data["comments"].write_text(json.dumps([{
        "id": 903, "html_url": f"https://github.com/{REPO}/issues/{ISSUE}#issuecomment-903",
        "user": {"login": ACTOR}, "body": f"@{AGENT} [dsh-bridge:{MARKER}] please rerun the audit",
        "created_at": "2026-01-01T00:10:00Z", "updated_at": "2026-01-01T00:10:00Z"}]), encoding="utf-8")
    before = gh_log(data).count('"POST"')

    duplicate = run(GITHUB, "reply", "send", "--plan", plan, "--yes")
    assert duplicate.returncode == 0, duplicate.stdout + duplicate.stderr
    output = payload(duplicate)
    assert output["duplicate"] is True
    assert output["comment_url"].endswith("issuecomment-903")
    assert gh_log(data).count('"POST"') == before
    assert len(comments_rows(data)) == 1

    again = run(GITHUB, "reply", "send", "--plan", plan, "--yes")
    assert again.returncode == 0 and payload(again)["duplicate"] is True
    assert len(comments_rows(data)) == 1


# --------------------------------------------------------------------------- #
# Acceptance 4: repository_matches=false refuses dispatch
# --------------------------------------------------------------------------- #
def test_precheck_repository_mismatch_refuses_reply_prepare(world):
    data, run, _ = world
    data["add"](ticket("reply-3"))
    data["repository"] = "someone/else"
    refused = run(GITHUB, "reply", "prepare", "--port", str(data["port"]),
                  "--ticket", "reply-3", "--request", "do the work")
    assert refused.returncode == 1
    output = payload(refused)
    assert output["reason"] == "precheck_failed"
    checks = {row["name"]: row["ok"] for row in output["precheck"]["checks"]}
    assert checks["repository_matches"] is False
    assert not (data["state"] / "reply" / "plans").exists()

    # The same check is what an acceptance run shows when the profile is bound to
    # another repository: the event cannot be dispatched from this profile.
    precheck = run(GITHUB, "precheck", "--port", str(data["port"]), "--repo", "example/other-repo",
                   "--actor", ACTOR)
    assert precheck.returncode == 1
    assert {row["name"]: row["ok"] for row in payload(precheck)["checks"]}["repository_matches"] is False
