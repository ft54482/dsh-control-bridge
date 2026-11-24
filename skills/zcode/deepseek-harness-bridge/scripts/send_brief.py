"""Send a task brief to one Harness Desktop session and keep the request ID.

ZCode addition to the upstream skill. It only assembles the JSON body and hands it to the
upstream `desktop.py resume` on stdin: the Host, the credential handling and the wire format
stay upstream. The brief file needs no JSON escaping, so multi-line text and Windows paths are safe.

    python scripts/send_brief.py --session SESSION_ID --brief TASK.md
    python scripts/send_brief.py --session SESSION_ID --brief - < TASK.md

A fresh request ID is generated for every send and printed on stderr *before* the request goes
out, so it survives a lost response; record it next to the session ID. Pass --request-id only to
resubmit a recorded ID together with the same session and the same text: the Host treats that as
the same request and does not prompt twice. CRLF line endings are sent as LF. Nothing is written
to disk.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

DESKTOP = Path(__file__).resolve().with_name("desktop.py")


def new_request_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"zcode-{stamp}-{uuid.uuid4().hex[:8]}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--session", required=True, help="an existing session_id that grants write")
    parser.add_argument("--brief", required=True, help="UTF-8 file with the task text; - reads stdin")
    parser.add_argument("--request-id", help="reuse a recorded ID; only with the same session and text")
    parser.add_argument("--port", type=int, default=8765, help="loopback port of the Desktop Host")
    args = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read() if args.brief == "-" else Path(args.brief).read_bytes()
        # Windows editors write CRLF; a brief's line-ending style carries no meaning, so the
        # same text always reaches Harness the same way regardless of which tool saved it.
        text = raw.decode("utf-8-sig").replace("\r\n", "\n")
    except (OSError, UnicodeError) as exc:
        print(f"send_brief: cannot read the brief: {exc.__class__.__name__}", file=sys.stderr)
        return 2
    if not text.strip():
        print("send_brief: the brief is empty; nothing was sent", file=sys.stderr)
        return 2
    request_id = args.request_id.strip() if args.request_id else ""
    request_id = request_id or new_request_id()
    body = {"session_id": args.session, "request_id": request_id, "text": text}
    print(f"request_id={request_id} session_id={args.session}", file=sys.stderr, flush=True)
    code = subprocess.run(
        [sys.executable, str(DESKTOP), "resume", "--data", "-", "--port", str(args.port)],
        input=json.dumps(body, ensure_ascii=False).encode("utf-8"),
    ).returncode
    if code == 0:
        print(
            "sent and accepted for tracking; this is not a completion. Read the outcome with:\n"
            f"  desktop.py wait --request-id {request_id} --param timeout_ms=110000\n"
            f"  desktop.py request --param session_id={args.session} --param request_id={request_id}",
            file=sys.stderr,
        )
    return code


if __name__ == "__main__":
    raise SystemExit(main())
