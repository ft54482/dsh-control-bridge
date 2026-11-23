# Harness 连接契约

不同入口操作不同的 Harness 资源。Python 协调桥的 `check`、`diagnose` 和 `preflight` 只检查本地配置与记录，它们返回的 `connected_to_harness=false` 是离线报告字段。Windows Desktop 的实际会话创建、任务回执与拒绝测试记录在[真机验收](verified-scope.md)。

## Desktop 会话

Host 插件安装在运行中的 Desktop profile，通过 Harness 的会话服务操作已配对工作区。Codex skill 可新建和续接会话；Python 协调桥的 `desktop_host` 适配器只续接显式授权的已有会话。验收主控流程时先核对 Host 的 `preset_create_verified`，再用创建回执中的 `workspace_id`、`agent_preset`、`agent_preset_source` 验证目标。派工后按请求 ID 查询官方终态。[Host API](host-api.md) · [Desktop 命令](../skills/deepseek-harness-bridge/references/desktop.md)

## 普通 headless CLI

来源是官方 `docs/cli-help.md`、`apps/cli/README.md`、`packages/bundle/headless/README.md`，以及操作者本机 `dsh.cmd` 0.2.2-rc.5 的 help/version。本仓库的回归测试使用假进程，不启动这支命令。

- 启动形式是 `dsh --profile headless --json -`，任务从 stdin 送入。
- 恢复使用 `--session-id`，并且 cwd 与 headless profile 必须和当初记录的一致。未知 id 在进程启动前拒绝。
- stdout 是 NDJSON：开头 `session`，中间可以有 `status`、`text`、`thinking`、`tool_call`、`tool_result`，结尾 `final`。
- 完成必须同时是退出码 0 和 `final.reason.kind == completed`。
- `desktop` profile 由 Electron 独占，CLI 不能启动它。headless 也不是当前打开的桌面工作区。
- 默认 headless 不使用 GUI 保存的登录。适配器把 `DSH_HOME` 指到桥自己的数据目录。可选的 `home_mode = "shared"` 才把子进程的 `DSH_HOME` 指到操作者写明的那一个目录，并且只允许配置里点名的工作区和 session。共享 home 不会自动开放里面的全部会话。
- 官方凭证复用是同一 `DSH_HOME` 里的托管存储。headless 默认关掉 `credentials`、`authorization`、`deepseek-account`。`credential_mode = "official_store"` 用桥数据目录里的 `--patch` 覆盖把这三行重新打开，交给官方组件读取。桥不读取、不复制 `.credentials.yaml`，也不把 Key 放进仓库。
- 没有官方的 `dsh session list` 或会话导出命令。会话文件不是受支持的 resume。能恢复的只有 headless `--session-id`，并且 cwd、profile 和授权必须一致。
- 取消只结束桥自己这次请求。外部占用确认不了就拒绝写。

实现和限制写在 [headless-cli.md](headless-cli.md)。默认 `spawn = false`。

## SuperAgent 管理面

在运行目标 SuperAgent profile 的机器上，skill 的 `scripts/superagent.py` 可读取管理状态、Source、Ticket 和 Assignment。用 `--port` 指定该 profile 实际监听的管理端口；默认值为 `3082`。查询的命令与参数见 [SuperAgent 指南](../skills/deepseek-harness-bridge/references/superagent.md)。

正式派工从该 profile 的授权 Source 触发。跟踪新任务时，将 Source 事件关联到 Ticket、Assignment ID 和 worker session（`ref`）。本仓库已有历史 Assignment 查询记录；新 Assignment 的实测状态见[验收记录](verified-scope.md)。

## Webhook 与 MCP

外部请求通过 Harness 的会话 webhook 进入时可以新建 Session。协调桥的 `POST /v1/events` 则用于接收带实例签名的阶段事件。Desktop Host 另有可选的出站完成通知，接收端与签名格式见 [Host API](host-api.md)。

运行 `dsh-bridge mcp` 时，协调代理作为 MCP 客户端，通过子进程的 stdin/stdout 调用桥的工具。Harness 自身也可以作为 MCP 客户端调用它配置的外部工具。[协调桥使用指南](coordinator.md)
