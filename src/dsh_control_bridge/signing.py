"""Shared-secret signatures for webhook bodies.

The secret is read from the environment at check time. It is never stored.
"""

from __future__ import annotations

import hashlib
import hmac


def signature_header(secret: str, body: bytes) -> str:
    if not secret:
        raise ValueError("webhook secret is empty")
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return "sha256=" + digest


def signatures_match(secret: str, body: bytes, header: str | None) -> bool:
    if not secret or not header:
        return False
    expected = signature_header(secret, body)
    return hmac.compare_digest(expected, header.strip())
