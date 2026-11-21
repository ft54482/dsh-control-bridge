"""Command line for inbox, dispatch, status, and cancel."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tomllib
from pathlib import Path
from typing import Any

from dsh_control_bridge import __version__
from dsh_control_bridge.bridge import open_bridge
from dsh_control_bridge.config import load_config
from dsh_control_bridge.credentials import credentials_report
from dsh_control_bridge.diagnose import diagnose
from dsh_control_bridge.errors import BridgeError
from dsh_control_bridge.http_server import serve
from dsh_control_bridge.mcp_server import serve_stdio
from dsh_control_bridge.mcp_tools import tool_catalog
from dsh_control_bridge.models import Mandate, Task, parse_mandate, utc_now
from dsh_control_bridge.preflight import load_facts, preflight
from dsh_control_bridge.selfcheck import run_self_check
from dsh_control_bridge.signing import sign_request


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    try:
        return _run(args)
    except BridgeError as exc:
        print(str(exc), file=sys.stderr)
        return 2


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="dsh-bridge",
        description="Control-plane bridge for DeepSeek Harness instances.",
    )
    parser.add_argument("--version", action="version", version=f"dsh-bridge {__version__}")
    parser.add_argument("--config", default="bridge.toml", help="path to bridge TOML")
    parser.add_argument("--data-dir", default="data", help="SQLite and audit directory")
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON")
    sub = parser.add_subparsers(dest="command", required=True)

    inbox = sub.add_parser("inbox", help="list events and tasks waiting on a person")
    inbox.add_argument("--instance")
    inbox.add_argument("--workspace")

    ack = sub.add_parser("acknowledge", help="mark an event read")
    ack.add_argument("event_id")

    dispatch = sub.add_parser("dispatch", help="draft a task, or send an approved one")
    dispatch.add_argument("--instance")
    dispatch.add_argument("--workspace")
    dispatch.add_argument("--executor", choices=["ordinary_session", "superagent"])
    dispatch.add_argument("--title")
    dispatch.add_argument("--objective")
    dispatch.add_argument("--scope", default="")
    dispatch.add_argument("--acceptance", default="")
    dispatch.add_argument("--mode", choices=["draft", "send"], default="draft")
    dispatch.add_argument("--mandate", type=Path)
    dispatch.add_argument("--task", dest="task_id")

    status = sub.add_parser("status", help="show one task")
    status.add_argument("task_id")

    cancel = sub.add_parser("cancel", help="cancel a task and record remote confirmation")
    cancel.add_argument("task_id")
    cancel.add_argument("--reason", required=True)

    accept = sub.add_parser("accept", help="accept a task that is awaiting review")
    accept.add_argument("task_id")

    nxt = sub.add_parser("next", help="draft the next brief and do not send it")
    nxt.add_argument("task_id")

    ingest = sub.add_parser("ingest", help="ingest one event file through the same checks as the webhook")
    ingest.add_argument("--body", type=Path, required=True)
    ingest.add_argument("--instance", required=True)

    serve_cmd = sub.add_parser("serve", help="listen for signed webhook events")
    serve_cmd.add_argument("--host", default="127.0.0.1")
    serve_cmd.add_argument("--port", type=int, default=8787)

    sign = sub.add_parser("sign", help="print the signed headers for the body on stdin")
    sign.add_argument("--instance", required=True)
    sub.add_parser("check", help="validate config and report credential presence")
    sub.add_parser("diagnose", help="local preflight; does not contact Harness")
    sub.add_parser("self-check", help="run the isolated fake install check")
    facts = sub.add_parser("preflight", help="compare a redacted facts file with the connector contract")
    facts.add_argument("--facts", type=Path)
    sub.add_parser("mcp", help="serve the stdio MCP tool server")
    sub.add_parser("tools", help="print the MCP tool catalog")
    sub.add_parser("recover", help="resume in-flight sends and cancels")
    return parser


def _run(args: argparse.Namespace) -> int:
    if args.command == "tools":
        _emit(args, tool_catalog())
        return 0
    if args.command == "self-check":
        report = run_self_check()
        _emit(args, report, human="self-check: ok\n" + "\n".join(f"- {item}" for item in report["checks"]))
        return 0

    config = load_config(Path(args.config))
    if args.command == "sign":
        _print_signature(config, args.instance, sys.stdin.buffer.read())
        return 0
    if args.command == "check":
        _emit(args, _check_payload(config))
        return 0
    if args.command == "diagnose":
        _emit(args, diagnose(config))
        return 0
    if args.command == "preflight":
        facts = load_facts(args.facts) if args.facts else None
        _emit(args, preflight(facts))
        return 0

    bridge = open_bridge(config, Path(args.data_dir))
    try:
        if args.command == "mcp":
            serve_stdio(bridge)
            return 0
        if args.command == "recover":
            _emit(args, {"recovered": bridge.recovery_notes})
            return 0
        if args.command == "inbox":
            payload = bridge.inbox(instance_id=args.instance, workspace=args.workspace)
            _emit(args, payload, human=_human_inbox(payload))
            return 0
        if args.command == "acknowledge":
            _emit(args, bridge.acknowledge(args.event_id))
            return 0
        if args.command == "status":
            payload = bridge.status(args.task_id)
            _emit(args, payload, human=_human_status(payload))
            return 0
        if args.command == "cancel":
            task = bridge.cancel(args.task_id, args.reason)
            _emit(args, task.to_dict(), human=_human_task(task))
            return 0
        if args.command == "accept":
            task = bridge.accept(args.task_id)
            _emit(args, task.to_dict(), human=_human_task(task))
            return 0
        if args.command == "next":
            task = bridge.draft_next(args.task_id)
            _emit(args, task.to_dict(), human=_human_task(task))
            return 0
        if args.command == "dispatch":
            mandate = _load_mandate(args.mandate) if args.mandate else None
            task = bridge.dispatch(
                instance_id=args.instance,
                workspace=args.workspace,
                executor=args.executor,
                title=args.title,
                objective=args.objective,
                scope=args.scope,
                acceptance=args.acceptance,
                mode=args.mode,
                mandate=mandate,
                task_id=args.task_id,
            )
            _emit(args, task.to_dict(), human=_human_task(task))
            return 0
        if args.command == "ingest":
            body = args.body.read_bytes()
            timestamp, signature = _signature_parts(config, args.instance, body)
            result = bridge.ingest_bytes(
                body,
                signature=signature,
                timestamp=timestamp,
                instance_id=args.instance,
            )
            _emit(args, result.to_dict())
            return 0
        if args.command == "serve":
            print(f"listening on http://{args.host}:{args.port}", file=sys.stderr)
            serve(bridge, args.host, args.port)
            return 0
    finally:
        bridge.store.close()
    raise BridgeError(f"unknown command {args.command}")


def _load_mandate(path: Path) -> Mandate:
    if not path.is_file():
        raise BridgeError(f"mandate file not found: {path}")
    try:
        raw = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, tomllib.TOMLDecodeError) as exc:
        raise BridgeError(f"cannot read mandate: {exc.__class__.__name__}") from exc
    return parse_mandate(raw)


def _print_signature(config: Any, instance_id: str, body: bytes) -> None:
    timestamp, signature = _signature_parts(config, instance_id, body)
    print(f"X-DSH-Timestamp: {timestamp}")
    print(f"X-DSH-Instance: {instance_id}")
    print(f"X-DSH-Signature: {signature}")


def _signature_parts(config: Any, instance_id: str, body: bytes) -> tuple[str, str]:
    instance = config.instance(instance_id)
    if instance is None:
        raise BridgeError(f"instance {instance_id!r} is not configured")
    secret = os.environ.get(instance.event_secret_env, "")
    if not secret:
        raise BridgeError(f"set {instance.event_secret_env} before signing")
    timestamp = str(int(utc_now().timestamp()))
    return timestamp, sign_request(secret, timestamp, instance_id, body)


def _check_payload(config: Any) -> dict[str, Any]:
    report = credentials_report()
    instances = []
    for instance in config.instances.values():
        instances.append(
            {
                "id": instance.id,
                "label": instance.label,
                "kind": instance.kind,
                "adapter": instance.adapter,
                "base_url": instance.base_url,
                "auth_env": instance.auth_env,
                "auth_env_set": bool(os.environ.get(instance.auth_env)),
                "event_secret_env": instance.event_secret_env,
                "event_secret_set": bool(os.environ.get(instance.event_secret_env)),
                "workspaces": list(instance.workspaces),
                "supports_send": instance.adapter == "fake",
                "connected_to_harness": False,
            }
        )
    return {
        "config": str(config.path),
        "default_mode": "draft",
        "signature_window_seconds": config.settings.signature_window_seconds,
        "allow_unsigned_effective": False,
        "connected_to_harness": False,
        "notify_mode": config.notify.mode,
        "credentials": report,
        "instances": instances,
    }


def _emit(args: argparse.Namespace, payload: dict[str, Any], *, human: str | None = None) -> None:
    if args.json or human is None:
        print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
        return
    print(human)


def _human_inbox(payload: dict[str, Any]) -> str:
    lines = ["收件箱"]
    events = payload["events"]
    tasks = payload["tasks"]
    if not events and not tasks:
        lines.append("  （空）")
    for event in events:
        lines.append(
            f"  事件 {event['event_id']} type={event.get('event_type') or '-'} "
            f"disposition={event['disposition']}"
        )
    for task in tasks:
        lines.append(
            f"  任务 {task['task_id']} status={task['status']} delivery={task['delivery']} "
            f"{task['executor']} {task['instance_id']}/{task['workspace']}"
        )
    return "\n".join(lines)


def _human_task(task: Task) -> str:
    remote = task.session_id or task.ticket_id or "-"
    extra = f"ticket={task.ticket_id or '-'} run={task.run_id or '-'}"
    return "\n".join(
        [
            f"任务 {task.task_id}",
            f"  状态: {task.status}",
            f"  投递: {task.delivery}",
            f"  实例: {task.instance_id}",
            f"  工作区: {task.workspace}",
            f"  执行路径: {task.executor}",
            f"  会话: {task.session_id or '-'}",
            f"  {extra}",
            f"  取消确认: {_cancel_line(task)}",
            f"  额度声明: {_budget_line(task)}",
            f"  标题: {task.title}",
        ]
    )


def _cancel_line(task: Task) -> str:
    if task.cancel_confirmation == "unconfirmed":
        return "unconfirmed（远端取消未确认，不能视为已经停止或已经交付）"
    if task.cancel_confirmation == "confirmed":
        return "confirmed（只表示取消请求已确认，不是验收通过）"
    return "-"


def _budget_line(task: Task) -> str:
    stored = task.mandate or {}
    inner = stored.get("mandate", stored) if isinstance(stored, dict) else {}
    cap = inner.get("budget_cap") if isinstance(inner, dict) else None
    if not cap:
        return "-（没有额度声明；声明本身也不是执行许可）"
    return f"{cap}（声明，不是执行许可，也不会触发调用）"


def _human_status(payload: dict[str, Any]) -> str:
    task = Task(**payload["task"])
    lines = [_human_task(task)]
    summaries = payload.get("summaries") or []
    if summaries:
        lines.append("  最近摘要:")
        lines.append(summaries[-1]["body"])
    return "\n".join(lines)
