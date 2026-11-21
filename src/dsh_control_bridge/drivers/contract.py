"""Facts declared by a local read-only probe. Nothing here opens a socket or runs dsh.cmd."""

from __future__ import annotations

DECLARED_FACTS = {
    "connected_to_harness": False,
    "called_by_this_repository": False,
    "desktop": {
        "version_observed": "0.2.2-rc.5",
        "bundled_runtimes_observed": ["node 24.21", "python 3.12"],
        "install_root": None,
        "install_root_note": "The operator keeps the absolute install path private. Do not commit it.",
    },
    "cli_headless": {
        "help_verified": True,
        "version_reported_by_operator": "0.2.2-rc.5",
        "argv": ["--profile", "headless", "--json", "-"],
        "task_transport": "stdin",
        "success_rule": "exit 0 and final.reason.kind == completed",
        "desktop_profile_boot": False,
        "live_process_in_ci": False,
        "implemented": True,
    },
    "superagent_plugin": {
        "relative_path": ".dsh/plugins/dsh-superagent",
        "version_observed": "0.1.0",
        "license_observed": "MIT",
        "official_product": False,
        "readme_says_research_prototype": True,
        "required_profile_name": "superagent",
    },
    "profiles_observed": ["superagent", "superagent-gd", "superagent-lab"],
    "profile_workspace_map": None,
    "profile_workspace_note": "Do not assume which profile holds which workspace.",
    "superagent_management_api": {
        "role": "management_plane",
        "is_ordinary_session_api": False,
        "is_dispatch_api": False,
        "implemented": False,
        "scheme": "http",
        "host_allowlist": ["127.0.0.1", "localhost"],
        "port_observed": 3082,
        "path_prefix": "/orchestrator/api/",
        "required_header": {"name": "x-orchestrator-request", "value": "1"},
        "routes_documented": [
            "GET state",
            "GET settings",
            "GET sources",
            "PUT settings/<block>",
            "POST executor/pause",
            "POST setup/check",
            "GET prompts",
            "PUT prompts",
            "POST tickets/<id>/retry",
            "POST tickets/<id>/stop",
        ],
        "note": "tickets stop/retry are management actions in the plugin docs, not a bridge cancel implementation.",
    },
    "ordinary_session_api": {
        "status": "documented_headless_cli",
        "implemented": True,
        "live_calls": False,
        "not_the_desktop_workspace": True,
    },
    "harness_webhook_inbound": {
        "supported": False,
        "reason": "cookbook webhook/hookq is an example Source, not an installed HTTP inbound. GitHub intake is documented as gh polling.",
    },
    "github_source": {
        "mode_documented": "gh poll",
        "interval_seconds_documented": 60,
    },
}

REQUIRED_EVIDENCE = (
    "business_profile_named_by_operator",
    "superagent_dispatch_binding",
    "headless_credential_env_chosen_by_operator",
)
