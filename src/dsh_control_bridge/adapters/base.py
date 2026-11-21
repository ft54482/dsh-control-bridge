"""Adapter contracts shared by the fake executor and the harness skeleton."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class DispatchRequest:
    task_id: str
    instance_id: str
    workspace: str
    executor: str
    title: str
    objective: str
    scope: str
    acceptance: str
    session_id: str | None
    parent_task_id: str | None


@dataclass(frozen=True)
class DispatchResult:
    acked: bool
    session_id: str | None = None
    ticket_id: str | None = None
    run_id: str | None = None


@dataclass(frozen=True)
class CancelRequest:
    task_id: str
    instance_id: str
    workspace: str
    executor: str
    session_id: str | None
    ticket_id: str | None
    run_id: str | None
    reason: str


@dataclass(frozen=True)
class CancelResult:
    confirmed: bool
    detail: str


class ExecutorAdapter(Protocol):
    instance_id: str
    supports_send: bool
    probe_items: tuple[str, ...]

    def dispatch(self, request: DispatchRequest) -> DispatchResult:
        """Start or resume work. Implementations must be idempotent on task_id."""

    def cancel(self, request: CancelRequest) -> CancelResult:
        """Ask the executor to stop. confirmed=False leaves the bridge unconfirmed."""
