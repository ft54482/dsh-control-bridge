"""MCP tool descriptions for the coordinating agent.

These descriptions match the CLI. They are not a second execution path:
a client should invoke the same bridge commands, with the same approval rules.
"""

from __future__ import annotations

from typing import Any


def tool_catalog() -> dict[str, Any]:
    return {
        "tools": [
            {
                "name": "inbox",
                "description": "读取未确认事件，以及待批准、待验收、等待人工输入的任务。不会派发任务。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "instance_id": {"type": "string"},
                        "workspace": {"type": "string"},
                    },
                    "additionalProperties": False,
                },
            },
            {
                "name": "acknowledge",
                "description": "把一条收件箱事件标为已读。已读不是验收通过，也不会派发下一阶段。",
                "inputSchema": {
                    "type": "object",
                    "properties": {"event_id": {"type": "string"}},
                    "required": ["event_id"],
                    "additionalProperties": False,
                },
            },
            {
                "name": "dispatch",
                "description": (
                    "创建任务书，或发送一份已经起草并且已经批准的任务。"
                    "默认 mode=draft，只保存任务书。"
                    "mode=send 必须带上 mandate，并且 instance、workspace、executor 必须是配置里声明的目标。"
                    "收到执行器的完成事件不会自动调用本工具。"
                ),
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "instance_id": {"type": "string"},
                        "workspace": {"type": "string"},
                        "executor": {
                            "type": "string",
                            "enum": ["ordinary_session", "superagent"],
                        },
                        "title": {"type": "string"},
                        "objective": {"type": "string"},
                        "scope": {"type": "string"},
                        "acceptance": {"type": "string"},
                        "mode": {"type": "string", "enum": ["draft", "send"], "default": "draft"},
                        "task_id": {"type": "string"},
                        "mandate": {"type": "object"},
                    },
                    "additionalProperties": False,
                },
            },
            {
                "name": "status",
                "description": "查看一个任务的状态、最近摘要、投递尝试和死信。",
                "inputSchema": {
                    "type": "object",
                    "properties": {"task_id": {"type": "string"}},
                    "required": ["task_id"],
                    "additionalProperties": False,
                },
            },
            {
                "name": "cancel",
                "description": "取消任务，并请适配器通知对应会话或 SuperAgent。远端未确认时记录 unconfirmed。取消不是验收，额度声明也不是执行。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "task_id": {"type": "string"},
                        "reason": {"type": "string"},
                    },
                    "required": ["task_id", "reason"],
                    "additionalProperties": False,
                },
            },
            {
                "name": "diagnose",
                "description": "读取本地配置预检。connected_to_harness 在没有新的受支持接口证据前始终为 false。不会访问网络。",
                "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
            },
        ]
    }
