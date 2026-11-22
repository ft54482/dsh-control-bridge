"""Outbound notifications with an explicit mode and a stored outcome.

``off`` does not send and does not pretend that it did.
``file`` appends a redacted JSON line under the bridge data directory.
``webhook`` posts only to a host listed in config. A non-2xx response, a
refusal, or a connection error is stored as ``failed``.
"""

from __future__ import annotations

import json
from http.client import HTTPConnection, HTTPSConnection
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from dsh_control_bridge.config import NotifySettings
from dsh_control_bridge.redact import Redactor
from dsh_control_bridge.store import Store


class Notifier:
    def __init__(self, settings: NotifySettings, data_dir: Path | None, store: Store, redactor: Redactor):
        self.settings = settings
        self.data_dir = data_dir
        self.store = store
        self.redactor = redactor

    def emit(self, *, kind: str, task_id: str | None = None, event_id: str | None = None, detail: dict[str, Any] | None = None) -> dict[str, str]:
        if self.settings.mode == "off":
            return {"status": "disabled", "reason": "notifications are off"}
        payload = self.redactor.redact_obj(
            {"kind": kind, "task_id": task_id, "event_id": event_id, "detail": detail or {}}
        )
        try:
            if self.settings.mode == "file":
                self._write_file(payload)
                status, reason = "recorded", "appended to the local outbox"
            elif self.settings.mode == "webhook":
                status, reason = self._post(payload)
            else:
                status, reason = "failed", "unknown notify mode"
        except OSError as exc:
            status, reason = "failed", self.redactor.redact(exc.__class__.__name__)
        self.store.add_notification(
            kind=kind,
            status=status,
            reason=reason,
            task_id=task_id,
            event_id=event_id,
        )
        return {"status": status, "reason": reason}

    def _write_file(self, payload: dict[str, Any]) -> None:
        if self.data_dir is None:
            raise OSError("data directory is not set")
        path = (self.data_dir / self.settings.file_name).resolve()
        root = self.data_dir.resolve()
        if path.parent != root:
            raise OSError("notification file must stay in the data directory")
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")
            handle.flush()

    def _post(self, payload: dict[str, Any]) -> tuple[str, str]:
        parsed = urlparse(self.settings.webhook_url)
        host = parsed.hostname or ""
        if parsed.scheme not in {"http", "https"} or not host:
            return "failed", "webhook url is not http(s)"
        if parsed.username or parsed.password:
            return "failed", "webhook url must not contain credentials"
        if host not in self.settings.allowed_hosts:
            return "failed", "webhook host is not in allowed_hosts"
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        connection_type = HTTPSConnection if parsed.scheme == "https" else HTTPConnection
        connection = connection_type(host, port, timeout=2)
        try:
            connection.request(
                "POST",
                parsed.path or "/",
                body=body,
                headers={"Content-Type": "application/json"},
            )
            response = connection.getresponse()
            response.read()
            if 200 <= response.status < 300:
                return "delivered", f"http {response.status}"
            return "failed", f"http {response.status}"
        except OSError as exc:
            return "failed", self.redactor.redact(exc.__class__.__name__)
        finally:
            connection.close()
