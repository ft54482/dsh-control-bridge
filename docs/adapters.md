# Python 协调桥的执行适配器

从 CLI 或 stdio MCP 提交任务时，协调桥根据目标实例的 `[[instances]].adapter` 选择执行端。直接使用 Codex skill 的用户由 skill 连接 Desktop Host，安装步骤见 [Windows 使用指南](windows-delivery.md#codex-desktop-setup)。

协调桥的适配器接口有两个操作。

- `dispatch(request) -> DispatchResult`，对同一个 `task_id` 必须幂等
- `cancel(request) -> CancelResult`，`confirmed=false` 时桥把取消记为 `unconfirmed`

## fake

`adapter = "fake"` 是测试、示例和 CI 的 dry-run。它在本地 JSON 文件里记住已经发出的 `session_id` 或 `ticket_id` / `run_id`，不打开网络连接。普通会话如果任务上已经有 `session_id`，就沿用该会话，用来表示返修回到原会话。

示例端点 `http://127.0.0.1:9` 与 `http://127.0.0.1:10` 只是配置里的占位，fake 适配器不会请求它们。

## desktop_host

`adapter = "desktop_host"` 用于向 Desktop 上已有的普通会话发送任务。将 `host_bind` 和 `host_port` 对准同机 Host 插件，通过 `host_secret_env` 指定的环境变量提供 Host 的长期配对凭据。启用 `spawn = true` 后，派工还需要目标会话的写授权、匹配的工作区目录和 `occupancy = "operator_confirmed_idle"`。样例默认关闭发送。[Desktop 适配器配置](../examples/desktop-host.example.toml)

这个适配器在发送时要求已有 `session_id`。需要在同一工作区为独立任务新建主控会话时，用 Codex skill 的 `create-session`，从会话投影读回预设后再 `resume`。[主控会话操作](../skills/deepseek-harness-bridge/references/desktop.md#new-work-in-master-control-mode)

## headless_cli

`adapter = "headless_cli"` 用于在指定目录运行独立的普通 CLI 会话。它通过 stdin 与子进程交换任务，默认 `spawn = false`。启用后，适配器根据退出码和最终事件判断成功，续接时还会核对会话与目录。[配置与完成判据](headless-cli.md)

## harness

`adapter = "harness"` 是早期连接契约的占位实现。选择它的实例可以起草任务，发送会被拒绝。

fake 演练会生成模拟的 SuperAgent 标识。要发起正式 SuperAgent 工作，请使用目标 profile 的授权 Source 触发事件，再用 skill 的查询脚本读取 Ticket 和 Assignment。[SuperAgent 工作流程](../skills/deepseek-harness-bridge/references/superagent.md)
