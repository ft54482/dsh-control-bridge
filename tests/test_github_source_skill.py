"""Offline tests for the GitHub Source trigger/trace helper.

The SuperAgent API and gh are fakes: no network, no GitHub event, no profile
change. They prove the trigger format, explicit-send gate, idempotency,
timeout handling and Ticket/Assignment correlation.
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

SCRIPT = (Path(__file__).resolve().parents[1] / "skills" / "deepseek-harness-bridge"
          / "scripts" / "github_source.py")
REPO = "example/prototype"
AGENT = "example-agent"
ACTOR = "example-actor"
MARKER = "dsb-20260101T000000Z-abcdef12"


@pytest.fixture
def skill_env(tmp_path):
    comments = tmp_path / "comments.json"
    comments.write_text("[]", encoding="utf-8")
    log = tmp_path / "gh.log"
    state = tmp_path / "state"
    state.mkdir()

    fake_gh = tmp_path / "fake_gh.py"
    template = textwrap.dedent(r'''
        import json, os, sys, time
        args = sys.argv[1:]
        with open(__LOG__, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(args) + "\n")
        if args[:3] == ["api", "user", "--jq"]:
            print(os.environ.get("FAKE_GH_USER", __ACTOR__)); raise SystemExit(0)
        path = next((item for item in args if item.startswith("repos/")), "")
        endpoint = path.split("?", 1)[0]
        method = "POST" if "--method" in args and args[args.index("--method") + 1] == "POST" else "GET"
        comments_file = os.environ.get("FAKE_GH_COMMENTS", __COMMENTS__)
        if method == "POST" and endpoint.endswith("/comments"):
            if float(os.environ.get("FAKE_GH_DELAY", "0")):
                time.sleep(float(os.environ["FAKE_GH_DELAY"]))
            body = next((item.split("=", 1)[1] for item in args if item.startswith("body=")), "")
            rows = json.load(open(comments_file, encoding="utf-8"))
            row = {"id": 901, "html_url": "https://github.com/__REPO__/issues/7#issuecomment-901",
                   "body": body, "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"}
            json.dump([*rows, row], open(comments_file, "w", encoding="utf-8"))
            print(json.dumps(row)); raise SystemExit(0)
        if "--paginate" in args and endpoint.endswith("/comments"):
            print(open(comments_file, encoding="utf-8").read()); raise SystemExit(0)
        if args[:2] == ["issue", "create"]:
            print(f"https://github.com/__REPO__/issues/77"); raise SystemExit(0)
        if args[:1] == ["api"] and len(args) > 1 and args[1].startswith("search/issues"):
            print(json.dumps({"items": []})); raise SystemExit(0)
        if endpoint.count("/") == 2:
            print(json.dumps({"permissions": {"push": True}, "has_issues": True, "private": False})); raise SystemExit(0)
        if endpoint.startswith("repos/__REPO__/issues/7"):
            print(json.dumps({"number": 7, "title": "Issue", "state": "open",
                              "html_url": "https://github.com/__REPO__/issues/7",
                              "user": {"login": __ACTOR__}, "created_at": "2026-01-01T00:00:00Z",
                              "updated_at": "2026-01-01T00:01:00Z",
                              "body": "@__AGENT__ [dsh-bridge:__MARKER__] request"})); raise SystemExit(0)
        print("{}"); raise SystemExit(0)
    ''')
    fake_gh.write_text(
        template.replace("__LOG__", repr(str(log)))
                .replace("__COMMENTS__", repr(str(comments)))
                .replace("__REPO__", REPO)
                .replace("__ACTOR__", repr(ACTOR))
                .replace("__AGENT__", AGENT)
                .replace("__MARKER__", MARKER),
        encoding="utf-8",
    )

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path.endswith("/state"):
                payload = {"setup": {"problem": None, "accounts": {"repository": REPO, "agent": AGENT, "feishu": None}},
                           "load": {"running": 1, "queued": 0, "maxWorkers": 4}, "paused": False,
                           "health": {"github": {"state": "ready"}}}
            elif path.endswith("/sources"):
                payload = [{"id": "github", "installed": True, "enabled": True, "state": "ready"}]
            elif path.endswith("/settings"):
                payload = {"blocks": {"policy": {"value": {"sources": {"github": {"allowed": [{"id": ACTOR}]}}}}}}
            elif path.endswith("/tickets") or path.endswith("/tickets/"):
                payload = {"items": [{"id": "ticket-1", "state": "open", "stage": "working", "action": None,
                                      "threads": [{"url": f"https://github.com/{REPO}/issues/7"}]}],
                           "total": 1, "next_offset": None}
            elif path.endswith("/tickets/ticket-1"):
                payload = {"id": "ticket-1", "state": "open", "stage": "working", "action": None, "strength": "explicit",
                           "mandate": {"basis": {"source": "github", "sender": ACTOR, "via": "addressed",
                                                 "scope": {"number": 7, "kind": "issue", "isPr": False}}},
                           "decision": {"id": "decision-1", "outcome": "accept", "at": "2026-01-01T00:00:02Z",
                                        "triggerIds": ["trigger-1"],
                                        "preview": f"@{AGENT} [dsh-bridge:{MARKER}] request"},
                           "threads": [{"key": "github:7", "url": f"https://github.com/{REPO}/issues/7",
                                        "latest": {"preview": f"@{AGENT} [dsh-bridge:{MARKER}] request"}}],
                           "channels": [{"source": "github", "url": f"https://github.com/{REPO}/issues/7"}],
                           "assignments": [{"id": "assignment-1", "state": "running", "ref": "worker-session-1",
                                            "report": {"state": "ready", "summary": "done"},
                                            "startedAt": "2026-01-01T00:00:01Z",
                                            "turnEndedAt": "2026-01-01T00:05:00Z",
                                            "idleAt": "2026-01-01T00:05:01Z"}],
                           "reply": {"source": "github", "url": f"https://github.com/{REPO}/issues/7"}}
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

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    Thread(target=server.serve_forever, daemon=True).start()

    def run(command, *arguments, env=None):
        base_env = {**os.environ, "FAKE_GH_COMMENTS": str(comments), "FAKE_GH_LOG": str(log),
                    "DSH_BRIDGE_SKILL_STATE": str(state), **(env or {})}
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--gh", f"{sys.executable} {fake_gh}", command, *arguments],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20, env=base_env, check=False,
        )
        return result, comments, log

    try:
        yield run, server.server_port, state, comments, log
    finally:
        server.shutdown()
        server.server_close()


def common(port, *, repo=REPO, actor=ACTOR):
    return ["--port", str(port), "--repo", repo, "--actor", actor]


def test_precheck_rejects_a_repo_or_actor_mismatch(skill_env):
    run, port, *_ = skill_env
    mismatched, _, _ = run("precheck", *common(port, repo="other/repo"))
    assert mismatched.returncode == 1
    payload = json.loads(mismatched.stdout)
    assert payload["ok"] is False
    assert next(item for item in payload["checks"] if item["name"] == "repository_matches")["ok"] is False
    assert payload["trigger"]["recommended"] == "comment"

    unlisted, _, _ = run("precheck", *common(port, actor="intruder"))
    assert unlisted.returncode == 1
    assert next(item for item in json.loads(unlisted.stdout)["checks"]
                if item["name"] == "actor_authorized")["ok"] is False


def test_prepare_does_not_touch_github_and_send_requires_yes(skill_env):
    run, port, state, comments, log = skill_env
    prepared, _, _ = run("prepare", *common(port), "--issue", "7", "--request", "fix the typo", "--marker", MARKER)
    assert prepared.returncode == 0, prepared.stderr
    payload = json.loads(prepared.stdout)
    assert payload["marker"] == MARKER
    assert f"[dsh-bridge:{MARKER}]" in payload["body"]
    assert json.loads(comments.read_text(encoding="utf-8")) == []
    assert "POST" not in log.read_text(encoding="utf-8")

    refused, _, _ = run("send", "--plan", payload["plan"])
    assert refused.returncode == 2
    assert json.loads(refused.stdout)["reason"] == "explicit_yes_required"
    assert json.loads(comments.read_text(encoding="utf-8")) == []

    sent, _, _ = run("send", "--plan", payload["plan"], "--yes")
    assert sent.returncode == 0, sent.stdout + sent.stderr
    assert json.loads(sent.stdout)["duplicate"] is False
    rows = json.loads(comments.read_text(encoding="utf-8"))
    assert len(rows) == 1 and MARKER in rows[0]["body"]

    again, _, _ = run("send", "--plan", payload["plan"], "--yes")
    assert again.returncode == 0
    assert json.loads(again.stdout)["duplicate"] is True
    assert len(json.loads(comments.read_text(encoding="utf-8"))) == 1


def test_send_refuses_when_the_marker_is_already_on_the_issue(skill_env):
    run, port, state, comments, _ = skill_env
    prepared, _, _ = run("prepare", *common(port), "--issue", "7", "--request", "fix", "--marker", MARKER)
    plan = json.loads(prepared.stdout)["plan"]
    comments.write_text(json.dumps([{"id": 1, "html_url": "https://github.com/example/prototype/issues/7#issuecomment-1",
                                     "body": f"@example-agent [dsh-bridge:{MARKER}] fix",
                                     "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"}]),
                        encoding="utf-8")
    replied, _, _ = run("send", "--plan", plan, "--yes")
    assert replied.returncode == 0
    output = json.loads(replied.stdout)
    assert output["duplicate"] is True and output["comment_url"].endswith("issuecomment-1")


def test_a_timed_out_send_is_unknown_and_is_not_retried(skill_env):
    run, port, state, comments, log = skill_env
    prepared, _, _ = run("prepare", *common(port), "--issue", "7", "--request", "slow", "--marker", MARKER)
    plan = json.loads(prepared.stdout)["plan"]
    unknown, _, _ = run("send", "--plan", plan, "--yes", "--timeout", "0.5", env={"FAKE_GH_DELAY": "3"})
    assert unknown.returncode == 3
    assert json.loads(unknown.stdout)["reason"] == "send_unknown"
    retry, _, _ = run("send", "--plan", plan, "--yes")
    assert retry.returncode == 3
    assert json.loads(retry.stdout)["reason"] == "previous_send_unknown"


def test_trace_maps_marker_to_trigger_ticket_assignment_and_reply(skill_env):
    run, port, state, comments, _ = skill_env
    comments.write_text(json.dumps([{"id": 901, "html_url": "https://github.com/example/prototype/issues/7#issuecomment-901",
                                     "user": {"login": ACTOR},
                                     "body": f"@{AGENT} [dsh-bridge:{MARKER}] request",
                                     "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"}]),
                        encoding="utf-8")
    traced, _, _ = run("trace", "--port", str(port), "--repo", REPO, "--issue", "7", "--marker", MARKER,
                       "--actor", ACTOR)
    assert traced.returncode == 0, traced.stdout + traced.stderr
    output = json.loads(traced.stdout)
    assert output["stage"] == "correlated"
    assert output["event"]["comment_id"] == 901
    assert output["acceptance"]["trigger_ids"] == ["trigger-1"]
    assert output["ticket"]["id"] == "ticket-1"
    assert output["assignment"]["id"] == "assignment-1"
    assert output["assignment"]["ref"] == "worker-session-1"
    assert output["person"]["waiting"] is False
    assert output["person"]["report_ready"] is True
    assert output["executor"]["active"] is False
    assert output["executor"]["stale_running_ignored"] is True
    assert output["final_comment"]["present"] is False
    assert output["reply"]["url"].endswith("/issues/7")


def test_prepare_rejects_credential_like_text_and_new_issue_without_allowance(skill_env):
    run, port, *_ = skill_env
    leaked, _, _ = run("prepare", *common(port), "--issue", "7", "--request", "token ghp_" + "a" * 36)
    assert leaked.returncode == 2
    assert json.loads(leaked.stdout)["reason"] == "request_contains_credential_like_text"
    new_issue, _, _ = run("prepare", *common(port), "--kind", "issue", "--request", "new work")
    assert new_issue.returncode == 2
    assert json.loads(new_issue.stdout)["reason"] == "new_issue_requires_allow_new_issue"

def _issue_plan(state_dir, port, *, status="sent", marker=MARKER, issue=None):
    plan = {"version": 1, "marker": marker, "port": port, "repo": REPO, "actor": ACTOR, "agent": AGENT,
            "kind": "issue", "issue": issue,
            "issue_url": f"https://github.com/{REPO}/issues/7",
            "title": "Issue", "body": f"@{AGENT} [dsh-bridge:{marker}] request",
            "created_at": "2026-01-01T00:00:00Z", "sent_at": "2026-01-01T00:00:01Z",
            "expires_at": "2099-01-01T00:00:00Z", "status": status}
    path = Path(state_dir) / f"{marker}-issue-plan.json"
    path.write_text(json.dumps(plan), encoding="utf-8")
    return path


def _comment(id, body, created):
    return {"id": id, "html_url": f"https://github.com/{REPO}/issues/7#issuecomment-{id}",
            "user": {"login": AGENT}, "body": body, "created_at": created, "updated_at": created}


def test_old_issue_plan_recovers_number_from_same_repo_url_and_uses_real_detail(skill_env):
    run, port, state, comments, _ = skill_env
    plan = _issue_plan(state, port)
    comments.write_text(json.dumps([
        _comment(801, "收到：开始处理。", "2026-01-01T00:00:02Z"),
        _comment(802, "This is by an automated agent, not a human.\n\ndone", "2026-01-01T00:05:02Z"),
    ]), encoding="utf-8")
    traced, _, _ = run("trace", "--plan", str(plan), "--show-body")
    assert traced.returncode == 0, traced.stdout + traced.stderr
    out = json.loads(traced.stdout)
    assert out["issue"] == 7 and out["event"]["kind"] == "issue"
    assert out["event"]["author"] == ACTOR
    assert out["acceptance"]["trigger_ids"] == ["trigger-1"]
    assert out["assignment"]["stale_running_ignored"] is True
    assert out["executor"]["active"] is False
    assert out["person"]["report_ready"] is True
    assert out["final_comment"]["present"] is True
    assert out["final_comment"]["acknowledgement_present"] is True
    assert out["final_comment"]["final_comment_id"] == 802
    assert "done" in out["final_comment"]["body"]


def test_ack_only_is_not_reported_as_a_final_comment(skill_env):
    run, port, state, comments, _ = skill_env
    plan = _issue_plan(state, port)
    comments.write_text(json.dumps([_comment(803, "收到：开始处理。", "2026-01-01T00:00:02Z")]), encoding="utf-8")
    traced, _, _ = run("trace", "--plan", str(plan))
    assert traced.returncode == 0
    final = json.loads(traced.stdout)["final_comment"]
    assert final["present"] is False
    assert final["ack_only"] is True


def test_send_issue_records_number_and_url(skill_env):
    run, port, state, comments, log = skill_env
    prepared, _, _ = run("prepare", *common(port), "--kind", "issue", "--allow-new-issue",
                         "--request", "create once", "--marker", MARKER)
    assert prepared.returncode == 0, prepared.stdout + prepared.stderr
    plan = json.loads(prepared.stdout)["plan"]
    sent, _, _ = run("send", "--plan", plan, "--yes")
    assert sent.returncode == 0, sent.stdout + sent.stderr
    record = json.loads(Path(plan).read_text(encoding="utf-8"))
    assert record["issue"] == 77
    assert record["issue_url"].endswith("/issues/77")
    assert "issue" in log.read_text(encoding="utf-8")


def test_send_is_single_writer_per_plan(skill_env):
    run, port, state, comments, log = skill_env
    prepared, _, _ = run("prepare", *common(port), "--issue", "7", "--request", "locked", "--marker", MARKER)
    plan = Path(json.loads(prepared.stdout)["plan"])
    plan.with_name(plan.name + ".lock").write_text("other", encoding="utf-8")
    blocked, _, _ = run("send", "--plan", str(plan), "--yes")
    assert blocked.returncode == 3
    assert json.loads(blocked.stdout)["reason"] == "send_locked"
    assert json.loads(comments.read_text(encoding="utf-8")) == []
    assert "POST" not in log.read_text(encoding="utf-8")


def test_unknown_reconciles_read_only_without_resending(skill_env):
    run, port, state, comments, log = skill_env
    prepared, _, _ = run("prepare", *common(port), "--issue", "7", "--request", "reconcile", "--marker", MARKER)
    plan = json.loads(prepared.stdout)["plan"]
    record = json.loads(Path(plan).read_text(encoding="utf-8"))
    record["status"] = "unknown"
    Path(plan).write_text(json.dumps(record), encoding="utf-8")
    comments.write_text(json.dumps([{"id": 804, "html_url": f"https://github.com/{REPO}/issues/7#issuecomment-804",
                                     "user": {"login": ACTOR}, "body": f"@{AGENT} [dsh-bridge:{MARKER}] reconcile",
                                     "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"}]),
                        encoding="utf-8")
    reconciled, _, _ = run("send", "--plan", plan, "--yes", "--reconcile")
    assert reconciled.returncode == 0
    assert json.loads(reconciled.stdout)["reason"] == "reconciled_without_resend"
    assert "POST" not in log.read_text(encoding="utf-8")
