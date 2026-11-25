"""Behaviour test for scripts/superagent_brief.py. The SuperAgent management API and the gh CLI are replaced
by in-process stand-ins that answer the same calls the upstream client makes: nothing here contacts a real
instance, a real account or GitHub, and the real connection.json is never read.

    python -I -X utf8 tests/superagent_brief_test.py

Exit code 0 means every check passed. Run it again after replacing the upstream github_source.py or editing
scripts/superagent_brief.py.
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
from datetime import datetime, timedelta
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
REPO = "owner/one"
OTHER_REPO = "owner/two"
LOGIN = "alice"
MARKER = r"dsb-\d{8}T\d{6}Z-[0-9a-f]{8}"
# The three read-only gh calls github_source.py's precheck and prepare make for this repository.
GH_LOGIN = ("api", "user", "--jq", ".login")
GH_REPO = ("api", f"repos/{REPO}", "--jq", "{push: .permissions.push, private: .private, has_issues: .has_issues}")
GH_ISSUE = ("api", f"repos/{REPO}/issues/123")
BRIEF = (
    "只在工单下回帖，不改任何文件。\n"
    "\n"
    "允许改的路径：无。参照路径 D:\\new\\table\\u0394 含 \"双引号\" 和 '单引号'，还有 emoji 🚀。\n"
)


def load(name: str, *relative: str):
    target = SKILL.joinpath(*relative)
    parent = str(target.parent)
    if parent not in sys.path:
        sys.path.insert(0, parent)
    spec = importlib.util.spec_from_file_location(name, target)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class StandIn:
    """Answers exactly what github_source.py asks for. Any other call, including every GitHub write, fails."""

    def __init__(self):
        self.repository = REPO
        self.allowed = [LOGIN]
        self.down = False
        self.gh_down = False
        self.gh_timeout = False
        self.calls: list[tuple] = []

    def api(self, port, path, timeout=15.0):
        self.calls.append(("api", port, path))
        if self.down:
            raise OSError("connection refused")
        if path == "state":
            return {"ok": True, "paused": False, "health": {"github": {"state": "ready"}},
                    "load": {"running": 1, "queued": 0, "maxWorkers": 4},
                    "setup": {"problem": None, "accounts": {"repository": self.repository, "agent": "bot"}}}
        if path == "sources":
            return [{"id": "github", "installed": True, "enabled": True}]
        if path == "settings":
            allowed = [{"id": name} for name in self.allowed]
            return {"blocks": {"policy": {"value": {"sources": {"github": {"allowed": allowed}}}}}}
        raise RuntimeError(f"SuperAgent API returned HTTP 404")

    def gh(self, args, gh_path, timeout=30.0):
        self.calls.append(("gh", *args))
        if self.gh_down:
            raise RuntimeError("gh CLI not found")
        if self.gh_timeout:
            raise subprocess.TimeoutExpired("gh", 30)
        if tuple(args) == GH_LOGIN:
            return subprocess.CompletedProcess(args, 0, LOGIN + "\n", "")
        if tuple(args) == GH_REPO:
            return subprocess.CompletedProcess(args, 0, json.dumps({"push": True, "private": True, "has_issues": True}), "")
        if tuple(args) == GH_ISSUE:
            return subprocess.CompletedProcess(args, 0, json.dumps({"number": 123}), "")
        return subprocess.CompletedProcess(args, 1, "", "unexpected gh call")


def check(label, condition, detail=""):
    print(("PASS  " if condition else "FAIL  ") + label + (f"  [{detail}]" if detail and not condition else ""))
    return bool(condition)


def prepare(helper, *argv, stdin=None):
    """Run the helper's main() in this process and return (exit code, parsed stdout JSON or None, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    saved_argv, saved_stdin = sys.argv, sys.stdin
    sys.argv = ["superagent_brief.py", *argv]
    if stdin is not None:
        sys.stdin = io.TextIOWrapper(io.BytesIO(stdin), encoding="utf-8")
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = helper.main()
    except SystemExit:
        # Only argparse exits on its own, and it reports on the stderr we captured.
        print(f"      the helper exited by itself; its stderr was: {err.getvalue().strip()[-400:]}")
        raise
    finally:
        sys.argv, sys.stdin = saved_argv, saved_stdin
    text = out.getvalue()
    return code, (json.loads(text) if text.strip() else None), err.getvalue()


