"""Compact, readable view of `desktop.py` output: one line per session plus a workspace legend.

ZCode addition to the upstream skill; `desktop.py` and `superagent.py` are the upstream files.
Pure formatting of the JSON on stdin: no network, no credential access, nothing written to disk.
The raw output is ASCII-escaped JSON of about 1 KB per session; this prints about 200 characters.

    python scripts/desktop.py granted | python scripts/sessions_table.py [--cwd PART] [--idle] [--limit N]
    python scripts/desktop.py discover --param kind=top --param limit=50 | python scripts/sessions_table.py [--cwd PART]

`--cwd PART` keeps the sessions whose directory contains that text. The legend lists the
workspaces of the shown sessions, plus with `--cwd` any workspace whose directory matches: that
is how a workspace ID is found before `discover --param workspace_id=`.
`discover` returns one page; the last line shows the server's offset, limit and total.

`granted` rows carry the grant (`access`). `discover` rows cover every registered session but do
not say whether it is granted; match their session_id against `granted` before relying on one.
An error document is printed readably instead of being summarised away.
"""

from __future__ import annotations

import argparse
import json
import sys


def clip(value: object, width: int) -> str:
    text = "-" if value in (None, "") else str(value)
    return text if len(text) <= width else text[: width - 1] + "…"


def norm(value: object) -> str:
    return ("" if value is None else str(value)).replace("\\", "/").lower()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--cwd", help="keep only sessions whose cwd contains this text")
    parser.add_argument("--idle", action="store_true", help="keep only sessions that are not running or busy")
    parser.add_argument("--limit", type=int, default=0, help="maximum sessions to print; 0 means all")
    args = parser.parse_args()
    if args.limit < 0:
        parser.error("--limit must be 0 or more")
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, OSError, ValueError):
        pass
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
    except (UnicodeError, ValueError):
        print("sessions_table: stdin is not JSON; pipe the output of desktop.py into it", file=sys.stderr)
        return 2
    if not isinstance(data, dict):
        print("sessions_table: expected one JSON object on stdin", file=sys.stderr)
        return 2
    status = data.get("http_status")
    if data.get("ok") is False or (isinstance(status, int) and status >= 400):
        # An error document: hand it back readable instead of summarising it away.
        print(json.dumps(data, ensure_ascii=False, indent=1))
        return 1
    if isinstance(data.get("sessions"), list):
        rows, granted = data["sessions"], True
    elif isinstance(data.get("items"), list):
        rows, granted = data["items"], False
    else:
        print(json.dumps(data, ensure_ascii=False, indent=1))
        return 0

    legend: dict[str, str] = {}
    for workspace in data.get("workspaces") or []:
        if isinstance(workspace, dict) and workspace.get("id"):
            legend[str(workspace["id"])] = str(workspace.get("path") or workspace.get("title") or "")
    kept = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        workspace_id, cwd = str(row.get("workspace_id") or ""), str(row.get("cwd") or "")
        if workspace_id and cwd:
            legend.setdefault(workspace_id, cwd)
        if args.cwd and norm(args.cwd) not in norm(cwd):
            continue
        if args.idle and (row.get("running") or row.get("busy")):
            continue
        kept.append(row)
    shown = kept if not args.limit else kept[: args.limit]

    print(f"{'access':<6} | {'state':<13} | {'agent':<5} | {'session_id':<44} | {'effort':<6} | title | cwd | ws")
    for row in shown:
        if granted:
            state = "busy" if (row.get("running") or row.get("busy")) else "idle"
            effort = (row.get("model_next") or {}).get("reasoningEffort")
        else:
            state = str(row.get("status") or "?")
            effort = row.get("reasoning_effort")
        cells = (
            str(row.get("access") or "?") if granted else "-",
            state,
            "yes" if row.get("agent_available") else "no",
            str(row.get("session_id") or "?"),
            clip(effort, 6),
            clip(row.get("title"), 30),
            clip(row.get("cwd"), 70),
            str(row.get("workspace_id") or "")[:8],
        )
        print(f"{cells[0]:<6} | {cells[1]:<13} | {cells[2]:<5} | {cells[3]:<44} | {cells[4]:<6} | {cells[5]} | {cells[6]} | {cells[7]}")
    # The legend lists the workspaces of the shown sessions, plus with --cwd any workspace whose
    # directory matches: that is how a workspace ID is found before `discover --param workspace_id=`.
    related = {str(row.get("workspace_id") or "") for row in shown}
    if args.cwd or related:
        legend = {key: path for key, path in legend.items()
                  if key in related or (args.cwd and norm(args.cwd) in norm(path))}
    for workspace_id, path in sorted(legend.items()):
        print(f"ws {workspace_id[:8]} = {workspace_id}  {path}")
    filters = [name for name, hit in (("filtered", len(kept) != len(rows)), ("limited", len(shown) != len(kept))) if hit]
    source = "granted" if granted else "discover"
    page = ""
    if all(isinstance(data.get(key), int) for key in ("total", "offset", "limit")):
        page = f"; server page offset {data['offset']} limit {data['limit']}, {data['total']} in all"
    print(f"{len(shown)} of {len(rows)} sessions on this page ({source}{', ' + ', '.join(filters) if filters else ''}{page})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
