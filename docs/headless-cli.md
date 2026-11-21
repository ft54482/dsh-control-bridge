# Headless CLI

普通任务可以走官方 headless profile。这个适配器按已核对的 CLI 帮助和 `packages/bundle/headless` 说明构造进程，但默认 `spawn = false`，所以安装和测试不会启动 `dsh`，也不会发出模型请求。

成功必须同时满足：进程退出码是 0，并且 NDJSON 末尾事件 `final.reason.kind` 是 `completed`。只有退出码、或只有 `final`，都不算完成。进程级 `error` 没有 `final`。回合失败可以带一个空的 `final`。

## 调用

argv 固定为：

```text
dsh --profile headless --json -
```

恢复时在 `-` 之前加入 `--session-id` 和已经见过的 id。任务正文只放在 stdin，不放进 argv，避免 Windows `dsh.cmd` 把 `%`、`&` 一类字符再解释一遍。`shell` 始终关闭。

每次新任务都会得到新的 session id。`--session-id` 只接受本适配器已经记录、并且 cwd 与 profile 都一致的 id。未知 id 或目录不符会在启动前拒绝。

工作目录是该工作区配置的绝对路径。headless 不是正在打开的 desktop 工作区。`desktop` profile 由 Electron 独占，CLI 不能启动它，配置里写 `profile = "desktop"` 会被拒绝。

子进程的 `DSH_HOME` 指向桥自己的数据目录，不指向桌面正在使用的 home。适配器不读取、不复制桌面凭证文件。只有 `credential_envs` 里点名的环境变量会传给子进程。

取消会先终止当前进程并等待它退出，然后才允许下一次恢复。

## 明确不做

- 不把 SuperAgent 的 `GET /orchestrator/api/state` 当成派工依据。那份状态没有 profile、工作区或 session 绑定。
- 不连接 `17300` 或 `49290`。
- 不把官方 webhook 当成完成回调。那条路径是外部请求进入 Harness 后新建 Session，fire-and-forget，没有去重、队列或结果。
- 不把 Harness 作为 MCP 客户端去调用外部工具，说成这座桥的上行通道。本仓库自己的 `dsh-bridge mcp` 仍是协调代理调用桥的 stdio 服务。
