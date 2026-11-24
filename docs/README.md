# 文档目录

项目介绍与快速开始提供 [简体中文](../README.md)、[English](../README.en.md)、[Français](../README.fr.md)、[日本語](../README.ja.md)、[한국어](../README.ko.md) 和 [Deutsch](../README.de.md) 版本。以下详细手册主要使用中文，命令和协议字段保持原文。

首次使用从下面选与自己环境相符的一行。已有安装需要迁移或排查连接时，先核对目标服务、profile 和端口。[项目首页](../README.md) · [端口配置与排错](ports.md)

## 安装与操作

| 我想做什么 | 从这里开始 | 按需查阅 |
| --- | --- | --- |
| 在 Codex 操作同机 Harness Desktop | [Windows 安装、配对与连接检查](windows-delivery.md#codex-desktop-setup) | [独立 skill](../skills/deepseek-harness-bridge/SKILL.md) · [会话命令](../skills/deepseek-harness-bridge/references/desktop.md) |
| 在 Desktop 查看主控任务和工单执行器 | [驾驶舱安装与数据说明](../plugins/dsh-superagent-cockpit/README.md) | [可安装插件下载](https://github.com/ft54482/dsh-control-bridge/releases/tag/cockpit-v0.1.3) |
| 升级或回滚 Host | [安装与回滚步骤](windows-delivery.md#host-install) | [插件说明](../plugins/dsh-control-bridge-host/README.md) · [真机验收范围](verified-scope.md) |
| 给 Bot 接入 CLI、收件箱或 MCP | [协调桥操作指南](coordinator.md) | [MCP 工具目录（JSON）](mcp-tools.json) · [多实例配置](local-harness.md) |
| 在独立 profile 运行命令行任务 | [Headless CLI 的进程、凭据与续接](headless-cli.md) | [隔离配置](../examples/headless-cli.example.toml) · [复用已有 home](../examples/headless-shared.example.toml) |
| 查询 SuperAgent 工单和执行者 | [SuperAgent 命令与 Source 派工](../skills/deepseek-harness-bridge/references/superagent.md) | [连接契约](connector-contract.md) |

## 仓库里的几个名字

| 位置 | 运行在哪里 | 职责 |
| --- | --- | --- |
| [`skills/deepseek-harness-bridge/`](../skills/deepseek-harness-bridge/) | Codex 所在的本机 | 提供操作指引和两个 Python 客户端，分别访问 Desktop Host 与 SuperAgent 管理服务。 |
| [`plugins/dsh-control-bridge-host/`](../plugins/dsh-control-bridge-host/) | Harness Desktop 进程 | 在已授权范围内，将本机 HTTP 请求交给官方会话服务。 |
| [`src/dsh_control_bridge/`](../src/dsh_control_bridge/) | 自己的协调程序所在机器 | 提供 `dsh-bridge` CLI、stdio MCP 和独立的签名事件接收器。 |
| [`scripts/windows/`](../scripts/windows/) | Windows 安装或维护时 | 安装、升级、配对和运行本机检查。 |

插件说明引用的 [dsh-agent-bridge](https://github.com/ft54482/dsh-agent-bridge) 是设计来源，当前安装所需的 Host 已随本项目发布。

## 接口与实现

| 主题 | 说明 |
| --- | --- |
| [Host HTTP API](host-api.md) | 配对凭据、会话权限、主控预设回读、轮询和 SSE。 |
| [协调桥架构](architecture.md) | 实例、工作区、任务、事件、审批和验收之间的关系。 |
| [适配器](adapters.md) | fake、Desktop Host、Headless CLI 和早期 harness 接口分别能执行什么。 |
| [连接契约](connector-contract.md) | Desktop、headless、SuperAgent、外部 webhook 和 MCP 的连接方向与证据。 |
| [配置示例](../examples/) | 多实例、Desktop Host、headless、凭据占位文件和授权任务书。 |

## 验收与版本记录

[Windows 真机验收](verified-scope.md) 按版本记录了现场观察、隔离测试和尚待验证的能力。以下是开发当时的记录，可用于排查旧安装。

| 记录 | 适用范围 |
| --- | --- |
| [Host 0.2.0 交付](history/release-0.2.0.md) | 请求日志、事件回传、工作区发现和 SuperAgent 查询。 |
| [Host 0.1.6 交付](history/release-0.1.6.md) | 早期请求跟踪、取消、配对窗口和授权热更新。 |
| [请求生命周期设计](request-lifecycle.md) | 0.1.6 至 0.2.0 的状态与恢复语义。 |
| [Desktop Host 官方契约复核](official-host-contract.md) | 对指定版本控制器源码的核对与夹具差异。 |

发布包和校验文件见 [GitHub Releases](https://github.com/ft54482/dsh-control-bridge/releases)。维护仓库封面时见[社交预览说明](https://github.com/ft54482/dsh-control-bridge/blob/main/SOCIAL.md)。开发环境、报告问题及许可证见 [贡献指南](../CONTRIBUTING.md)、[安全说明](../SECURITY.md)和 [LICENSE](../LICENSE)。
