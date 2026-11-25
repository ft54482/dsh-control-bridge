"""Behaviour test for scripts/superagent_wait.py. The upstream client is replaced by an in-process stand-in
that replays a scripted sequence of correlation documents, and the clock is fake, so a quarter of an hour
of waiting takes milliseconds. Nothing here contacts a real instance, GitHub or a real plan.

    python -I -X utf8 tests/superagent_wait_test.py

Exit code 0 means every check passed. Run it again after replacing the upstream github_source.py or editing
scripts/superagent_wait.py.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
TICKET = "0123456789abcdef0123456789abcdef"
PLAN = {"marker": "dsb-20260101T000000Z-0a1b2c3d", "port": 3082, "repo": "owner/one", "actor": "alice",
        "agent": "bot", "kind": "comment", "issue": 123, "status": "sent"}
ENDED_ROW = {"issue": 123, "author": "alice", "created_at": "2026-01-01T09:59:00Z",
             "ticket": {"id": TICKET, "state": "ended", "stage": "ended", "ended": {"outcome": "completed"}},
             "assignment": {"id": "fedcba9876543210fedcba9876543210", "state": "ended", "state_effective": "ended",
                            "ref": "worker-" + TICKET, "report_state": "ready"},
             "trigger_ids": ["aaaaaaaabbbbccccddddeeeeeeeeeeee"], "person": {"stage": "ended", "report_ready": True},
             "executor": {"active": False}, "final_comment": {"present": True, "body": "SMOKE-OK"}}


def document(state=None, outcome=None, report=None, assignment="running", stage="correlated", load=None,
             ended_at="2026-01-01T10:00:00.000Z"):
    """A document shaped like the output of github_source.py trace. No Ticket means ticket_pending."""
    if state is None:
        return {"ok": False, "stage": "ticket_pending" if stage == "correlated" else stage, "event": {"issue": 378},
                "instance": {"load": load or {"running": 0, "queued": 1}}, "final_comment": {"present": False}}
    ticket = {"id": TICKET, "state": state, "stage": "working" if state == "open" else state}
    if outcome:
        ticket["ended"] = {"at": ended_at, "by": "executor", "outcome": outcome}
    return {"ok": True, "stage": stage, "event": {"issue": 378}, "instance": {"load": load or {"running": 1, "queued": 0}},
            "ticket": ticket,
            "assignment": {"id": "fedcba9876543210fedcba9876543210", "state": assignment,
                           "state_effective": assignment, "ref": "worker-" + TICKET, "report_state": report},
            "worker_result": {"ref": "worker-" + TICKET, "report_state": report},
            "final_comment": {"present": True, "ack_only": False}}


ENDED = document("ended", "completed", "ready", "ended")
NOT_UNIQUE = RuntimeError("comment_marker_not_unique")


class FakeSource:
    """Replays describe_correlation answers (the last one repeats) and answers compare_issues with one row."""

    def __init__(self, answers, row=None):
        self.answers = list(answers)
        self.row = row if row is not None else {"issue": 378, "ticket": None, "stage": "ticket_pending",
                                                "final_comment": {"present": True}}
        self.marker_calls = self.compare_calls = 0

    def describe_correlation(self, plan, port, gh, show_body=False):
        self.marker_calls += 1
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(answer, Exception):
            raise answer
        return answer

    def resolve_plan_issue(self, plan, gh):
        return plan["issue"]

    def compare_issues(self, args):
        self.compare_calls += 1
        print(json.dumps({"repo": args.repo, "port": args.port, "instance_load": {"running": 0, "queued": 0},
                          "issues": [self.row]}))

    sanitise = staticmethod(lambda text, limit=500: str(text)[:limit])


class FakeTime:
    def __init__(self):
        self.now, self.sleeps = 1000.0, []

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        if len(self.sleeps) >= 10000:
            # Real sleeps of zero would spin too; here the test stops it with a clear message instead.
            raise RuntimeError("the helper keeps sleeping without the clock moving: it is spinning")
        self.sleeps.append(seconds)
        self.now += seconds


def load(name: str, *relative: str):
    spec = importlib.util.spec_from_file_location(name, SKILL.joinpath(*relative))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check(label, condition, detail=""):
    print(("PASS  " if condition else "FAIL  ") + label + (f"  [{detail}]" if detail and not condition else ""))
    return bool(condition)


def wait(helper, *argv):
    """Run the helper's main() in this process and return (exit code, parsed stdout JSON or None, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    saved_argv = sys.argv
    sys.argv = ["superagent_wait.py", *argv]
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = helper.main()
    finally:
        sys.argv = saved_argv
    text = out.getvalue()
    return code, (json.loads(text) if text.strip() else None), err.getvalue()


