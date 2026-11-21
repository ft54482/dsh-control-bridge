"""Task lifecycle: draft, send, ingest, review, cancel, and restart recovery."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from dsh_control_bridge.adapters.base import CancelRequest, DispatchRequest, DispatchResult
from dsh_control_bridge.adapters.fake import FakeAdapter
from dsh_control_bridge.adapters.harness import HarnessAdapter
from dsh_control_bridge.config import Config
from dsh_control_bridge.errors import (
    AdapterError,
    BridgeError,
    InvalidTransition,
    MandateRequired,
    NotFound,
    PayloadError,
    ProbeRequired,
    SignatureError,
    SimulatedCrash,
)
from dsh_control_bridge.models import (
    EVENT_TARGET_STATUS,
    TERMINAL_STATUSES,
    ExtractedEvent,
    IngestResult,
    Mandate,
    Task,
    can_transition,
    ensure_mandate_active,
    extract_event,
    format_utc,
    parse_mandate,
    utc_now,
)
from dsh_control_bridge.signing import signatures_match
from dsh_control_bridge.store import Store, new_id
from dsh_control_bridge.summary import render_summary

MAX_BODY_BYTES = 65_536
_DEFAULT_SCOPE = "不扩大范围，不发布，不合并，不增加预算。"
_DEFAULT_ACCEPTANCE = "由负责人对照证据验收。执行器自报完成不算交付。"


class Bridge:
    def __init__(self, config: Config, store: Store, adapters: dict[str, Any]):
        self.config = config
        self.store = store
        self.adapters = adapters
        self.recovery_notes: list[str] = []

    def dispatch(
        self,
        *,
        instance_id: str | None = None,
        workspace: str | None = None,
        executor: str | None = None,
        title: str | None = None,
        objective: str | None = None,
        scope: str = "",
        acceptance: str = "",
        mode: str = "draft",
        mandate: Mandate | None = None,
        task_id: str | None = None,
        session_id: str | None = None,
        parent_task_id: str | None = None,
    ) -> Task:
        if mode not in {"draft", "send"}:
            raise BridgeError("mode must be draft or send")
        if task_id:
            return self._send_existing(
                task_id,
                mode=mode,
                mandate=mandate,
                instance_id=instance_id,
                workspace=workspace,
                executor=executor,
            )
        if not instance_id or not workspace or not executor:
            raise BridgeError("dispatch requires instance, workspace, and executor")
        self.config.require_target(instance_id, workspace)
        if executor not in {"ordinary_session", "superagent"}:
            raise BridgeError("executor must be ordinary_session or superagent")
        if mode == "send":
            self._require_sendable(instance_id, mandate)
        title = _bounded(title, "title", 200)
        objective = _bounded(objective, "objective", 4000)
        scope = (scope or _DEFAULT_SCOPE).strip()
        acceptance = (acceptance or _DEFAULT_ACCEPTANCE).strip()
        if len(scope) > 4000 or len(acceptance) > 4000:
            raise BridgeError("scope or acceptance is too long")
        if executor == "superagent":
            session_id = None
        now = format_utc(utc_now())
        task = Task(
            task_id=new_id("task"),
            instance_id=instance_id,
            workspace=workspace,
            executor=executor,
            title=title,
            objective=objective,
            scope=scope,
            acceptance=acceptance,
            status="pending",
            delivery="drafted" if mode == "draft" else "queued",
            session_id=session_id,
            ticket_id=None,
            run_id=None,
            parent_task_id=parent_task_id,
            mandate=mandate.to_dict() if mandate else None,
            dispatch_mode=mode,
            retry_count=0,
            retry_limit=mandate.retry_limit if mandate else 0,
            cancel_confirmation=None,
            cancel_reason=None,
            last_error=None,
            created_at=now,
            updated_at=now,
        )
        self.store.insert_task(task)
        self.store.audit.write(
            "task.created",
            task_id=task.task_id,
            instance_id=instance_id,
            workspace=workspace,
            executor=executor,
            mode=mode,
        )
        if mode == "draft":
            return task
        return self._send(task, mandate)

    def status(self, task_id: str) -> dict[str, Any]:
        task = self._require_task(task_id)
        return {
            "task": task.to_dict(),
            "summaries": self.store.summaries_for(task_id),
            "attempts": self.store.attempts_for(task_id),
            "dead_letters": self.store.dead_letters_for_task(task_id),
        }

    def inbox(self, *, instance_id: str | None = None, workspace: str | None = None) -> dict[str, Any]:
        if instance_id and workspace:
            self.config.require_target(instance_id, workspace)
        elif instance_id and self.config.instance(instance_id) is None:
            self.config.require_target(instance_id, "")
        events = self.store.unacked_events(instance_id=instance_id, workspace=workspace)
        tasks = self.store.list_tasks(
            statuses=("pending", "awaiting_review", "awaiting_user"),
            instance_id=instance_id,
            workspace=workspace,
        )
        return {"events": events, "tasks": [task.to_dict() for task in tasks]}

    def acknowledge(self, event_id: str) -> dict[str, Any]:
        event = self.store.get_event(event_id)
        if event is None:
            raise NotFound(f"event {event_id} not found")
        self.store.acknowledge(event_id)
        self.store.audit.write("event.acknowledged", event_id=event_id)
        return {"event_id": event_id, "acked": True}

    def accept(self, task_id: str) -> Task:
        task = self._require_task(task_id)
        if not can_transition(task.status, "done"):
            raise InvalidTransition(f"cannot accept a task in status {task.status}")
        self.store.update_task(task_id, status="done")
        self.store.audit.write(
            "task.transition",
            task_id=task_id,
            detail={"from": task.status, "to": "done", "reason": "human_accept"},
        )
        return self._require_task(task_id)

    def draft_next(self, task_id: str) -> Task:
        parent = self._require_task(task_id)
        if parent.status != "awaiting_review":
            raise InvalidTransition("the next brief is drafted only from awaiting_review")
        existing = self.store.find_open_child(parent.task_id)
        if existing:
            return existing
        return self.dispatch(
            instance_id=parent.instance_id,
            workspace=parent.workspace,
            executor=parent.executor,
            title=f"下一阶段：{parent.title}"[:200],
            objective="在上一阶段待验收结果的基础上继续。范围与验收标准保持不变，除非负责人另行批准。",
            scope=parent.scope,
            acceptance=parent.acceptance,
            mode="draft",
            session_id=parent.session_id if parent.executor == "ordinary_session" else None,
            parent_task_id=parent.task_id,
        )

    def cancel(self, task_id: str, reason: str) -> Task:
        task = self._require_task(task_id)
        reason = _bounded(reason, "reason", 500)
        if task.status in TERMINAL_STATUSES:
            raise InvalidTransition(f"cannot cancel a task in status {task.status}")
        if not can_transition(task.status, "canceled"):
            raise InvalidTransition(f"cannot cancel a task in status {task.status}")
        remote = bool(task.session_id or task.ticket_id or task.run_id) or task.delivery in {
            "in_flight",
            "acked",
        }
        if not remote:
            self.store.update_task(
                task_id,
                status="canceled",
                delivery="drafted",
                cancel_confirmation="confirmed",
                cancel_reason=reason,
            )
            self.store.audit.write(
                "task.cancel",
                task_id=task_id,
                detail={"confirmation": "confirmed", "remote": False},
            )
            return self._require_task(task_id)

        adapter = self.adapters[task.instance_id]
        attempt_id = self.store.begin_attempt(task_id, "cancel")
        if not adapter.supports_send:
            self.store.finish_attempt(attempt_id, "failed", "remote cancel is a probe item")
            self.store.update_task(
                task_id,
                status="canceled",
                cancel_confirmation="unconfirmed",
                cancel_reason=reason,
                last_error="remote cancel is a probe item",
            )
            self.store.audit.write(
                "task.cancel",
                task_id=task_id,
                detail={"confirmation": "unconfirmed", "remote": False},
            )
            return self._require_task(task_id)
        try:
            result = adapter.cancel(_cancel_request(task, reason))
        except SimulatedCrash:
            raise
        except AdapterError as exc:
            self.store.finish_attempt(attempt_id, "failed", str(exc))
            self.store.update_task(
                task_id,
                status="canceled",
                cancel_confirmation="unconfirmed",
                cancel_reason=reason,
                last_error=str(exc),
            )
            self.store.audit.write(
                "task.cancel",
                task_id=task_id,
                detail={"confirmation": "unconfirmed", "error": str(exc)},
            )
            return self._require_task(task_id)
        confirmation = "confirmed" if result.confirmed else "unconfirmed"
        self.store.finish_attempt(attempt_id, "succeeded", result.detail)
        self.store.update_task(
            task_id,
            status="canceled",
            cancel_confirmation=confirmation,
            cancel_reason=reason,
            last_error=None if result.confirmed else result.detail,
        )
        self.store.audit.write(
            "task.cancel",
            task_id=task_id,
            detail={"confirmation": confirmation, "remote": True},
        )
        return self._require_task(task_id)

    def ingest_bytes(self, raw_body: bytes, signature: str | None) -> IngestResult:
        if len(raw_body) > MAX_BODY_BYTES:
            raise PayloadError("body is too large")
        self._verify(raw_body, signature)
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise PayloadError("body is not UTF-8 JSON") from exc
        digest = hashlib.sha256(raw_body).hexdigest()
        event = extract_event(payload)
        existing = self.store.get_event(event.event_id)
        if existing:
            self.store.bump_duplicate(event.event_id)
            self.store.audit.write("event.duplicate", event_id=event.event_id)
            task = self.store.get_task(existing["task_id"]) if existing.get("task_id") else None
            return IngestResult(
                event_id=event.event_id,
                duplicate=True,
                rejected=existing["disposition"] == "rejected",
                applied=False,
                reason=existing.get("reject_reason"),
                task_id=existing.get("task_id"),
                status=task.status if task else None,
                evidence_missing=event.evidence_missing,
            )
        problems = list(event.problems)
        problems.extend(self._target_problems(event))
        if problems:
            reason = "; ".join(problems)
            self._remember_event(event, digest, disposition="rejected", reason=reason, applied=False)
            self.store.add_dead_letter(event_id=event.event_id, reason=reason)
            self.store.audit.write("event.rejected", event_id=event.event_id, detail={"reason": reason})
            return IngestResult(
                event_id=event.event_id,
                duplicate=False,
                rejected=True,
                applied=False,
                reason=reason,
                task_id=None,
                status=None,
                evidence_missing=event.evidence_missing,
            )
        task = self._locate_task(event)
        applied = False
        status = task.status if task else None
        if task is not None:
            status, applied = self._apply_event(task, event)
        self._remember_event(
            event,
            digest,
            disposition="accepted",
            reason=None,
            applied=applied,
            task_id=task.task_id if task else event.task_id,
        )
        body = render_summary(event, task_status=status, applied=applied)
        bound_task = task.task_id if task else None
        self.store.insert_summary(
            task_id=bound_task,
            event_id=event.event_id,
            body=body,
            evidence_missing=event.evidence_missing,
        )
        self.store.audit.write(
            "event.accepted",
            event_id=event.event_id,
            task_id=bound_task,
            detail={"applied": applied, "event_type": event.event_type},
        )
        return IngestResult(
            event_id=event.event_id,
            duplicate=False,
            rejected=False,
            applied=applied,
            reason=None,
            task_id=bound_task,
            status=status,
            evidence_missing=event.evidence_missing,
        )

    def recover(self) -> list[str]:
        notes: list[str] = []
        for attempt in self.store.in_flight_attempts():
            task = self.store.get_task(attempt["task_id"])
            if task is None:
                self.store.finish_attempt(attempt["attempt_id"], "failed", "task missing")
                continue
            if attempt["kind"] == "cancel":
                self.store.finish_attempt(attempt["attempt_id"], "recovered", "cancel interrupted")
                if task.status != "canceled":
                    resumed = self.cancel(task.task_id, task.cancel_reason or "recovered cancel")
                    notes.append(f"{resumed.task_id}:cancel:{resumed.cancel_confirmation}")
                elif task.cancel_confirmation != "confirmed":
                    self.store.update_task(task.task_id, cancel_confirmation="unconfirmed")
                    notes.append(f"{task.task_id}:cancel:unconfirmed")
                continue
            self.store.finish_attempt(attempt["attempt_id"], "recovered", "dispatch interrupted")
            if task.status == "pending":
                self.store.update_task(task.task_id, delivery="queued", dispatch_mode="send")
        for task in self.store.list_tasks(statuses=("pending",), delivery="queued"):
            if task.dispatch_mode != "send" or not task.mandate:
                continue
            try:
                mandate = parse_mandate(task.mandate)
                ensure_mandate_active(mandate)
            except MandateRequired as exc:
                self._dead_letter(task, str(exc))
                notes.append(f"{task.task_id}:dead-letter")
                continue
            try:
                updated = self._send(self._require_task(task.task_id), mandate)
            except ProbeRequired as exc:
                self._dead_letter(self._require_task(task.task_id), str(exc))
                notes.append(f"{task.task_id}:probe")
                continue
            notes.append(f"{updated.task_id}:{updated.status}")
        return notes

    def _require_sendable(self, instance_id: str, mandate: Mandate | None) -> Mandate:
        if mandate is None:
            raise MandateRequired("send requires a mandate")
        ensure_mandate_active(mandate)
        if not mandate.allows("dispatch"):
            raise MandateRequired("mandate does not allow dispatch")
        adapter = self.adapters[instance_id]
        if not adapter.supports_send:
            raise ProbeRequired(adapter.probe_items)
        return mandate

    def _send_existing(
        self,
        task_id: str,
        *,
        mode: str,
        mandate: Mandate | None,
        instance_id: str | None,
        workspace: str | None,
        executor: str | None,
    ) -> Task:
        task = self._require_task(task_id)
        if instance_id and instance_id != task.instance_id:
            raise BridgeError("instance does not match the drafted task")
        if workspace and workspace != task.workspace:
            raise BridgeError("workspace does not match the drafted task")
        if executor and executor != task.executor:
            raise BridgeError("executor does not match the drafted task")
        if mode == "draft":
            return task
        if task.delivery not in {"drafted", "queued"} or task.status != "pending":
            raise BridgeError(f"task {task_id} is not a draft waiting for approval")
        if mandate is None:
            raise MandateRequired("send requires a mandate")
        self._require_sendable(task.instance_id, mandate)
        self.store.update_task(
            task_id,
            mandate_json=json.dumps(mandate.to_dict(), ensure_ascii=False, sort_keys=True),
            retry_limit=mandate.retry_limit,
            dispatch_mode="send",
            delivery="queued",
            objective=mandate.objective,
            scope=mandate.scope,
            acceptance=mandate.acceptance,
        )
        self.store.audit.write("task.mandate_accepted", task_id=task_id)
        return self._send(self._require_task(task_id), mandate)

    def _send(self, task: Task, mandate: Mandate | None) -> Task:
        if mandate is None:
            if not task.mandate:
                raise MandateRequired("send requires a mandate")
            mandate = parse_mandate(task.mandate)
        ensure_mandate_active(mandate)
        if not mandate.allows("dispatch"):
            raise MandateRequired("mandate does not allow dispatch")
        adapter = self.adapters[task.instance_id]
        if not adapter.supports_send:
            raise ProbeRequired(adapter.probe_items)
        max_tries = 1 + (mandate.retry_limit if mandate.allows("retry") else 0)
        remaining = max_tries - task.retry_count
        if remaining <= 0:
            return self._dead_letter(task, task.last_error or "retry limit reached")
        tries = 0
        while tries < remaining:
            tries += 1
            current = self._require_task(task.task_id)
            attempt_id = self.store.begin_attempt(task.task_id, "dispatch")
            self.store.update_task(task.task_id, delivery="in_flight", status="pending")
            try:
                result = adapter.dispatch(_dispatch_request(current))
            except SimulatedCrash:
                raise
            except AdapterError as exc:
                self.store.finish_attempt(attempt_id, "failed", str(exc))
                self.store.update_task(
                    task.task_id,
                    retry_count=current.retry_count + 1,
                    last_error=str(exc),
                    delivery="queued",
                    status="pending",
                )
                if tries >= remaining:
                    return self._dead_letter(self._require_task(task.task_id), str(exc))
                continue
            try:
                _validate_result(current, result)
            except AdapterError as exc:
                self.store.finish_attempt(attempt_id, "failed", str(exc))
                return self._dead_letter(self._require_task(task.task_id), str(exc))
            self.store.finish_attempt(attempt_id, "succeeded", "acked")
            self.store.update_task(
                task.task_id,
                status="running",
                delivery="acked",
                session_id=result.session_id,
                ticket_id=result.ticket_id,
                run_id=result.run_id,
                last_error=None,
            )
            self.store.audit.write(
                "task.transition",
                task_id=task.task_id,
                detail={"from": current.status, "to": "running", "reason": "dispatch_ack"},
            )
            return self._require_task(task.task_id)
        return self._dead_letter(self._require_task(task.task_id), "retry limit reached")

    def _dead_letter(self, task: Task, reason: str) -> Task:
        self.store.update_task(task.task_id, status="failed", delivery="dead_letter", last_error=reason)
        self.store.add_dead_letter(task_id=task.task_id, reason=reason)
        self.store.audit.write("task.dead_letter", task_id=task.task_id, detail={"reason": reason})
        return self._require_task(task.task_id)

    def _verify(self, raw_body: bytes, signature: str | None) -> None:
        if self.config.settings.allow_unsigned:
            return
        secret = os.environ.get(self.config.settings.webhook_secret_env, "")
        if not secret:
            raise SignatureError(
                f"set {self.config.settings.webhook_secret_env} or the bridge will refuse events"
            )
        if not signatures_match(secret, raw_body, signature):
            raise SignatureError("webhook signature does not match")

    def _target_problems(self, event: ExtractedEvent) -> list[str]:
        problems: list[str] = []
        if not event.instance_id:
            problems.append("instance_id is required")
        elif self.config.instance(event.instance_id) is None:
            problems.append(f"instance {event.instance_id!r} is not configured")
        elif not event.workspace:
            problems.append("workspace is required")
        elif event.workspace not in self.config.instances[event.instance_id].workspaces:
            problems.append(
                f"workspace {event.workspace!r} is not declared on instance {event.instance_id!r}"
            )
        return problems

    def _locate_task(self, event: ExtractedEvent) -> Task | None:
        if event.task_id:
            return self.store.get_task(event.task_id)
        for column, value in (
            ("session_id", event.session_id),
            ("ticket_id", event.ticket_id),
            ("run_id", event.run_id),
        ):
            if not value:
                continue
            matches = self.store.find_by(column, value)
            for task in matches:
                if task.status not in TERMINAL_STATUSES:
                    return task
            if matches:
                return matches[0]
        return None

    def _apply_event(self, task: Task, event: ExtractedEvent) -> tuple[str, bool]:
        if task.delivery == "drafted":
            self.store.audit.write(
                "event.ignored",
                event_id=event.event_id,
                task_id=task.task_id,
                detail={"reason": "task was not sent"},
            )
            return task.status, False
        if event.instance_id != task.instance_id or event.workspace != task.workspace:
            self.store.audit.write(
                "event.ignored",
                event_id=event.event_id,
                task_id=task.task_id,
                detail={"reason": "target does not match the task"},
            )
            return task.status, False
        if event.executor and event.executor != task.executor:
            self.store.audit.write(
                "event.ignored",
                event_id=event.event_id,
                task_id=task.task_id,
                detail={"reason": "executor does not match the task"},
            )
            return task.status, False
        if event.event_type == "cancel_ack":
            if task.status == "canceled" and task.cancel_confirmation != "confirmed":
                self.store.update_task(task.task_id, cancel_confirmation="confirmed")
                self.store.audit.write(
                    "task.cancel",
                    task_id=task.task_id,
                    detail={"confirmation": "confirmed", "reason": "cancel_ack"},
                )
                return "canceled", True
            self.store.audit.write(
                "event.ignored",
                event_id=event.event_id,
                task_id=task.task_id,
                detail={"reason": "cancel_ack without a local cancel"},
            )
            return task.status, False
        desired = EVENT_TARGET_STATUS[event.event_type or ""]
        if desired is None:
            return task.status, False
        if desired == task.status:
            return task.status, True
        if not can_transition(task.status, desired):
            self.store.audit.write(
                "event.ignored",
                event_id=event.event_id,
                task_id=task.task_id,
                detail={"reason": f"cannot move {task.status} -> {desired}"},
            )
            return task.status, False
        self.store.update_task(task.task_id, status=desired)
        self.store.audit.write(
            "task.transition",
            task_id=task.task_id,
            detail={"from": task.status, "to": desired, "reason": event.event_type},
        )
        return desired, True

    def _remember_event(
        self,
        event: ExtractedEvent,
        digest: str,
        *,
        disposition: str,
        reason: str | None,
        applied: bool,
        task_id: str | None = None,
    ) -> None:
        self.store.insert_event(
            event_id=event.event_id,
            event_type=event.event_type,
            occurred_at=event.occurred_at,
            instance_id=event.instance_id,
            workspace=event.workspace,
            executor=event.executor,
            task_id=task_id if task_id is not None else event.task_id,
            session_id=event.session_id,
            ticket_id=event.ticket_id,
            run_id=event.run_id,
            commit_sha=event.commit_sha,
            evidence=event.evidence,
            payload_sha256=digest,
            disposition=disposition,
            reject_reason=reason,
            applied=applied,
        )

    def _require_task(self, task_id: str) -> Task:
        task = self.store.get_task(task_id)
        if task is None:
            raise NotFound(f"task {task_id} not found")
        return task


def open_bridge(config: Config, data_dir: Path, *, adapters: dict[str, Any] | None = None) -> Bridge:
    data_dir.mkdir(parents=True, exist_ok=True)
    store = Store(data_dir / "bridge.sqlite", data_dir / "audit.jsonl")
    if adapters is None:
        adapters = {}
        for instance in config.instances.values():
            if instance.adapter == "fake":
                adapters[instance.id] = FakeAdapter(
                    instance.id,
                    data_dir / "adapters" / f"fake-{instance.id}.json",
                )
            else:
                adapters[instance.id] = HarnessAdapter(instance.id, instance.auth_env)
    bridge = Bridge(config, store, adapters)
    bridge.recovery_notes = bridge.recover()
    return bridge


def _dispatch_request(task: Task) -> DispatchRequest:
    return DispatchRequest(
        task_id=task.task_id,
        instance_id=task.instance_id,
        workspace=task.workspace,
        executor=task.executor,
        title=task.title,
        objective=task.objective,
        scope=task.scope,
        acceptance=task.acceptance,
        session_id=task.session_id,
        parent_task_id=task.parent_task_id,
    )


def _cancel_request(task: Task, reason: str) -> CancelRequest:
    return CancelRequest(
        task_id=task.task_id,
        instance_id=task.instance_id,
        workspace=task.workspace,
        executor=task.executor,
        session_id=task.session_id,
        ticket_id=task.ticket_id,
        run_id=task.run_id,
        reason=reason,
    )


def _validate_result(task: Task, result: DispatchResult) -> None:
    if not result.acked:
        raise AdapterError("adapter did not ack")
    if task.executor == "ordinary_session":
        if not result.session_id or result.ticket_id or result.run_id:
            raise AdapterError("ordinary_session ack must carry only session_id")
        if task.session_id and result.session_id != task.session_id:
            raise AdapterError("ordinary_session resumed a different session")
        return
    if task.executor == "superagent":
        if not result.ticket_id or not result.run_id or result.session_id:
            raise AdapterError("superagent ack must carry ticket_id and run_id")
        return
    raise AdapterError(f"unsupported executor {task.executor}")


def _bounded(value: str | None, name: str, limit: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise BridgeError(f"{name} is required")
    cleaned = value.strip()
    if len(cleaned) > limit:
        raise BridgeError(f"{name} is too long")
    return cleaned
