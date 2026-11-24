"""The ZCode skills under skills/zcode track the Codex skill and ship nothing that belongs to one machine."""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
ZCODE = ROOT / "skills" / "zcode"
SKILLS = ("deepseek-harness-bridge", "dsh-control-bridge")
# These files are the upstream clients. The ZCode skill carries them unchanged from the Codex skill.
SHARED_WITH_CODEX = ("references/desktop.md", "references/superagent.md", "scripts/desktop.py",
                     "scripts/superagent.py", "scripts/github_source.py")
# Filled-in copies of these stay on the machine that uses them; the repository ships the examples only.
LOCAL_ONLY = ("connection.json", "local.json")
TOKEN_LIKE = re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}")
BEHAVIOUR_TESTS = ("deepseek-harness-bridge/tests/stub_host_test.py",
                   "deepseek-harness-bridge/tests/superagent_brief_test.py",
                   "deepseek-harness-bridge/tests/superagent_wait_test.py")
windows_only = pytest.mark.skipif(os.name != "nt", reason="the ZCode helpers were verified on Windows only")


def shipped_files() -> list[Path]:
    return sorted(path for path in ZCODE.rglob("*") if path.is_file() and "__pycache__" not in path.parts)


def as_stored_by_git(path: Path) -> bytes:
    # A Windows checkout may hold one copy with CRLF and the other still with LF; git stores both as LF.
    return path.read_bytes().replace(b"\r\n", b"\n")


def test_shared_files_match_the_codex_skill():
    for relative in SHARED_WITH_CODEX:
        zcode = as_stored_by_git(ZCODE / "deepseek-harness-bridge" / relative)
        codex = as_stored_by_git(ROOT / "skills" / "deepseek-harness-bridge" / relative)
        assert zcode == codex, relative


def test_each_skill_is_named_after_its_directory():
    for skill in SKILLS:
        head = (ZCODE / skill / "SKILL.md").read_text(encoding="utf-8").splitlines()[:6]
        assert any(re.fullmatch(rf"name:\s*['\"]?{re.escape(skill)}['\"]?", line) for line in head), skill


def test_no_local_pairing_or_credential_file_is_shipped():
    offenders = [path.relative_to(ROOT).as_posix() for path in ZCODE.rglob("*")
                 if path.is_file() and (path.name in LOCAL_ONLY or path.name.endswith(".secret"))]
    assert offenders == []


def test_examples_exist_and_stay_placeholders():
    connection = json.loads((ZCODE / "deepseek-harness-bridge" / "connection.example.json").read_text(encoding="utf-8"))
    assert {"secret_file", "superagent_instances", "superagent_state_dir"} <= set(connection)
    assert "C:/Users/<name>/" in json.dumps(connection)
    assert all(row["repo"] == "OWNER/REPO" for row in connection["superagent_instances"])
    local = json.loads((ZCODE / "dsh-control-bridge" / "local.example.json").read_text(encoding="utf-8"))
    assert local["repo"].startswith("~/")


def test_nothing_that_looks_like_a_token_is_shipped():
    offenders = [path.relative_to(ROOT).as_posix() for path in shipped_files()
                 if TOKEN_LIKE.search(path.read_text(encoding="utf-8", errors="replace"))]
    assert offenders == []


def run(relative: str, *arguments: str, timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-I", "-B", "-X", "utf8", str(ZCODE / relative), *arguments],
                          capture_output=True, timeout=timeout)


@windows_only
@pytest.mark.parametrize("relative", BEHAVIOUR_TESTS)
def test_helper_behaviour_test_passes(relative):
    result = run(relative)
    tail = result.stdout.decode("utf-8", "replace")[-600:] + result.stderr.decode("utf-8", "replace")[-600:]
    assert result.returncode == 0 and b"RESULT: ALL PASS" in result.stdout, tail


@windows_only
def test_every_sabotage_of_the_helpers_is_caught():
    result = run("deepseek-harness-bridge/tests/mutation_check.py", str(ZCODE / "deepseek-harness-bridge"), timeout=300)
    assert result.returncode == 0 and b"RESULT: EVERY MUTATION CAUGHT" in result.stdout, \
        result.stdout.decode("utf-8", "replace")[-800:]


@windows_only
def test_control_plane_event_entry(tmp_path):
    result = run("dsh-control-bridge/tests/serve_test.py", str(ROOT), str(tmp_path / "scratch"))
    assert result.returncode == 0 and b"RESULT: ALL PASS" in result.stdout, \
        result.stdout.decode("utf-8", "replace")[-800:] + result.stderr.decode("utf-8", "replace")[-800:]
