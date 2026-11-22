"""Per-instance HMAC signatures with a freshness window.

Canonical bytes are ``v1\\n{unix_timestamp}\\n{instance_id}\\n{body}``.
The instance header selects the key, so one instance's secret cannot sign
for another. The timestamp is outside the body and is covered by the MAC.
"""

from __future__ import annotations

import hashlib
import hmac
import re
from datetime import datetime, timezone

from dsh_control_bridge.errors import SignatureError

_TIMESTAMP = re.compile(r"^[0-9]{10,12}$")
_INSTANCE = re.compile(r"^[a-z][a-z0-9-]{1,63}$")


def canonical_bytes(timestamp: str, instance_id: str, body: bytes) -> bytes:
    if not isinstance(timestamp, str) or not _TIMESTAMP.match(timestamp):
        raise SignatureError("signature rejected")
    if not isinstance(instance_id, str) or not _INSTANCE.match(instance_id):
        raise SignatureError("signature rejected")
    return b"v1\n" + timestamp.encode("ascii") + b"\n" + instance_id.encode("ascii") + b"\n" + body


def sign_request(secret: str, timestamp: str, instance_id: str, body: bytes) -> str:
    if not secret:
        raise SignatureError("signature rejected")
    digest = hmac.new(
        secret.encode("utf-8"),
        canonical_bytes(timestamp, instance_id, body),
        hashlib.sha256,
    ).hexdigest()
    return "sha256=" + digest


def verify_request(
    *,
    secret: str,
    timestamp: str | None,
    instance_id: str | None,
    body: bytes,
    signature: str | None,
    now: datetime,
    window_seconds: int,
) -> None:
    """Reject missing, stale, future, or mismatched signatures.

    Failure messages do not include the secret or say which check failed when
    that would distinguish an unknown instance from a bad MAC.
    """

    if not secret or not signature or not timestamp or not instance_id:
        raise SignatureError("signature rejected")
    try:
        signed = canonical_bytes(timestamp, instance_id, body)
    except SignatureError:
        raise SignatureError("signature rejected") from None
    stamp = int(timestamp)
    now_seconds = int(now.astimezone(timezone.utc).timestamp())
    if abs(now_seconds - stamp) > window_seconds:
        raise SignatureError("signature timestamp is outside the allowed window")
    expected = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()
    if not hmac.compare_digest("sha256=" + expected, signature.strip()):
        raise SignatureError("signature rejected")
