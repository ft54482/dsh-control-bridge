"""Run the upstream `dsh-bridge` command line from a local checkout: no pip, no PATH change.

Antigravity wrapper for https://github.com/ft54482/dsh-control-bridge (MIT). The source is not bundled:
it stays a git checkout, so it is updated with git and never drifts from upstream. Keep that
checkout outside every skills directory, because the repository ships its own SKILL.md.

    python dsh-bridge.py --version
    python dsh-bridge.py self-check
    python dsh-bridge.py --config bridge.toml --data-dir data dispatch ...

Every other argument is passed to the upstream CLI unchanged. The checkout is found through
--repo PATH (given first), the environment variable DSH_CONTROL_BRIDGE_REPO, or "repo" in
local.json beside this file. Without a checkout this prints how to create one and exits with 3.
"""

from __future__ import annotations

import importlib
import json
import os
import sys
from pathlib import Path

EXPECTED_VERSION = "0.2.2"
REPO_URL = "https://github.com/ft54482/dsh-control-bridge.git"
LOCAL = Path(__file__).resolve().parent / "local.json"


def configured_repo(override: str | None) -> Path | None:
    if override:
        return Path(override).expanduser()
    from_env = os.environ.get("DSH_CONTROL_BRIDGE_REPO")
    if from_env:
        return Path(from_env).expanduser()
    try:
        value = json.loads(LOCAL.read_bytes().decode("utf-8-sig")).get("repo")
    except (OSError, UnicodeError, ValueError):
        return None
    if isinstance(value, str) and value.strip():
        return Path(value.strip()).expanduser()
    return None


def install_hint() -> str:
    default = Path.home() / ".dsh-control-bridge" / "repo"
    return "\n".join(
        [
            "dsh-bridge.py: no dsh-control-bridge checkout is configured, so nothing was run.",
            "Create one with the upstream clone, pinned to the release these instructions were checked against:",
            f'  git clone --branch v{EXPECTED_VERSION} {REPO_URL} "{default}"',
            "Keep it outside every skills directory: the repository contains its own SKILL.md.",
            f'Then write {{"repo": "{default}"}} into {LOCAL.name} beside this file,',
            "or set DSH_CONTROL_BRIDGE_REPO, or pass --repo PATH as the first argument.",
        ]
    )


def main() -> int:
    argv = sys.argv[1:]
    override = None
    if argv and argv[0] == "--repo":
        if len(argv) < 2 or argv[1].startswith("-"):
            print("dsh-bridge.py: --repo needs a path", file=sys.stderr)
            return 2
        override, argv = argv[1], argv[2:]
    repo = configured_repo(override)
    source = repo / "src" if repo else None
    if source is None:
        print(install_hint(), file=sys.stderr)
        return 3
    if not (source / "dsh_control_bridge" / "cli.py").is_file():
        print(f"dsh-bridge.py: {source} has no dsh_control_bridge/cli.py; is this the right checkout?", file=sys.stderr)
        return 3
    sys.path.insert(0, str(source))
    package = importlib.import_module("dsh_control_bridge")
    version = getattr(package, "__version__", "?")
    if version != EXPECTED_VERSION:
        print(
            f"dsh-bridge.py: note: the checkout is version {version}; "
            f"the skill instructions were checked against {EXPECTED_VERSION}.",
            file=sys.stderr,
        )
    from dsh_control_bridge.cli import main as upstream_main

    return upstream_main(argv)


if __name__ == "__main__":
    raise SystemExit(main())
