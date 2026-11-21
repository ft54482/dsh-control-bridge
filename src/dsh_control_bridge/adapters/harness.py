"""Skeleton for a future documented DeepSeek Harness adapter.

This class does not call a vendor API. Public material describes ordinary
sessions and a longer-running SuperAgent path, but this repository does not
ship a verified request shape for creating a session, opening a SuperAgent
ticket, canceling either one, or reading evidence. Those stay probe items.

Do not point this adapter at an undocumented panel route and treat it as
supported. Drafts still work, because drafting never leaves the bridge.
"""

from __future__ import annotations

import os

from dsh_control_bridge.adapters.base import (
    CancelRequest,
    CancelResult,
    DispatchRequest,
    DispatchResult,
)
from dsh_control_bridge.errors import ProbeRequired

PROBE_ITEMS = (
    "documented_session_open_or_resume",
    "documented_superagent_ticket_and_run",
    "documented_cancel",
    "documented_event_signature",
    "documented_evidence_read",
)


class HarnessAdapter:
    supports_send = False
    probe_items = PROBE_ITEMS

    def __init__(self, instance_id: str, auth_env: str):
        self.instance_id = instance_id
        self.auth_env = auth_env

    def auth_configured(self) -> bool:
        """Report whether the env var is present. The value is never returned."""

        return bool(os.environ.get(self.auth_env))

    def dispatch(self, request: DispatchRequest) -> DispatchResult:
        raise ProbeRequired(self.probe_items)

    def cancel(self, request: CancelRequest) -> CancelResult:
        raise ProbeRequired(self.probe_items)
