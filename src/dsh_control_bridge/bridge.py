"""Task lifecycle: draft, send, ingest, review, cancel, and restart recovery."""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from dsh_control_bridge.adapters.base import CancelRequest, DispatchRequest, DispatchResult
from dsh_control_bridge.adapters.fake import FakeAdapter
from dsh_control_bridge.adapters.harness import HarnessAdapter
from dsh_control_bridge.adapters.desktop_host import DesktopHostAdapter
from dsh_control_bridge.adapters.headless_cli import HeadlessCliAdapter
from dsh_control_bridge.config import Config, dev_unsigned
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
    TargetRejected,
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
    open_mandate,
    pack_mandate,
    utc_now,
)
from dsh_control_bridge.notify import Notifier
from dsh_control_bridge.redact import Redactor
from dsh_control_bridge.signing import verify_request
from dsh_control_bridge.store import Store, new_id
from dsh_control_bridge.summary import render_summary

MAX_BODY_BYTES = 65_536
_DEFAULT_SCOPE = "不扩大范围，不发布，不合并，不增加预算。"
_DEFAULT_ACCEPTANCE = "由负责人对照证据验收。执行器自报完成不算交付。"


class Bridge:
    def __init__(
        self,
        config: Config,
        store: Store,
        adapters: dict[str, Any],
        data_dir: Path | None = None,
    ):
        self.config = config
        self.store = store
        self.adapters = adapters
        self.data_dir = data_dir
        self.recovery_notes: list[str] = []
        self.redactor = Redactor()
        for instance in config.instances.values():
            self.redactor.add(os.environ.get(instance.event_secret_env, ""))
            self.redactor.add(os.environ.get(instance.auth_env, ""))
        store.audit.redactor = self.redactor
        self.notifier = Notifier(config.notify, data_dir, store, self.redactor)

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
        mandate_source: str = "operator_file",
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
                mandate_source=mandate_source,
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
            self._require_sendable(instance_id, mandate, task_id=None, session_id=session_id)
            if mandate is None or not mandate.matches_target(
                instance_id=instance_id, workspace=workspace, executor=executor
            ):
                raise MandateRequired("mandate target does not match the dispatch target")
            objective = mandate.objective
            scope = mandate.scope
            acceptance = mandate.acceptance
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
            mandate=pack_mandate(mandate, mandate_source) if mandate else None,
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
            "notifications": self.store.notifications_for(task_id),
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
            self._notify("canceled", task_id)
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
            self._notify("canceled", task_id)
            return self._require_task(task_id)
        try:
            result = adapter.cancel(_cancel_request(task, reason))
        except SimulatedCrash:
            raise
        except AdapterError as exc:
            safe = self._safe(str(exc))
            self.store.finish_attempt(attempt_id, "failed", safe)
            self.store.update_task(
                task_id,
                status="canceled",
                cancel_confirmation="unconfirmed",
                cancel_reason=reason,
                last_error=safe,
            )
            self.store.audit.write(
                "task.cancel",
                task_id=task_id,
                detail={"confirmation": "unconfirmed", "error": safe},
            )
            self._notify("canceled", task_id)
            return self._require_task(task_id)
        confirmation = "confirmed" if result.confirmed else "unconfirmed"
        self.store.finish_attempt(attempt_id, "succeeded", result.detail)
        self.store.update_task(
            task_id,
            status="canceled",
            cancel_confirmation=confirmation,
            cancel_reason=reason,
            last_error=None if result.confirmed else self._safe(result.detail),
        )
        self.store.audit.write(
            "task.cancel",
            task_id=task_id,
            detail={"confirmation": confirmation, "remote": True},
        )
        self._notify("canceled", task_id)
        return self._require_task(task_id)

    def recover(self) -> list[str]:
        notes: list[str] = []
        for attempt in self.store.in_flight_attempts():
            task = self.store.get_task(attempt["task_id"])
            if task is None:
                self.store.finish_attempt_if(attempt["attempt_id"], "in_flight", "failed", "task missing")
                continue
            if not self.store.finish_attempt_if(
                attempt["attempt_id"], "in_flight", "recovered", f"{attempt['kind']} interrupted"
            ):
                continue
            if attempt["kind"] == "cancel":
                if task.status != "canceled":
                    resumed = self.cancel(task.task_id, task.cancel_reason or "recovered cancel")
                    notes.append(f"{resumed.task_id}:cancel:{resumed.cancel_confirmation}")
                elif task.cancel_confirmation != "confirmed":
                    self.store.update_task(task.task_id, cancel_confirmation="unconfirmed")
                    notes.append(f"{task.task_id}:cancel:unconfirmed")
                continue
            if task.status == "pending" and task.delivery == "in_flight":
                self.store.update_task(task.task_id, delivery="queued", dispatch_mode="send")
        for task in self.store.list_tasks(statuses=("pending",), delivery="queued"):
            if task.dispatch_mode != "send" or not task.mandate:
                continue
            try:
                mandate, _source = open_mandate(task.mandate)
                ensure_mandate_active(mandate)
                if not mandate.matches_target(
                    instance_id=task.instance_id,
                    workspace=task.workspace,
                    executor=task.executor,
                    task_id=task.task_id,
                ):
                    raise MandateRequired("mandate target does not match the task")
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
            except BridgeError as exc:
                if "already in progress" in str(exc):
                    notes.append(f"{task.task_id}:in-progress")
                    continue
                raise
            notes.append(f"{updated.task_id}:{updated.status}")
        return notes

    def _require_sendable(
        self,
        instance_id: str,
        mandate: Mandate | None,
        *,
        task_id: str | None,
        session_id: str | None = None,
    ) -> Mandate:
        if mandate is None:
            raise MandateRequired("send requires a mandate")
        ensure_mandate_active(mandate)
        instance = self.config.instance(instance_id)
        shared_resume = (
            instance is not None
            and instance.adapter == "headless_cli"
            and instance.home_mode == "shared"
            and bool(session_id)
        )
        desktop_resume = instance is not None and instance.adapter == "desktop_host" and bool(session_id)
        if shared_resume or desktop_resume:
            if not mandate.allows("resume"):
                raise MandateRequired("resume requires mandate action resume")
            if mandate.session_id != session_id:
                raise MandateRequired("mandate.session_id does not match the resume target")
        elif not mandate.allows("dispatch"):
            raise MandateRequired("mandate does not allow dispatch")
        if not mandate.matches_target(
            instance_id=instance_id,
            workspace=mandate.workspace,
            executor=mandate.executor,
            task_id=task_id,
        ):
            raise MandateRequired("mandate target does not match the dispatch target")
        self.config.require_target(mandate.instance_id, mandate.workspace)
        if mandate.instance_id != instance_id:
            raise MandateRequired("mandate instance does not match the dispatch target")
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
        mandate_source: str,
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
        self._require_sendable(task.instance_id, mandate, task_id=task.task_id, session_id=task.session_id)
        if not mandate.matches_target(
            instance_id=task.instance_id,
            workspace=task.workspace,
            executor=task.executor,
            task_id=task.task_id,
        ):
            raise MandateRequired("mandate target does not match the drafted task")
        packed = pack_mandate(mandate, mandate_source)
        self.store.update_task(
            task_id,
            mandate_json=json.dumps(packed, ensure_ascii=False, sort_keys=True),
            retry_limit=mandate.retry_limit,
            dispatch_mode="send",
            delivery="queued",
            objective=mandate.objective,
            scope=mandate.scope,
            acceptance=mandate.acceptance,
        )
        self.store.audit.write(
            "task.mandate_accepted",
            task_id=task_id,
            detail={"source": mandate_source, "sha256": packed["sha256"]},
        )
        return self._send(self._require_task(task_id), mandate)

    def _send(self, task: Task, mandate: Mandate | None) -> Task:
        if mandate is None:
            if not task.mandate:
                raise MandateRequired("send requires a mandate")
            mandate, _source = open_mandate(task.mandate)
        ensure_mandate_active(mandate)
        self._require_sendable(
            task.instance_id,
            mandate,
            task_id=task.task_id,
            session_id=task.session_id,
        )
        if not mandate.matches_target(
            instance_id=task.instance_id,
            workspace=task.workspace,
            executor=task.executor,
            task_id=task.task_id,
        ):
            raise MandateRequired("mandate target does not match the task")
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
            if not self.store.claim_delivery(task.task_id, ("drafted", "queued"), "in_flight"):
                current = self._require_task(task.task_id)
                if current.status == "running" and current.delivery == "acked":
                    return current
                raise BridgeError("dispatch already in progress")
            attempt_id = self.store.begin_attempt(task.task_id, "dispatch")
            try:
                result = adapter.dispatch(_dispatch_request(current))
            except SimulatedCrash:
                raise
            except AdapterError as exc:
                safe = self._safe(str(exc))
                self.store.finish_attempt(attempt_id, "failed", safe)
                self.store.update_task(
                    task.task_id,
                    retry_count=current.retry_count + 1,
                    last_error=safe,
                    delivery="queued",
                    status="pending",
                )
                if tries >= remaining:
                    return self._dead_letter(self._require_task(task.task_id), safe)
                continue
            try:
                _validate_result(current, result)
            except AdapterError as exc:
                safe = self._safe(str(exc))
                self.store.finish_attempt(attempt_id, "failed", safe)
                return self._dead_letter(self._require_task(task.task_id), safe)
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
            report = None
            take = getattr(adapter, "take_host_report", None)
            if take is not None:
                report = take()
            if report:
                self.record_host_completion(task.task_id, report)
            return self._require_task(task.task_id)
        return self._dead_letter(self._require_task(task.task_id), "retry limit reached")

    def _dead_letter(self, task: Task, reason: str) -> Task:
        safe = self._safe(reason)
        self.store.update_task(task.task_id, status="failed", delivery="dead_letter", last_error=safe)
        self.store.add_dead_letter(task_id=task.task_id, reason=safe)
        self.store.audit.write("task.dead_letter", task_id=task.task_id, detail={"reason": safe})
        self._notify("failed", task.task_id)
        return self._require_task(task.task_id)

    def _safe(self, text: str) -> str:
        return self.redactor.redact(text)[:500]

    def _notify(self, kind: str, task_id: str, event_id: str | None = None) -> None:
        self.notifier.emit(kind=kind, task_id=task_id, event_id=event_id, detail={"kind": kind})

    def ingest_bytes(
        self,
        raw_body: bytes,
        *,
        signature: str | None,
        timestamp: str | None,
        instance_id: str | None,
        now: datetime | None = None,
    ) -> IngestResult:
        if len(raw_body) > MAX_BODY_BYTES:
            raise PayloadError("body is too large")
        current = now or utc_now()
        self._verify(raw_body, signature=signature, timestamp=timestamp, instance_id=instance_id, now=current)
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise PayloadError("body is not UTF-8 JSON") from exc
        event = extract_event(payload)
        if not dev_unsigned(self.config.settings) and event.instance_id != instance_id:
            raise SignatureError("signature rejected")
        digest = hashlib.sha256(raw_body).hexdigest()
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
                evidence_missing=not json.loads(existing["evidence_json"] or "[]"),
            )
        problems = list(event.problems)
        problems.extend(self._target_problems(event))
        if problems:
            reason = "; ".join(problems)
            claimed = self.store.begin_event(
                **self._event_fields(event, digest, disposition="rejected", reason=reason, applied=False)
            )
            if claimed == "duplicate":
                return self._duplicate_result(event)
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
        claimed = self.store.begin_event(
            **self._event_fields(
                event,
                digest,
                disposition="accepted",
                reason=None,
                applied=False,
                task_id=task.task_id if task else None,
            )
        )
        if claimed == "duplicate":
            return self._duplicate_result(event)
        applied = False
        status = task.status if task else None
        if task is not None:
            status, applied = self._apply_event(task, event)
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
        if applied and status in {"awaiting_review", "failed", "canceled"}:
            self._notify(status, bound_task or "", event.event_id)
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

    def _verify(
        self,
        raw_body: bytes,
        *,
        signature: str | None,
        timestamp: str | None,
        instance_id: str | None,
        now: datetime,
    ) -> None:
        if dev_unsigned(self.config.settings):
            return
        instance = self.config.instance(instance_id or "")
        secret = ""
        if instance is not None:
            secret = os.environ.get(instance.event_secret_env, "")
        verify_request(
            secret=secret,
            timestamp=timestamp,
            instance_id=instance_id,
            body=raw_body,
            signature=signature,
            now=now,
            window_seconds=self.config.settings.signature_window_seconds,
        )

    def _event_fields(
        self,
        event: ExtractedEvent,
        digest: str,
        *,
        disposition: str,
        reason: str | None,
        applied: bool,
        task_id: str | None = None,
    ) -> dict[str, Any]:
        return {
            "event_id": event.event_id,
            "event_type": event.event_type,
            "occurred_at": event.occurred_at,
            "instance_id": event.instance_id,
            "workspace": event.workspace,
            "executor": event.executor,
            "task_id": task_id,
            "session_id": event.session_id,
            "ticket_id": event.ticket_id,
            "run_id": event.run_id,
            "commit_sha": event.commit_sha,
            "evidence": event.evidence,
            "payload_sha256": digest,
            "disposition": disposition,
            "reject_reason": reason,
            "applied": applied,
        }

    def _duplicate_result(self, event: ExtractedEvent) -> IngestResult:
        self.store.audit.write("event.duplicate", event_id=event.event_id)
        existing = self.store.get_event(event.event_id) or {}
        task = self.store.get_task(existing["task_id"]) if existing.get("task_id") else None
        evidence = json.loads(existing.get("evidence_json") or "[]")
        return IngestResult(
            event_id=event.event_id,
            duplicate=True,
            rejected=existing.get("disposition") == "rejected",
            applied=False,
            reason=existing.get("reject_reason"),
            task_id=existing.get("task_id"),
            status=task.status if task else None,
            evidence_missing=not evidence,
        )

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
        def same(task: Task) -> bool:
            return task.instance_id == event.instance_id and task.workspace == event.workspace

        if event.task_id:
            task = self.store.get_task(event.task_id)
            return task if task is not None and same(task) else None
        for column, value in (
            ("session_id", event.session_id),
            ("ticket_id", event.ticket_id),
            ("run_id", event.run_id),
        ):
            if not value:
                continue
            matches = [task for task in self.store.find_by(column, value) if same(task)]
            for task in matches:
                if task.status not in TERMINAL_STATUSES:
                    return task
            if matches:
                return matches[0]
        return None

    def _apply_event(self, task: Task, event: ExtractedEvent) -> tuple[str, bool]:
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
        if not _event_may_touch(task, event):
            self.store.audit.write(
                "event.ignored",
                event_id=event.event_id,
                task_id=task.task_id,
                detail={"reason": "event cannot grant execution or acceptance"},
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
        if desired is None or desired == "done":
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
        before = {
            "objective": task.objective,
            "scope": task.scope,
            "acceptance": task.acceptance,
            "mandate": task.mandate,
        }
        self.store.update_task(task.task_id, status=desired)
        after = self._require_task(task.task_id)
        if (
            after.objective != before["objective"]
            or after.scope != before["scope"]
            or after.acceptance != before["acceptance"]
            or after.mandate != before["mandate"]
        ):
            raise BridgeError("event changed mandate or scope")
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

    def session_catalog(self, instance_id: str) -> dict[str, Any]:
        from dsh_control_bridge.home_access import catalog

        instance = self.config.instance(instance_id)
        if instance is None:
            self.config.require_target(instance_id, "")
            raise TargetRejected(f"instance {instance_id!r} is not configured")
        recorded: dict[str, dict[str, str]] = {}
        adapter = self.adapters.get(instance_id)
        recorded_fn = getattr(adapter, "recorded_sessions", None)
        if recorded_fn is not None:
            recorded = recorded_fn()
        workspaces = [
            {
                "name": workspace.name,
                "cwd": workspace.cwd,
                "allow_new_session": workspace.allow_new_session,
                "occupancy": workspace.occupancy,
            }
            for workspace in instance.workspaces.values()
        ]
        return catalog(
            instance_id=instance.id,
            home_mode=instance.home_mode,
            dsh_home=instance.dsh_home,
            credential_mode=instance.credential_mode,
            workspaces=workspaces,
            grants=instance.session_grants,
            recorded=recorded,
        )

    def session_history(self, instance_id: str, session_id: str, *, offset: int = 0, limit: int = 20) -> dict[str, Any]:
        from dsh_control_bridge.home_access import read_transcript

        listed = self.session_catalog(instance_id)
        known = {item["session_id"] for item in listed["sessions"]}
        if session_id not in known:
            raise AdapterError("unknown session id")
        if self.data_dir is None:
            raise AdapterError("history needs a bridge data directory")
        return read_transcript(self.data_dir, instance_id, session_id, offset=offset, limit=limit)

    def record_host_completion(self, task_id: str, report: dict[str, Any]) -> dict[str, Any]:
        """Move a desktop host result to review. The text cannot grant access."""

        task = self._require_task(task_id)
        if report.get("source") != "desktop_session" or report.get("session_id") != task.session_id:
            raise AdapterError("completion does not match the authorized desktop session")
        if report.get("kind") != "completed":
            raise AdapterError("desktop run has no completed final")
        text = self.redactor.redact(str(report.get("text") or ""))
        digest = hashlib.sha256(f"{task.task_id}:{report.get('request_id')}".encode("utf-8")).hexdigest()
        event_id = f"host.{digest[:32]}"
        state = self.store.begin_event(
            event_id=event_id,
            event_type="stage_submitted",
            occurred_at=format_utc(utc_now()),
            instance_id=task.instance_id,
            workspace=task.workspace,
            executor=task.executor,
            task_id=task.task_id,
            session_id=task.session_id,
            ticket_id=None,
            run_id=None,
            commit_sha=None,
            evidence=[],
            payload_sha256=digest,
            disposition="accepted",
            reject_reason=None,
            applied=False,
        )
        if state == "duplicate":
            current = self._require_task(task_id)
            return {"duplicate": True, "status": current.status, "authorization_changed": False, "text": text}
        event = ExtractedEvent(
            event_id=event_id,
            event_type="stage_submitted",
            occurred_at=format_utc(utc_now()),
            instance_id=task.instance_id,
            workspace=task.workspace,
            executor=task.executor,
            task_id=task.task_id,
            session_id=task.session_id,
            ticket_id=None,
            run_id=None,
            commit_sha=None,
            evidence=[],
            problems=[],
        )
        status, applied = self._apply_event(task, event)
        return {
            "duplicate": False,
            "applied": applied,
            "status": status,
            "authorization_changed": False,
            "text": text,
        }

    def home_plan(self, instance_id: str) -> dict[str, Any]:
        from dsh_control_bridge.home_access import non_secret_operator_fields, surface_matrix

        instance = self.config.instance(instance_id)
        if instance is None:
            self.config.require_target(instance_id, "")
            raise TargetRejected(f"instance {instance_id!r} is not configured")
        return {
            "instance_id": instance.id,
            "home_mode": instance.home_mode,
            "credential_mode": instance.credential_mode,
            "spawn": instance.spawn,
            "timeout_seconds": instance.timeout_seconds,
            "official_patch": instance.credential_mode == "official_store",
            "copies_credentials": False,
            "reads_credentials": False,
            "real_model_call": False,
            "operator_fields": non_secret_operator_fields(),
            "surfaces": surface_matrix(),
        }

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
            elif instance.adapter == "desktop_host":
                adapters[instance.id] = DesktopHostAdapter(instance)
            elif instance.adapter == "headless_cli":
                adapters[instance.id] = HeadlessCliAdapter(
                    instance,
                    data_dir / "adapters" / f"headless-{instance.id}.json",
                    data_dir=data_dir,
                )
            else:
                adapters[instance.id] = HarnessAdapter(instance.id, instance.auth_env)
    bridge = Bridge(config, store, adapters, data_dir=data_dir)
    bridge.recovery_notes = bridge.recover()
    return bridge


def _event_may_touch(task: Task, event: ExtractedEvent) -> bool:
    """Events never accept work, never send work, and never move a draft."""

    if event.event_type == "cancel_ack":
        return task.status == "canceled"
    if task.delivery == "acked":
        return True
    return task.delivery == "in_flight" and event.event_type in {"started", "error", "exited"}


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
