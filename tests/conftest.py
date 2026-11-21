"""Shared fixtures for the control bridge tests."""

from __future__ import annotations

from datetime import timedelta

import pytest

from dsh_control_bridge.adapters.fake import FakeAdapter
from dsh_control_bridge.bridge import Bridge
from dsh_control_bridge.config import load_config
from dsh_control_bridge.models import Mandate, format_utc, utc_now
from dsh_control_bridge.store import Store

CONFIG = """
[bridge]
webhook_secret_env = "DSH_BRIDGE_WEBHOOK_SECRET"
allow_unsigned = false

[[instances]]
id = "local-desktop"
label = "本机 DeepSeek Harness Desktop"
kind = "desktop"
adapter = "fake"
base_url = "http://127.0.0.1:9"
auth_env = "DSH_LOCAL_DESKTOP_TOKEN"

[[instances.workspaces]]
name = "broadcast-cs"
description = "示例工作区"

[[instances.workspaces]]
name = "auto-video"
description = "另一个示例工作区"

[[instances]]
id = "lab-server"
label = "实验室远程 Harness"
kind = "remote"
adapter = "fake"
base_url = "http://127.0.0.1:10"
auth_env = "DSH_LAB_SERVER_TOKEN"

[[instances.workspaces]]
name = "broadcast-cs"
description = "另一套实例上的同名工作区"
"""


@pytest.fixture
def secret(monkeypatch: pytest.MonkeyPatch) -> str:
    monkeypatch.setenv("DSH_BRIDGE_WEBHOOK_SECRET", "test-secret")
    return "test-secret"


@pytest.fixture
def config_path(tmp_path):
    path = tmp_path / "bridge.toml"
    path.write_text(CONFIG.strip() + "\n", encoding="utf-8")
    return path


@pytest.fixture
def bridge(tmp_path, config_path, secret):
    del secret
    config = load_config(config_path)
    data = tmp_path / "data"
    local = FakeAdapter("local-desktop", data / "adapters" / "local.json")
    lab = FakeAdapter("lab-server", data / "adapters" / "lab.json")
    store = Store(data / "bridge.sqlite", data / "audit.jsonl")
    opened = Bridge(config, store, {"local-desktop": local, "lab-server": lab})
    yield opened
    store.close()


def make_mandate(**overrides) -> Mandate:
    values = {
        "objective": "完成已经写明的一步。",
        "scope": "不扩大范围，不发布，不合并，不增加预算。",
        "acceptance": "负责人验收后才算交付。",
        "budget_cap": "fake-adapter-only",
        "retry_limit": 2,
        "expires_at": format_utc(utc_now() + timedelta(days=1)),
        "allowed_actions": ("dispatch", "retry"),
    }
    values.update(overrides)
    actions = values["allowed_actions"]
    if isinstance(actions, list):
        values["allowed_actions"] = tuple(actions)
    return Mandate(**values)
