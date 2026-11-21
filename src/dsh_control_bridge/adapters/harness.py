"""Skeleton. It records the declared local facts and does not call them.

The observed SuperAgent plugin exposes a localhost management API. That API
is not an ordinary-session dispatch API, and this class does not request it.
The desktop CLI exists, but its --help output has not been verified, so this
class does not spawn it. Harness webhook inbound is not a supported source.
"""

from __future__ import annotations

import os

from dsh_control_bridge.adapters.base import (
    CancelRequest,
    CancelResult,
    DispatchRequest,
    DispatchResult,
)
from dsh_control_bridge.drivers.contract import DECLARED_FACTS
from dsh_control_bridge.errors import ProbeRequired

PROBE_ITEMS = (
    "ordinary_session_request",
    "cli_help_verified",
    "documented_cancel_for_ordinary_session",
    "event_signature_compatibility",
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
        del request
        raise ProbeRequired(self.probe_items)

    def facts(self) -> dict:
        return DECLARED_FACTS

    def cancel(self, request: CancelRequest) -> CancelResult:
        raise ProbeRequired(self.probe_items)
