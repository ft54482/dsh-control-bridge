"""Decide whether a Desktop install must wait.

Matching the executable name is not enough. A ``DeepSeek Harness.exe`` process
started as ``--profile superagent --no-open`` is not the Desktop shell. A
running Desktop shell, a host on the desktop profile, or a harness process
whose command line cannot be read still blocks installation. This module
never stops a process.
"""

from __future__ import annotations

from pathlib import Path


def _profile(command_line: str) -> str | None:
    parts = command_line.split()
    for index, part in enumerate(parts):
        lowered = part.lower()
        if lowered == "--profile" and index + 1 < len(parts):
            return parts[index + 1].lower()
        if lowered.startswith("--profile="):
            return part.split("=", 1)[1].lower()
    return None


def _looks_like_harness(image: str) -> bool:
    name = Path(image.replace("\\", "/")).name.lower()
    return name in {"deepseek harness.exe", "deepseek harness"}


def classify_process(image: str, command_line: str | None) -> str:
    """Return desktop_shell, desktop_host, other_profile, unknown, or unrelated."""

    if not image or not _looks_like_harness(image):
        return "unrelated"
    if command_line is None or not str(command_line).strip():
        return "unknown"
    profile = _profile(command_line)
    if profile == "desktop":
        return "desktop_host"
    if profile:
        return "other_profile"
    return "desktop_shell"


def install_blocked(processes: list[dict[str, str | None]]) -> tuple[bool, str]:
    """Fail closed while Desktop is running. Never signals a process."""

    kinds = [classify_process(str(item.get("image") or ""), item.get("command_line")) for item in processes]
    if any(kind in {"desktop_shell", "desktop_host", "unknown"} for kind in kinds):
        return True, "desktop is running or a harness command line could not be read; quit Desktop from the tray and do not kill the process"
    return False, "no desktop shell or desktop-profile host is running"
