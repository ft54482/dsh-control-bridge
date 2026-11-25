"""Mutation check for the two Antigravity helpers of this skill.

Sabotages scripts/superagent_brief.py and scripts/superagent_wait.py in memory, one change at a time, and
requires their behaviour tests to go red for every change. Nothing on disk is modified; plans written by a
mutated helper land in a scratch directory, never near ~/.codex.

    python -I -X utf8 tests/mutation_check.py <skill directory>

Add a mutation whenever a helper grows a new guard: a check that cannot be made to fail proves nothing.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import os
import shutil
import sys
import tempfile
import types
from pathlib import Path

BRIEF_MUTATIONS = [
    ("guess a port when the repository is not registered",
     "            return row\n    return None\n",
     "            return row\n    return {\"port\": 3084, \"profile\": \"guessed\"}\n"),
    ("skip the upstream precheck",
     "skip_precheck=False,",
     "skip_precheck=True,"),
    ("append a newline to the request",
     "request=request,",
     "request=request + \"\\n\","),
    ("stop trimming the brief",
     '.replace("\\r\\n", "\\n").strip()',
     '.replace("\\r\\n", "\\n")'),
    ("ignore the configured state directory",
     'state_dir=str(config.get("superagent_state_dir") or upstream.DEFAULT_STATE),',
     "state_dir=str(upstream.DEFAULT_STATE),"),
    ("hard-code the actor instead of asking gh",
     'actor = upstream.gh_authenticated_login(gh) or ""',
     'actor = "alice"'),
    ("drop the empty-brief guard",
     '    if not request:\n        print("superagent_brief: the brief is empty; nothing was prepared", file=sys.stderr)\n        return 2\n',
     ""),
    ("report an upstream error as success",
     'print(f"superagent_brief: stopped before a plan was written: {exc.__class__.__name__}: {exc}",\n              file=sys.stderr)\n        return 2',
     'print(f"superagent_brief: stopped before a plan was written: {exc.__class__.__name__}: {exc}",\n              file=sys.stderr)\n        return 0'),
]

WAIT_MUTATIONS = [
    ("keep waiting after the Ticket has ended",
     'if done or latest.get("stage") == "ticket_ambiguous" or failures >= 3:',
     'if latest.get("stage") == "ticket_ambiguous" or failures >= 3:'),
    ("treat a quoted marker as an ordinary read failure",
     "if str(error) != NOT_UNIQUE:",
     "if True:"),
    ("never stop on failed reads",
     "or failures >= 3:",
     "or failures >= 99:"),
    ("add scattered failed reads up",
     "            failures = 0\n",
     ""),
    ("report an ended Ticket as still running",
     "    if done:\n        return 0",
     "    if done:\n        return 4"),
    ("report an unidentifiable Ticket as merely unfinished",
     "        return 3\n",
     "        return 4\n"),
    ("drop the bounds on the poll interval",
     "time.sleep(max(1, min(args.interval, 60)))",
     "time.sleep(args.interval)"),
    ("count the previous round's end as this dispatch's end",
     "    return later > sent\n",
     "    return True\n"),
]

SUITES = [
    ("scripts/superagent_brief.py", "tests/superagent_brief_test.py", "superagent_brief_under_test", BRIEF_MUTATIONS),
    ("scripts/superagent_wait.py", "tests/superagent_wait_test.py", "superagent_wait_under_test", WAIT_MUTATIONS),
]


def run_suite(test) -> tuple:
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out):
            code = test.main()
    except Exception as error:
        # A mutated helper may crash, or spin until the fake clock stops it. That is red as well.
        return -1, [f"CRASH {error.__class__.__name__}: {error}"[:200]], 0
    lines = out.getvalue().splitlines()
    return code, [line for line in lines if line.startswith("FAIL")], sum(line.startswith("PASS") for line in lines)


def main() -> int:
    skill = Path(sys.argv[1]).resolve()
    scratch = tempfile.mkdtemp(prefix="dsh-mutation-state-")
    # github_source.py reads this at import time; with it set, even a mutated helper cannot write near ~/.codex.
    os.environ["DSH_BRIDGE_SKILL_STATE"] = scratch
    ok = True
    for helper_path, test_path, helper_name, mutations in SUITES:
        source = (skill / helper_path).read_text(encoding="utf-8")
        spec = importlib.util.spec_from_file_location(f"test_of_{helper_name}", skill / test_path)
        test = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(test)
        original_load = test.load
        code, failed, passed = run_suite(test)
        ok &= code == 0 and not failed
        print(f"[{helper_path}] baseline: exit {code}, {passed} passed, {len(failed)} failed")
        for label, old, new in mutations:
            count = source.count(old)
            if count != 1:
                print(f"SKIP    {label}: the anchor text occurs {count} times in the helper, expected 1")
                ok = False
                continue

            def load_mutated(name, *relative, _text=source.replace(old, new)):
                if name != helper_name:
                    return original_load(name, *relative)
                module = types.ModuleType(name)
                module.__file__ = str(skill.joinpath(*relative))
                exec(compile(_text, module.__file__, "exec"), module.__dict__)
                return module

            test.load = load_mutated
            try:
                code, failed, passed = run_suite(test)
            finally:
                test.load = original_load
            caught = code != 0 and bool(failed)
            ok &= caught
            print(f"{'CAUGHT' if caught else 'MISSED'}  {label}: exit {code}, {len(failed)} failed, {passed} passed; "
                  f"first: {failed[0][:96] if failed else ''}")
    shutil.rmtree(scratch, ignore_errors=True)
    print("RESULT:", "EVERY MUTATION CAUGHT" if ok else "SOME MUTATION MISSED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
