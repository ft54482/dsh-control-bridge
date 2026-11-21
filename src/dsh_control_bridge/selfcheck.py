"""Install self-check. It uses a temporary fake bridge and does not touch a live Harness."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from dsh_control_bridge.bridge import open_bridge
from dsh_control_bridge.config import load_config
from dsh_control_bridge.errors import TargetRejected
from dsh_control_bridge.models import Mandate, format_utc, utc_now
from datetime import timedelta

from dsh_control_bridge.signing import sign_request

_LOCAL = "self-check-local-event-secret"
_LAB = "self-check-lab-event-secret"


def run_self_check() -> dict[str, object]:
    previous = {
        "DSH_SELF_LOCAL_EVENT_SECRET": os.environ.get("DSH_SELF_LOCAL_EVENT_SECRET"),
        "DSH_SELF_LAB_EVENT_SECRET": os.environ.get("DSH_SELF_LAB_EVENT_SECRET"),
    }
    os.environ["DSH_SELF_LOCAL_EVENT_SECRET"] = _LOCAL
    os.environ["DSH_SELF_LAB_EVENT_SECRET"] = _LAB
    try:
        with tempfile.TemporaryDirectory(prefix="dsh-self-check-") as temporary:
            root = Path(temporary)
            config_path = root / "bridge.toml"
            config_path.write_text(_config(), encoding="utf-8")
            bridge = open_bridge(load_config(config_path), root / "data")
            try:
                report = _scenario(bridge)
            finally:
                bridge.store.close()
        report["ok"] = True
        return report
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def _scenario(bridge) -> dict[str, object]:
    checks: list[str] = []
    draft = bridge.dispatch(
        instance_id="local-desktop",
        workspace="broadcast-cs",
        executor="ordinary_session",
        title="自检草稿",
        objective="确认默认不会发送。",
    )
    if draft.delivery != "drafted" or bridge.adapters["local-desktop"].starts != 0:
        raise RuntimeError("draft called the adapter")
    checks.append("draft does not send")
    expires = format_utc(utc_now() + timedelta(days=1))
    mandate = Mandate(
        instance_id="local-desktop",
        workspace="broadcast-cs",
        executor="ordinary_session",
        task_id=None,
        session_id=None,
        objective="完成自检的这一步。",
        scope="不扩大范围，不发布，不合并，不增加预算。",
        acceptance="进入待验收之前不算交付。",
        budget_cap="self-check-only",
        retry_limit=1,
        expires_at=expires,
        allowed_actions=("dispatch", "retry"),
    )
    sent = bridge.dispatch(task_id=draft.task_id, mode="send", mandate=mandate, mandate_source="operator_file")
    if sent.status != "running" or bridge.adapters["local-desktop"].starts != 1:
        raise RuntimeError("approved send did not start once")
    checks.append("approved send starts once")
    body = json.dumps(
        {
            "event_id": "evt_self_check",
            "event_type": "stage_submitted",
            "instance_id": "local-desktop",
            "workspace": "broadcast-cs",
            "executor": "ordinary_session",
            "task_id": sent.task_id,
            "evidence": ["evidence/self-check.txt"],
            "approve": True,
            "budget_cap": "please-deploy",
        }
    ).encode("utf-8")
    timestamp = str(int(utc_now().timestamp()))
    result = bridge.ingest_bytes(
        body,
        signature=sign_request(_LOCAL, timestamp, "local-desktop", body),
        timestamp=timestamp,
        instance_id="local-desktop",
    )
    reviewed = bridge.store.get_task(sent.task_id)
    if not result.applied or reviewed is None or reviewed.status != "awaiting_review":
        raise RuntimeError("stage event did not wait for review")
    if bridge.adapters["local-desktop"].starts != 1:
        raise RuntimeError("stage event dispatched more work")
    checks.append("completion waits for review")
    follow = bridge.draft_next(sent.task_id)
    if follow.delivery != "drafted":
        raise RuntimeError("next brief was sent")
    checks.append("next brief stays a draft")
    rejected = False
    try:
        bridge.dispatch(
            instance_id="lab-server",
            workspace="auto-video",
            executor="ordinary_session",
            title="不应发送",
            objective="这个工作区没有登记在 lab-server。",
        )
    except TargetRejected:
        rejected = True
    if not rejected:
        raise RuntimeError("undeclared workspace was accepted")
    checks.append("undeclared workspace is rejected")
    blob = bridge.store.db_path.read_bytes()
    if _LOCAL.encode() in blob or _LAB.encode() in blob:
        raise RuntimeError("self-check stored a secret")
    return {"checks": checks}


def _config() -> str:
    return """
[bridge]
signature_window_seconds = 300
allow_unsigned = false

[notify]
mode = "off"

[[instances]]
id = "local-desktop"
label = "self-check local"
kind = "desktop"
adapter = "fake"
base_url = "http://127.0.0.1:9"
auth_env = "DSH_SELF_LOCAL_TOKEN"
event_secret_env = "DSH_SELF_LOCAL_EVENT_SECRET"

[[instances.workspaces]]
name = "broadcast-cs"
description = "self-check"

[[instances]]
id = "lab-server"
label = "self-check remote"
kind = "remote"
adapter = "fake"
base_url = "http://127.0.0.1:10"
auth_env = "DSH_SELF_LAB_TOKEN"
event_secret_env = "DSH_SELF_LAB_EVENT_SECRET"

[[instances.workspaces]]
name = "broadcast-cs"
description = "self-check"
""".strip() + "\n"
