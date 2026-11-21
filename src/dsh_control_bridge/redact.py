"""Strip secret-shaped text before it reaches disk, the terminal, or a notification."""

from __future__ import annotations

import re
from typing import Any

_PATTERNS = (
    re.compile(r"sk-[A-Za-z0-9_\-]{8,}"),
    re.compile(r"ghp_[A-Za-z0-9]{8,}"),
    re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._\-]{8,}"),
    re.compile(r"(?i)\b(token|secret|password|api_key)\s*[=:]\s*\S+"),
)


class Redactor:
    def __init__(self) -> None:
        self._secrets: list[str] = []

    def add(self, value: str | None) -> None:
        if not value or len(value) < 8:
            return
        if value not in self._secrets:
            self._secrets.append(value)

    def redact(self, text: str) -> str:
        cleaned = text
        for secret in self._secrets:
            cleaned = cleaned.replace(secret, "[redacted]")
        for pattern in _PATTERNS:
            cleaned = pattern.sub("[redacted]", cleaned)
        return cleaned

    def redact_obj(self, value: Any) -> Any:
        if isinstance(value, str):
            return self.redact(value)
        if isinstance(value, dict):
            return {str(key): self.redact_obj(item) for key, item in value.items()}
        if isinstance(value, list):
            return [self.redact_obj(item) for item in value]
        if isinstance(value, tuple):
            return [self.redact_obj(item) for item in value]
        return value
