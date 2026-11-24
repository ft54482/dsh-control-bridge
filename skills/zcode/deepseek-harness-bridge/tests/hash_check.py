"""Read-only helper for upgrading this skill.

cmp      compare every file in the release skill ZIP with the same path at a git tag and with the
         installed skill directory. "equal-modulo-eol" means the two differ only in CRLF versus LF.
inspect  report whitespace and non-ASCII facts of one text file, before or after a verbatim rewrite.

Usage (stdlib only). Keep the downloaded ZIP in a directory of its own:
  python -I -X utf8 tests/hash_check.py cmp --zip ZIP --sha256 FILE --repo REPO --tag TAG --skill DIR
  python -I -X utf8 tests/hash_check.py inspect FILE

Example, after downloading deepseek-harness-bridge-0.2.3-skill.zip and its .sha256 into an empty directory:
  python -I -X utf8 tests/hash_check.py cmp \
      --zip "<dir>/deepseek-harness-bridge-0.2.3-skill.zip" \
      --sha256 "<dir>/deepseek-harness-bridge-0.2.3-skill.zip.sha256" \
      --repo "$HOME/.dsh-control-bridge/repo" --tag skill-v0.2.3 \
      --skill "$HOME/.zcode/skills/deepseek-harness-bridge"

Exit code is 0 only when the ZIP matches its .sha256 and every upstream file in it is installed with
the same content. SKILL.md is reported but not required to match, because the installed one is the
ZCode adaptation.
"""

from __future__ import annotations

import argparse
import hashlib
import subprocess
import sys
import zipfile
from pathlib import Path

PREFIX = "skills/deepseek-harness-bridge/"
ADAPTED = {"SKILL.md"}


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def lf(data: bytes) -> bytes:
    return data.replace(b"\r\n", b"\n")


def cmd_cmp(a) -> int:
    expected = Path(a.sha256).read_text(encoding="utf-8").split()[0].strip().lower()
    actual = sha(Path(a.zip).read_bytes())
    ok = actual == expected
    print(f"zip sha256 {'OK' if ok else 'MISMATCH'}  {actual}  (expected {expected})")
    skill = Path(a.skill)
    with zipfile.ZipFile(a.zip) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            data = archive.read(info)
            name = info.filename
            if name.startswith(a.strip_prefix):
                name = name[len(a.strip_prefix):]
            cells = [f"{info.file_size:>6}", f"zip_crlf={data.count(b'\r\n')}", sha(lf(data))[:16], name]
            blob = subprocess.run(
                ["git", "-C", a.repo, "show", f"{a.tag}:{PREFIX}{name}"],
                capture_output=True,
            )
            if blob.returncode != 0:
                cells.append("tag=absent")
            else:
                same = blob.stdout == data
                same_lf = lf(blob.stdout) == lf(data)
                cells.append("tag=equal" if same else "tag=equal-modulo-eol" if same_lf else f"tag=DIFF {sha(blob.stdout)[:16]}")
            installed = skill / name
            if not installed.is_file():
                cells.append("installed=absent")
                state = "absent"
            else:
                raw = installed.read_bytes()
                state = "equal" if raw == data else "equal-modulo-eol" if lf(raw) == lf(data) else "DIFF"
                cells.append(f"installed={state}" + (f" crlf={raw.count(b'\r\n')}" if state != "equal" else ""))
            if state not in ("equal", "equal-modulo-eol") and name not in ADAPTED:
                ok = False
            print("  ".join(cells))
    print("RESULT:", "UPSTREAM FILES MATCH" if ok else "SOMETHING DOES NOT MATCH")
    return 0 if ok else 1


def cmd_inspect(a) -> int:
    raw = Path(a.file).read_bytes()
    text = raw.decode("utf-8")
    lines = text.split("\n")
    print(f"bytes={len(raw)} chars={len(text)} crlf={raw.count(b'\r\n')} lf={raw.count(b'\n')}")
    print(f"ends_with_newline={text.endswith(chr(10))} bom={raw.startswith(b'\xef\xbb\xbf')}")
    trailing = [n for n, line in enumerate(lines, 1) if line.rstrip("\r") != line.rstrip("\r").rstrip()]
    tabs = [n for n, line in enumerate(lines, 1) if "\t" in line]
    print(f"trailing_whitespace_lines={trailing}")
    print(f"tab_lines={tabs}")
    longest = max(enumerate(lines, 1), key=lambda row: len(row[1]))
    print(f"longest_line={longest[0]} len={len(longest[1])}")
    for n, line in enumerate(lines, 1):
        for col, char in enumerate(line, 1):
            if ord(char) > 126 or (ord(char) < 32 and char != "\r"):
                print(f"  line {n} col {col}: U+{ord(char):04X} {char!r}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    cmp_parser = sub.add_parser("cmp")
    for flag in ("--zip", "--sha256", "--repo", "--tag", "--skill"):
        cmp_parser.add_argument(flag, required=True)
    cmp_parser.add_argument("--strip-prefix", default="deepseek-harness-bridge/")
    inspect_parser = sub.add_parser("inspect")
    inspect_parser.add_argument("file")
    a = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    return cmd_cmp(a) if a.command == "cmp" else cmd_inspect(a)


if __name__ == "__main__":
    raise SystemExit(main())
