"""Private credential files stay outside the git work tree.

The bridge reports whether a token is present. It does not print the token.
"""

from __future__ import annotations

import os
from pathlib import Path

import tomllib

from dsh_control_bridge.errors import ConfigError

_PLACEHOLDERS = frozenset(
    {
        "",
        "replace-with-token",
        "replace-with-local-secret",
        "changeme",
        "todo",
    }
)


def credentials_path() -> Path:
    override = os.environ.get("DSH_CREDENTIALS_FILE")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".dsh-control-bridge" / "credentials.toml"


def assert_outside_work_tree(path: Path) -> None:
    resolved = path.expanduser().resolve()
    root = _git_root(Path.cwd())
    if root and (resolved == root or root in resolved.parents):
        raise ConfigError(
            [
                "refusing to read credentials from the git work tree; "
                "copy the example to ~/.dsh-control-bridge/credentials.toml"
            ]
        )


def credentials_report() -> dict[str, object]:
    path = credentials_path()
    if not path.exists():
        return {"path": str(path), "present": False, "instances": {}}
    assert_outside_work_tree(path)
    try:
        raw = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, tomllib.TOMLDecodeError) as exc:
        raise ConfigError([f"cannot read credentials file: {exc.__class__.__name__}"]) from exc
    instances: dict[str, str] = {}
    table = raw.get("instances", {}) if isinstance(raw, dict) else {}
    if isinstance(table, dict):
        for key, value in table.items():
            token = value.get("token") if isinstance(value, dict) else None
            if not isinstance(token, str) or token.strip().lower() in _PLACEHOLDERS:
                instances[str(key)] = "placeholder"
            else:
                instances[str(key)] = "configured"
    webhook = "missing"
    if isinstance(raw, dict) and isinstance(raw.get("webhook"), dict):
        secret = raw["webhook"].get("shared_secret")
        if isinstance(secret, str) and secret.strip().lower() not in _PLACEHOLDERS:
            webhook = "configured"
        else:
            webhook = "placeholder"
    return {
        "path": str(path),
        "present": True,
        "webhook": webhook,
        "instances": instances,
    }


def _git_root(start: Path) -> Path | None:
    current = start.resolve()
    for candidate in (current, *current.parents):
        if (candidate / ".git").exists():
            return candidate
    return None
