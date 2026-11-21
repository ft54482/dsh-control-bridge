"""Load and validate the multi-instance bridge configuration.

Project config may name environment variables. It may not contain secrets.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath
from typing import Any
from urllib.parse import urlparse

import tomllib

from dsh_control_bridge.errors import AdapterError, ConfigError
from dsh_control_bridge.home_access import SessionGrant, validate_configured_path

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
_BRIDGE_KEYS = frozenset({"signature_window_seconds", "allow_unsigned"})
_INSTANCE_KEYS = frozenset(
    {
        "id",
        "label",
        "kind",
        "adapter",
        "base_url",
        "auth_env",
        "event_secret_env",
        "workspaces",
        "executable",
        "spawn",
        "timeout_seconds",
        "credential_envs",
        "profile",
        "home_mode",
        "dsh_home",
        "credential_mode",
        "session_grants",
        "host_bind",
        "host_port",
        "host_secret_env",
    }
)
_NOTIFY_KEYS = frozenset({"mode", "file_name", "webhook_url", "allowed_hosts"})
_FILE_NAME = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
_WORKSPACE_KEYS = frozenset({"name", "description", "cwd", "allow_new_session", "occupancy", "host_workspace_id"})
_GRANT_KEYS = frozenset({"session_id", "workspace", "profile", "cwd", "access", "occupancy"})
_GRANT_PROFILES = frozenset({"headless", "desktop", "web", "superagent"})
_KINDS = frozenset({"desktop", "remote"})
_ADAPTERS = frozenset({"fake", "harness", "headless_cli", "desktop_host"})
_META = set('%&|<>^\r\n"!`')


@dataclass(frozen=True)
class Workspace:
    name: str
    description: str
    cwd: str
    allow_new_session: bool = False
    occupancy: str = "unknown"
    host_workspace_id: str = ""


@dataclass(frozen=True)
class NotifySettings:
    mode: str
    file_name: str
    webhook_url: str
    allowed_hosts: tuple[str, ...]


@dataclass(frozen=True)
class Instance:
    id: str
    label: str
    kind: str
    adapter: str
    base_url: str
    auth_env: str
    event_secret_env: str
    workspaces: dict[str, Workspace]
    executable: str = ""
    spawn: bool = False
    timeout_seconds: int = 0
    credential_envs: tuple[str, ...] = ()
    home_mode: str = "isolated"
    dsh_home: str = ""
    credential_mode: str = "environment"
    session_grants: tuple[SessionGrant, ...] = ()
    host_bind: str = ""
    host_port: int = 0
    host_secret_env: str = ""


@dataclass(frozen=True)
class BridgeSettings:
    signature_window_seconds: int
    allow_unsigned: bool


@dataclass(frozen=True)
class Config:
    settings: BridgeSettings
    notify: NotifySettings
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
    unknown_root = sorted(set(raw) - {"bridge", "instances", "notify"})
    for key in unknown_root:
        if key in _AUTO_SEND:
            errors.append(f"{key} is not allowed; tasks are drafted unless a person sends them")
        else:
            errors.append(f"unknown top-level field {key!r}")
    settings = _parse_bridge(raw.get("bridge", {}), errors)
    notify = _parse_notify(raw.get("notify", {}), errors)
    instances = _parse_instances(raw.get("instances"), errors)
    if errors:
        raise ConfigError(errors)
    return Config(settings=settings, notify=notify, instances=instances, path=path.resolve())


def dev_unsigned(settings: BridgeSettings) -> bool:
    """Unsigned ingest is a local test switch, not a config-file choice by itself."""

    import os

    return settings.allow_unsigned and os.environ.get("DSH_BRIDGE_DEV_UNSIGNED") == "1"


def _parse_bridge(raw: Any, errors: list[str]) -> BridgeSettings:
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        errors.append("[bridge] must be a table")
        return BridgeSettings(300, False)
    for key in sorted(set(raw) - _BRIDGE_KEYS):
        if key in _AUTO_SEND or key == "webhook_secret_env":
            errors.append(
                f"bridge.{key} is not allowed; each instance has its own event_secret_env, "
                "and send is always an explicit decision"
            )
        else:
            errors.append(f"unknown bridge field {key!r}")
    window = raw.get("signature_window_seconds", 300)
    if isinstance(window, bool) or not isinstance(window, int) or not 30 <= window <= 900:
        errors.append("bridge.signature_window_seconds must be an integer from 30 to 900")
        window = 300
    allow = raw.get("allow_unsigned", False)
    if not isinstance(allow, bool):
        errors.append("bridge.allow_unsigned must be a boolean")
        allow = False
    return BridgeSettings(signature_window_seconds=window, allow_unsigned=allow)


def _parse_notify(raw: Any, errors: list[str]) -> NotifySettings:
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        errors.append("[notify] must be a table")
        return NotifySettings("off", "notifications.jsonl", "", ())
    for key in sorted(set(raw) - _NOTIFY_KEYS):
        errors.append(f"unknown notify field {key!r}")
    mode = raw.get("mode", "off")
    if mode not in {"off", "file", "webhook"}:
        errors.append("notify.mode must be off, file, or webhook")
        mode = "off"
    file_name = raw.get("file_name", "notifications.jsonl")
    if not isinstance(file_name, str) or not _FILE_NAME.match(file_name):
        errors.append("notify.file_name must be a file name inside the data directory")
        file_name = "notifications.jsonl"
    webhook_url = raw.get("webhook_url", "")
    if not isinstance(webhook_url, str):
        errors.append("notify.webhook_url must be a string")
        webhook_url = ""
    hosts_raw = raw.get("allowed_hosts", [])
    hosts: list[str] = []
    if hosts_raw and not isinstance(hosts_raw, list):
        errors.append("notify.allowed_hosts must be a list")
    elif isinstance(hosts_raw, list):
        for host in hosts_raw:
            if not isinstance(host, str) or not host or "/" in host or " " in host:
                errors.append("notify.allowed_hosts entries must be hostnames")
            else:
                hosts.append(host)
    if mode == "webhook":
        parsed = urlparse(webhook_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            errors.append("notify.webhook_url must be an http(s) URL when mode is webhook")
        elif parsed.username or parsed.password:
            errors.append("notify.webhook_url must not contain credentials")
        elif parsed.hostname not in hosts:
            errors.append("notify.webhook_url host must be listed in allowed_hosts")
    elif webhook_url:
        errors.append("notify.webhook_url is only allowed when mode is webhook")
    return NotifySettings(mode=mode, file_name=file_name, webhook_url=webhook_url, allowed_hosts=tuple(hosts))


def _parse_instances(raw: Any, errors: list[str]) -> dict[str, Instance]:
    if not isinstance(raw, list) or not raw:
        errors.append("instances must be a non-empty array of tables")
        return {}
    instances: dict[str, Instance] = {}
    urls: dict[str, str] = {}
    envs: dict[str, str] = {}
    event_envs: dict[str, str] = {}
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
            errors.append(f"{where}.adapter must be fake, harness, headless_cli, or desktop_host")
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
        event_secret_env = item.get("event_secret_env")
        if not isinstance(event_secret_env, str) or not _ENV.match(event_secret_env):
            errors.append(f"{where}.event_secret_env must name an environment variable, not a secret")
            event_secret_env = ""
        elif event_secret_env in event_envs:
            errors.append(
                f"{where}.event_secret_env repeats {event_envs[event_secret_env]}; "
                "each instance signs with its own secret"
            )
        elif event_secret_env in envs or event_secret_env == auth_env:
            errors.append(f"{where}.event_secret_env must not reuse an auth_env")
        else:
            event_envs[event_secret_env] = instance_id
        workspaces = _parse_workspaces(item.get("workspaces"), where, errors)
        profile = item.get("profile", "headless" if adapter == "headless_cli" else "")
        if profile == "desktop" or (isinstance(profile, str) and profile.lower() == "desktop"):
            errors.append(f"{where}.profile desktop cannot be booted by the CLI")
            profile = ""
        executable = item.get("executable", "")
        if not isinstance(executable, str):
            errors.append(f"{where}.executable must be a path string")
            executable = ""
        elif any(character in executable for character in _META):
            errors.append(f"{where}.executable contains a shell metacharacter")
            executable = ""
        spawn = item.get("spawn", False)
        if not isinstance(spawn, bool):
            errors.append(f"{where}.spawn must be a boolean")
            spawn = False
        timeout = item.get("timeout_seconds", 0)
        if isinstance(timeout, bool) or not isinstance(timeout, int) or timeout < 0 or timeout > 3600:
            errors.append(f"{where}.timeout_seconds must be an integer from 0 to 3600")
            timeout = 0
        credential_envs = _parse_env_names(item.get("credential_envs", []), where, errors)
        host_bind = item.get("host_bind", "")
        host_port = item.get("host_port", 0)
        host_secret_env = item.get("host_secret_env", "")
        if not isinstance(host_bind, str):
            errors.append(f"{where}.host_bind must be a string")
            host_bind = ""
        if isinstance(host_port, bool) or not isinstance(host_port, int) or host_port < 0 or host_port > 65535:
            errors.append(f"{where}.host_port must be an integer from 0 to 65535")
            host_port = 0
        if host_secret_env and (not isinstance(host_secret_env, str) or not _ENV.match(host_secret_env)):
            errors.append(f"{where}.host_secret_env must name an environment variable")
            host_secret_env = ""
        if adapter == "headless_cli":
            if not executable:
                errors.append(f"{where}.executable is required for headless_cli")
            if spawn and timeout <= 0:
                errors.append(f"{where}.timeout_seconds is required when spawn is true")
            cwds = [workspace.cwd for workspace in workspaces.values()]
            if any(not cwd for cwd in cwds):
                errors.append(f"{where} headless workspaces require an absolute cwd")
            normalized = [_normalize_cwd(cwd) for cwd in cwds if cwd]
            if len(normalized) != len(set(normalized)):
                errors.append(f"{where} headless workspaces must use distinct directories")
            if host_bind or host_port or host_secret_env:
                errors.append(f"{where} host_bind belongs only to desktop_host")
        elif adapter == "desktop_host":
            if executable or credential_envs:
                errors.append(f"{where} desktop_host does not take an executable or credential env")
            if host_bind not in {"127.0.0.1", "localhost"}:
                errors.append(f"{where}.host_bind must be 127.0.0.1")
            if host_port <= 0:
                errors.append(f"{where}.host_port is required for desktop_host")
            if not isinstance(host_secret_env, str) or not _ENV.match(host_secret_env or ""):
                errors.append(f"{where}.host_secret_env is required for desktop_host")
            if spawn and timeout <= 0:
                errors.append(f"{where}.timeout_seconds is required when spawn is true")
        elif executable or spawn or credential_envs or host_bind or host_port or host_secret_env:
            errors.append(f"{where} executable, spawn, and host fields belong only to a headless or desktop adapter")
        home_mode = item.get("home_mode", "isolated")
        if home_mode not in {"isolated", "shared"}:
            errors.append(f"{where}.home_mode must be isolated or shared")
            home_mode = "isolated"
        dsh_home = item.get("dsh_home", "")
        if not isinstance(dsh_home, str):
            errors.append(f"{where}.dsh_home must be a path string")
            dsh_home = ""
        elif dsh_home:
            try:
                dsh_home = validate_configured_path(dsh_home, label=f"{where}.dsh_home")
            except AdapterError as exc:
                errors.append(str(exc))
                dsh_home = ""
        credential_mode = item.get("credential_mode", "environment")
        if credential_mode not in {"environment", "official_store"}:
            errors.append(f"{where}.credential_mode must be environment or official_store")
            credential_mode = "environment"
        if home_mode == "shared" and not dsh_home:
            errors.append(f"{where}.dsh_home is required when home_mode is shared")
        if home_mode == "isolated" and dsh_home:
            errors.append(f"{where}.dsh_home belongs only to home_mode shared")
        grants = _parse_grants(item.get("session_grants", []), workspaces, where, errors)
        headless_only = home_mode != "isolated" or bool(dsh_home) or credential_mode != "environment"
        workspace_shared = any(item.allow_new_session or item.occupancy != "unknown" for item in workspaces.values())
        if adapter != "headless_cli" and headless_only:
            errors.append(f"{where} shared home belongs only to headless_cli")
        if adapter not in {"headless_cli", "desktop_host"} and (grants or workspace_shared):
            errors.append(f"{where} session grants belong only to headless_cli or desktop_host")
        if adapter == "desktop_host" and any(item.allow_new_session for item in workspaces.values()):
            errors.append(f"{where} desktop_host does not create a stand-in session")
        if adapter == "desktop_host" and any(not item.host_workspace_id for item in workspaces.values()):
            errors.append(f"{where} desktop workspaces require host_workspace_id")
        if adapter == "desktop_host":
            for grant in grants:
                if grant.access == "write" and grant.profile != "desktop":
                    errors.append(
                        f"{where} session {grant.session_id} is {grant.profile}, not desktop; refusing to forge a resume"
                    )
                if grant.access == "write" and grant.occupancy != "operator_confirmed_idle":
                    errors.append(
                        f"{where} session {grant.session_id} refuses write until occupancy is operator_confirmed_idle"
                    )
        if adapter == "headless_cli" and home_mode == "shared":
            for grant in grants:
                if grant.access == "write" and grant.profile != "headless":
                    errors.append(f"{where} session {grant.session_id} cannot be written on profile {grant.profile}")
                if grant.access == "write" and grant.occupancy != "operator_confirmed_idle":
                    errors.append(f"{where} session {grant.session_id} refuses write until occupancy is operator_confirmed_idle")
        instances[instance_id] = Instance(
            id=instance_id,
            label=str(label).strip(),
            kind=str(kind),
            adapter=str(adapter),
            base_url=base_url,
            auth_env=auth_env,
            event_secret_env=event_secret_env,
            workspaces=workspaces,
            executable=executable,
            spawn=spawn,
            timeout_seconds=timeout,
            credential_envs=tuple(credential_envs),
            home_mode=str(home_mode),
            dsh_home=dsh_home,
            credential_mode=str(credential_mode),
            session_grants=tuple(grants),
            host_bind=host_bind,
            host_port=host_port,
            host_secret_env=host_secret_env or "",
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
        cwd = item.get("cwd", "")
        if not isinstance(cwd, str):
            errors.append(f"{spot}.cwd must be a path string")
            cwd = ""
        elif cwd and not _is_absolute(cwd):
            errors.append(f"{spot}.cwd must be an absolute directory")
            cwd = ""
        elif cwd and any(character in cwd for character in _META):
            errors.append(f"{spot}.cwd contains a shell metacharacter")
            cwd = ""
        elif cwd and ".." in cwd.replace("\\", "/").split("/"):
            errors.append(f"{spot}.cwd must not contain ..")
            cwd = ""
        allow_new = item.get("allow_new_session", False)
        if not isinstance(allow_new, bool):
            errors.append(f"{spot}.allow_new_session must be a boolean")
            allow_new = False
        occupancy = item.get("occupancy", "unknown")
        if occupancy not in {"unknown", "operator_confirmed_idle"}:
            errors.append(f"{spot}.occupancy must be unknown or operator_confirmed_idle")
            occupancy = "unknown"
        if allow_new and occupancy != "operator_confirmed_idle":
            errors.append(f"{spot} allow_new_session requires occupancy operator_confirmed_idle")
        host_workspace_id = item.get("host_workspace_id", "")
        if host_workspace_id and (
            not isinstance(host_workspace_id, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,200}", host_workspace_id)
        ):
            errors.append(f"{spot}.host_workspace_id must be a safe token")
            host_workspace_id = ""
        found[name] = Workspace(
            name=name,
            description=description.strip(),
            cwd=cwd,
            allow_new_session=allow_new,
            occupancy=occupancy,
            host_workspace_id=host_workspace_id if isinstance(host_workspace_id, str) else "",
        )
    return found


def _parse_grants(
    raw: Any,
    workspaces: dict[str, Workspace],
    where: str,
    errors: list[str],
) -> list[SessionGrant]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        errors.append(f"{where}.session_grants must be a list")
        return []
    found: list[SessionGrant] = []
    seen: set[str] = set()
    for index, item in enumerate(raw):
        spot = f"{where}.session_grants[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{spot} must be a table")
            continue
        for key in sorted(set(item) - _GRANT_KEYS):
            errors.append(f"{spot} has unknown field {key!r}")
        session_id = item.get("session_id")
        if not isinstance(session_id, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,200}", session_id):
            errors.append(f"{spot}.session_id must be a safe token")
            continue
        if session_id in seen:
            errors.append(f"{where} repeats session {session_id!r}")
            continue
        seen.add(session_id)
        workspace_name = item.get("workspace")
        if not isinstance(workspace_name, str) or workspace_name not in workspaces:
            errors.append(f"{spot}.workspace must be one of this instance's workspaces")
            continue
        profile = item.get("profile", "headless")
        if profile not in _GRANT_PROFILES:
            errors.append(f"{spot}.profile must be headless, desktop, web, or superagent")
            profile = "headless"
        access = item.get("access", "read")
        if access not in {"read", "write"}:
            errors.append(f"{spot}.access must be read or write")
            access = "read"
        occupancy = item.get("occupancy", "unknown")
        if occupancy not in {"unknown", "operator_confirmed_idle"}:
            errors.append(f"{spot}.occupancy must be unknown or operator_confirmed_idle")
            occupancy = "unknown"
        cwd = item.get("cwd", "")
        if not isinstance(cwd, str) or not cwd:
            errors.append(f"{spot}.cwd is required")
            continue
        try:
            cwd = validate_configured_path(cwd, label=f"{spot}.cwd")
        except AdapterError as exc:
            errors.append(str(exc))
            continue
        expected = _normalize_cwd(workspaces[workspace_name].cwd) if workspaces[workspace_name].cwd else ""
        if not expected or _normalize_cwd(cwd) != expected:
            errors.append(f"{spot}.cwd must be the declared cwd of workspace {workspace_name!r}")
            continue
        found.append(
            SessionGrant(
                session_id=session_id,
                workspace=workspace_name,
                profile=str(profile),
                cwd=cwd,
                access=str(access),
                occupancy=str(occupancy),
            )
        )
    return found


def _parse_env_names(raw: Any, where: str, errors: list[str]) -> list[str]:
    if raw is None:
        return []
    if not isinstance(raw, list) or not all(isinstance(item, str) and _ENV.match(item) for item in raw):
        errors.append(f"{where}.credential_envs must be a list of environment variable names")
        return []
    return list(dict.fromkeys(raw))


def _is_absolute(value: str) -> bool:
    return Path(value).is_absolute() or PureWindowsPath(value).is_absolute()


def _normalize_cwd(value: str) -> str:
    if PureWindowsPath(value).is_absolute() and not Path(value).is_absolute():
        return str(PureWindowsPath(value))
    return str(Path(value))


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
