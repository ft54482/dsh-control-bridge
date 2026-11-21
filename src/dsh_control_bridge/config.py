"""Load and validate the multi-instance bridge configuration.

Project config may name environment variables. It may not contain secrets.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import tomllib

from dsh_control_bridge.errors import ConfigError

_SLUG = re.compile(r"^[a-z][a-z0-9-]{1,63}$")
_ENV = re.compile(r"^[A-Z][A-Z0-9_]{2,80}$")
_FORBIDDEN = frozenset(
    {
        "token",
        "secret",
        "password",
        "api_key",
        "authorization",
        "private_key",
        "access_key",
        "credential",
        "credentials",
    }
)
_AUTO_SEND = frozenset({"default_mode", "default_dispatch", "auto_dispatch", "auto_send"})
_BRIDGE_KEYS = frozenset({"webhook_secret_env", "allow_unsigned"})
_INSTANCE_KEYS = frozenset({"id", "label", "kind", "adapter", "base_url", "auth_env", "workspaces"})
_WORKSPACE_KEYS = frozenset({"name", "description"})
_KINDS = frozenset({"desktop", "remote"})
_ADAPTERS = frozenset({"fake", "harness"})


@dataclass(frozen=True)
class Workspace:
    name: str
    description: str


@dataclass(frozen=True)
class Instance:
    id: str
    label: str
    kind: str
    adapter: str
    base_url: str
    auth_env: str
    workspaces: dict[str, Workspace]


@dataclass(frozen=True)
class BridgeSettings:
    webhook_secret_env: str
    allow_unsigned: bool


@dataclass(frozen=True)
class Config:
    settings: BridgeSettings
    instances: dict[str, Instance]
    path: Path

    def instance(self, instance_id: str) -> Instance | None:
        return self.instances.get(instance_id)

    def require_target(self, instance_id: str, workspace: str) -> Instance:
        from dsh_control_bridge.errors import TargetRejected

        inst = self.instances.get(instance_id)
        if inst is None:
            known = ", ".join(sorted(self.instances)) or "(none)"
            raise TargetRejected(f"instance {instance_id!r} is not configured; known instances: {known}")
        if workspace not in inst.workspaces:
            known = ", ".join(sorted(inst.workspaces)) or "(none)"
            raise TargetRejected(
                f"workspace {workspace!r} is not declared on instance {instance_id!r}; "
                f"declared workspaces: {known}"
            )
        return inst


def load_config(path: Path) -> Config:
    path = path.expanduser()
    if not path.is_file():
        raise ConfigError([f"config file not found: {path}"])
    try:
        raw = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, tomllib.TOMLDecodeError) as exc:
        raise ConfigError([f"cannot read {path}: {exc.__class__.__name__}"]) from exc
    if not isinstance(raw, dict):
        raise ConfigError(["config root must be a table"])
    errors: list[str] = []
    _reject_forbidden(raw, "$", errors)
    unknown_root = sorted(set(raw) - {"bridge", "instances"})
    for key in unknown_root:
        if key in _AUTO_SEND:
            errors.append(f"{key} is not allowed; tasks are drafted unless a person sends them")
        else:
            errors.append(f"unknown top-level field {key!r}")
    settings = _parse_bridge(raw.get("bridge", {}), errors)
    instances = _parse_instances(raw.get("instances"), errors)
    if errors:
        raise ConfigError(errors)
    return Config(settings=settings, instances=instances, path=path.resolve())


def _parse_bridge(raw: Any, errors: list[str]) -> BridgeSettings:
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        errors.append("[bridge] must be a table")
        return BridgeSettings("DSH_BRIDGE_WEBHOOK_SECRET", False)
    for key in sorted(set(raw) - _BRIDGE_KEYS):
        if key in _AUTO_SEND:
            errors.append(
                f"bridge.{key} is not allowed; the default is draft, and each send is a separate decision"
            )
        else:
            errors.append(f"unknown bridge field {key!r}")
    secret_env = raw.get("webhook_secret_env", "DSH_BRIDGE_WEBHOOK_SECRET")
    if not isinstance(secret_env, str) or not _ENV.match(secret_env):
        errors.append("bridge.webhook_secret_env must be an environment variable name")
        secret_env = "DSH_BRIDGE_WEBHOOK_SECRET"
    allow = raw.get("allow_unsigned", False)
    if not isinstance(allow, bool):
        errors.append("bridge.allow_unsigned must be a boolean")
        allow = False
    return BridgeSettings(webhook_secret_env=secret_env, allow_unsigned=allow)


def _parse_instances(raw: Any, errors: list[str]) -> dict[str, Instance]:
    if not isinstance(raw, list) or not raw:
        errors.append("instances must be a non-empty array of tables")
        return {}
    instances: dict[str, Instance] = {}
    urls: dict[str, str] = {}
    envs: dict[str, str] = {}
    for index, item in enumerate(raw):
        where = f"instances[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{where} must be a table")
            continue
        for key in sorted(set(item) - _INSTANCE_KEYS):
            if key in _AUTO_SEND:
                errors.append(f"{where}.{key} is not allowed; send is never the configured default")
            else:
                errors.append(f"{where} has unknown field {key!r}")
        instance_id = item.get("id")
        if not isinstance(instance_id, str) or not _SLUG.match(instance_id):
            errors.append(f"{where}.id must be a lowercase slug")
            continue
        if instance_id in instances:
            errors.append(f"duplicate instance id {instance_id!r}")
            continue
        label = item.get("label")
        if not isinstance(label, str) or not label.strip() or len(label.strip()) > 120:
            errors.append(f"{where}.label must be a short non-empty string")
            label = instance_id
        kind = item.get("kind")
        if kind not in _KINDS:
            errors.append(f"{where}.kind must be desktop or remote")
            kind = "remote"
        adapter = item.get("adapter")
        if adapter not in _ADAPTERS:
            errors.append(f"{where}.adapter must be fake or harness")
            adapter = "fake"
        base_url = _normalize_url(item.get("base_url"), f"{where}.base_url", errors)
        if base_url in urls:
            errors.append(
                f"{where}.base_url repeats {urls[base_url]}; "
                "configure each physical or logical Harness as its own instance"
            )
        elif base_url:
            urls[base_url] = instance_id
        auth_env = item.get("auth_env")
        if not isinstance(auth_env, str) or not _ENV.match(auth_env):
            errors.append(f"{where}.auth_env must name an environment variable, not a secret")
            auth_env = ""
        elif auth_env in envs:
            errors.append(
                f"{where}.auth_env repeats {envs[auth_env]}; give each instance its own variable"
            )
        else:
            envs[auth_env] = instance_id
        workspaces = _parse_workspaces(item.get("workspaces"), where, errors)
        instances[instance_id] = Instance(
            id=instance_id,
            label=str(label).strip(),
            kind=str(kind),
            adapter=str(adapter),
            base_url=base_url,
            auth_env=auth_env,
            workspaces=workspaces,
        )
    return instances


def _parse_workspaces(raw: Any, where: str, errors: list[str]) -> dict[str, Workspace]:
    if not isinstance(raw, list) or not raw:
        errors.append(f"{where}.workspaces must list at least one workspace")
        return {}
    found: dict[str, Workspace] = {}
    for index, item in enumerate(raw):
        spot = f"{where}.workspaces[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{spot} must be a table")
            continue
        for key in sorted(set(item) - _WORKSPACE_KEYS):
            errors.append(f"{spot} has unknown field {key!r}")
        name = item.get("name")
        if not isinstance(name, str) or not _SLUG.match(name):
            errors.append(f"{spot}.name must be a lowercase slug")
            continue
        if name in found:
            errors.append(f"{where} repeats workspace {name!r}")
            continue
        description = item.get("description", "")
        if not isinstance(description, str) or len(description) > 300:
            errors.append(f"{spot}.description must be a short string")
            description = ""
        found[name] = Workspace(name=name, description=description.strip())
    return found


def _normalize_url(value: Any, where: str, errors: list[str]) -> str:
    if not isinstance(value, str) or not value.strip():
        errors.append(f"{where} is required")
        return ""
    cleaned = value.strip().rstrip("/")
    parsed = urlparse(cleaned)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        errors.append(f"{where} must be an http(s) URL")
        return ""
    if parsed.username or parsed.password:
        errors.append(f"{where} must not embed credentials")
        return ""
    return cleaned


def _reject_forbidden(value: Any, path: str, errors: list[str]) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            lowered = str(key).lower()
            if lowered in _FORBIDDEN:
                errors.append(
                    f"{path}.{key} is not allowed in project config; "
                    "put secrets in an environment variable or in ~/.dsh-control-bridge/"
                )
            _reject_forbidden(child, f"{path}.{key}", errors)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _reject_forbidden(child, f"{path}[{index}]", errors)
