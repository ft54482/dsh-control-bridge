"""Trigger and trace an authorized SuperAgent GitHub Source event.

This helper never changes another profile's Source, Policy, tickets or
permissions. `precheck` only reads the local management API and the local gh
identity; `prepare` writes a local plan and prints the exact authorized event;
`send` requires --yes and a fresh precheck, sends at most one event, and records
an idempotency marker so a retry or a timed-out send cannot duplicate it;
`trace` follows that same issue/comment to its Trigger, Ticket, Assignment and
reply. All output is intended for the local operator.
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import re
import secrets
import shlex
import subprocess
import time
from urllib.parse import quote
from datetime import datetime, timedelta, timezone
from pathlib import Path

from superagent import (assignment_rows as sa_assignment_rows, assignment_view as sa_assignment_view,
                        delivered_to_ticket as sa_delivered_to_ticket, delivery_view as sa_delivery_view,
                        newest_assignment as sa_newest_assignment, pull_requests as sa_pull_requests,
                        source_thread as sa_source_thread, ticket_detail as sa_ticket_detail)

DEFAULT_STATE = Path(os.environ.get("DSH_BRIDGE_SKILL_STATE", Path.home() / ".codex" / "state" / "deepseek-harness-bridge")) / "github"
API_HEADERS = {"x-orchestrator-request": "1"}
TOKEN_RE = re.compile(r"(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|Bearer\s+\S+)")


def sanitise(text: str, limit: int = 500) -> str:
    return TOKEN_RE.sub("[redacted]", str(text))[:limit]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def api(port: int, path: str, timeout: float = 15.0) -> dict | list:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        connection.request("GET", f"/orchestrator/api/{path}", headers=API_HEADERS)
        with connection.getresponse() as response:
            raw = response.read()
            if response.status != 200:
                raise RuntimeError(f"SuperAgent API returned HTTP {response.status}")
            return json.loads(raw.decode("utf-8", "replace"))
    finally:
        connection.close()


def gh(args: list[str], gh_path: str, timeout: float = 30.0) -> subprocess.CompletedProcess:
    command = [*shlex.split(gh_path, posix=(os.name != "nt")), *args]
    try:
        return subprocess.run(command, capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=timeout, check=False)
    except FileNotFoundError as error:
        raise RuntimeError("gh CLI not found") from error


def gh_json(args: list[str], gh_path: str, timeout: float = 30.0):
    result = gh(args, gh_path, timeout)
    if result.returncode != 0:
        raise RuntimeError(sanitise(result.stderr or result.stdout or f"gh exited {result.returncode}", 300))
    try:
        return json.loads(result.stdout or "null")
    except ValueError as error:
        raise RuntimeError("gh returned non-JSON output") from error


def json_stream(raw: str) -> list:
    """Parse gh --paginate output, which may be several concatenated JSON arrays."""
    text = (raw or "").strip()
    if not text:
        return []
    decoder = json.JSONDecoder()
    values, index = [], 0
    while index < len(text):
        while index < len(text) and text[index].isspace():
            index += 1
        if index >= len(text):
            break
        value, index = decoder.raw_decode(text, index)
        values.append(value)
    items = []
    for value in values:
        if isinstance(value, list):
            items.extend(value)
        else:
            items.append(value)
    return items


def issue_comments(repo: str, number: int, gh_path: str) -> list[dict]:
    result = gh(["api", "--paginate", f"repos/{repo}/issues/{number}/comments?per_page=100"], gh_path, 60)
    if result.returncode != 0:
        raise RuntimeError(sanitise(result.stderr or "gh comments failed", 300))
    comments = json_stream(result.stdout)
    return [item for item in comments if isinstance(item, dict)]


def issue_number_from_url(url: object) -> int | None:
    match = re.search(r"/issues/(\d+)(?:$|[?#])", str(url or ""))
    return int(match.group(1)) if match else None


def issue_info(repo: str, number: int, gh_path: str) -> dict:
    return gh_json(["api", f"repos/{repo}/issues/{number}"], gh_path)


def is_acknowledgement(body: str) -> bool:
    text = (body or "").strip().lower()
    if not text:
        return True
    if "this is by an automated agent" in text:
        return False
    return text.startswith(("收到", "received", "acknowledged", "ack:"))


def gh_authenticated_login(gh_path: str) -> str | None:
    result = gh(["api", "user", "--jq", ".login"], gh_path)
    return result.stdout.strip() if result.returncode == 0 and result.stdout.strip() else None


def source_allowed(settings: dict) -> list[str]:
    blocks = settings.get("blocks") if isinstance(settings, dict) else None
    policy = ((blocks or {}).get("policy") or {}).get("value") or {}
    github = (((policy.get("sources") or {}).get("github")) or {})
    return [str(row.get("id")) for row in github.get("allowed") or [] if isinstance(row, dict) and row.get("id")]


def precheck_data(args) -> dict:
    checks: list[dict] = []

    def check(name: str, ok: bool, detail=None, mandatory: bool = True):
        checks.append({"name": name, "ok": bool(ok), "mandatory": mandatory,
                       **({"detail": detail} if detail is not None and not ok else {})})

    try:
        state = api(args.port, "state")
        sources = api(args.port, "sources")
        settings = api(args.port, "settings")
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        return {"ok": False, "reason": "superagent_unreachable", "detail": sanitise(error, 200), "checks": checks}

    setup = state.get("setup") or {}
    accounts = setup.get("accounts") or {}
    repository = str(accounts.get("repository") or "")
    agent = str(accounts.get("agent") or "")
    check("superagent_setup", setup.get("problem") in (None, ""), sanitise(setup.get("problem") or "", 200))
    check("repository_matches", repository.casefold() == args.repo.casefold(),
          f"profile has {repository!r}; requested {args.repo!r}")
    if args.agent:
        check("agent_matches", agent.casefold() == args.agent.casefold(), f"profile agent is {agent!r}")
    github = next((row for row in sources if row.get("id") == "github"), None) if isinstance(sources, list) else None
    check("github_source_enabled", bool(github and github.get("installed") and github.get("enabled")),
          "GitHub Source is missing, uninstalled or disabled")
    health = {key: (value or {}).get("state") for key, value in (state.get("health") or {}).items()}
    check("github_health_ready", health.get("github") == "ready", f"github health is {health.get('github')!r}")
    allowed = source_allowed(settings)
    check("actor_authorized", args.actor in allowed, f"allowed accounts: {allowed or 'none'}")

    login = gh_authenticated_login(args.gh)
    check("gh_actor_matches", login is not None and login.casefold() == args.actor.casefold(),
          f"local gh account is {login!r}")
    try:
        repo = gh_json(["api", f"repos/{args.repo}", "--jq", "{push: .permissions.push, private: .private, has_issues: .has_issues}"], args.gh)
        check("repository_readable", isinstance(repo, dict), "gh cannot read the repository")
        if isinstance(repo, dict):
            check("actor_can_push", repo.get("push") is True,
                  "local gh account cannot push; the Source's agent account, not this actor, needs push", mandatory=False)
            check("issues_enabled", repo.get("has_issues") is not False, "issues are disabled")
    except RuntimeError as error:
        check("repository_readable", False, sanitise(error, 200))

    mandatory = all(item["ok"] for item in checks if item["mandatory"])
    return {
        "ok": mandatory,
        "port": args.port,
        "repository": repository,
        "agent": agent,
        "actor": args.actor,
        "allowed_accounts": allowed,
        "load": state.get("load"),
        "checks": checks,
        "trigger": {
            "recommended": "comment",
            "format": f"@{agent} [dsh-bridge:<marker>] <request>" if agent else "@<agent> <request>",
            "new_issue_body": "not recommended: this prototype reads a newly opened Issue body only through the agent account's notification and only after its cursor; repository-wide new Issues are off unless observeIssues is enabled. A comment that mentions the agent is the reliable explicit event.",
            "unaddressed_events": "not reliable for explicit work: they are inferred candidates; the documented explicit request is a listed actor's mention in an Issue or comment.",
            "dedupe": "A comment edit changes updated_at and can produce a second Trigger; do not edit or resend. One marker, one comment.",
        },
    }


def precheck(args) -> int:
    data = precheck_data(args)
    print(json.dumps(data, ensure_ascii=True, indent=2))
    return 0 if data["ok"] else 1


def marker_new() -> str:
    return "dsb-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + secrets.token_hex(4)


def plan_path_for(marker: str, state_dir: Path) -> Path:
    return state_dir / "plans" / f"{marker}.json"


def write_plan(plan: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f".{os.getpid()}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    handle = os.open(temporary, flags, 0o600)
    try:
        os.write(handle, json.dumps(plan, ensure_ascii=True, indent=2).encode("utf-8"))
        os.fsync(handle)
    finally:
        os.close(handle)
    os.replace(temporary, path)


def load_plan(path: Path) -> dict:
    if not path.is_file():
        raise RuntimeError(f"plan not found: {path}")
    plan = json.loads(path.read_text(encoding="utf-8"))
    return plan


def acquire_plan_lock(path: Path):
    """Single writer per plan: O_EXCL lock beside the plan, never auto-broken."""
    lock = path.with_name(path.name + ".lock")
    try:
        handle = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return None
    try:
        os.write(handle, f"{os.getpid()} {now_iso()}\n".encode("ascii"))
    finally:
        os.close(handle)
    return lock


def release_plan_lock(lock: Path | None) -> None:
    if lock:
        try:
            lock.unlink()
        except OSError:
            pass


def resolve_plan_issue(plan: dict, gh_path: str) -> int:
    """Old plans may have issue=null but a same-repository issue_url."""
    number = plan.get("issue")
    if isinstance(number, int) and number > 0:
        return number
    number = issue_number_from_url(plan.get("issue_url"))
    if number is None:
        raise RuntimeError("plan has neither issue number nor issue_url")
    return number


def reconcile_unknown(plan: dict, gh_path: str) -> dict:
    """Read-only lookup for a plan whose send outcome is unknown. Never sends."""
    marker = plan["marker"]
    repo = plan["repo"]
    if plan.get("kind") == "comment":
        number = resolve_plan_issue(plan, gh_path)
        comments = issue_comments(repo, number, gh_path)
        found = find_marker(comments, marker)
        return {"found": bool(found), "comments": found, "issue": number}
    number = plan.get("issue")
    if isinstance(number, int) and number > 0:
        issue = issue_info(repo, number, gh_path)
        body = str(issue.get("body") or "")
        author = str((issue.get("user") or {}).get("login") or "")
        if marker in body:
            return {"found": True, "issue_record": issue, "issue": number,
                    "author_matches": author.casefold() == str(plan.get("actor", "")).casefold()}
        return {"found": False, "issue": number}
    query = quote(f'repo:{repo} "{marker}" in:body')
    result = gh_json(["api", f"search/issues?q={query}&per_page=10"], gh_path)
    items = [item for item in result.get("items", []) if marker in str(item.get("body") or "")]
    return {"found": bool(items), "issue_record": items[0] if items else None,
            "issue": items[0].get("number") if items else None, "ambiguous": len(items) > 1}


def prepare(args) -> int:
    state_dir = Path(args.state_dir).expanduser()
    if not args.request or not args.request.strip():
        print(json.dumps({"ok": False, "reason": "empty_request"}))
        return 2
    if len(args.request) > 8000:
        print(json.dumps({"ok": False, "reason": "request_too_long"}))
        return 2
    if TOKEN_RE.search(args.request):
        print(json.dumps({"ok": False, "reason": "request_contains_credential_like_text"}))
        return 2
    if not args.skip_precheck:
        checked = precheck_data(args)
        if not checked["ok"]:
            print(json.dumps({"ok": False, "reason": "precheck_failed", "precheck": checked}, ensure_ascii=True))
            return 1
        agent = checked.get("agent") or args.agent
    else:
        agent = args.agent
        if not agent:
            print(json.dumps({"ok": False, "reason": "agent_required_without_precheck"}))
            return 2
    if args.kind == "comment":
        if args.issue is None or args.issue <= 0:
            print(json.dumps({"ok": False, "reason": "issue_required_for_comment"}))
            return 2
        if not args.skip_precheck:
            try:
                gh_json(["api", f"repos/{args.repo}/issues/{args.issue}"], args.gh)
            except RuntimeError as error:
                print(json.dumps({"ok": False, "reason": "issue_unreadable", "detail": sanitise(error, 200)}))
                return 1
    elif args.kind == "issue":
        if not args.allow_new_issue:
            print(json.dumps({"ok": False, "reason": "new_issue_requires_allow_new_issue",
                              "detail": "prefer a comment on an existing Issue; new Issue bodies depend on the agent's notification cursor and are not repository-observed when observeIssues is off"}))
            return 2
    marker = args.marker or marker_new()
    if not re.fullmatch(r"dsb-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}", marker):
        print(json.dumps({"ok": False, "reason": "invalid_marker"}))
        return 2
    body = f"@{agent} [dsh-bridge:{marker}] {args.request}"
    plan = {
        "version": 1,
        "marker": marker,
        "port": args.port,
        "repo": args.repo,
        "actor": args.actor,
        "agent": agent,
        "kind": args.kind,
        "issue": args.issue,
        "body": body,
        "title": args.title if args.kind == "issue" else None,
        "created_at": now_iso(),
        "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=args.ttl_minutes)).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "status": "prepared",
        "gh_command": (f"gh issue comment {args.issue} --repo {args.repo} --body-file <plan-body>"
                       if args.kind == "comment" else f"gh issue create --repo {args.repo} --title ... --body-file <plan-body>"),
    }
    path = Path(args.out) if args.out else plan_path_for(marker, state_dir)
    write_plan(plan, path)
    print(json.dumps({"ok": True, "marker": marker, "plan": str(path), "body": body,
                      "send_command": f"python github_source.py send --plan \"{path}\" --yes",
                      "gh_command": plan["gh_command"], "note": "prepared only; no GitHub write was made"},
                     ensure_ascii=True, indent=2))
    return 0


def find_marker(comments: list[dict], marker: str) -> list[dict]:
    return [item for item in comments if marker in str(item.get("body") or "")]


def mark_sent(plan: dict, path: Path, comment: dict | None) -> dict:
    plan["status"] = "sent"
    plan["sent_at"] = now_iso()
    if comment:
        plan["comment_id"] = comment.get("id")
        plan["comment_url"] = comment.get("html_url")
        plan["comment_updated_at"] = comment.get("updated_at") or comment.get("created_at")
    write_plan(plan, path)
    return plan


def send(args) -> int:
    path = Path(args.plan).expanduser()
    try:
        plan = load_plan(path)
    except (OSError, RuntimeError, ValueError) as error:
        print(json.dumps({"ok": False, "reason": "plan_unreadable", "detail": sanitise(error, 200)}))
        return 2
    if not args.yes:
        print(json.dumps({"ok": False, "reason": "explicit_yes_required", "plan": str(path),
                          "note": "prepare is not send; rerun send with --yes"}))
        return 2
    if plan.get("status") == "sent":
        print(json.dumps({"ok": True, "duplicate": True, "reason": "already_sent", "plan": str(path),
                          "marker": plan.get("marker"), "comment_url": plan.get("comment_url"),
                          "issue": plan.get("issue"), "issue_url": plan.get("issue_url")}))
        return 0
    if plan.get("status") == "sending":
        print(json.dumps({"ok": False, "reason": "send_already_in_progress", "plan": str(path)}))
        return 3
    if plan.get("status") == "unknown":
        if not args.reconcile:
            print(json.dumps({"ok": False, "reason": "previous_send_unknown",
                              "note": "read-only reconcile only: rerun with --reconcile; this tool will not resend"}))
            return 3
        try:
            found = reconcile_unknown(plan, args.gh)
        except (OSError, RuntimeError, ValueError) as error:
            print(json.dumps({"ok": False, "reason": "reconcile_failed", "detail": sanitise(error, 200)}))
            return 3
        if found.get("found") and not found.get("ambiguous"):
            if plan.get("kind") == "issue":
                record = found.get("issue_record") or {}
                plan["issue"] = record.get("number") or found.get("issue")
                plan["issue_url"] = record.get("html_url") or plan.get("issue_url")
                plan["status"] = "sent"
                plan["sent_at"] = plan.get("sent_at") or now_iso()
                plan["reconciled_at"] = now_iso()
                write_plan(plan, path)
            else:
                plan = mark_sent(plan, path, (found.get("comments") or [None])[0])
            print(json.dumps({"ok": True, "duplicate": True, "reason": "reconciled_without_resend",
                              "plan": str(path), "issue": plan.get("issue"), "issue_url": plan.get("issue_url"),
                              "comment_url": plan.get("comment_url")}))
            return 0
        print(json.dumps({"ok": False, "reason": "unknown_still_unproven", "plan": str(path),
                          "note": "nothing was found and nothing was sent; do not resend automatically"}))
        return 3
    expires = datetime.fromisoformat(str(plan.get("expires_at", "")).replace("Z", "+00:00"))
    if datetime.now(timezone.utc) > expires:
        print(json.dumps({"ok": False, "reason": "plan_expired", "plan": str(path)}))
        return 2

    lock = acquire_plan_lock(path)
    if lock is None:
        print(json.dumps({"ok": False, "reason": "send_locked",
                          "plan": str(path), "note": "another send owns this plan; no event was sent"}))
        return 3
    try:
        plan = load_plan(path)
        if plan.get("status") == "sent":
            print(json.dumps({"ok": True, "duplicate": True, "reason": "already_sent"}))
            return 0
        args.repo, args.actor, args.port = plan["repo"], plan["actor"], int(plan["port"])
        args.issue, args.agent, args.gh = plan.get("issue"), plan.get("agent"), args.gh
        if not args.skip_precheck:
            checked = precheck_data(args)
            if not checked["ok"]:
                print(json.dumps({"ok": False, "reason": "precheck_failed", "precheck": checked}, ensure_ascii=True))
                return 1

        # Strict duplicate check: comment marker, or the Issue body author+marker.
        try:
            existing = reconcile_unknown(plan, args.gh)
        except (OSError, RuntimeError, ValueError) as error:
            print(json.dumps({"ok": False, "reason": "duplicate_check_failed", "detail": sanitise(error, 200)}))
            return 1
        if existing.get("found") and not existing.get("ambiguous"):
            if plan.get("kind") == "issue":
                record = existing.get("issue_record") or {}
                plan["issue"] = record.get("number") or existing.get("issue")
                plan["issue_url"] = record.get("html_url") or plan.get("issue_url")
                plan["status"] = "sent"
                plan["sent_at"] = plan.get("sent_at") or now_iso()
                write_plan(plan, path)
            else:
                plan = mark_sent(plan, path, (existing.get("comments") or [None])[0])
            print(json.dumps({"ok": True, "duplicate": True, "reason": "marker_already_present",
                              "plan": str(path), "issue": plan.get("issue"), "issue_url": plan.get("issue_url"),
                              "comment_url": plan.get("comment_url")}))
            return 0

        plan["status"] = "sending"
        plan["sending_at"] = now_iso()
        write_plan(plan, path)
        try:
            if plan["kind"] == "comment":
                number = resolve_plan_issue(plan, args.gh)
                plan["issue"] = number
                result = gh(["api", "--method", "POST", f"repos/{plan['repo']}/issues/{number}/comments",
                             "-f", f"body={plan['body']}"], args.gh, args.timeout)
                if result.returncode != 0:
                    raise RuntimeError(sanitise(result.stderr or result.stdout or f"gh exited {result.returncode}", 300))
                comment = json.loads(result.stdout or "{}")
                plan = mark_sent(plan, path, comment)
            else:
                result = gh(["issue", "create", "--repo", plan["repo"],
                             "--title", plan.get("title") or plan["body"][:120],
                             "--body", plan["body"]], args.gh, args.timeout)
                if result.returncode != 0:
                    raise RuntimeError(sanitise(result.stderr or result.stdout or f"gh exited {result.returncode}", 300))
                url = next((line.strip() for line in reversed(result.stdout.splitlines()) if "github.com/" in line), "")
                plan["status"] = "sent"
                plan["sent_at"] = now_iso()
                plan["issue_url"] = url or None
                plan["issue"] = issue_number_from_url(url)
                write_plan(plan, path)
        except (RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
            plan["status"] = "unknown"
            plan["unknown_at"] = now_iso()
            plan["error"] = sanitise(error, 300)
            write_plan(plan, path)
            print(json.dumps({"ok": False, "reason": "send_unknown", "plan": str(path),
                              "detail": sanitise(error, 300),
                              "note": "the event may exist; do not resend; run send --reconcile or trace"}))
            return 3
        print(json.dumps({"ok": True, "duplicate": False, "marker": plan["marker"], "plan": str(path),
                          "issue": plan.get("issue"), "issue_url": plan.get("issue_url"),
                          "comment_url": plan.get("comment_url"),
                          "note": "event sent once; trace it to the Ticket and Assignment"}, ensure_ascii=True))
        return 0
    finally:
        release_plan_lock(lock)


def tickets_all(port: int, limit: int = 100) -> list[dict]:
    items, seen = [], set()
    for filter_state in ("open", "ended"):
        offset = 0
        while offset < 500:
            page = api(port, f"tickets?state={filter_state}&limit={limit}&offset={offset}")
            rows = page.get("items") if isinstance(page, dict) else None
            if not rows:
                break
            for row in rows:
                key = str(row.get("id"))
                if key not in seen:
                    seen.add(key)
                    items.append(row)
            offset += len(rows)
            if not page.get("next_offset"):
                break
    return items


def ticket_detail(port: int, ticket_id: str) -> dict:
    return api(port, "tickets/" + ticket_id)


def ticket_matches(detail: dict, repo: str, issue: int, marker: str, actor: str) -> bool:
    mandate = detail.get("mandate") or {}
    basis = mandate.get("basis") or {}
    scope = basis.get("scope") or {}
    if str(basis.get("sender", "")).casefold() != actor.casefold():
        return False
    if str(basis.get("source", "")).casefold() != "github":
        return False
    if not isinstance(scope, dict) or scope.get("number") != issue:
        return False
    previews = [str((detail.get("decision") or {}).get("preview") or "")]
    for thread in detail.get("threads") or []:
        latest = thread.get("latest") or {}
        previews.append(str(latest.get("preview") or ""))
    return any(marker in preview for preview in previews)


def event_of_plan(plan: dict, gh_path: str) -> tuple[dict, dict, list[dict]]:
    repo = plan["repo"]
    marker = plan["marker"]
    issue_number = resolve_plan_issue(plan, gh_path)
    issue = issue_info(repo, issue_number, gh_path)
    body = str(issue.get("body") or "")
    author = str((issue.get("user") or {}).get("login") or "")
    comments = issue_comments(repo, issue_number, gh_path)
    if plan.get("kind") == "comment":
        found = find_marker(comments, marker)
        if len(found) != 1:
            raise RuntimeError("comment_marker_not_unique" if found else "comment_missing")
        comment = found[0]
        event = {
            "kind": "comment",
            "issue": issue_number,
            "comment_id": comment.get("id"),
            "url": comment.get("html_url"),
            "author": str((comment.get("user") or {}).get("login") or ""),
            "created_at": comment.get("created_at"),
            "updated_at": comment.get("updated_at"),
            "fingerprint": f"{comment.get('html_url')}#{comment.get('id')}@{comment.get('updated_at') or comment.get('created_at')}",
            "marker": marker,
        }
        return event, issue, comments
    if marker not in body:
        raise RuntimeError("marker_not_in_issue_body")
    if author.casefold() != str(plan.get("actor", "")).casefold():
        raise RuntimeError("issue_author_mismatch")
    if plan.get("sent_at"):
        try:
            sent = datetime.fromisoformat(str(plan["sent_at"]).replace("Z", "+00:00"))
            created = datetime.fromisoformat(str(issue.get("created_at") or "").replace("Z", "+00:00"))
            if abs((created - sent).total_seconds()) > 3600:
                raise RuntimeError("issue_time_mismatch")
        except ValueError:
            pass
    event = {
        "kind": "issue",
        "issue": issue_number,
        "url": issue.get("html_url"),
        "author": author,
        "created_at": issue.get("created_at"),
        "updated_at": issue.get("updated_at"),
        "fingerprint": f"{issue.get('html_url')}#{issue.get('created_at')}#{author}#{marker}",
        "marker": marker,
    }
    return event, issue, comments


def final_comment_view(comments: list[dict], agent: str, after: str | None, show_body: bool) -> dict:
    candidates = []
    for comment in comments:
        author = str((comment.get("user") or {}).get("login") or "")
        if not agent or author.casefold() != agent.casefold():
            continue
        if after and str(comment.get("created_at") or "") < after:
            continue
        candidates.append(comment)
    acknowledgements = [item for item in candidates if is_acknowledgement(str(item.get("body") or ""))]
    finals = [item for item in candidates if not is_acknowledgement(str(item.get("body") or ""))]
    final = finals[-1] if finals else None
    view = {
        "present": bool(final),
        "ack_only": bool(candidates) and final is None,
        "acknowledgement_present": bool(acknowledgements),
        "agent_comment_count": len(candidates),
        "final_comment_id": final.get("id") if final else None,
        "final_comment_url": final.get("html_url") if final else None,
        "final_comment_at": final.get("created_at") if final else None,
        "final_comment_author": str(((final or {}).get("user") or {}).get("login") or "") or None,
    }
    if final and show_body:
        view["body"] = str(final.get("body") or "")[:500]
    return view


def describe_correlation(plan: dict, port: int, gh_path: str, show_body: bool = False) -> dict:
    event, issue, comments = event_of_plan(plan, gh_path)
    state = api(port, "state")
    setup = state.get("setup") or {}
    agent = str((setup.get("accounts") or {}).get("agent") or plan.get("agent") or "")
    instance = {
        "load": state.get("load"),
        "paused": state.get("paused"),
        "github_health": ((state.get("health") or {}).get("github") or {}).get("state"),
        "agent": agent or None,
    }
    detail = None
    for row in tickets_all(port):
        candidate = ticket_detail(port, str(row.get("id")))
        if ticket_matches(candidate, plan["repo"], int(event["issue"]), plan["marker"], plan["actor"]):
            if detail is not None:
                return {"ok": False, "stage": "ticket_ambiguous", "event": event,
                        "instance": instance, "final_comment": final_comment_view(comments, agent, str(issue.get("created_at") or ""), show_body)}
            detail = candidate
    final = final_comment_view(comments, agent, str(issue.get("created_at") or ""), show_body)
    if detail is None:
        return {"ok": False, "stage": "ticket_pending", "event": event, "instance": instance,
                "final_comment": final, "reply": None}
    decision = detail.get("decision") or {}
    ended = detail.get("ended") or {}
    assignments = []
    for assignment in detail.get("assignments") or []:
        report = assignment.get("report") or {}
        state_name = assignment.get("state")
        stale = (state_name == "running" and report.get("state") == "ready"
                 and bool(assignment.get("turnEndedAt")))
        effective = "ended" if stale else state_name
        assignments.append({
            "id": assignment.get("id"),
            "state": state_name,
            "state_effective": effective,
            "stale_running_ignored": stale,
            "ref": assignment.get("ref"),
            "report_state": report.get("state"),
            "report_present": bool(report.get("summary")),
            "turn_ended_at": assignment.get("turnEndedAt"),
            "started_at": assignment.get("startedAt"),
            "ended_at": assignment.get("endedAt") or assignment.get("idleAt"),
        })
    active = (detail.get("state") != "ended"
              and any(a["state_effective"] in ("pending", "running") for a in assignments))
    stage = detail.get("stage")
    channels = detail.get("channels") or []
    reply = channels[0] if channels else None
    return {
        "ok": True,
        "stage": "correlated",
        "event": event,
        "instance": instance,
        "acceptance": {
            "accepted": decision.get("outcome") == "accept",
            "decision_id": decision.get("id"),
            "decision_outcome": decision.get("outcome"),
            "decision_at": decision.get("at"),
            "trigger_ids": decision.get("triggerIds") or [],
            "strength": detail.get("strength"),
            "sender": ((detail.get("mandate") or {}).get("basis") or {}).get("sender"),
            "via": ((detail.get("mandate") or {}).get("basis") or {}).get("via"),
        },
        "ticket": {
            "id": detail.get("id"),
            "state": detail.get("state"),
            "stage": stage,
            "action": detail.get("action"),
            "ended": ended or None,
        },
        "assignments": assignments,
        "assignment": assignments[0] if assignments else None,
        "worker_result": {
            "ref": assignments[0]["ref"] if assignments else None,
            "report_state": assignments[0]["report_state"] if assignments else None,
            "report_present": assignments[0]["report_present"] if assignments else False,
            "turn_ended_at": assignments[0]["turn_ended_at"] if assignments else None,
            "ended_at": assignments[0]["ended_at"] if assignments else None,
        },
        "person": {
            "waiting": stage in ("open", "person"),
            "stage": stage,
            "action": detail.get("action"),
            "report_ready": any(a["report_state"] == "ready" for a in assignments),
        },
        "executor": {
            "active": active,
            "stage": stage,
            "stale_running_ignored": any(a["stale_running_ignored"] for a in assignments),
            "refs": [a["ref"] for a in assignments if a["ref"]],
        },
        "final_comment": final,
        "reply": reply,
    }


def ticket_for_issue(port: int, repo: str, issue: int, marker: str | None = None,
                     actor: str | None = None) -> dict | None:
    matches = []
    for row in tickets_all(port):
        detail = ticket_detail(port, str(row.get("id")))
        mandate = detail.get("mandate") or {}
        basis = mandate.get("basis") or {}
        scope = basis.get("scope") or {}
        if not isinstance(scope, dict) or scope.get("number") != issue:
            continue
        if str(basis.get("source", "")).casefold() != "github":
            continue
        if actor and str(basis.get("sender", "")).casefold() != actor.casefold():
            continue
        if marker:
            previews = [str((detail.get("decision") or {}).get("preview") or "")]
            previews += [str((thread.get("latest") or {}).get("preview") or "") for thread in detail.get("threads") or []]
            if not any(marker in preview for preview in previews):
                continue
        matches.append(detail)
    return matches[0] if len(matches) == 1 else None


def compare_issues(args) -> int:
    repo, port = args.repo, args.port
    state = api(port, "state")
    setup = state.get("setup") or {}
    agent = str((setup.get("accounts") or {}).get("agent") or "")
    rows = []
    for raw in args.issues.split(","):
        number = int(raw.strip())
        issue = issue_info(repo, number, args.gh)
        comments = issue_comments(repo, number, args.gh)
        detail = ticket_for_issue(port, repo, number)
        row = {"issue": number, "author": (issue.get("user") or {}).get("login"),
               "created_at": issue.get("created_at"),
               "final_comment": final_comment_view(comments, agent, str(issue.get("created_at") or ""), args.show_body)}
        if detail is None:
            row.update({"ticket": None, "stage": "ticket_pending"})
            rows.append(row)
            continue
        assignments = []
        for assignment in detail.get("assignments") or []:
            report = assignment.get("report") or {}
            stale = (assignment.get("state") == "running" and report.get("state") == "ready"
                     and bool(assignment.get("turnEndedAt")))
            assignments.append({"id": assignment.get("id"), "state": assignment.get("state"),
                                "state_effective": "ended" if stale else assignment.get("state"),
                                "stale_running_ignored": stale, "ref": assignment.get("ref"),
                                "report_state": report.get("state"),
                                "turn_ended_at": assignment.get("turnEndedAt"),
                                "ended_at": assignment.get("endedAt") or assignment.get("idleAt")})
        active = (detail.get("state") != "ended"
                  and any(item["state_effective"] in ("pending", "running") for item in assignments))
        row.update({
            "ticket": {"id": detail.get("id"), "state": detail.get("state"), "stage": detail.get("stage"),
                       "ended": detail.get("ended")},
            "assignment": assignments[0] if assignments else None,
            "trigger_ids": (detail.get("decision") or {}).get("triggerIds") or [],
            "person": {"stage": detail.get("stage"), "report_ready": any(item["report_state"] == "ready" for item in assignments)},
            "executor": {"active": active, "stale_running_ignored": any(item["stale_running_ignored"] for item in assignments)},
        })
        rows.append(row)
    print(json.dumps({"repo": repo, "port": port,
                      "instance_load": state.get("load"), "issues": rows}, ensure_ascii=True, indent=2))
    return 0


def trace(args) -> int:
    if args.plan:
        plan_path = Path(args.plan).expanduser()
        plan = load_plan(plan_path)
        if str(plan.get("repo")) != str(args.repo) and args.repo is not None:
            print(json.dumps({"ok": False, "reason": "plan_repo_mismatch"}))
            return 2
        port = int(plan.get("port") or args.port)
    else:
        if not (args.repo and args.issue and args.marker):
            print(json.dumps({"ok": False, "reason": "trace_needs_plan_or_repo_issue_marker"}))
            return 2
        plan = {"repo": args.repo, "issue": args.issue, "marker": args.marker,
                "actor": args.actor, "agent": args.agent, "port": args.port, "kind": "comment",
                "issue_url": f"https://github.com/{args.repo}/issues/{args.issue}"}
        port = args.port
    deadline = time.monotonic() + max(0, args.wait)
    latest = None
    while True:
        try:
            latest = describe_correlation(plan, port, args.gh, show_body=args.show_body)
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
            latest = {"ok": False, "stage": "read_failed", "detail": sanitise(error, 200)}
        if latest.get("stage") in ("correlated", "ticket_ambiguous", "read_failed"):
            break
        if time.monotonic() >= deadline:
            break
        time.sleep(max(1, min(args.interval, 30)))
    output = {"repo": plan["repo"], "issue": plan.get("issue") or issue_number_from_url(plan.get("issue_url")),
              "marker": plan["marker"], **(latest or {})}
    print(json.dumps(output, ensure_ascii=True, indent=2))
    return 0 if latest and latest.get("stage") == "correlated" else 4


# --------------------------------------------------------------------------- #
# Reply on the source thread, and follow the result
# --------------------------------------------------------------------------- #
REPO_URL_RE = re.compile(r"https://github\.com/([^/\s]+)/([^/\s]+)/(?:issues|pull)/\d+")
STOP_MARKERS = ("stopped", "stop", "cancelled", "canceled")


def skill_root() -> Path:
    return Path(os.environ.get("DSH_BRIDGE_SKILL_STATE", Path.home() / ".codex" / "state" / "deepseek-harness-bridge")).expanduser()


def reply_plans_dir() -> Path:
    return skill_root() / "reply" / "plans"


def reply_cursors_dir() -> Path:
    return skill_root() / "reply" / "cursors"


def verdicts_path() -> Path:
    return skill_root() / "local" / "verdicts.jsonl"


def repo_from_url(url: object) -> str | None:
    match = REPO_URL_RE.search(str(url or ""))
    return f"{match.group(1)}/{match.group(2)}" if match else None


def write_state(value: dict, path: Path) -> None:
    """Atomic 0600 local state file; same writer as the send plan."""
    write_plan(value, path)


def read_state(path: Path) -> dict | None:
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def reply_evidence(detail: dict, source: dict | None, issue: int | None) -> dict:
    """What was checked before replying: the delivery basis, captured as of now."""
    row = sa_newest_assignment(sa_assignment_rows(detail))
    latest = sa_assignment_view(row) if row else None
    delivery = sa_delivery_view(detail)
    ended = detail.get("ended") if isinstance(detail.get("ended"), dict) else None
    return {
        "captured_at": now_iso(),
        "ticket": detail.get("id"),
        "engine_state": {"state": detail.get("state"), "stage": detail.get("stage"),
                         "action": detail.get("action"), "ended": ended},
        "latest_assignment": latest,
        "report_cursor": {"assignment": (latest or {}).get("id"),
                          "report_state": (latest or {}).get("report_state"),
                          "report_at": (latest or {}).get("report_at")},
        "delivery": delivery,
        "delivered_to_ticket": sa_delivered_to_ticket(detail),
        "undelivered": delivery.get("undelivered"),
        "source_thread": source,
        "issue": issue,
        "note": "a ready report, an accepted decision and a stop are each recorded as-is; none of them is a pass",
    }


def reply_prepare(args) -> int:
    if not args.request or not args.request.strip():
        print(json.dumps({"ok": False, "reason": "empty_request"}))
        return 2
    if len(args.request) > 8000:
        print(json.dumps({"ok": False, "reason": "request_too_long"}))
        return 2
    if TOKEN_RE.search(args.request):
        print(json.dumps({"ok": False, "reason": "request_contains_credential_like_text"}))
        return 2
    try:
        detail = sa_ticket_detail(args.port, args.ticket)
    except (OSError, RuntimeError, ValueError) as error:
        print(json.dumps({"ok": False, "reason": "ticket_unreadable", "ticket": args.ticket,
                          "detail": sanitise(error, 200)}))
        return 1
    source = sa_source_thread(detail)
    issue = args.issue or (source or {}).get("issue_number")
    if not issue:
        print(json.dumps({"ok": False, "reason": "no_source_thread", "ticket": args.ticket,
                          "note": "this ticket has no GitHub Issue thread; a Pull Request thread is not a reply target"}))
        return 2
    repo = args.repo or repo_from_url((source or {}).get("url"))
    if not repo:
        for channel in detail.get("channels") or []:
            repo = repo_from_url(channel.get("url") if isinstance(channel, dict) else channel)
            if repo:
                break
    if not repo:
        print(json.dumps({"ok": False, "reason": "repo_unknown", "ticket": args.ticket,
                          "note": "pass --repo or use a ticket whose Issue thread names the repository"}))
        return 2
    issue_url = ((source or {}).get("url") if (source or {}).get("issue_number") == issue
                 else f"https://github.com/{repo}/issues/{issue}")
    actor = args.actor or gh_authenticated_login(args.gh) or str(
        ((detail.get("mandate") or {}).get("basis") or {}).get("sender") or "")
    agent = args.agent
    evidence = reply_evidence(detail, source, issue)
    if not args.skip_precheck:
        checked = precheck_data(argparse.Namespace(port=args.port, repo=repo, actor=actor, agent=agent, gh=args.gh))
        if not checked["ok"]:
            print(json.dumps({"ok": False, "reason": "precheck_failed", "precheck": checked,
                              "note": "dispatch refused; repository_matches=false means this profile's Source is bound "
                                      "to another repository and cannot take this event"},
                             ensure_ascii=True))
            return 1
        agent = checked.get("agent") or agent
    if not agent:
        print(json.dumps({"ok": False, "reason": "agent_unknown",
                          "note": "pass --agent or use a profile whose GitHub Source names an agent"}))
        return 2
    marker = args.marker or marker_new()
    if not re.fullmatch(r"dsb-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}", marker):
        print(json.dumps({"ok": False, "reason": "invalid_marker"}))
        return 2
    body = f"@{agent} [dsh-bridge:{marker}] {args.request}"
    plan = {
        "version": 1,
        "reply": True,
        "ticket": args.ticket,
        "marker": marker,
        "port": args.port,
        "repo": repo,
        "actor": actor,
        "agent": agent,
        "kind": "comment",
        "issue": issue,
        "issue_url": issue_url,
        "body": body,
        "title": None,
        "created_at": now_iso(),
        "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=args.ttl_minutes))
        .isoformat(timespec="seconds").replace("+00:00", "Z"),
        "status": "prepared",
        "evidence": evidence,
        "gh_command": f"gh issue comment {issue} --repo {repo} --body-file <plan-body>",
    }
    path = Path(args.out) if args.out else reply_plans_dir() / f"{marker}.json"
    write_plan(plan, path)
    print(json.dumps({
        "ok": True,
        "ticket": args.ticket,
        "source_thread": source,
        "target_issue_url": issue_url,
        "marker": marker,
        "body": body,
        "plan": str(path),
        "instance": {"port": args.port, "repo": repo, "actor": actor, "agent": agent},
        "latest_assignment": evidence["latest_assignment"],
        "report_cursor": evidence["report_cursor"],
        "delivery": evidence["delivery"],
        "send_command": f"python github_source.py reply send --plan \"{path}\" --yes",
        "note": "prepared only; no GitHub write was made. send --yes writes once.",
    }, ensure_ascii=True, indent=2))
    return 0


def reply_send(args) -> int:
    try:
        plan = load_plan(Path(args.plan).expanduser())
    except (OSError, RuntimeError, ValueError) as error:
        print(json.dumps({"ok": False, "reason": "plan_unreadable", "detail": sanitise(error, 200)}))
        return 2
    if not plan.get("reply") or not plan.get("ticket"):
        print(json.dumps({"ok": False, "reason": "not_a_reply_plan",
                          "note": "use reply prepare; the generic send path is unchanged"}))
        return 2
    # The single sender, duplicate check, lock and unknown handling stay in send().
    return send(args)


def reply_plan_for(args) -> tuple[dict | None, Path | None]:
    if getattr(args, "plan", None):
        path = Path(args.plan).expanduser()
        return load_plan(path), path
    ticket = getattr(args, "ticket", None)
    if not ticket:
        raise RuntimeError("plan_or_ticket_required")
    found = []
    if reply_plans_dir().is_dir():
        for path in sorted(reply_plans_dir().glob("*.json")):
            plan = read_state(path)
            if plan and str(plan.get("ticket")) == str(ticket):
                found.append((str(plan.get("created_at") or ""), plan, path))
    if not found:
        return None, None
    _, plan, path = max(found, key=lambda item: item[0])
    return plan, path


def pr_checks(gh_path: str, repo: str, number: int, sha: str | None) -> dict:
    """Checks by `gh pr checks`, else commit check-runs + commit status.

    GitHub's REST API has no `GET /repos/{repo}/pulls/{number}/checks` (it is a
    404); these three reads are the ones that exist. An empty list is not a pass.
    """
    result = gh(["pr", "checks", str(number), "--repo", repo, "--json", "name,state,bucket,link"], gh_path, 60)
    if (result.stdout or "").strip().startswith("["):
        try:
            rows = [row for row in json.loads(result.stdout) if isinstance(row, dict)]
            buckets: dict[str, int] = {}
            for row in rows:
                label = str(row.get("bucket") or row.get("state") or "unknown")
                buckets[label] = buckets.get(label, 0) + 1
            return {"source": "gh_pr_checks", "total": len(rows), "by_bucket": buckets,
                    "exit_code": result.returncode, "note": "an empty check list is not a pass"}
        except ValueError:
            pass
    if sha:
        try:
            runs = gh_json(["api", f"repos/{repo}/commits/{sha}/check-runs"], gh_path)
            status = gh_json(["api", f"repos/{repo}/commits/{sha}/status"], gh_path)
            return {"source": "commit_check_runs+status", "total": runs.get("total_count", 0),
                    "state": status.get("state"), "statuses": status.get("total_count", 0),
                    "note": "0 checks is not a pass"}
        except RuntimeError as error:
            return {"source": "unavailable", "error": sanitise(error, 200)}
    return {"source": "unavailable", "note": "gh pr checks returned no JSON and there is no head sha"}


def pr_state(gh_path: str, repo: str, number: int) -> dict:
    """Read-only Pull Request state: open/merged/closed/draft, mergeStateStatus, checks."""
    owner, name = repo.split("/", 1)
    query = ("query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){"
             "pullRequest(number:$number){number url state merged isDraft mergeStateStatus reviewDecision "
             "baseRefName headRefOid}}}")
    record: dict = {}
    try:
        data = gh_json(["api", "graphql", "-f", f"query={query}", "-f", f"owner={owner}",
                        "-f", f"name={name}", "-F", f"number={number}"], gh_path)
        pull = (((data or {}).get("data") or {}).get("repository") or {}).get("pullRequest") or {}
        if pull:
            record = {"source": "graphql", "number": pull.get("number") or number, "url": pull.get("url"),
                      "state": pull.get("state"), "merged": bool(pull.get("merged")),
                      "draft": bool(pull.get("isDraft")), "mergeStateStatus": pull.get("mergeStateStatus"),
                      "reviewDecision": pull.get("reviewDecision"), "base_ref": pull.get("baseRefName"),
                      "head_sha": pull.get("headRefOid")}
    except (OSError, RuntimeError, ValueError) as error:
        record = {"graphql_error": sanitise(error, 200)}
    if "number" not in record:
        rest = gh_json(["api", f"repos/{repo}/pulls/{number}"], gh_path)
        record = {"source": "rest", "number": number, "url": rest.get("html_url"), "state": rest.get("state"),
                  "merged": bool(rest.get("merged")), "draft": bool(rest.get("draft")),
                  "mergeStateStatus": rest.get("mergeable_state"), "reviewDecision": rest.get("reviewDecision"),
                  "base_ref": (rest.get("base") or {}).get("ref"), "head_sha": (rest.get("head") or {}).get("sha")}
    record["checks"] = pr_checks(gh_path, repo, number, record.get("head_sha"))
    record["note"] = ("REST GET /repos/{repo}/pulls/{number}/checks does not exist (404); "
                      "checks come from gh pr checks or commit check-runs/status")
    return record


def reply_snapshot(detail: dict, plan: dict | None, gh_path: str, check_pr: bool = False) -> dict:
    """One read-only view of 'what happened after the reply'."""
    source = sa_source_thread(detail)
    marker = (plan or {}).get("marker")
    repo = (plan or {}).get("repo") or repo_from_url((source or {}).get("url"))
    issue = (plan or {}).get("issue") or (source or {}).get("issue_number")
    submitted: dict = {"submitted": None, "marker": marker}
    if plan and marker and repo and issue:
        try:
            comments = issue_comments(repo, int(issue), gh_path)
            found = find_marker(comments, marker)
            submitted = {"submitted": bool(found), "marker": marker, "marker_count": len(found),
                         "comment_id": found[0].get("id") if found else None,
                         "comment_url": found[0].get("html_url") if found else None,
                         "comment_at": found[0].get("created_at") if found else None}
        except (OSError, RuntimeError, ValueError) as error:
            submitted = {"submitted": None, "marker": marker, "read_error": sanitise(error, 200)}
    proof = sa_delivered_to_ticket(detail, marker) if marker else sa_delivered_to_ticket(detail)
    if marker and not proof.get("delivered"):
        sent_at = str((plan or {}).get("sent_at") or (plan or {}).get("created_at") or "")
        fallback = sa_delivered_to_ticket(detail)
        if fallback.get("delivered") and str(fallback.get("delivered_at") or "") >= sent_at:
            proof = {**fallback, "matched": "any_input_after_plan"}
    if proof.get("delivered"):
        delivery_state = "delivered_to_ticket"
    elif submitted.get("submitted"):
        delivery_state = "pending_delivery"
    elif plan:
        delivery_state = "not_delivered"
    else:
        delivery_state = "unknown"
    row = sa_newest_assignment(sa_assignment_rows(detail))
    latest = sa_assignment_view(row) if row else None
    decision = detail.get("decision") if isinstance(detail.get("decision"), dict) else {}
    decision_at = str(decision.get("at") or "")
    delivered_at = str(proof.get("delivered_at") or "")
    report_at = str((latest or {}).get("report_at") or "")
    ended = detail.get("ended") if isinstance(detail.get("ended"), dict) else None
    pull_request = None
    if check_pr and repo:
        numbers = [row.get("number") for row in sa_pull_requests(detail) if row.get("number")]
        if numbers:
            pulls, problems = [], []
            for number in numbers:
                try:
                    pulls.append(pr_state(gh_path, repo, int(number)))
                except (OSError, RuntimeError, ValueError) as error:
                    problems.append({"number": number, "error": sanitise(error, 200)})
            pull_request = {"pull_requests": pulls, "errors": problems}
    return {
        "ticket": {"id": detail.get("id"), "state": detail.get("state"), "stage": detail.get("stage"),
                   "action": detail.get("action"), "ended": ended},
        "source_thread": source,
        "issue": issue,
        "marker": marker,
        "submitted": submitted,
        "delivery": delivery_state,
        "delivered_to": proof,
        "worker_read": bool(proof.get("read_at")),
        "report": {"assignment": (latest or {}).get("id"), "assignments": len(sa_assignment_rows(detail)),
                   "report_state": (latest or {}).get("report_state"), "report_at": (latest or {}).get("report_at"),
                   "report_new_since_delivery": bool(report_at and delivered_at and report_at >= delivered_at)},
        "acceptance": {"accepted": decision.get("outcome") == "accept", "outcome": decision.get("outcome"),
                       "at": decision.get("at")},
        "new_decision_after_input": bool(decision_at and delivered_at and decision_at >= delivered_at),
        "pull_request": pull_request,
        "delivery_scope": {
            "assignments": [{"id": item.get("id"), "state": item.get("state_effective"),
                             "ref": item.get("ref"), "report_state": item.get("report_state")}
                            for item in (sa_assignment_view(r) for r in sa_assignment_rows(detail))],
            "threads": [{"key": row.get("key"), "subscriptions": row.get("subscriptions"), "stage": row.get("stage")}
                        for row in (detail.get("threads") or []) if isinstance(row, dict)],
        },
        "rule": "delivered_to_ticket means this Ticket took the message; a new Decision is not required",
    }


def reply_stage(snapshot: dict) -> str:
    if (snapshot.get("ticket") or {}).get("ended"):
        return "ticket_terminal"
    if snapshot.get("delivery") == "delivered_to_ticket":
        return "delivered"
    if (snapshot.get("submitted") or {}).get("submitted"):
        return "submitted"
    if snapshot.get("delivery") == "pending_delivery":
        return "pending_delivery"
    return "pending"


def reply_trace(args) -> int:
    try:
        plan, plan_path = reply_plan_for(args)
    except (OSError, RuntimeError, ValueError) as error:
        print(json.dumps({"ok": False, "reason": "plan_unreadable", "detail": sanitise(error, 200)}))
        return 2
    ticket = getattr(args, "ticket", None) or (plan or {}).get("ticket")
    if not ticket:
        print(json.dumps({"ok": False, "reason": "plan_or_ticket_required"}))
        return 2
    port = args.port or int((plan or {}).get("port") or 3084)
    deadline = time.monotonic() + max(0, args.wait)
    snapshot: dict = {}
    while True:
        try:
            detail = sa_ticket_detail(port, ticket)
            snapshot = reply_snapshot(detail, plan, args.gh, args.check_pr)
        except (OSError, RuntimeError, ValueError) as error:
            snapshot = {"error": "read_failed", "detail": sanitise(error, 200)}
        stage = reply_stage(snapshot) if "error" not in snapshot else "read_failed"
        if stage in ("delivered", "ticket_terminal", "read_failed") or time.monotonic() >= deadline:
            break
        time.sleep(max(1, min(args.interval, 60)))
    output = {"ok": "error" not in snapshot, "port": port, "ticket": ticket,
              "stage": reply_stage(snapshot) if "error" not in snapshot else "read_failed",
              "plan": str(plan_path) if plan_path else None,
              **snapshot}
    print(json.dumps(output, ensure_ascii=True, indent=2))
    return 0 if output["ok"] else 1


def reply_cursor(snapshot: dict, previous: dict | None = None) -> dict:
    proof = snapshot.get("delivered_to") or {}
    submitted = snapshot.get("submitted") or {}
    report = snapshot.get("report") or {}
    ended = (snapshot.get("ticket") or {}).get("ended") or {}
    pull = snapshot.get("pull_request") or {}
    states = "/".join(str(item.get("state")) for item in pull.get("pull_requests") or []) or ""
    return {
        "ticket": (snapshot.get("ticket") or {}).get("id"),
        "updated_at": now_iso(),
        "marker": snapshot.get("marker"),
        "stage": reply_stage(snapshot),
        "submitted_comment_id": submitted.get("comment_id") or (previous or {}).get("submitted_comment_id"),
        "delivered_input_id": proof.get("input_id") or (previous or {}).get("delivered_input_id"),
        "delivered_at": proof.get("delivered_at") or (previous or {}).get("delivered_at"),
        "read_at": proof.get("read_at") or (previous or {}).get("read_at"),
        "report_at": report.get("report_at") or (previous or {}).get("report_at"),
        "terminal_outcome": ended.get("outcome") or (previous or {}).get("terminal_outcome"),
        "pull_request_state": states or (previous or {}).get("pull_request_state"),
    }


def poll_changes(previous: dict, snapshot: dict) -> list[str]:
    """Only states that moved since the saved cursor. The same cursor reports nothing."""
    changes: list[str] = []
    submitted = snapshot.get("submitted") or {}
    proof = snapshot.get("delivered_to") or {}
    report = snapshot.get("report") or {}
    ended = (snapshot.get("ticket") or {}).get("ended") or {}
    pull = snapshot.get("pull_request") or {}
    if submitted.get("submitted") and str(submitted.get("comment_id")) != str(previous.get("submitted_comment_id")):
        changes.append("submitted")
    if proof.get("delivered") and str(proof.get("input_id")) != str(previous.get("delivered_input_id")):
        changes.append("delivered")
    if snapshot.get("worker_read") and str(proof.get("read_at")) != str(previous.get("read_at")):
        changes.append("worker_read")
    if report.get("report_at") and str(report.get("report_at")) != str(previous.get("report_at")):
        changes.append("report_new")
    if ended.get("outcome") and str(ended.get("outcome")) != str(previous.get("terminal_outcome")):
        changes.append("ticket_terminal")
    states = "/".join(str(item.get("state")) for item in pull.get("pull_requests") or [])
    if states and states != str(previous.get("pull_request_state")):
        changes.append("pull_request_state")
    return changes


def reply_poll(args) -> int:
    try:
        plan, _ = reply_plan_for(args)
    except (OSError, RuntimeError, ValueError) as error:
        print(json.dumps({"ok": False, "reason": "plan_unreadable", "detail": sanitise(error, 200)}))
        return 2
    ticket = args.ticket or (plan or {}).get("ticket")
    if not ticket:
        print(json.dumps({"ok": False, "reason": "plan_or_ticket_required"}))
        return 2
    port = args.port or int((plan or {}).get("port") or 3084)
    cursor_path = reply_cursors_dir() / f"{ticket}.json"
    previous = read_state(cursor_path) or {}
    deadline = time.monotonic() + max(0, args.wait)
    snapshot: dict = {}
    changes: list[str] = []
    cursor: dict = previous
    while True:
        detail = sa_ticket_detail(port, ticket)
        snapshot = reply_snapshot(detail, plan, args.gh, args.check_pr)
        changes = poll_changes(previous, snapshot)
        cursor = reply_cursor(snapshot, previous)
        write_state(cursor, cursor_path)
        if changes or not (args.watch or args.wait) or time.monotonic() >= deadline:
            break
        time.sleep(max(1, min(args.interval, 300)))
    output = {"ok": True, "ticket": ticket, "port": port, "marker": snapshot.get("marker"),
              "changed": bool(changes), "new": changes, "stage": reply_stage(snapshot),
              "cursor": cursor, "cursor_path": str(cursor_path), "snapshot": snapshot,
              "note": "poll only; event subscription is not enabled (the management API has no event route)"}
    if args.resume:
        output["resumed_from"] = previous or None
    print(json.dumps(output, ensure_ascii=True, indent=2))
    return 0


# --------------------------------------------------------------------------- #
# Local verdict (never writes engine state)
# --------------------------------------------------------------------------- #
def engine_state_of(detail: dict) -> dict:
    ended = detail.get("ended") if isinstance(detail.get("ended"), dict) else None
    decision = detail.get("decision") if isinstance(detail.get("decision"), dict) else {}
    row = sa_newest_assignment(sa_assignment_rows(detail))
    latest = sa_assignment_view(row) if row else None
    delivery = sa_delivery_view(detail)
    stopped = bool(ended and str(ended.get("by")) == "human"
                   and str(ended.get("outcome") or "") in STOP_MARKERS)
    report_ready = bool(latest and latest.get("report_state") == "ready")
    label = "stopped_by_human" if stopped else (
        "ended" if ended else f"{detail.get('stage')}/{detail.get('action')}")
    return {
        "label": label,
        "state": detail.get("state"),
        "stage": detail.get("stage"),
        "action": detail.get("action"),
        "ended": ended,
        "stopped_by_human": stopped,
        "latest_assignment": latest,
        "report_ready": report_ready,
        "report_at": (latest or {}).get("report_at"),
        "undelivered": delivery.get("undelivered"),
        "delivery_proven": bool(report_ready and delivery.get("undelivered") == 0),
        "delivery_note": "a ready worker report with nothing undelivered is delivery evidence; "
                         "an accepted Decision is not",
        "acceptance": {"accepted": decision.get("outcome") == "accept", "outcome": decision.get("outcome"),
                       "at": decision.get("at")},
        "stop_is_not_pass": True,
    }


def remote_state(args, detail: dict) -> dict:
    source = sa_source_thread(detail)
    repo = args.repo or repo_from_url((source or {}).get("url"))
    pulls, errors = [], []
    if repo:
        for row in sa_pull_requests(detail):
            try:
                pulls.append(pr_state(args.gh, repo, int(row["number"])))
            except (OSError, RuntimeError, ValueError) as error:
                errors.append({"number": row.get("number"), "error": sanitise(error, 200)})
    issue = None
    if repo and source and source.get("issue_number"):
        try:
            record = gh_json(["api", f"repos/{repo}/issues/{source['issue_number']}"], args.gh)
            issue = {"number": source["issue_number"], "state": record.get("state"),
                     "url": record.get("html_url")}
        except (OSError, RuntimeError, ValueError) as error:
            issue = {"number": source["issue_number"], "error": sanitise(error, 200)}
    return {"repo": repo, "pull_requests": pulls, "errors": errors, "issue": issue, "read_only": True}


def append_verdict(record: dict) -> Path:
    path = verdicts_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(handle, (json.dumps(record, ensure_ascii=True) + "\n").encode("utf-8"))
        os.fsync(handle)
    finally:
        os.close(handle)
    return path


def verdict_set(args) -> int:
    if not args.evidence or not args.evidence.strip():
        print(json.dumps({"ok": False, "reason": "evidence_required",
                          "note": "a local verdict needs a path or URL that shows what was checked"}))
        return 2
    try:
        detail = sa_ticket_detail(args.port, args.ticket)
    except (OSError, RuntimeError, ValueError) as error:
        print(json.dumps({"ok": False, "reason": "ticket_unreadable", "detail": sanitise(error, 200)}))
        return 1
    engine = engine_state_of(detail)
    if args.result == "pass" and engine["stopped_by_human"]:
        print(json.dumps({"ok": False, "reason": "engine_state_stopped_by_human",
                          "local_verdict": args.result, "engine_state": engine,
                          "note": "a human stop ends the ticket as stopped; it is never a pass"}, ensure_ascii=True, indent=2))
        return 2
    if args.result == "pass" and not engine["delivery_proven"] and not args.force:
        print(json.dumps({"ok": False, "reason": "delivery_not_proven",
                          "local_verdict": args.result, "engine_state": engine,
                          "note": "no ready worker report with nothing undelivered; an accepted Decision is not a "
                                  "delivery. Record fail/hold, or pass --force to override explicitly."},
                         ensure_ascii=True, indent=2))
        return 2
    warnings = []
    if engine["acceptance"]["accepted"] and not engine["delivery_proven"]:
        warnings.append("acceptance_is_not_delivery")
    if args.result == "pass" and not engine["delivery_proven"]:
        warnings.append("forced_pass_without_delivery")
    record = {
        "id": secrets.token_hex(6),
        "at": now_iso(),
        "ticket": args.ticket,
        "port": args.port,
        "local_verdict": args.result,
        "evidence": args.evidence.strip(),
        "note": args.note,
        "engine_state": engine,
        "remote": remote_state(args, detail) if args.check_remote else None,
        "warnings": warnings,
        "writer": "deepseek-harness-bridge local verdict file; no engine write",
    }
    path = append_verdict(record)
    print(json.dumps({"ok": True, "local_verdict": record["local_verdict"], "engine_state": engine,
                      "record": record, "path": str(path)}, ensure_ascii=True, indent=2))
    return 0


def verdict_rows() -> list[dict]:
    path = verdicts_path()
    if not path.is_file():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict):
            rows.append(value)
    return rows


def verdict_list(args) -> int:
    rows = verdict_rows()
    if args.ticket:
        rows = [row for row in rows if str(row.get("ticket")) == str(args.ticket)]
    rows = rows[-max(1, args.limit):]
    print(json.dumps({"ok": True, "path": str(verdicts_path()), "count": len(rows), "items": rows},
                     ensure_ascii=True, indent=2))
    return 0


def verdict_show(args) -> int:
    rows = verdict_rows()
    match = next((row for row in reversed(rows) if str(row.get("id")) == str(args.target)), None)
    if match is None:
        match = next((row for row in reversed(rows) if str(row.get("ticket")) == str(args.target)), None)
    if match is None:
        print(json.dumps({"ok": False, "reason": "verdict_not_found", "target": args.target}))
        return 1
    print(json.dumps({"ok": True, "local_verdict": match.get("local_verdict"),
                      "engine_state": match.get("engine_state"), "record": match,
                      "path": str(verdicts_path())}, ensure_ascii=True, indent=2))
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("--gh", default=os.environ.get("DSH_BRIDGE_GH", "gh"))
    sub = root.add_subparsers(dest="command", required=True)
    common = {
        "--port": {"type": int, "default": 3084},
        "--repo": {"required": True},
        "--actor": {"required": True},
        "--agent": {"default": None},
    }

    def add_common(target):
        for flag, options in common.items():
            target.add_argument(flag, **options)

    check = sub.add_parser("precheck")
    add_common(check)

    prep = sub.add_parser("prepare")
    add_common(prep)
    prep.add_argument("--issue", type=int)
    prep.add_argument("--kind", choices=("comment", "issue"), default="comment")
    prep.add_argument("--request", default="")
    prep.add_argument("--title", default="")
    prep.add_argument("--marker", default="")
    prep.add_argument("--out")
    prep.add_argument("--state-dir", default=str(DEFAULT_STATE))
    prep.add_argument("--ttl-minutes", type=int, default=30)
    prep.add_argument("--allow-new-issue", action="store_true")
    prep.add_argument("--skip-precheck", action="store_true")

    send_cmd = sub.add_parser("send")
    send_cmd.add_argument("--plan", required=True)
    send_cmd.add_argument("--yes", action="store_true")
    send_cmd.add_argument("--timeout", type=float, default=30.0)
    send_cmd.add_argument("--skip-precheck", action="store_true")
    send_cmd.add_argument("--reconcile", action="store_true")

    trace_cmd = sub.add_parser("trace")
    trace_cmd.add_argument("--plan")
    trace_cmd.add_argument("--port", type=int, default=3084)
    trace_cmd.add_argument("--repo")
    trace_cmd.add_argument("--issue", type=int)
    trace_cmd.add_argument("--marker")
    trace_cmd.add_argument("--actor")
    trace_cmd.add_argument("--agent")
    trace_cmd.add_argument("--show-body", action="store_true")
    trace_cmd.add_argument("--wait", type=int, default=0)
    trace_cmd.add_argument("--interval", type=int, default=10)

    compare_cmd = sub.add_parser("compare")
    compare_cmd.add_argument("--port", type=int, default=3084)
    compare_cmd.add_argument("--repo", required=True)
    compare_cmd.add_argument("--actor")
    compare_cmd.add_argument("--issues", required=True)
    compare_cmd.add_argument("--show-body", action="store_true")

    reply_cmd = sub.add_parser("reply", help="reply on the ticket's source Issue and follow the result")
    reply_sub = reply_cmd.add_subparsers(dest="reply_command", required=True)

    reply_prep = reply_sub.add_parser("prepare")
    reply_prep.add_argument("--ticket", required=True)
    reply_prep.add_argument("--port", type=int, default=3084)
    reply_prep.add_argument("--repo")
    reply_prep.add_argument("--actor")
    reply_prep.add_argument("--agent")
    reply_prep.add_argument("--issue", type=int)
    reply_prep.add_argument("--request", default="")
    reply_prep.add_argument("--marker", default="")
    reply_prep.add_argument("--out")
    reply_prep.add_argument("--ttl-minutes", type=int, default=60)
    reply_prep.add_argument("--skip-precheck", action="store_true")

    reply_send_cmd = reply_sub.add_parser("send")
    reply_send_cmd.add_argument("--plan", required=True)
    reply_send_cmd.add_argument("--yes", action="store_true")
    reply_send_cmd.add_argument("--timeout", type=float, default=30.0)
    reply_send_cmd.add_argument("--skip-precheck", action="store_true")
    reply_send_cmd.add_argument("--reconcile", action="store_true")

    reply_trace_cmd = reply_sub.add_parser("trace")
    reply_trace_cmd.add_argument("--plan")
    reply_trace_cmd.add_argument("--ticket")
    reply_trace_cmd.add_argument("--port", type=int, default=None)
    reply_trace_cmd.add_argument("--wait", type=int, default=0)
    reply_trace_cmd.add_argument("--interval", type=int, default=15)
    reply_trace_cmd.add_argument("--check-pr", action="store_true")

    reply_poll_cmd = reply_sub.add_parser("poll")
    reply_poll_cmd.add_argument("--ticket", required=True)
    reply_poll_cmd.add_argument("--plan")
    reply_poll_cmd.add_argument("--port", type=int, default=None)
    reply_poll_cmd.add_argument("--wait", type=int, default=0)
    reply_poll_cmd.add_argument("--interval", type=int, default=30)
    reply_poll_cmd.add_argument("--watch", action="store_true")
    reply_poll_cmd.add_argument("--resume", action="store_true")
    reply_poll_cmd.add_argument("--check-pr", action="store_true")

    verdict_cmd = sub.add_parser("verdict", help="local acceptance verdict; never writes engine state")
    verdict_sub = verdict_cmd.add_subparsers(dest="verdict_command", required=True)
    verdict_set_cmd = verdict_sub.add_parser("set")
    verdict_set_cmd.add_argument("--ticket", required=True)
    verdict_set_cmd.add_argument("--port", type=int, default=3084)
    verdict_set_cmd.add_argument("--result", required=True, choices=("pass", "fail", "hold"))
    verdict_set_cmd.add_argument("--evidence", required=True)
    verdict_set_cmd.add_argument("--note", default=None)
    verdict_set_cmd.add_argument("--repo")
    verdict_set_cmd.add_argument("--check-remote", action="store_true")
    verdict_set_cmd.add_argument("--force", action="store_true")
    verdict_list_cmd = verdict_sub.add_parser("list")
    verdict_list_cmd.add_argument("--ticket")
    verdict_list_cmd.add_argument("--limit", type=int, default=20)
    verdict_show_cmd = verdict_sub.add_parser("show")
    verdict_show_cmd.add_argument("target")
    return root


def main() -> int:
    args = parser().parse_args()
    if args.command == "precheck":
        return precheck(args)
    if args.command == "prepare":
        return prepare(args)
    if args.command == "send":
        return send(args)
    if args.command == "trace":
        if not args.plan and not (args.repo and args.issue and args.marker):
            print(json.dumps({"ok": False, "reason": "trace_needs_plan_or_repo_issue_marker"}))
            return 2
        return trace(args)
    if args.command == "compare":
        return compare_issues(args)
    if args.command == "reply":
        return {
            "prepare": reply_prepare,
            "send": reply_send,
            "trace": reply_trace,
            "poll": reply_poll,
        }[args.reply_command](args)
    if args.command == "verdict":
        return {
            "set": verdict_set,
            "list": verdict_list,
            "show": verdict_show,
        }[args.verdict_command](args)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