def main() -> int:
    ok = True
    with tempfile.TemporaryDirectory(prefix="dsh-superagent-wait-test-") as temporary:
        scratch = Path(temporary)
        plan_file = scratch / "plan.json"
        plan_file.write_text(json.dumps(PLAN), encoding="utf-8")

        def rig(answers, row=None):
            source, clock = FakeSource(answers, row), FakeTime()
            helper = load("superagent_wait_under_test", "scripts", "superagent_wait.py")
            helper.load_upstream, helper.time = (lambda: source), clock
            return helper, source, clock

        helper, source, clock = rig([document(), document("open"), ENDED])
        code, doc, err = wait(helper, "--plan", str(plan_file))
        lines = err.splitlines()
        ok &= check("ends: exit 0 when the Ticket has ended", code == 0 and doc.get("ended_after_dispatch") is True,
                    f"{code} {doc} {err}")
        ok &= check("ends: the final document keeps the fields that decide completion",
                    (doc or {}).get("stage") == "correlated" and doc.get("ticket", {}).get("state") == "ended"
                    and doc.get("ticket", {}).get("ended", {}).get("outcome") == "completed"
                    and doc.get("worker_result", {}).get("report_state") == "ready", str(doc)[:300])
        ok &= check("ends: one stderr line per poll, with the stages in order",
                    len(lines) == 3 and [line.split(" | ")[2] for line in lines] == ["ticket_pending", "correlated", "correlated"], err)
        ok &= check("ends: the last poll line names the Ticket and its end state",
                    f"ticket {TICKET[:12]} ended/ended" in lines[-1] and "assignment ended/ready" in lines[-1], lines[-1] if lines else "")
        ok &= check("ends: it slept the default 20 seconds between polls and never after the last one",
                    clock.sleeps == [20, 20], str(clock.sleeps))

        helper, source, clock = rig([document("open")])
        code, doc, err = wait(helper, "--plan", str(plan_file), "--wait", "60")
        ok &= check("still running: exit 4 when the wait runs out",
                    code == 4 and doc.get("ticket", {}).get("state") == "open", f"{code} {err}")
        ok &= check("still running: polled at 0, 20, 40 and 60 seconds, three sleeps",
                    source.marker_calls == 4 and clock.sleeps == [20, 20, 20], f"{source.marker_calls} {clock.sleeps}")
        code, doc, err = wait(helper, "--plan", str(plan_file), "--wait", "0")
        ok &= check("--wait 0 checks once and does not sleep", source.marker_calls == 5 and clock.sleeps == [20, 20, 20], str(clock.sleeps))

        helper, source, clock = rig([document(stage="ticket_pending")])
        code, doc, err = wait(helper, "--plan", str(plan_file), "--wait", "40")
        ok &= check("never matched: exit 4 with stage ticket_pending", code == 4 and doc.get("stage") == "ticket_pending", f"{code} {doc}")

        helper, source, clock = rig([document("open", load={"running": 0, "queued": 1}), NOT_UNIQUE], ENDED_ROW)
        code, doc, err = wait(helper, "--plan", str(plan_file))
        ok &= check("quoted marker: falls back to the Issue by number and still ends with exit 0",
                    code == 0 and doc.get("looked_up_by") == "issue" and doc.get("ticket", {}).get("state") == "ended"
                    and doc.get("worker_result", {}).get("report_state") == "ready"
                    and doc.get("final_comment", {}).get("body") == "SMOKE-OK", f"{code} {doc} {err}")
        ok &= check("quoted marker: the marker was abandoned after the one failure",
                    source.marker_calls == 2 and source.compare_calls == 1, f"{source.marker_calls} {source.compare_calls}")
        ok &= check("quoted marker: stderr says what happened and what it does instead",
                    "comment_marker_not_unique" in err and "following Issue #123 by number" in err, err)

        helper, source, clock = rig([NOT_UNIQUE])
        code, doc, err = wait(helper, "--plan", str(plan_file), "--wait", "40")
        ok &= check("quoted marker with no single Ticket on the Issue: exit 3 and a way forward",
                    code == 3 and "does not identify exactly one" in err and "superagent.py ticket" in err, f"{code} {err}")
        ok &= check("quoted marker with no single Ticket: it kept asking by number until the wait ran out",
                    source.marker_calls == 1 and source.compare_calls == 3, f"{source.marker_calls} {source.compare_calls}")

        helper, source, clock = rig([OSError("connection refused"), RuntimeError("SuperAgent API returned HTTP 500"), ENDED])
        code, doc, err = wait(helper, "--plan", str(plan_file))
        ok &= check("two failed reads in a row are survived", code == 0 and err.count("read_failed") == 2
                    and doc.get("ticket", {}).get("state") == "ended", f"{code} {err}")

        helper, source, clock = rig([OSError("x"), document("open"), OSError("y"), document("open"),
                                     OSError("z"), document("open"), ENDED])
        code, doc, err = wait(helper, "--plan", str(plan_file))
        ok &= check("scattered failed reads are not added up: only three in a row stop the wait",
                    code == 0 and err.count("read_failed") == 3 and doc.get("ticket", {}).get("state") == "ended",
                    f"{code} {err}")

        helper, source, clock = rig([RuntimeError("boom")])
        code, doc, err = wait(helper, "--plan", str(plan_file), "--wait", "900")
        ok &= check("three failed reads in a row stop the wait with exit 4",
                    code == 4 and doc.get("stage") == "read_failed" and doc.get("detail") == "boom"
                    and source.marker_calls == 3 and clock.sleeps == [20, 20], f"{code} {doc} {clock.sleeps}")

        helper, source, clock = rig([document(stage="ticket_ambiguous")])
        code, doc, err = wait(helper, "--plan", str(plan_file), "--wait", "900")
        ok &= check("an ambiguous Ticket stops the wait at once",
                    code == 4 and doc.get("stage") == "ticket_ambiguous" and source.marker_calls == 1 and not clock.sleeps, f"{code} {err}")

        helper, source, clock = rig([document("ended", "stopped", None, "ended")])
        code, doc, err = wait(helper, "--plan", str(plan_file))
        ok &= check("ended for another reason: exit 0, and the outcome says so",
                    code == 0 and doc.get("ticket", {}).get("ended", {}).get("outcome") == "stopped"
                    and doc.get("worker_result", {}).get("report_state") is None, str(doc))

        # A later comment on the same Issue re-opens the Ticket; until the new round ends it still shows the old end.
        followup = scratch / "followup.json"
        followup.write_text(json.dumps({**PLAN, "marker": "dsb-20260101T110000Z-0a1b2c3d", "sent_at": "2026-01-01T11:00:00.000Z"}),
                            encoding="utf-8")
        fresh = document("ended", "completed", "ready", "ended", ended_at="2026-01-01T11:05:00.000Z")
        helper, source, clock = rig([ENDED, fresh])
        code, doc, err = wait(helper, "--plan", str(followup))
        lines = err.splitlines()
        ok &= check("follow-up: the previous round's end does not count; it waits for the new round",
                    code == 0 and source.marker_calls == 2 and clock.sleeps == [20]
                    and doc.get("ticket", {}).get("ended", {}).get("at") == "2026-01-01T11:05:00.000Z"
                    and doc.get("ended_after_dispatch") is True, f"{code} {doc} {err}")
        ok &= check("follow-up: the first poll line says why it keeps waiting",
                    "ended before this dispatch was sent; waiting for the new round" in lines[0]
                    and "waiting for the new round" not in lines[1], err)
        helper, source, clock = rig([ENDED])
        code, doc, err = wait(helper, "--plan", str(followup), "--wait", "40")
        ok &= check("follow-up: only the old end within the wait: exit 4, and the document says it is not this round's",
                    code == 4 and doc.get("ticket", {}).get("state") == "ended" and doc.get("ended_after_dispatch") is False
                    and err.count("ended before this dispatch was sent") == 3, f"{code} {doc} {err}")
        odd = scratch / "odd-times.json"
        odd.write_text(json.dumps({**PLAN, "sent_at": "not a time"}), encoding="utf-8")
        helper, source, clock = rig([ENDED])
        code, doc, err = wait(helper, "--plan", str(odd))
        ok &= check("a plan whose sent_at cannot be read still accepts an ended Ticket", code == 0, f"{code} {doc} {err}")

        helper, source, clock = rig([document("open")])
        wait(helper, "--plan", str(plan_file), "--wait", "200", "--interval", "500")
        ok &= check("an interval above 60 seconds is capped: polls at 0, 60, 120, 180 and 240 seconds",
                    clock.sleeps == [60, 60, 60, 60], str(clock.sleeps))
        helper, source, clock = rig([document("open")])
        wait(helper, "--plan", str(plan_file), "--wait", "10", "--interval", "0")
        ok &= check("an interval below 1 second is raised: one sleep per second until the wait runs out",
                    clock.sleeps == [1] * 10, str(clock.sleeps))

        for label, content in (("a missing plan file", None), ("a plan that is not JSON", "not json"),
                               ("a plan without a port", json.dumps({k: v for k, v in PLAN.items() if k != "port"}))):
            target = scratch / f"{re.sub(r'\W+', '-', label)}.json"
            if content is not None:
                target.write_text(content, encoding="utf-8")
            helper, source, clock = rig([ENDED])
            code, doc, err = wait(helper, "--plan", str(target))
            ok &= check(f"{label}: exit 2, nothing is polled, nothing is printed on stdout",
                        code == 2 and "cannot use the plan" in err and doc is None and source.marker_calls == 0, f"{code} {doc} {err}")

    with tempfile.TemporaryDirectory(prefix="dsh-superagent-wait-test-") as temporary:
        scratch = Path(temporary)
        plan_file = scratch / "plan.json"
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            closed_port = probe.getsockname()[1]
        plan_file.write_text(json.dumps({**PLAN, "port": closed_port}), encoding="utf-8")
        env = {**os.environ, "DSH_BRIDGE_GH": "no-such-gh-command"}
        script = str(SKILL / "scripts" / "superagent_wait.py")
        result = subprocess.run([sys.executable, "-I", "-X", "utf8", script], capture_output=True, env=env)
        ok &= check("black box: --plan is required", result.returncode == 2 and b"--plan" in result.stderr, result.stderr.decode("utf-8", "replace"))
        result = subprocess.run([sys.executable, "-I", "-X", "utf8", script, "--plan", str(plan_file), "--wait", "0"],
                                capture_output=True, env=env)
        out = result.stdout.decode("utf-8", "replace")
        ok &= check("black box: under python -I it loads the upstream client and reports a failed read instead of crashing",
                    result.returncode == 4 and '"stage": "read_failed"' in out and "gh CLI not found" in out
                    and "Traceback" not in result.stderr.decode("utf-8", "replace"), f"{result.returncode} {out[:300]}")
    print("RESULT:", "ALL PASS" if ok else "SOMETHING FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
