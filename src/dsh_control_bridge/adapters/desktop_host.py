"""Desktop host plugin client.

Talks only to 127.0.0.1. The plugin, not this process, calls the official
session services inside Desktop. This module does not read a desktop token
or .credentials.yaml and does not create a replacement session.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from urllib.parse import urlencode

from dsh_control_bridge.adapters.base import CancelRequest, CancelResult, DispatchRequest, DispatchResult
from dsh_control_bridge.config import Instance
from dsh_control_bridge.errors import AdapterError
from dsh_control_bridge.redact import Redactor

_PROFILE = "desktop"


class DesktopHostAdapter:
    supports_send = True
    probe_items = ()

    def __init__(self, instance: Instance):
        self.instance_id = instance.id
        self.instance = instance
        self._report: dict[str, object] | None = None
        self._request_id: str | None = None

    def dispatch(self, request: DispatchRequest) -> DispatchResult:
        if request.instance_id != self.instance_id:
            raise AdapterError("desktop host refused a different instance")
        if request.executor != "ordinary_session":
            raise AdapterError("desktop host refuses superagent; that binding is not verified")
        if not self.instance.spawn:
            raise AdapterError("desktop host calls are disabled")
        if not request.session_id:
            raise AdapterError("desktop host resumes an authorized session and does not create a stand-in")
        grant = next((item for item in self.instance.session_grants if item.session_id == request.session_id), None)
        if grant is None or grant.workspace != request.workspace or grant.profile != _PROFILE or grant.access != "write":
            raise AdapterError("session is not an authorized desktop write")
        if grant.occupancy != "operator_confirmed_idle":
            raise AdapterError("external occupancy is not confirmed; refusing to write")
        workspace = self.instance.workspaces[request.workspace]
        if grant.cwd != workspace.cwd:
            raise AdapterError("session cwd does not match the authorized workspace")
        self._request_id = f"bridge-{request.task_id}"
        payload = {
            "workspace_id": workspace.host_workspace_id,
            "session_id": request.session_id,
            "profile": _PROFILE,
            "request_id": self._request_id,
            "text": request.objective,
        }
        body = self._call("POST", "/v1/resume", payload)
        if body.get("session_id") != request.session_id or body.get("accepted") is not True:
            raise AdapterError(str(body.get("reason") or "desktop resume was not accepted"))
        if body.get("model_selection") != "session_recorded_not_overridden":
            raise AdapterError("desktop host changed the model selection")
        text = Redactor().redact(str(body.get("text") or ""))
        final = body.get("final") if isinstance(body.get("final"), dict) else {}
        reason = final.get("reason") if isinstance(final.get("reason"), dict) else {}
        self._report = {
            "source": "desktop_session",
            "session_id": request.session_id,
            "request_id": self._request_id,
            "kind": reason.get("kind"),
            "text": text,
        }
        return DispatchResult(acked=True, session_id=request.session_id)

    def take_host_report(self) -> dict[str, object] | None:
        report = self._report
        self._report = None
        return report

    def cancel(self, request: CancelRequest) -> CancelResult:
        if not self._request_id or request.task_id not in self._request_id:
            return CancelResult(confirmed=False, detail="no bridge desktop request to cancel")
        try:
            body = self._call("POST", "/v1/cancel", {"request_id": self._request_id})
        except AdapterError as exc:
            return CancelResult(confirmed=False, detail=str(exc))
        if body.get("killed_desktop") is True:
            return CancelResult(confirmed=False, detail="refusing a cancel that would stop Desktop")
        if body.get("confirmed") is True:
            return CancelResult(confirmed=True, detail="aborted the bridge request only")
        return CancelResult(confirmed=False, detail="desktop request was not running")

    def history(self, session_id: str, *, offset: int, limit: int) -> dict[str, object]:
        grant = next((item for item in self.instance.session_grants if item.session_id == session_id), None)
        if grant is None:
            raise AdapterError("unknown session id")
        query = urlencode({"session_id": session_id, "offset": offset, "limit": limit})
        body = self._call("GET", f"/v1/history?{query}", None)
        if body.get("source") != "desktop_session":
            raise AdapterError("history source is not the desktop session service")
        return body

    def _call(self, method: str, path: str, payload: dict[str, object] | None) -> dict[str, object]:
        host = self.instance.host_bind
        if host not in {"127.0.0.1", "localhost"}:
            raise AdapterError("desktop host bind is not loopback")
        secret = os.environ.get(self.instance.host_secret_env, "")
        if len(secret) < 32:
            raise AdapterError("desktop host secret is missing")
        url = f"http://{host}:{self.instance.host_port}{path}"
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.instance.timeout_seconds or 5) as response:
                parsed = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                parsed = {"reason": "host_error"}
            if isinstance(parsed, dict) and parsed.get("accepted") is False:
                raise AdapterError(str(parsed.get("reason") or "desktop host rejected the call")) from None
            raise AdapterError("desktop host rejected the call") from None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise AdapterError("desktop host is unreachable") from exc
        if not isinstance(parsed, dict):
            raise AdapterError("desktop host returned an unusable body")
        return parsed
