"""Wait until the Ticket of one sent SuperAgent plan has ended, then print its final state.

ZCode addition to the upstream skill. `github_source.py trace --wait N` returns as soon as the event is
matched to a Ticket, which is when the work starts, not when it ends. This script keeps polling through
the upstream client's own functions until the Ticket has ended, or `--wait` seconds have passed. It
prints one line per poll on stderr and the final document on stdout as ASCII JSON, laid out like the
output of `trace`, so the same fields decide whether the work is done.

    python scripts/superagent_wait.py --plan "<plan>" [--wait 900] [--interval 20]

The port, repository and marker come from the plan; nothing is defaulted here. A later comment on the
same Issue re-opens its Ticket with another Assignment, so right after a follow-up is sent the Ticket
still shows the end of the previous round. Only an end later than the plan's `sent_at` counts.

When a reply quotes the marker, the marker no longer identifies the dispatch comment
(`comment_marker_not_unique`). The script then follows the same Issue by number, as `compare --issues` does.

Exit codes: 0 the Ticket ended after this dispatch. 4 the wait ran out, the reads kept failing, or the
Ticket is ambiguous. 3 the marker is no longer unique and the Issue does not identify exactly one
Ticket. 2 the plan is unusable.
"""

from __future__ import annotations

import argparse
import contextlib
import importlib.util
import io
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
NOT_UNIQUE = "comment_marker_not_unique"
READ_ERRORS = (OSError, RuntimeError, ValueError, KeyError, IndexError, json.JSONDecodeError)


def load_upstream():
    """Import github_source.py from beside this file, also under `python -I`."""
    spec = importlib.util.spec_from_file_location("github_source", SCRIPTS / "github_source.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def by_issue(source, plan: dict, number: int, gh: str) -> dict:
    """One row of the upstream `compare` command, reshaped like a `trace` document."""
    args = argparse.Namespace(port=int(plan["port"]), repo=plan["repo"], gh=gh, issues=str(number),
                              actor=None, show_body=True)
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        source.compare_issues(args)
    document = json.loads(out.getvalue())
    row = document["issues"][0]
    ticket, assignment = row.get("ticket"), row.get("assignment") or {}
    return {
        "repo": plan["repo"], "issue": number, "marker": plan["marker"], "looked_up_by": "issue",
        "stage": "correlated" if ticket else "ticket_pending",
        "instance": {"load": document.get("instance_load")},
        "ticket": ticket,
        "assignment": row.get("assignment"),
        "worker_result": {"ref": assignment.get("ref"), "report_state": assignment.get("report_state")},
        "final_comment": row.get("final_comment"),
    }


def ended_after_dispatch(ticket: dict, sent_at) -> bool:
    """True when the Ticket has ended and that end is not the previous round's."""
    if ticket.get("state") != "ended":
        return False
    ended = str((ticket.get("ended") or {}).get("at") or "")
    if not sent_at or not ended:
        return True
    try:
        later = datetime.fromisoformat(ended.replace("Z", "+00:00"))
        sent = datetime.fromisoformat(str(sent_at).replace("Z", "+00:00"))
    except ValueError:
        return True
    return later > sent


def poll_line(document: dict, stale_end: bool) -> str:
    ticket, assignment = document.get("ticket") or {}, document.get("assignment") or {}
    final = document.get("final_comment") or {}
    load = (document.get("instance") or {}).get("load") or {}
    identifier = str(ticket.get("id") or "")[:12] or "-"
    stamp = datetime.now(timezone.utc).strftime("%H:%M:%SZ")
    note = " | ended before this dispatch was sent; waiting for the new round" if stale_end else ""
    return (f"{stamp} | load {load.get('running')}/{load.get('queued')} | {document.get('stage')}"
            f" | ticket {identifier} {ticket.get('state')}/{ticket.get('stage')}"
            f" | assignment {assignment.get('state_effective')}/{assignment.get('report_state')}"
            f" | final_comment present={final.get('present')}{note}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--plan", required=True, help="the plan file written by prepare")
    parser.add_argument("--wait", type=int, default=900, help="seconds to keep polling; 0 checks once")
    parser.add_argument("--interval", type=int, default=20, help="seconds between polls, kept between 1 and 60")
    args = parser.parse_args()
    try:
        plan = json.loads(Path(args.plan).expanduser().read_text(encoding="utf-8"))
        port = int(plan["port"])
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"superagent_wait: cannot use the plan: {exc.__class__.__name__}: {exc}", file=sys.stderr)
        return 2
    source = load_upstream()
    gh = os.environ.get("DSH_BRIDGE_GH", "gh")
    sent_at = plan.get("sent_at")
    deadline = time.monotonic() + max(0, args.wait)
    latest, failures, by_number, done = None, 0, False, False
    while True:
        try:
            if by_number:
                latest = by_issue(source, plan, source.resolve_plan_issue(plan, gh), gh)
            else:
                try:
                    latest = source.describe_correlation(plan, port, gh, show_body=True)
                except RuntimeError as error:
                    if str(error) != NOT_UNIQUE:
                        raise
                    latest = by_issue(source, plan, source.resolve_plan_issue(plan, gh), gh)
                    by_number = True
                    print(f"superagent_wait: {NOT_UNIQUE}: a reply quoted the marker; "
                          f"following Issue #{latest['issue']} by number from now on", file=sys.stderr)
            failures = 0
        except READ_ERRORS as error:
            latest = {"stage": "read_failed", "detail": source.sanitise(error, 200)}
            failures += 1
        ticket = latest.get("ticket") or {}
        done = ended_after_dispatch(ticket, sent_at)
        print(poll_line(latest, bool(ticket) and ticket.get("state") == "ended" and not done),
              file=sys.stderr, flush=True)
        if done or latest.get("stage") == "ticket_ambiguous" or failures >= 3:
            break
        if time.monotonic() >= deadline:
            break
        time.sleep(max(1, min(args.interval, 60)))
    print(json.dumps({**(latest or {}), "ended_after_dispatch": done}, ensure_ascii=True, indent=2))
    if done:
        return 0
    if by_number and latest.get("stage") == "ticket_pending":
        print("superagent_wait: the marker is no longer unique and the Issue does not identify exactly one "
              "Ticket. Read it with its ID: superagent.py ticket TICKET_ID, or the management API.",
              file=sys.stderr)
        return 3
    return 4


if __name__ == "__main__":
    raise SystemExit(main())
