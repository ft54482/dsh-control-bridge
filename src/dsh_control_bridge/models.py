"""Shared records, the task state machine, and untrusted-event extraction."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any

from dsh_control_bridge.errors import MandateRequired, PayloadError

EXECUTORS = ("ordinary_session", "superagent")
STATUSES = (
    "pending",
    "running",
    "awaiting_review",
    "awaiting_user",
    "failed",
    "done",
    "canceled",
)
EVENT_TYPES = (
    "stage_submitted",
    "error",
    "awaiting_input",
    "exited",
    "started",
    "cancel_ack",
)
TERMINAL_STATUSES = frozenset({"failed", "done", "canceled"})

# Executor self-reports may move a task into review or failure.
# Only a person can move awaiting_review to done.
TRANSITIONS: dict[str, frozenset[str]] = {
    "pending": frozenset({"running", "failed", "canceled"}),
    "running": frozenset({"awaiting_review", "awaiting_user", "failed", "canceled"}),
    "awaiting_review": frozenset({"done", "canceled"}),
    "awaiting_user": frozenset({"running", "awaiting_review", "failed", "canceled"}),
    "failed": frozenset(),
    "done": frozenset(),
    "canceled": frozenset(),
}

EVENT_TARGET_STATUS = {
    "started": "running",
    "stage_submitted": "awaiting_review",
    "awaiting_input": "awaiting_user",
    "error": "failed",
    "exited": "failed",
    "cancel_ack": None,
}

_EVENT_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")
_SHA = re.compile(r"^[0-9a-f]{7,64}$")
_EVIDENCE = re.compile(r"^[A-Za-z0-9_./:-]{1,240}$")

MANDATE_KEYS = (
    "objective",
    "scope",
    "acceptance",
    "budget_cap",
    "retry_limit",
    "expires_at",
    "allowed_actions",
)
MANDATE_ACTIONS = frozenset({"dispatch", "retry"})


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def format_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_utc(value: str) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z") or "T" not in value:
        raise ValueError("timestamp must be UTC and end with Z")
    parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    if parsed.tzinfo is None:
        raise ValueError("timestamp must be UTC and end with Z")
    return parsed.astimezone(timezone.utc)


def can_transition(source: str, target: str) -> bool:
    return target in TRANSITIONS.get(source, frozenset())


@dataclass
class Mandate:
    objective: str
    scope: str
    acceptance: str
    budget_cap: str
    retry_limit: int
    expires_at: str
    allowed_actions: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["allowed_actions"] = list(self.allowed_actions)
        return data

    def allows(self, action: str) -> bool:
        return action in self.allowed_actions


def parse_mandate(raw: Any) -> Mandate:
    if not isinstance(raw, dict):
        raise MandateRequired("mandate must be an object")
    unknown = sorted(set(raw) - set(MANDATE_KEYS))
    if unknown:
        raise MandateRequired(f"unknown mandate fields: {', '.join(unknown)}")
    missing = [key for key in MANDATE_KEYS if key not in raw]
    if missing:
        raise MandateRequired(f"mandate is missing: {', '.join(missing)}")

    def text(key: str, limit: int) -> str:
        value = raw[key]
        if not isinstance(value, str) or not value.strip():
            raise MandateRequired(f"mandate.{key} must be a non-empty string")
        cleaned = value.strip()
        if len(cleaned) > limit:
            raise MandateRequired(f"mandate.{key} is too long")
        return cleaned

    actions = raw["allowed_actions"]
    if not isinstance(actions, list) or not actions or not all(isinstance(item, str) for item in actions):
        raise MandateRequired("mandate.allowed_actions must be a list of strings")
    normalized = tuple(dict.fromkeys(actions))
    alien = [item for item in normalized if item not in MANDATE_ACTIONS]
    if alien:
        raise MandateRequired(
            "mandate.allowed_actions only accepts dispatch and retry; "
            "release, budget changes, and scope changes are not bridge actions"
        )
    if "dispatch" not in normalized:
        raise MandateRequired("mandate.allowed_actions must include dispatch")
    retry_limit = raw["retry_limit"]
    if isinstance(retry_limit, bool) or not isinstance(retry_limit, int) or not 0 <= retry_limit <= 10:
        raise MandateRequired("mandate.retry_limit must be an integer from 0 to 10")
    expires_at = text("expires_at", 40)
    try:
        parse_utc(expires_at)
    except ValueError as exc:
        raise MandateRequired("mandate.expires_at must be UTC and end with Z") from exc
    return Mandate(
        objective=text("objective", 4000),
        scope=text("scope", 4000),
        acceptance=text("acceptance", 4000),
        budget_cap=text("budget_cap", 80),
        retry_limit=retry_limit,
        expires_at=expires_at,
        allowed_actions=normalized,
    )


def ensure_mandate_active(mandate: Mandate, *, now: datetime | None = None) -> None:
    current = now or utc_now()
    if parse_utc(mandate.expires_at) <= current:
        raise MandateRequired("mandate is expired")


@dataclass
class ExtractedEvent:
    event_id: str
    event_type: str | None
    occurred_at: str | None
    instance_id: str | None
    workspace: str | None
    executor: str | None
    task_id: str | None
    session_id: str | None
    ticket_id: str | None
    run_id: str | None
    commit_sha: str | None
    evidence: list[str]
    problems: list[str]

    @property
    def evidence_missing(self) -> bool:
        return not self.evidence


def _optional_id(payload: dict[str, Any], key: str) -> str | None:
    value = payload.get(key)
    if value is None:
        return None
    if isinstance(value, str) and _EVENT_ID.match(value):
        return value
    return None


def _clean_evidence(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    refs: list[str] = []
    for item in value[:20]:
        if not isinstance(item, str):
            continue
        if item.startswith(("/", "\\")) or item.startswith("~"):
            continue
        parts = item.split("/")
        if any(part in {"", ".", ".."} for part in parts):
            continue
        if not _EVIDENCE.match(item):
            continue
        refs.append(item)
    return refs


def extract_event(payload: Any) -> ExtractedEvent:
    """Copy the allow-listed fields. Extra keys are ignored, never executed."""

    if not isinstance(payload, dict):
        raise PayloadError("payload must be a JSON object")
    event_id = payload.get("event_id")
    if not isinstance(event_id, str) or not _EVENT_ID.match(event_id):
        raise PayloadError("event_id is required and must be a short token")

    problems: list[str] = []
    raw_type = payload.get("event_type")
    event_type = raw_type if raw_type in EVENT_TYPES else None
    if event_type is None:
        problems.append(f"unsupported event_type: {raw_type!r}")

    occurred_at = None
    if payload.get("occurred_at") is not None:
        try:
            occurred_at = format_utc(parse_utc(payload["occurred_at"]))
        except (ValueError, TypeError):
            occurred_at = None

    executor = _optional_id(payload, "executor")
    raw_executor = payload.get("executor")
    if raw_executor is not None and executor not in EXECUTORS:
        executor = None
        problems.append("executor is not ordinary_session or superagent")

    commit = payload.get("commit_sha")
    commit_sha = commit if isinstance(commit, str) and _SHA.match(commit) else None

    return ExtractedEvent(
        event_id=event_id,
        event_type=event_type,
        occurred_at=occurred_at,
        instance_id=_optional_id(payload, "instance_id"),
        workspace=_optional_id(payload, "workspace"),
        executor=executor,
        task_id=_optional_id(payload, "task_id"),
        session_id=_optional_id(payload, "session_id"),
        ticket_id=_optional_id(payload, "ticket_id"),
        run_id=_optional_id(payload, "run_id"),
        commit_sha=commit_sha,
        evidence=_clean_evidence(payload.get("evidence")),
        problems=problems,
    )


@dataclass
class Task:
    task_id: str
    instance_id: str
    workspace: str
    executor: str
    title: str
    objective: str
    scope: str
    acceptance: str
    status: str
    delivery: str
    session_id: str | None
    ticket_id: str | None
    run_id: str | None
    parent_task_id: str | None
    mandate: dict[str, Any] | None
    dispatch_mode: str
    retry_count: int
    retry_limit: int
    cancel_confirmation: str | None
    cancel_reason: str | None
    last_error: str | None
    created_at: str
    updated_at: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class IngestResult:
    event_id: str
    duplicate: bool
    rejected: bool
    applied: bool
    reason: str | None
    task_id: str | None
    status: str | None
    evidence_missing: bool

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["ok"] = not self.rejected
        return data
