"""Prepare one SuperAgent GitHub Source event from a brief file, on the instance that serves that repository.

Antigravity addition to the upstream skill. `github_source.py prepare` takes the request as one
command-line argument and defaults to port 3084. Both are awkward on a machine like this one:
a task brief is a multi-line UTF-8 file with quotes and Windows paths, and each repository has its
own SuperAgent profile, so a default port can belong to another project's instance. This script
looks the port up by `--repo` in connection.json, reads the brief from a file, and hands both to
the upstream `prepare`. The precheck, the marker, the plan file and the exit codes stay upstream.
Nothing is sent: sending stays the separate upstream step that the output names.

    python scripts/superagent_brief.py --repo OWNER/REPO --issue 123 --brief TASK.md
    python scripts/superagent_brief.py --repo OWNER/REPO --brief TASK.md --kind issue --allow-new-issue --title "..."

`--actor` defaults to the account the local gh CLI is logged in as, because the upstream precheck
accepts only that account. The precheck cannot be skipped from here. Exit code 2 means this script
refused the request or it stopped on an error before writing a plan; 0 and 1 are upstream's.

connection.json, the Antigravity additions:
    "superagent_instances": [{"repo": "OWNER/REPO", "port": 3082, "profile": "superagent"}, ...]
    "superagent_state_dir": "C:/Users/<name>/.gemini/state/deepseek-harness-bridge"   (optional)

DSH_BRIDGE_CONNECTION_FILE points at another connection.json; the behaviour test uses it.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
CONNECTION = Path(os.environ.get("DSH_BRIDGE_CONNECTION_FILE") or SCRIPTS.parent / "connection.json")


def load_upstream():
    """Import github_source.py from beside this file, also under `python -I`."""
    scripts_dir = str(SCRIPTS)
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    spec = importlib.util.spec_from_file_location("github_source", SCRIPTS / "github_source.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def instance_for(config: dict, repo: str) -> dict | None:
    for row in config.get("superagent_instances") or []:
        if str(row.get("repo", "")).casefold() == repo.casefold() and isinstance(row.get("port"), int):
            return row
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", required=True, help="owner/name that a SuperAgent instance is configured for")
    parser.add_argument("--brief", required=True, help="UTF-8 file with the request; - reads stdin")
    parser.add_argument("--issue", type=int, help="existing Issue to comment on (the default kind)")
    parser.add_argument("--kind", choices=("comment", "issue"), default="comment")
    parser.add_argument("--allow-new-issue", action="store_true", help="with --kind issue: open a new Issue")
    parser.add_argument("--title", default="", help="with --kind issue")
    parser.add_argument("--actor", help="GitHub login; defaults to the local gh account")
    parser.add_argument("--agent", help="agent account; defaults to the instance's configured agent")
    parser.add_argument("--ttl-minutes", type=int, default=30, help="how long the plan stays sendable")
    parser.add_argument("--out", help="plan file; defaults to <state dir>/plans/<marker>.json")
    args = parser.parse_args()
    try:
        config = json.loads(CONNECTION.read_text(encoding="utf-8"))
        raw = sys.stdin.buffer.read() if args.brief == "-" else Path(args.brief).read_bytes()
        # Windows editors write CRLF and sometimes a BOM; neither carries meaning in a request.
        request = raw.decode("utf-8-sig").replace("\r\n", "\n").strip()
    except (OSError, UnicodeError, ValueError) as exc:
        print(f"superagent_brief: {exc.__class__.__name__}: {exc}", file=sys.stderr)
        return 2
    instance = instance_for(config, args.repo)
    if instance is None:
        registered = ", ".join(f"{row.get('repo')} -> port {row.get('port')}"
                               for row in config.get("superagent_instances") or []) or "none"
        print(f"superagent_brief: no SuperAgent instance in {CONNECTION} is registered for {args.repo!r}. "
              f"Registered: {registered}. Add the instance there after checking which repository its profile "
              "serves; do not guess a port.", file=sys.stderr)
        return 2
    if not request:
        print("superagent_brief: the brief is empty; nothing was prepared", file=sys.stderr)
        return 2

    upstream = load_upstream()
    gh = os.environ.get("DSH_BRIDGE_GH", "gh")
    try:
        actor = args.actor.strip() if args.actor else ""
        if not actor:
            try:
                actor = upstream.gh_authenticated_login(gh) or ""
            except RuntimeError as exc:
                print(f"superagent_brief: {exc}; pass --actor if the gh CLI lives elsewhere "
                      "(DSH_BRIDGE_GH names the command)", file=sys.stderr)
                return 2
        if not actor:
            print("superagent_brief: --actor was not given and the local gh CLI is not logged in; "
                  "nothing was prepared", file=sys.stderr)
            return 2
        plan_args = argparse.Namespace(
            port=instance["port"], repo=args.repo, actor=actor, agent=args.agent, gh=gh,
            state_dir=str(config.get("superagent_state_dir") or upstream.DEFAULT_STATE),
            request=request, kind=args.kind, issue=args.issue, title=args.title,
            marker="", out=args.out, ttl_minutes=args.ttl_minutes,
            allow_new_issue=args.allow_new_issue, skip_precheck=False,
        )
        print(f"port={plan_args.port} repo={args.repo} actor={actor} profile={instance.get('profile')}",
              file=sys.stderr, flush=True)
        # Upstream writes the plan last, so an exception that escapes it means no plan was written.
        return upstream.prepare(plan_args)
    except subprocess.TimeoutExpired as exc:
        print(f"superagent_brief: gh or the instance did not answer in time; no plan was written. {exc}",
              file=sys.stderr)
        return 2
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"superagent_brief: stopped before a plan was written: {exc.__class__.__name__}: {exc}",
              file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
