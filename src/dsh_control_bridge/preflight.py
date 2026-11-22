"""Compare a redacted facts file with the connector contract. Never contacts a host."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from dsh_control_bridge.drivers.contract import DECLARED_FACTS, REQUIRED_EVIDENCE


def load_facts(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("facts file must be a JSON object")
    return data


def preflight(facts: dict[str, Any] | None = None) -> dict[str, Any]:
    supplied = facts or {}
    missing = [name for name in REQUIRED_EVIDENCE if not supplied.get(name)]
    webhook_claim = bool(supplied.get("harness_webhook_inbound_supported"))
    contradictions = []
    if webhook_claim:
        contradictions.append(
            "harness_webhook_inbound_supported contradicts the observed evidence: "
            "cookbook webhook/hookq is an example Source, not an installed inbound"
        )
    if supplied.get("ordinary_session_api_implemented") is True:
        contradictions.append("ordinary_session_api_implemented is not evidenced")
    if supplied.get("profile_workspace_map"):
        contradictions.append("profile_workspace_map must stay empty until the operator names the profile in scope")
    return {
        "connected_to_harness": False,
        "calls_network": False,
        "declared": DECLARED_FACTS,
        "missing_evidence": missing,
        "contradictions": contradictions,
        "ready_to_implement_driver": not missing and not contradictions,
    }
