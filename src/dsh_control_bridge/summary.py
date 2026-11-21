"""Human-readable stage notes built only from extracted fields."""

from __future__ import annotations

from dsh_control_bridge.models import ExtractedEvent


def render_summary(event: ExtractedEvent, *, task_status: str | None, applied: bool) -> str:
    if event.evidence:
        evidence_line = "、".join(event.evidence)
    else:
        evidence_line = "缺失"
    lines = [
        "阶段总结（待验收，不等于交付完成）",
        f"- 事件: {event.event_id} / {event.event_type or '无法识别'}",
        (
            "- 目标: "
            f"instance={event.instance_id or '未提供'} "
            f"workspace={event.workspace or '未提供'} "
            f"executor={event.executor or '未提供'}"
        ),
        (
            "- 关联: "
            f"task={event.task_id or '-'} "
            f"session={event.session_id or '-'} "
            f"ticket={event.ticket_id or '-'} "
            f"run={event.run_id or '-'}"
        ),
        f"- 提交: {event.commit_sha or '未提供'}",
        f"- 证据: {evidence_line}",
        "- 说明: 摘要只使用已提取字段。payload 里的其他文本没有被当作事实或指令。",
        "- 证据读取: 未打开 payload 中的任何路径。",
    ]
    if event.evidence_missing:
        lines.append("- 证据状态: 缺失。")
    else:
        lines.append("- 证据状态: 仅保留通过形状检查的引用。")
    if task_status:
        lines.append(f"- 任务状态: {task_status}")
    if not applied:
        lines.append("- 状态机: 这次事件没有改变任务状态。")
    return "\n".join(lines)
