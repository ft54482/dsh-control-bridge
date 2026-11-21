"""In-process dry-run adapter used by tests, the demo, and CI.

It never opens a socket. Issued session, ticket, and run ids are stored next
to the bridge database so a restarted process continues the same task instead
of starting a second one.
"""

from __future__ import annotations

import json
from pathlib import Path

from dsh_control_bridge.adapters.base import (
    CancelRequest,
    CancelResult,
    DispatchRequest,
    DispatchResult,
)
from dsh_control_bridge.errors import AdapterError, SimulatedCrash


class FakeAdapter:
    supports_send = True
    probe_items = ()

    def __init__(
        self,
        instance_id: str,
        state_path: Path,
        *,
        fail_remaining: int = 0,
        cancel_confirms: bool = True,
        crash_after_accept: bool = False,
    ):
        self.instance_id = instance_id
        self.state_path = state_path
        self.fail_remaining = fail_remaining
        self.cancel_confirms = cancel_confirms
        self.crash_after_accept = crash_after_accept
        self.calls: list[tuple[str, str]] = []
        self.starts = 0
        self._issued: dict[str, dict[str, str | None]] = {}
        self._load()

    def dispatch(self, request: DispatchRequest) -> DispatchResult:
        if request.instance_id != self.instance_id:
            raise AdapterError(
                f"fake adapter {self.instance_id} refused instance {request.instance_id}"
            )
        self.calls.append(("dispatch", request.task_id))
        existing = self._issued.get(request.task_id)
        if existing is not None:
            return _result(existing)
        if self.fail_remaining > 0:
            self.fail_remaining -= 1
            raise AdapterError("simulated failure")
        if request.executor == "ordinary_session":
            issued = {
                "session_id": request.session_id or f"sess_{request.task_id[-8:]}",
                "ticket_id": None,
                "run_id": None,
            }
        elif request.executor == "superagent":
            if request.session_id:
                raise AdapterError("superagent dispatch cannot resume an ordinary session id")
            issued = {
                "session_id": None,
                "ticket_id": f"tkt_{request.task_id[-8:]}",
                "run_id": f"run_{request.task_id[-8:]}",
            }
        else:
            raise AdapterError(f"unsupported executor {request.executor}")
        self._issued[request.task_id] = issued
        self.starts += 1
        crash = self.crash_after_accept
        self.crash_after_accept = False
        self._save()
        if crash:
            raise SimulatedCrash("process died after the fake adapter accepted the task")
        return _result(issued)

    def cancel(self, request: CancelRequest) -> CancelResult:
        if request.instance_id != self.instance_id:
            raise AdapterError(
                f"fake adapter {self.instance_id} refused instance {request.instance_id}"
            )
        self.calls.append(("cancel", request.task_id))
        if self.cancel_confirms:
            return CancelResult(confirmed=True, detail="fake adapter confirmed cancel")
        return CancelResult(confirmed=False, detail="fake adapter left cancel unconfirmed")

    def _load(self) -> None:
        if not self.state_path.is_file():
            return
        data = json.loads(self.state_path.read_text(encoding="utf-8"))
        self.starts = int(data.get("starts", 0))
        issued = data.get("issued", {})
        if isinstance(issued, dict):
            self._issued = {str(key): dict(value) for key, value in issued.items()}

    def _save(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"starts": self.starts, "issued": self._issued}
        temporary = self.state_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
        temporary.replace(self.state_path)


def _result(issued: dict[str, str | None]) -> DispatchResult:
    return DispatchResult(
        acked=True,
        session_id=issued.get("session_id"),
        ticket_id=issued.get("ticket_id"),
        run_id=issued.get("run_id"),
    )
