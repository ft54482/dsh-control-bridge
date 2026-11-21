"""Local preflight. This does not open a connection to Harness."""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import urlparse

from dsh_control_bridge.config import Config, dev_unsigned

CONNECTOR_FACTS = (
    "ordinary_session_request",
    "ordinary_session_idempotency",
    "superagent_request",
    "superagent_idempotency",
    "cancel_request",
    "event_signature_compatibility",
    "evidence_path_convention",
    "base_url_origin",
)


def diagnose(config: Config) -> dict[str, Any]:
    instances = []
    missing = list(CONNECTOR_FACTS)
    any_harness = False
    for instance in config.instances.values():
        parsed = urlparse(instance.base_url)
        harness = instance.adapter == "harness"
        any_harness = any_harness or harness
        instances.append(
            {
                "id": instance.id,
                "label": instance.label,
                "kind": instance.kind,
                "adapter": instance.adapter,
                "workspaces": list(instance.workspaces),
                "base_url_host": parsed.hostname or "",
                "base_url_port": parsed.port,
                "auth_env": instance.auth_env,
                "auth_env_set": bool(os.environ.get(instance.auth_env)),
                "event_secret_env": instance.event_secret_env,
                "event_secret_set": bool(os.environ.get(instance.event_secret_env)),
                "dry_run": instance.adapter == "fake",
                "supports_send": instance.adapter == "fake" or (
                    instance.adapter == "headless_cli" and instance.spawn
                ),
                "headless_spawn": instance.spawn,
                "headless_cwd_configured": all(bool(item.cwd) for item in instance.workspaces.values())
                if instance.adapter == "headless_cli"
                else False,
                "credential_env_names": list(instance.credential_envs),
                "home_mode": instance.home_mode,
                "credential_mode": instance.credential_mode,
                "session_grant_count": len(instance.session_grants),
                "connected_to_harness": False,
            }
        )
    if not any_harness:
        missing = []
    return {
        "version": "0.1.0",
        "connected_to_harness": False,
        "connection_reason": (
            "no supported connector facts are loaded; the harness adapter does not call a network API"
        ),
        "signature_window_seconds": config.settings.signature_window_seconds,
        "allow_unsigned_requested": config.settings.allow_unsigned,
        "allow_unsigned_effective": dev_unsigned(config.settings),
        "notify": {
            "mode": config.notify.mode,
            "file_name": config.notify.file_name,
            "webhook_host": _host(config.notify.webhook_url),
            "allowed_hosts": list(config.notify.allowed_hosts),
        },
        "instances": instances,
        "compatibility": {
            "desktop_profile_cli_boot": False,
            "headless_is_desktop_workspace": False,
            "headless_reads_gui_credential_files": False,
            "shared_home_default": False,
            "official_history_read": False,
            "desktop_attach": False,
            "superagent_state_can_dispatch": False,
            "unused_ports": [17300, 49290],
            "harness_webhook_is_completion_callback": False,
        },
        "missing_connector_facts": missing,
    }


def _host(url: str) -> str:
    if not url:
        return ""
    return urlparse(url).hostname or ""
