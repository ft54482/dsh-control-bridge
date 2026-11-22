"""Errors that are safe to show on a terminal. They never include secrets."""


class BridgeError(Exception):
    """Base class for expected bridge failures."""


class ConfigError(BridgeError):
    def __init__(self, errors: list[str]):
        self.errors = list(errors)
        detail = "\n".join(f"- {item}" for item in self.errors)
        super().__init__(f"invalid config:\n{detail}" if detail else "invalid config")


class TargetRejected(BridgeError):
    """The instance or workspace is not declared in config."""


class MandateRequired(BridgeError):
    """A send was requested without an active, explicit mandate."""


class InvalidTransition(BridgeError):
    """The task state machine refused this change."""


class SignatureError(BridgeError):
    """The webhook body failed the shared-secret check."""


class PayloadError(BridgeError):
    """The body is not a usable event. Nothing was stored."""


class NotFound(BridgeError):
    """The named task or event does not exist."""


class AdapterError(BridgeError):
    """An executor adapter failed a dispatch or cancel call."""


class ProbeRequired(AdapterError):
    """The harness adapter has no documented call for this capability yet."""

    def __init__(self, items: list[str] | tuple[str, ...]):
        self.items = list(items)
        joined = ", ".join(self.items)
        super().__init__(
            "harness adapter is a documented skeleton and did not send anything; "
            f"probe items: {joined}"
        )


class SimulatedCrash(BridgeError):
    """Test seam.

    Raised after an attempt row has been committed, to model a process death.
    Production adapters should not raise this.
    """