def failing(result) -> str:
    return ",".join(item["name"] for item in (result or {}).get("precheck", {}).get("checks", []) if not item["ok"])


def minutes_between(later: str, earlier: str):
    if not later or not earlier:
        return None

    def moment(stamp: str) -> datetime:
        return datetime.fromisoformat(stamp.replace("Z", "+00:00"))

    return moment(later) - moment(earlier)


def plans(state: Path) -> list[str]:
    folder = state / "plans"
    return sorted(path.name for path in folder.iterdir()) if folder.is_dir() else []


def read_plan(result) -> dict:
    path = Path((result or {}).get("plan", ""))
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


def main() -> int:
    ok = True
    with tempfile.TemporaryDirectory(prefix="dsh-superagent-skill-test-") as temporary:
        scratch = Path(temporary)
        state = scratch / "state"
        connection = scratch / "connection.json"
        connection.write_text(json.dumps({
            "secret_file": "unused-by-this-test",
            "superagent_instances": [
                {"repo": REPO.upper(), "port": 3082, "profile": "superagent"},
                {"repo": OTHER_REPO, "port": 3084, "profile": "other"},
                {"repo": "owner/broken", "port": "3083", "profile": "port-is-a-string"},
            ],
            "superagent_state_dir": str(state),
        }), encoding="utf-8")
        brief_file = scratch / "brief.md"
        brief_file.write_bytes(BRIEF.encode("utf-8"))

        upstream = load("github_source_under_test", "scripts", "github_source.py")
        stand = StandIn()
        upstream.api, upstream.gh = stand.api, stand.gh
        helper = load("superagent_brief_under_test", "scripts", "superagent_brief.py")
        helper.CONNECTION = connection
        helper.load_upstream = lambda: upstream
        comment = ("--repo", REPO, "--issue", "123", "--brief", str(brief_file))

        code, result, err = prepare(helper, *comment)
        ok &= check("comment: exit 0 and ok", code == 0 and (result or {}).get("ok") is True, f"{code} {result} {err}")
        marker = (result or {}).get("marker", "")
        ok &= check("comment: the marker has the upstream shape", bool(re.fullmatch(MARKER, marker)), marker)
        plan = read_plan(result)
        ok &= check("comment: the plan lands in the configured state dir", Path((result or {}).get("plan", "")).parent == state / "plans",
                    str((result or {}).get("plan")))
        ok &= check("comment: the plan carries the port registered for the repository, never a default",
                    plan.get("port") == 3082, str(plan.get("port")))
        ok &= check("comment: the actor is the local gh account and the agent is the instance's",
                    (plan.get("actor"), plan.get("agent")) == (LOGIN, "bot"), str(plan))
        ok &= check("comment: kind, issue and status",
                    (plan.get("kind"), plan.get("issue"), plan.get("status")) == ("comment", 123, "prepared"), str(plan))
        ok &= check("comment: the body is the mention, the marker and the whole brief",
                    plan.get("body") == f"@bot [dsh-bridge:{marker}] {BRIEF.strip()}", repr(plan.get("body"))[:160])
        ok &= check("comment: the reported body equals the plan body", (result or {}).get("body") == plan.get("body"))
        ok &= check("comment: stderr names the port and the actor that were used",
                    f"port=3082 repo={REPO} actor={LOGIN}" in err, err)
        ok &= check("comment: state, sources and settings were all read from that one port",
                    [call for call in stand.calls if call[0] == "api"]
                    == [("api", 3082, "state"), ("api", 3082, "sources"), ("api", 3082, "settings")], str(stand.calls))
        ok &= check("comment: gh was asked only for the login, the repository and the Issue; nothing was written",
                    [call[1:] for call in stand.calls if call[0] == "gh"] == [GH_LOGIN, GH_LOGIN, GH_REPO, GH_ISSUE],
                    str(stand.calls))
        ok &= check("comment: the plan expires 30 minutes after creation by default",
                    minutes_between(plan.get("expires_at"), plan.get("created_at")) == timedelta(minutes=30), str(plan))

        (scratch / "crlf.md").write_bytes(b"\xef\xbb\xbf" + BRIEF.replace("\n", "\r\n").encode("utf-8"))
        code, result, err = prepare(helper, "--repo", REPO, "--issue", "123", "--brief", str(scratch / "crlf.md"))
        ok &= check("a CRLF file with a BOM prepares the same request under a new marker",
                    code == 0 and (result or {}).get("body", "").endswith(BRIEF.strip())
                    and (result or {}).get("marker") not in (None, "", marker), f"{code} {result} {err}")
        code, result, err = prepare(helper, "--repo", REPO, "--issue", "123", "--brief", "-", stdin=BRIEF.encode("utf-8"))
        ok &= check("a brief on stdin is prepared intact", code == 0 and (result or {}).get("body", "").endswith(BRIEF.strip()),
                    f"{code} {result} {err}")

        stand.calls.clear()
        code, result, err = prepare(helper, "--repo", REPO, "--brief", str(brief_file), "--kind", "issue",
                                    "--allow-new-issue", "--title", "测试：新工单", "--ttl-minutes", "5")
        plan = read_plan(result)
        ok &= check("issue: a new Issue needs the flag and takes its title",
                    code == 0 and (plan.get("kind"), plan.get("issue"), plan.get("title")) == ("issue", None, "测试：新工单")
                    and plan.get("body", "").startswith("@bot [dsh-bridge:dsb-"), f"{code} {result} {err}")
        ok &= check("issue: --ttl-minutes is honoured",
                    minutes_between(plan.get("expires_at"), plan.get("created_at")) == timedelta(minutes=5), str(plan.get("expires_at")))
        ok &= check("issue: gh was asked only for the login and the repository; a new Issue need not exist yet",
                    [call[1:] for call in stand.calls if call[0] == "gh"] == [GH_LOGIN, GH_LOGIN, GH_REPO], str(stand.calls))

        def refused(label, argv, expected_code, failing_name="", reason="", nested="", text=""):
            nonlocal ok
            calls_before, plans_before = len(stand.calls), plans(state)
            code, result, err = prepare(helper, *argv)
            ok &= check(label, code == expected_code and plans(state) == plans_before
                        and (not failing_name or failing(result) == failing_name)
                        and (not reason or (result or {}).get("reason") == reason)
                        and (not nested or (result or {}).get("precheck", {}).get("reason") == nested)
                        and (not text or text in err),
                        f"{code} {result} {err}")
            return result, err

        stand.calls.clear()
        result, err = refused("an unregistered repository is refused before any call or plan",
                              ("--repo", "owner/unknown", *comment[2:]), 2, text="no SuperAgent instance")
        ok &= check("an unregistered repository: the message lists what is registered",
                    "owner/unknown" in err and f"{REPO.upper()} -> port 3082" in err and f"{OTHER_REPO} -> port 3084" in err, err)
        ok &= check("an unregistered repository: nothing was asked of the instance or gh", not stand.calls, str(stand.calls))
        refused("an instance whose port is not an integer counts as unregistered", ("--repo", "owner/broken", *comment[2:]), 2)

        stand.repository = OTHER_REPO
        refused("the instance serves another repository: the precheck fails and no plan is written", comment, 1,
                "repository_matches", "precheck_failed")
        stand.repository = REPO
        stand.allowed = ["bob"]
        refused("an actor outside the allow list: the precheck fails and no plan is written", comment, 1,
                "actor_authorized", "precheck_failed")
        stand.allowed = [LOGIN, "bob"]
        refused("an --actor that is not the local gh account: the precheck fails and no plan is written",
                (*comment[:4], "--actor", "bob", *comment[4:]), 1, "gh_actor_matches", "precheck_failed")
        stand.allowed = [LOGIN]
        stand.down = True
        refused("an unreachable instance: the precheck fails and no plan is written", comment, 1, "", "precheck_failed",
                nested="superagent_unreachable")
        stand.down = False
        refused("--kind issue without --allow-new-issue", (*comment[:4], "--kind", "issue", *comment[4:]), 2, "",
                "new_issue_requires_allow_new_issue")
        refused("a comment without --issue", ("--repo", REPO, "--brief", str(brief_file)), 2, "", "issue_required_for_comment")
        (scratch / "empty.md").write_text(" \r\n\t\n", encoding="utf-8")
        refused("an empty brief", ("--repo", REPO, "--issue", "123", "--brief", str(scratch / "empty.md")), 2, text="the brief is empty")
        refused("a missing brief", ("--repo", REPO, "--issue", "123", "--brief", str(scratch / "no-such-file.md")), 2)
        (scratch / "secret.md").write_text("token ghp_" + "a1b2c3d4" * 5 + "\n", encoding="utf-8")
        refused("credential-like text in the brief", ("--repo", REPO, "--issue", "123", "--brief", str(scratch / "secret.md")), 2, "",
                "request_contains_credential_like_text")
        stand.gh_down = True
        refused("no gh CLI: nothing is prepared", comment, 2, text="gh CLI not found")
        refused("no gh CLI with --actor given: the lookup inside the upstream precheck is reported, no plan",
                (*comment, "--actor", LOGIN), 2, text="stopped before a plan was written: RuntimeError: gh CLI not found")
        stand.gh_down = False
        stand.gh_timeout = True
        refused("gh times out while looking up the account: no plan, no traceback", comment, 2, text="did not answer in time")
        refused("gh times out inside the upstream precheck: no plan, no traceback", (*comment, "--actor", LOGIN), 2,
                text="did not answer in time")
        stand.gh_timeout = False

        helper.CONNECTION = scratch / "missing-connection.json"
        code, result, err = prepare(helper, *comment)
        ok &= check("a missing connection.json is reported and nothing is prepared", code == 2 and "superagent_brief:" in err, f"{code} {err}")
        helper.CONNECTION = connection

        chosen = scratch / "chosen-plan.json"
        code, result, err = prepare(helper, *comment, "--out", str(chosen))
        ok &= check("--out picks the plan file",
                    code == 0 and read_plan({"plan": str(chosen)}).get("port") == 3082, f"{code} {result} {err}")

    with tempfile.TemporaryDirectory(prefix="dsh-superagent-skill-test-") as temporary:
        scratch = Path(temporary)
        brief_file = scratch / "brief.md"
        brief_file.write_bytes(BRIEF.encode("utf-8"))
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            closed_port = probe.getsockname()[1]
        black_box = scratch / "black-box.json"
        black_box.write_text(json.dumps({
            "superagent_instances": [{"repo": REPO, "port": closed_port}],
            "superagent_state_dir": str(scratch / "state"),
        }), encoding="utf-8")
        env = {**os.environ, "DSH_BRIDGE_CONNECTION_FILE": str(black_box), "DSH_BRIDGE_GH": "no-such-gh-command"}
        script = str(SKILL / "scripts" / "superagent_brief.py")

        result = subprocess.run([sys.executable, "-I", "-X", "utf8", script, "--repo", REPO, "--brief", str(brief_file)],
                                capture_output=True, env=env)
        ok &= check("black box: under python -I the helper loads the upstream client and stops at the gh step",
                    result.returncode == 2 and b"gh CLI not found" in result.stderr and b"DSH_BRIDGE_GH" in result.stderr,
                    result.stderr.decode("utf-8", "replace"))
        result = subprocess.run([sys.executable, "-X", "utf8", script, "--repo", "owner/unknown", "--brief", str(brief_file)],
                                capture_output=True, env=env)
        ok &= check("black box: an unregistered repository exits 2 and lists the registered ones",
                    result.returncode == 2 and b"owner/unknown" in result.stderr and b"Registered" in result.stderr,
                    result.stderr.decode("utf-8", "replace"))
        ok &= check("black box: the black-box runs wrote no plan", not (scratch / "state").exists())
    print("RESULT:", "ALL PASS" if ok else "SOMETHING FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
