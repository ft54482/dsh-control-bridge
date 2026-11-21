"""Prepare or roll back the headless profile patch. It does not boot dsh."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from dsh_control_bridge.errors import BridgeError
from dsh_control_bridge.home_access import prepare_headless_profile, rollback_headless_profile


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Plan a headless credential-store patch. Desktop is not modified.")
    parser.add_argument("--home", required=True, type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--rollback", action="store_true")
    args = parser.parse_args(argv)
    if args.apply and args.rollback:
        print("choose apply or rollback, not both", file=sys.stderr)
        return 2
    try:
        if args.rollback:
            report = rollback_headless_profile(args.home, apply=args.apply)
        else:
            report = prepare_headless_profile(args.home, apply=args.apply)
    except BridgeError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
