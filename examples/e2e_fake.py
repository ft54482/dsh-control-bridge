#!/usr/bin/env python3
"""Run the fake end-to-end story. Safe for CI: no real Harness, no quota."""

from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from dsh_control_bridge.demo import run_demo


def main() -> int:
    parser = argparse.ArgumentParser(description="Fake end-to-end bridge demo")
    parser.add_argument("--data-dir", type=Path, help="keep the sqlite data in this directory")
    args = parser.parse_args()
    if args.data_dir:
        args.data_dir.mkdir(parents=True, exist_ok=True)
        report = run_demo(args.data_dir)
    else:
        with tempfile.TemporaryDirectory(prefix="dsh-bridge-e2e-") as temporary:
            report = run_demo(Path(temporary))
    print("\n".join(report["lines"]))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(f"e2e: failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
