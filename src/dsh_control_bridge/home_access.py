"""Opt-in access to an existing DSH_HOME.

The default stays an isolated directory under the bridge data dir. A shared
home is off until the operator names that one directory and the workspaces
and sessions it may touch. Sharing the home does not share every session.

Official write/resume is only ``dsh --profile headless --session-id`` against
the same home and the session's recorded cwd. Reading session files is not
that resume. Desktop, Web, and SuperAgent have no supported attach path here.
This module does not open ``.credentials.yaml`` and does not spawn ``dsh``.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath

from dsh_control_bridge.errors import AdapterError
from dsh_control_bridge.redact import Redactor

_META = set('%&|<>^\r\n"!`')
_PROFILES = frozenset({"headless", "desktop", "web", "superagent"})
_ACCESS = frozenset({"read", "write"})
_OCCUPANCY = frozenset({"unknown", "operator_confirmed_idle"})
OFFICIAL_AUTH_PATCH = """- id: credentials
  disabled: false
- id: authorization
  disabled: false
- id: deepseek-account
  disabled: false
"""
CREDENTIALS_FILENAME = ".credentials.yaml"
PATCH_FILENAME = "cordis.patch.yml"
BACKUP_FILENAME = "cordis.patch.yml.bridge-bak"

# What the current official interfaces actually allow this bridge to do.
# Sources: deepseek-ai/deepseek-harness docs/cli-help.md, apps/cli/README.md,
# packages/bundle/headless/README.md, and the desktop-attach discussion.
SURFACE_MATRIX = (
    {
        "surface": "headless",
        "list_sessions": "unsupported_no_cli",
        "read_official_history": "unsupported_no_export_cli",
        "resume_or_write": "supported_session_id_same_home_and_cwd",
        "credentials": "same_dsh_home_official_store_or_environment",
        "note": "Default profile disables credentials, authorization, and deepseek-account. A --patch overlay can restore those three rows. The bridge does not read or copy .credentials.yaml.",
    },
    {
        "surface": "desktop",
        "list_sessions": "unsupported",
        "read_official_history": "unsupported",
        "resume_or_write": "unsupported",
        "credentials": "not_copied",
        "note": "Electron owns the desktop profile. There is no pairing path for an outside client. Busy sessions are not written.",
    },
    {
        "surface": "web",
        "list_sessions": "unsupported",
        "read_official_history": "unsupported",
        "resume_or_write": "unsupported",
        "credentials": "not_copied",
        "note": "The web host RPC is an internal wire format and needs that host's launch token. It is not a stable bridge API. dsh-agent-bridge drives this surface and is not vendored.",
    },
    {
        "surface": "superagent",
        "list_sessions": "unsupported",
        "read_official_history": "unsupported",
        "resume_or_write": "unsupported",
        "credentials": "not_copied",
        "note": "Orchestrator state has no profile, workspace, or session binding.",
    },
)


@dataclass(frozen=True)
class SessionGrant:
    session_id: str
    workspace: str
    profile: str
    cwd: str
    access: str
    occupancy: str


def surface_matrix() -> list[dict[str, str]]:
    return [dict(item) for item in SURFACE_MATRIX]


def validate_configured_path(value: str, *, label: str) -> str:
    """Lexical path check. It does not touch the filesystem."""

    if not isinstance(value, str) or not value.strip():
        raise AdapterError(f"{label} is required")
    raw = value.strip()
    if any(character in raw for character in _META) or "\x00" in raw:
        raise AdapterError(f"{label} contains a shell metacharacter")
    parts = raw.replace("\\", "/").split("/")
    if any(part == ".." for part in parts):
        raise AdapterError(f"{label} must not contain ..")
    windows = PureWindowsPath(raw).is_absolute() and not Path(raw).is_absolute()
    native = Path(raw)
    if windows:
        if not PureWindowsPath(raw).is_absolute():
            raise AdapterError(f"{label} must be absolute")
        return str(PureWindowsPath(raw))
    if not native.is_absolute() and not PurePosixPath(raw).is_absolute():
        raise AdapterError(f"{label} must be absolute")
    if not native.is_absolute():
        raise AdapterError(f"{label} must be absolute")
    return str(native)


def seal_local_directory(value: str, *, label: str, must_exist: bool) -> str:
    """Reject symlink and junction redirection on this operating system."""

    lexical = validate_configured_path(value, label=label)
    if _foreign_path(lexical):
        raise AdapterError(f"{label} is not a directory on this operating system")
    path = Path(lexical)
    if path.is_symlink() or (path.exists() and os.path.normcase(os.path.abspath(path)) != os.path.normcase(os.path.realpath(path))):
        raise AdapterError(f"{label} is a symlink or junction")
    if not path.exists():
        if must_exist:
            raise AdapterError(f"{label} does not exist")
        return str(Path(os.path.abspath(path)))
    if not path.is_dir():
        raise AdapterError(f"{label} is not a directory")
    return str(Path(os.path.realpath(path)))


def _foreign_path(value: str) -> bool:
    if os.name == "nt":
        return False
    return PureWindowsPath(value).is_absolute() and not Path(value).is_absolute()


def isolated_home(data_dir: Path, instance_id: str) -> Path:
    root = data_dir / "dsh-home" / instance_id
    root.mkdir(parents=True, exist_ok=True)
    return root


def official_patch_path(data_dir: Path, instance_id: str) -> Path:
    directory = data_dir / "headless-patches"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{instance_id}.yml"
    path.write_text(OFFICIAL_AUTH_PATCH, encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return path


def authorize_new_session(*, home_mode: str, allow_new_session: bool, occupancy: str) -> None:
    if home_mode != "shared":
        return
    if not allow_new_session:
        raise AdapterError("shared home does not allow a new session in this workspace")
    if occupancy != "operator_confirmed_idle":
        raise AdapterError("external occupancy is not confirmed; refusing to write")


def authorize_resume(
    *,
    home_mode: str,
    workspace: str,
    cwd: str,
    session_id: str,
    grants: tuple[SessionGrant, ...],
    recorded: dict[str, str] | None,
) -> str:
    """Return ``grant`` or ``bridge_created``. Unknown sessions stay rejected."""

    if not session_id or any(character in session_id for character in _META) or "/" in session_id or "\\" in session_id:
        raise AdapterError("session id is not safe to pass as an argument")
    grant = next((item for item in grants if item.session_id == session_id), None)
    if grant is not None:
        if grant.workspace != workspace or _same_path(grant.cwd, cwd) is False:
            raise AdapterError("session grant does not match this workspace")
        if grant.profile != "headless":
            raise AdapterError(f"{grant.profile} resume is unsupported; the CLI cannot boot that profile")
        if grant.access != "write":
            raise AdapterError("session grant is read-only")
        if grant.occupancy != "operator_confirmed_idle":
            raise AdapterError("external occupancy is not confirmed; refusing to write")
        if home_mode != "shared":
            raise AdapterError("a configured session grant requires home_mode shared")
        return "grant"
    if recorded is None:
        raise AdapterError("unknown session id")
    if recorded.get("profile") != "headless" or _same_path(recorded.get("cwd", ""), cwd) is False:
        raise AdapterError("session cwd or profile does not match this workspace")
    recorded_workspace = recorded.get("workspace")
    if recorded_workspace and recorded_workspace != workspace:
        raise AdapterError("session cwd or profile does not match this workspace")
    if home_mode == "shared" and recorded.get("occupancy") != "operator_confirmed_idle":
        raise AdapterError("external occupancy is not confirmed; refusing to write")
    return "bridge_created"


def _same_path(left: str, right: str) -> bool:
    if not left or not right:
        return False
    return validate_configured_path(left, label="cwd") == validate_configured_path(right, label="cwd")


def catalog(
    *,
    instance_id: str,
    home_mode: str,
    dsh_home: str,
    credential_mode: str,
    workspaces: list[dict[str, object]],
    grants: tuple[SessionGrant, ...],
    recorded: dict[str, dict[str, str]],
) -> dict[str, object]:
    sessions: list[dict[str, object]] = []
    for grant in grants:
        sessions.append(_public_session(grant.session_id, grant.workspace, grant.profile, grant.cwd, grant.access, grant.occupancy, "operator_config"))
    for session_id, item in sorted(recorded.items()):
        if any(session["session_id"] == session_id for session in sessions):
            continue
        sessions.append(
            _public_session(
                session_id,
                str(item.get("workspace", "")),
                str(item.get("profile", "")),
                str(item.get("cwd", "")),
                "write" if item.get("occupancy", "operator_confirmed_idle") == "operator_confirmed_idle" else "read",
                str(item.get("occupancy", "unknown")),
                "bridge_created",
            )
        )
    return {
        "instance_id": instance_id,
        "home_mode": home_mode,
        "dsh_home": dsh_home if home_mode == "shared" else "",
        "credential_mode": credential_mode,
        "credentials_file_copied": False,
        "credentials_file_read": False,
        "workspaces": workspaces,
        "sessions": sessions,
        "official_history": "unsupported",
        "surfaces": surface_matrix(),
    }


def _public_session(
    session_id: str,
    workspace: str,
    profile: str,
    cwd: str,
    access: str,
    occupancy: str,
    origin: str,
) -> dict[str, object]:
    writable = (
        access == "write"
        and profile == "headless"
        and occupancy == "operator_confirmed_idle"
    )
    return {
        "session_id": session_id,
        "workspace": workspace,
        "profile": profile,
        "cwd": cwd,
        "access": access,
        "occupancy": occupancy,
        "origin": origin,
        "resume": "headless_session_id" if writable else "refused",
        "official_history": "unsupported",
    }


def observe_tool_output(text: str, grants: tuple[SessionGrant, ...]) -> dict[str, object]:
    """Tool output is data. It never adds a grant."""

    return {
        "authorization_changed": False,
        "grant_count": len(grants),
        "ignored_characters": len(text),
        "note": "tool output is data and does not create a session grant",
    }


def append_transcript(data_dir: Path, instance_id: str, session_id: str, stdout: bytes) -> None:
    if "/" in session_id or "\\" in session_id or ".." in session_id:
        raise AdapterError("session id is not safe to store")
    directory = data_dir / "transcripts" / instance_id
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{session_id}.jsonl"
    redactor = Redactor()
    with path.open("a", encoding="utf-8") as handle:
        for line in stdout.splitlines():
            if not line.strip():
                continue
            text = line.decode("utf-8", errors="replace")
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                payload = {"type": "unparsed", "text": text[:2000]}
            stored = json.dumps(redactor.redact_obj(payload), ensure_ascii=False, sort_keys=True)
            handle.write(stored + "\n")
    try:
        path.chmod(0o600)
    except OSError:
        pass


def read_transcript(
    data_dir: Path,
    instance_id: str,
    session_id: str,
    *,
    offset: int,
    limit: int,
) -> dict[str, object]:
    if "/" in session_id or "\\" in session_id or ".." in session_id:
        raise AdapterError("session id is not safe to read")
    bounded = min(max(int(limit), 1), 50)
    start = max(int(offset), 0)
    path = data_dir / "transcripts" / instance_id / f"{session_id}.jsonl"
    lines = path.read_text(encoding="utf-8").splitlines() if path.is_file() else []
    page = lines[start : start + bounded]
    redactor = Redactor()
    events = []
    for line in page:
        try:
            events.append(redactor.redact_obj(json.loads(line)))
        except json.JSONDecodeError:
            events.append({"type": "unparsed", "text": redactor.redact(line[:2000])})
    return {
        "source": "bridge_transcript",
        "official_session_log": "unsupported",
        "uploaded": False,
        "session_id": session_id,
        "offset": start,
        "limit": bounded,
        "total": len(lines),
        "events": events,
        "note": "this is the redacted stream from runs this bridge started, not the official session log and not a native resume",
    }


def prepare_headless_profile(home: Path, *, apply: bool) -> dict[str, object]:
    """Plan or apply the official three-row headless patch. Desktop is untouched."""

    root = seal_local_directory(str(home), label="dsh_home", must_exist=True)
    headless = Path(root) / "profiles" / "headless"
    target = headless / PATCH_FILENAME
    desktop = Path(root) / "profiles" / "desktop"
    _refuse_escape(Path(root), target)
    report: dict[str, object] = {
        "applied": False,
        "would_write": str(target),
        "copies_credentials": False,
        "reads_credentials": False,
        "touches_desktop": False,
        "touches_global_plugins": False,
        "credentials_path_present_in_plan": False,
        "plugin_install": "not_performed",
        "plugin_risk": (
            "Installing chengzipro-dsh-plugin or any shared component can change "
            "later logins for every profile. This prepare step does not install it."
        ),
        "rollback": f"restore {BACKUP_FILENAME} over the headless patch, or stop passing --patch",
    }
    if not apply:
        return report
    headless.mkdir(parents=True, exist_ok=True)
    backup = headless / BACKUP_FILENAME
    created_flag = headless / "cordis.patch.yml.bridge-created"
    if not backup.exists() and not created_flag.exists():
        if target.exists():
            backup.write_bytes(target.read_bytes())
        else:
            created_flag.write_text("created-by-bridge\n", encoding="utf-8")
    existing = target.read_text(encoding="utf-8") if target.exists() else ""
    if "id: credentials" not in existing:
        separator = "\n" if existing and not existing.endswith("\n") else ""
        target.write_text(existing + separator + OFFICIAL_AUTH_PATCH, encoding="utf-8")
    report["applied"] = True
    report["desktop_exists"] = desktop.exists()
    return report


def rollback_headless_profile(home: Path, *, apply: bool) -> dict[str, object]:
    root = seal_local_directory(str(home), label="dsh_home", must_exist=True)
    headless = Path(root) / "profiles" / "headless"
    target = headless / PATCH_FILENAME
    backup = headless / BACKUP_FILENAME
    created_flag = headless / "cordis.patch.yml.bridge-created"
    _refuse_escape(Path(root), target)
    if not backup.is_file() and not created_flag.is_file():
        raise AdapterError("no headless patch backup to restore")
    report = {
        "applied": False,
        "restores": str(target),
        "touches_desktop": False,
        "reads_credentials": False,
    }
    if not apply:
        return report
    if created_flag.is_file() and not backup.is_file():
        target.unlink(missing_ok=True)
        created_flag.unlink()
    else:
        target.write_bytes(backup.read_bytes())
    report["applied"] = True
    return report


def _refuse_escape(root: Path, target: Path) -> None:
    try:
        target.resolve().relative_to(root.resolve())
    except ValueError as exc:
        raise AdapterError("headless patch path escapes the home") from exc
    if "desktop" in target.parts or target.name == CREDENTIALS_FILENAME:
        raise AdapterError("prepare refuses desktop and credential files")


def non_secret_operator_fields() -> list[dict[str, str]]:
    return [
        {"field": "home_mode", "value": "shared", "note": "default remains isolated"},
        {"field": "dsh_home", "value": "operator absolute home", "note": "one directory; not committed"},
        {"field": "credential_mode", "value": "official_store", "note": "official component reads the store; the bridge does not"},
        {"field": "profile", "value": "headless", "note": "desktop, web, and superagent stay unsupported"},
        {"field": "workspace.cwd", "value": "demo directory only", "note": "do not list the busy business directories"},
        {"field": "allow_new_session", "value": "true only on the demo workspace", "note": "after occupancy is confirmed idle"},
        {"field": "occupancy", "value": "operator_confirmed_idle", "note": "unknown refuses write"},
        {"field": "session_grants", "value": "explicit session id, cwd, and access", "note": "no automatic grant of every session"},
        {"field": "spawn", "value": "false", "note": "a later single real call must set this on purpose"},
        {"field": "timeout_seconds", "value": "120", "note": "no automatic retry on that call"},
    ]
