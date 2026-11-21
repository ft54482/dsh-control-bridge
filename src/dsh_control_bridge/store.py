"""SQLite task store and an append-only JSONL audit log."""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from pathlib import Path
from typing import Any

from dsh_control_bridge.models import Task, format_utc, utc_now

_TASK_UPDATES = frozenset(
    {
        "title",
        "objective",
        "scope",
        "acceptance",
        "status",
        "delivery",
        "session_id",
        "ticket_id",
        "run_id",
        "mandate_json",
        "dispatch_mode",
        "retry_count",
        "retry_limit",
        "cancel_confirmation",
        "cancel_reason",
        "last_error",
    }
)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


class AuditLog:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def write(self, kind: str, **detail: Any) -> None:
        record = {"ts": format_utc(utc_now()), "kind": kind, **detail}
        line = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        with self._lock:
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
                handle.flush()


class Store:
    def __init__(self, db_path: Path, audit_path: Path):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.db_path = db_path
        self.audit = AuditLog(audit_path)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._migrate()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def _migrate(self) -> None:
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS events (
                event_id TEXT PRIMARY KEY,
                event_type TEXT,
                occurred_at TEXT,
                received_at TEXT NOT NULL,
                instance_id TEXT,
                workspace TEXT,
                executor TEXT,
                task_id TEXT,
                session_id TEXT,
                ticket_id TEXT,
                run_id TEXT,
                commit_sha TEXT,
                evidence_json TEXT NOT NULL,
                payload_sha256 TEXT NOT NULL,
                disposition TEXT NOT NULL,
                reject_reason TEXT,
                acked INTEGER NOT NULL DEFAULT 0,
                duplicate_count INTEGER NOT NULL DEFAULT 0,
                applied INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS tasks (
                task_id TEXT PRIMARY KEY,
                instance_id TEXT NOT NULL,
                workspace TEXT NOT NULL,
                executor TEXT NOT NULL,
                title TEXT NOT NULL,
                objective TEXT NOT NULL,
                scope TEXT NOT NULL,
                acceptance TEXT NOT NULL,
                status TEXT NOT NULL,
                delivery TEXT NOT NULL,
                session_id TEXT,
                ticket_id TEXT,
                run_id TEXT,
                parent_task_id TEXT,
                mandate_json TEXT,
                dispatch_mode TEXT NOT NULL,
                retry_count INTEGER NOT NULL DEFAULT 0,
                retry_limit INTEGER NOT NULL DEFAULT 0,
                cancel_confirmation TEXT,
                cancel_reason TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS attempts (
                attempt_id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                detail TEXT
            );
            CREATE TABLE IF NOT EXISTS dead_letters (
                dead_letter_id TEXT PRIMARY KEY,
                task_id TEXT,
                event_id TEXT,
                reason TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS summaries (
                summary_id TEXT PRIMARY KEY,
                task_id TEXT,
                event_id TEXT,
                body TEXT NOT NULL,
                evidence_missing INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
            CREATE INDEX IF NOT EXISTS idx_events_acked ON events(acked);
            """
        )
        self._conn.commit()

    def insert_task(self, task: Task) -> None:
        mandate_json = json.dumps(task.mandate, ensure_ascii=False, sort_keys=True) if task.mandate else None
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO tasks (
                    task_id, instance_id, workspace, executor, title, objective, scope,
                    acceptance, status, delivery, session_id, ticket_id, run_id,
                    parent_task_id, mandate_json, dispatch_mode, retry_count, retry_limit,
                    cancel_confirmation, cancel_reason, last_error, created_at, updated_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    task.task_id,
                    task.instance_id,
                    task.workspace,
                    task.executor,
                    task.title,
                    task.objective,
                    task.scope,
                    task.acceptance,
                    task.status,
                    task.delivery,
                    task.session_id,
                    task.ticket_id,
                    task.run_id,
                    task.parent_task_id,
                    mandate_json,
                    task.dispatch_mode,
                    task.retry_count,
                    task.retry_limit,
                    task.cancel_confirmation,
                    task.cancel_reason,
                    task.last_error,
                    task.created_at,
                    task.updated_at,
                ),
            )
            self._conn.commit()

    def update_task(self, task_id: str, **fields: Any) -> None:
        unknown = set(fields) - _TASK_UPDATES
        if unknown:
            raise KeyError(f"cannot update {sorted(unknown)}")
        assignments = []
        values: list[Any] = []
        for key in fields:
            assignments.append(f"{key}=?")
            values.append(fields[key])
        assignments.append("updated_at=?")
        values.append(format_utc(utc_now()))
        values.append(task_id)
        with self._lock:
            cursor = self._conn.execute(
                f"UPDATE tasks SET {', '.join(assignments)} WHERE task_id=?",
                values,
            )
            if cursor.rowcount != 1:
                raise KeyError(task_id)
            self._conn.commit()

    def get_task(self, task_id: str) -> Task | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM tasks WHERE task_id=?", (task_id,)).fetchone()
        return _task(row) if row else None

    def find_open_child(self, parent_task_id: str) -> Task | None:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT * FROM tasks
                WHERE parent_task_id=? AND status='pending' AND delivery='drafted'
                ORDER BY created_at
                LIMIT 1
                """,
                (parent_task_id,),
            ).fetchone()
        return _task(row) if row else None

    def find_by(self, column: str, value: str) -> list[Task]:
        if column not in {"session_id", "ticket_id", "run_id"}:
            raise KeyError(column)
        with self._lock:
            rows = self._conn.execute(
                f"SELECT * FROM tasks WHERE {column}=? ORDER BY created_at DESC",
                (value,),
            ).fetchall()
        return [_task(row) for row in rows]

    def list_tasks(
        self,
        *,
        statuses: tuple[str, ...] | None = None,
        delivery: str | None = None,
        instance_id: str | None = None,
        workspace: str | None = None,
    ) -> list[Task]:
        clauses: list[str] = []
        values: list[Any] = []
        if statuses:
            marks = ",".join("?" for _ in statuses)
            clauses.append(f"status IN ({marks})")
            values.extend(statuses)
        if delivery:
            clauses.append("delivery=?")
            values.append(delivery)
        if instance_id:
            clauses.append("instance_id=?")
            values.append(instance_id)
        if workspace:
            clauses.append("workspace=?")
            values.append(workspace)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._lock:
            rows = self._conn.execute(
                f"SELECT * FROM tasks {where} ORDER BY created_at",
                values,
            ).fetchall()
        return [_task(row) for row in rows]

    def insert_event(self, **fields: Any) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO events (
                    event_id, event_type, occurred_at, received_at, instance_id, workspace,
                    executor, task_id, session_id, ticket_id, run_id, commit_sha,
                    evidence_json, payload_sha256, disposition, reject_reason, acked,
                    duplicate_count, applied
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?)
                """,
                (
                    fields["event_id"],
                    fields.get("event_type"),
                    fields.get("occurred_at"),
                    format_utc(utc_now()),
                    fields.get("instance_id"),
                    fields.get("workspace"),
                    fields.get("executor"),
                    fields.get("task_id"),
                    fields.get("session_id"),
                    fields.get("ticket_id"),
                    fields.get("run_id"),
                    fields.get("commit_sha"),
                    json.dumps(fields.get("evidence") or [], ensure_ascii=False),
                    fields["payload_sha256"],
                    fields["disposition"],
                    fields.get("reject_reason"),
                    1 if fields.get("applied") else 0,
                ),
            )
            self._conn.commit()

    def get_event(self, event_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM events WHERE event_id=?", (event_id,)).fetchone()
        return _plain(row) if row else None

    def bump_duplicate(self, event_id: str) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE events SET duplicate_count = duplicate_count + 1 WHERE event_id=?",
                (event_id,),
            )
            self._conn.commit()

    def acknowledge(self, event_id: str) -> bool:
        with self._lock:
            cursor = self._conn.execute("UPDATE events SET acked=1 WHERE event_id=?", (event_id,))
            self._conn.commit()
            return cursor.rowcount == 1

    def unacked_events(
        self, *, instance_id: str | None = None, workspace: str | None = None
    ) -> list[dict[str, Any]]:
        clauses = ["acked=0"]
        values: list[Any] = []
        if instance_id:
            clauses.append("instance_id=?")
            values.append(instance_id)
        if workspace:
            clauses.append("workspace=?")
            values.append(workspace)
        with self._lock:
            rows = self._conn.execute(
                f"SELECT * FROM events WHERE {' AND '.join(clauses)} ORDER BY received_at",
                values,
            ).fetchall()
        return [_plain(row) for row in rows]

    def begin_attempt(self, task_id: str, kind: str) -> str:
        attempt_id = new_id("att")
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO attempts (attempt_id, task_id, kind, status, started_at)
                VALUES (?, ?, ?, 'in_flight', ?)
                """,
                (attempt_id, task_id, kind, format_utc(utc_now())),
            )
            self._conn.commit()
        return attempt_id

    def finish_attempt(self, attempt_id: str, status: str, detail: str) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE attempts SET status=?, finished_at=?, detail=? WHERE attempt_id=?",
                (status, format_utc(utc_now()), detail[:500], attempt_id),
            )
            self._conn.commit()

    def in_flight_attempts(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM attempts WHERE status='in_flight' ORDER BY started_at"
            ).fetchall()
        return [_plain(row) for row in rows]

    def attempts_for(self, task_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM attempts WHERE task_id=? ORDER BY started_at",
                (task_id,),
            ).fetchall()
        return [_plain(row) for row in rows]

    def add_dead_letter(
        self, *, reason: str, task_id: str | None = None, event_id: str | None = None
    ) -> str:
        dead_letter_id = new_id("dead")
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO dead_letters (dead_letter_id, task_id, event_id, reason, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (dead_letter_id, task_id, event_id, reason[:500], format_utc(utc_now())),
            )
            self._conn.commit()
        return dead_letter_id

    def dead_letters_for_task(self, task_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM dead_letters WHERE task_id=? ORDER BY created_at",
                (task_id,),
            ).fetchall()
        return [_plain(row) for row in rows]

    def insert_summary(
        self, *, task_id: str | None, event_id: str, body: str, evidence_missing: bool
    ) -> str:
        summary_id = new_id("sum")
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO summaries (summary_id, task_id, event_id, body, evidence_missing, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    summary_id,
                    task_id,
                    event_id,
                    body,
                    1 if evidence_missing else 0,
                    format_utc(utc_now()),
                ),
            )
            self._conn.commit()
        return summary_id

    def summaries_for(self, task_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM summaries WHERE task_id=? ORDER BY created_at",
                (task_id,),
            ).fetchall()
        return [_plain(row) for row in rows]


def _plain(row: sqlite3.Row | None) -> dict[str, Any]:
    if row is None:
        return {}
    return {key: row[key] for key in row.keys()}


def _task(row: sqlite3.Row) -> Task:
    mandate = json.loads(row["mandate_json"]) if row["mandate_json"] else None
    return Task(
        task_id=row["task_id"],
        instance_id=row["instance_id"],
        workspace=row["workspace"],
        executor=row["executor"],
        title=row["title"],
        objective=row["objective"],
        scope=row["scope"],
        acceptance=row["acceptance"],
        status=row["status"],
        delivery=row["delivery"],
        session_id=row["session_id"],
        ticket_id=row["ticket_id"],
        run_id=row["run_id"],
        parent_task_id=row["parent_task_id"],
        mandate=mandate,
        dispatch_mode=row["dispatch_mode"],
        retry_count=row["retry_count"],
        retry_limit=row["retry_limit"],
        cancel_confirmation=row["cancel_confirmation"],
        cancel_reason=row["cancel_reason"],
        last_error=row["last_error"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
