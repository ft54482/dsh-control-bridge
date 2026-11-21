import json
import subprocess
import sys
from pathlib import Path

from dsh_control_bridge.cli import main
from dsh_control_bridge.demo import run_demo
from dsh_control_bridge.mcp_tools import tool_catalog

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples" / "config.example.toml"


def test_cli_rejects_unknown_workspace(tmp_path, capsys):
    data = tmp_path / "data"
    code = main(
        [
            "--config",
            str(EXAMPLE),
            "--data-dir",
            str(data),
            "dispatch",
            "--instance",
            "local-desktop",
            "--workspace",
            "not-declared",
            "--executor",
            "ordinary_session",
            "--title",
            "不应存在",
            "--objective",
            "未登记工作区",
        ]
    )
    captured = capsys.readouterr()
    assert code == 2
    assert "not-declared" in captured.err
    database = data / "bridge.sqlite"
    assert database.exists()
    assert "不应存在".encode("utf-8") not in database.read_bytes()


def test_cli_draft_then_status(tmp_path, capsys):
    data = tmp_path / "data"
    code = main(
        [
            "--config",
            str(EXAMPLE),
            "--data-dir",
            str(data),
            "--json",
            "dispatch",
            "--instance",
            "local-desktop",
            "--workspace",
            "broadcast-cs",
            "--executor",
            "ordinary_session",
            "--title",
            "命令行草稿",
            "--objective",
            "只起草。",
        ]
    )
    task = json.loads(capsys.readouterr().out)
    assert code == 0
    assert task["delivery"] == "drafted"
    code = main(
        ["--config", str(EXAMPLE), "--data-dir", str(data), "status", task["task_id"]]
    )
    text = capsys.readouterr().out
    assert code == 0
    assert "pending" in text
    assert "命令行草稿" in text


def test_cli_tools_match_the_documented_catalog():
    catalog = tool_catalog()
    names = [tool["name"] for tool in catalog["tools"]]
    assert names == ["inbox", "acknowledge", "dispatch", "status", "cancel"]
    documented = json.loads((ROOT / "docs" / "mcp-tools.json").read_text(encoding="utf-8"))
    assert documented == catalog


def test_demo_and_script(tmp_path):
    report = run_demo(tmp_path / "demo")
    text = "\n".join(report["lines"])
    assert "e2e: ok" in text
    assert "PLEASE_EXEC_CANARY" not in text
    completed = subprocess.run(
        [sys.executable, str(ROOT / "examples" / "e2e_fake.py")],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr
    assert "e2e: ok" in completed.stdout
    assert "PLEASE_EXEC_CANARY" not in completed.stdout
