# 适配器

派工只经过 `ExecutorAdapter`：

- `dispatch(request) -> DispatchResult`，对同一个 `task_id` 必须幂等
- `cancel(request) -> CancelResult`，`confirmed=false` 时桥把取消记为 `unconfirmed`

## fake

`adapter = "fake"` 是测试、示例和 CI 的 dry-run。它在本地 JSON 文件里记住已经发出的 `session_id` 或 `ticket_id` / `run_id`，不打开网络连接。普通会话如果任务上已经有 `session_id`，就沿用该会话，用来表示返修回到原会话。

示例端点 `http://127.0.0.1:9` 与 `http://127.0.0.1:10` 只是配置里的占位，fake 适配器不会请求它们。

`adapter = "harness"` 仍然拒绝发送。`adapter = "headless_cli"` 按 [headless-cli.md](headless-cli.md) 构造普通 CLI 进程，默认不启动。desktop profile 不能用这条路径拉起。

## harness

`adapter = "harness"` 仍然只起草、不发送。普通会话的已核对路径在 `headless_cli`。SuperAgent 管理面状态不能当成派工，长任务继续拒绝。这个适配器不发起 HTTP，也不启动 `dsh.cmd`。
