# 适配器

派工只经过 `ExecutorAdapter`：

- `dispatch(request) -> DispatchResult`，对同一个 `task_id` 必须幂等
- `cancel(request) -> CancelResult`，`confirmed=false` 时桥把取消记为 `unconfirmed`

## fake

`adapter = "fake"` 是测试、示例和 CI 的 dry-run。它在本地 JSON 文件里记住已经发出的 `session_id` 或 `ticket_id` / `run_id`，不打开网络连接。普通会话如果任务上已经有 `session_id`，就沿用该会话，用来表示返修回到原会话。

示例端点 `http://127.0.0.1:9` 与 `http://127.0.0.1:10` 只是配置里的占位，fake 适配器不会请求它们。

## harness

`adapter = "harness"` 是骨架。公开资料足以支持本仓库的路径模型：普通会话，以及用 ticket / run 跟踪的长程 SuperAgent。本仓库没有附带一份已经核对过的、可以创建会话、创建 SuperAgent 运行、取消它们或读取证据的请求格式。

因此这个适配器：

- 允许起草，因为起草不离开本机数据库
- 对 `dispatch` 和远端 `cancel` 抛出 `ProbeRequired`
- 不根据面板源码猜测 URL、端口或私有头
- 不把“能连上某个本机端口”写成已经接通

探测项：

| id | 还缺什么 |
| --- | --- |
| `documented_session_open_or_resume` | 打开或续上普通会话的受支持接口 |
| `documented_superagent_ticket_and_run` | 创建 SuperAgent 运行并返回 `ticket_id` 与 `run_id` 的受支持接口 |
| `documented_cancel` | 取消上述两种执行的受支持接口 |
| `documented_event_signature` | Harness 实际使用的事件签名，如何对应本桥的 `X-DSH-Signature` |
| `documented_evidence_read` | 证据文件的约定位置。桥现在只保存引用，不读取文件 |

在这些项有文档并且接入测试之前，不要把 `adapter` 改成 `harness` 并期望任务被发出。把真实令牌放进环境变量或 `~/.dsh-control-bridge/credentials.toml` 也不会让骨架开始发请求；`check` 只会报告变量或文件是否已填写，不会打印值。
