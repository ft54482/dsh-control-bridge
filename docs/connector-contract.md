# 连接契约

这座桥目前没有连上正在运行的 Harness。下面是已经核对过的事实，以及仍然不能做的事。

## 普通 headless CLI

来源是官方 `docs/cli-help.md`、`apps/cli/README.md`、`packages/bundle/headless/README.md`，以及操作者本机 `dsh.cmd` 0.2.2-rc.5 的 help/version。本仓库的回归测试使用假进程，不启动这支命令。

- 启动形式是 `dsh --profile headless --json -`，任务从 stdin 送入。
- 恢复使用 `--session-id`，并且 cwd 与 headless profile 必须和当初记录的一致。未知 id 在进程启动前拒绝。
- stdout 是 NDJSON：开头 `session`，中间可以有 `status`、`text`、`thinking`、`tool_call`、`tool_result`，结尾 `final`。
- 完成必须同时是退出码 0 和 `final.reason.kind == completed`。
- `desktop` profile 由 Electron 独占，CLI 不能启动它。headless 也不是当前打开的桌面工作区。
- 默认 headless 不使用 GUI 保存的登录。凭证只来自显式列出的环境变量。适配器把 `DSH_HOME` 指到桥自己的数据目录，不读取、不复制桌面凭证文件。
- 取消会等待原进程退出，然后才允许恢复。

实现和限制写在 [headless-cli.md](headless-cli.md)。默认 `spawn = false`。

## SuperAgent 管理面

操作者对 `http://127.0.0.1:3082/orchestrator/api/state` 做过一次只读 GET，返回 200。顶层有 `setup`、`health`、`load`、`paused`、`masterId`。当时 health 为 ready，`paused` 为 false，`running` 为 0，`queued` 为 0，`maxWorkers` 为 4。

这份状态没有 profile、工作区或 session 绑定。不能据此派任何业务。本仓库不因为这次观测去调用该端口。`17300` 和 `49290` 不使用。

长任务 dispatch 在绑定被单独核对之前继续拒绝。

## Webhook 与 MCP

官方 webhook 是外部请求进入 Harness 后新建 Session，fire-and-forget：没有去重、队列或完成结果。它不是这座桥的上行完成回调。

Harness 文档里的 MCP 是 Harness 作为客户端去调用外部工具。`dsh-bridge mcp` 是另一件事：协调代理调用这座桥的 stdio 工具。

## 还缺的证据

- 哪一个 profile 才是这次业务要使用的，不能从工作区名字推断。
- SuperAgent 派工要绑定到哪个 profile、工作区和 session。`state` 不够。
- 操作者准备把哪一个环境变量名交给 headless 当独立凭证。不要把值发回来。
