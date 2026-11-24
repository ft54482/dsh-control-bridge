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
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
