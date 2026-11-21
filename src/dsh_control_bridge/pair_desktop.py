"""Operator pairing client. It lists metadata and posts one explicit selection.

It does not print secrets and it does not start a desktop task.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path


def _secret(path: Path) -> str:
    value = path.read_text(encoding="utf-8").strip()
    if len(value) < 32:
        raise SystemExit("bootstrap secret is too short")
    return value


def _call(url: str, secret: str, method: str, payload: dict | None = None) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="List Desktop sessions and record one allowlist entry.")
    parser.add_argument("--url", default="http://127.0.0.1:8765")
    parser.add_argument("--bootstrap-secret-file", required=True, type=Path)
    parser.add_argument("--index", type=int)
    parser.add_argument("--access", choices=("read", "write"), default="read")
    args = parser.parse_args(argv)
    secret = _secret(args.bootstrap_secret_file)
    catalog = _call(f"{args.url}/v1/bootstrap/catalog", secret, "GET")
    sessions = catalog.get("sessions") or []
    if args.index is None:
        if not sessions:
            print("没有发现会话。")
            return 1
        for number, item in enumerate(sessions, start=1):
            busy = "忙" if item.get("busy") else "空闲"
            model = item.get("model") or "列表里没有模型字段"
            provider = item.get("provider") or "列表里没有提供方字段"
            print(f"{number}. {item.get('title') or '未命名会话'}")
            print(f"   目录: {item.get('cwd') or '-'}")
            print(f"   状态: {busy}  配置面: {item.get('profile') or 'unknown'}  模型: {provider} / {model}")
        print("选定后用同一个命令加上 --index 编号。默认只读，不会启动任务。")
        return 0
    if args.index < 1 or args.index > len(sessions):
        print("编号不在列表里。先不加 --index 再看一遍。")
        return 2
    chosen = sessions[args.index - 1]
    result = _call(
        f"{args.url}/v1/bootstrap/select",
        secret,
        "POST",
        {"session_id": chosen["session_id"], "access": args.access},
    )
    if not result.get("ok"):
        print(result.get("reason") or "没有写入授权")
        return 1
    entry = result["allowlist"]["sessionAllowlist"][0]
    print(f"已写入一条授权: {entry.get('title') or '未命名会话'}  权限: {entry.get('access')}  目录: {entry.get('cwd')}")
    print("没有启动任务，也没有修改模型。发现用的短期口令已经作废。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
