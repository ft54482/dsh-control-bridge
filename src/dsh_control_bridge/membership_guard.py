"""Compare two workspace membership fingerprints. It never restores a backup."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path


def compare_membership(before: dict, after: dict) -> dict:
    if before.get("status") == "read_failed" or after.get("status") == "read_failed":
        return {"ok": False, "reason": "read_failed", "missing": [], "hoisted": [], "moved": []}
    missing = []
    hoisted = []
    moved = []
    after_workspaces = {item["id"]: item for item in after.get("workspaces") or []}
    after_sessions = {}
    for workspace in after.get("workspaces") or []:
        for session_id in workspace.get("top_level") or []:
            after_sessions[session_id] = {"bucket": "top_level", "workspace_id": workspace["id"], "parent": None}
        for child in workspace.get("subagent") or []:
            after_sessions[child["id"]] = {
                "bucket": "subagent",
                "workspace_id": workspace["id"],
                "parent": child.get("parent"),
            }
    for workspace in before.get("workspaces") or []:
        if workspace["id"] not in after_workspaces:
            missing.append({"kind": "workspace", "workspace_id": workspace["id"], "session_id": None})
            continue
        for session_id in workspace.get("top_level") or []:
            found = after_sessions.get(session_id)
            if found is None:
                missing.append({"kind": "top_level", "workspace_id": workspace["id"], "session_id": session_id})
            elif found["workspace_id"] != workspace["id"]:
                moved.append({"session_id": session_id, "from": workspace["id"], "to": found["workspace_id"]})
        for child in workspace.get("subagent") or []:
            found = after_sessions.get(child["id"])
            if found is None:
                missing.append({
                    "kind": "subagent",
                    "workspace_id": workspace["id"],
                    "session_id": child["id"],
                    "parent": child.get("parent"),
                })
            elif found["bucket"] == "top_level":
                hoisted.append({"session_id": child["id"], "parent": child.get("parent")})
            elif found["parent"] != child.get("parent"):
                moved.append({"session_id": child["id"], "parent": child.get("parent"), "found_parent": found["parent"]})
    return {
        "ok": not missing and not hoisted and not moved,
        "missing": missing,
        "hoisted": hoisted,
        "moved": moved,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Save or compare a workspace membership fingerprint.")
    parser.add_argument("--url", default="http://127.0.0.1:8765")
    parser.add_argument("--secret-file", type=Path)
    parser.add_argument("--save", type=Path)
    parser.add_argument("--before", type=Path)
    parser.add_argument("--after", type=Path)
    args = parser.parse_args(argv)
    if args.before and args.after:
        result = compare_membership(
            json.loads(args.before.read_text(encoding="utf-8")),
            json.loads(args.after.read_text(encoding="utf-8")),
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["ok"] else 1
    if args.save is None or args.secret_file is None:
        print("需要 --save 和 --secret-file，或 --before 与 --after。")
        return 2
    secret = args.secret_file.read_text(encoding="utf-8").strip()
    request = urllib.request.Request(
        f"{args.url}/v1/guard/membership",
        headers={"Authorization": f"Bearer {secret}"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if payload.get("status") == "read_failed":
        print("工作区登记读取失败，不把结果当成空历史。")
        return 1
    args.save.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已保存登记指纹到 {args.save.name}。没有修改工作区登记。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
