# 用 CLI 或 MCP 管理任务、事件与验收

需要让协调程序管理多套 Harness、记录批准与验收，或给 Grok Bot 等调用方提供工具时，使用 Python 包 `dsh-control-bridge`。CLI 和 MCP 共用协调桥的任务逻辑、SQLite 数据库和审计记录。只想从 Codex 操作本机 Harness Desktop，可以直接按 [Codex skill 安装指南](windows-delivery.md#codex-desktop-setup) 配对。

## 先用 fake 走一遍

在仓库根目录、已激活的 Python 3.11+ 虚拟环境中运行。下列示例用 POSIX shell；Windows 便携安装见 [Windows 手册](windows-delivery.md)。

```bash
python -m pip install -e .
python examples/e2e_fake.py
```

看到 `e2e: ok`，表示本地演示跑通了起草、批准、模拟派工、交卷、待验收和下一阶段草稿，也测试了未登记工作区会被拒绝。设置一份私有配置和数据目录，供后面所有命令复用。

```bash
STATE="$HOME/.dsh-control-bridge/demo"
mkdir -p "$STATE"
CFG="$STATE/bridge.toml"
DATA="$STATE/data"
cp -n examples/config.example.toml "$CFG"
bridge() {
  dsh-bridge --config "$CFG" --data-dir "$DATA" "$@"
}
bridge check
bridge inbox
```

`check` 检查 TOML 和凭据是否已设置。`diagnose`、`preflight` 给出本地诊断。三者都不能证实远端实例已连接。配置里每个 `[[instances]]` 有自己的 `id`、`base_url`、`auth_env`、`event_secret_env` 和工作区清单。不同实例的同名工作区分别授权。fake 配置里的端口 `9` 和 `10` 是占位值，无需启动监听器。[多实例配置样例](../examples/config.example.toml)

## 选择执行适配器

| `adapter` | 可执行的操作 | 所需配置 |
| --- | --- | --- |
| `fake` | 在本地模拟普通会话和 SuperAgent 的任务状态，供示例与 CI 使用 | [fake 多实例样例](../examples/config.example.toml) |
| `desktop_host` | 通过 Host 续接指定的、已有写授权的空闲 Desktop 普通会话。若需创建并回读主控会话，使用独立 Codex skill | 启用 `spawn`，设置 `host_bind`、`host_port`、`host_secret_env`、工作区 ID 和会话授权。[Desktop 样例](../examples/desktop-host.example.toml) |
| `headless_cli` | 启动官方 CLI 子进程执行普通任务；默认关闭。按退出码和最后的 `final.reason.kind` 判定结果 | 启用 `spawn`，绑定可执行文件、工作目录和凭据。复用已有 home 另需显式授权。[Headless 指南](headless-cli.md) |
| `harness` | 保留的通用适配器，可起草任务，发送时明确拒绝 | [连接契约](connector-contract.md) |

`ordinary_session` 用 `session_id` 跟踪。协调桥也支持给 `superagent` 类型起草任务，fake 会返回模拟的 `ticket_id` 和 `run_id`。实际的 SuperAgent 派工由已配置的官方 Source 触发，跟踪时核对真实 Assignment 和 worker session。[SuperAgent 用法](../skills/deepseek-harness-bridge/references/superagent.md)

## 在 CLI 中起草、批准和验收

以下命令沿用上面的 fake 配置。`--config`、`--data-dir`、`--json` 是全局选项，放在子命令前。先起草，再把响应中的 `task_id` 赋给 `TASK_ID`。

```bash
bridge --json dispatch --instance local-desktop --workspace broadcast-cs \
  --executor ordinary_session --title "整理阶段说明" \
  --objective "根据已有证据写一段说明。"
```

从授权样例复制一份到私有目录，写明这次批准的目标、范围、验收、额度声明、重试次数、允许动作和 UTC 到期时间。核对 `instance_id`、`workspace` 和 `executor` 与草稿一致，再执行发送命令。普通派工需 `dispatch`；Desktop 或共享 home 的指定会话续接还要求 `resume` 和匹配的 `session_id`。允许重试时另加 `retry`。额度声明不计量供应商账单。[mandate 样例](../examples/mandate.example.toml)

```bash
cp -n examples/mandate.example.toml "$STATE/mandate.toml"
# 编辑上述文件后，用草稿的实际 ID 替换下面的值
TASK_ID='复制返回的 task_id'
bridge dispatch --task "$TASK_ID" --mode send --mandate "$STATE/mandate.toml"
bridge status "$TASK_ID"
```

| 状态 | 操作者可以据此判断什么 |
| --- | --- |
| `pending` | 草稿已保存，或已批准且正在等适配器确认。可结合 `delivery` 区分。 |
| `running` | 适配器已确认接收。 |
| `awaiting_review` | 执行方已交卷。负责人检查证据后运行 `bridge accept "$TASK_ID"`，变为 `done`。如要起草下一阶段，在待验收状态下运行 `bridge next "$TASK_ID"`。 |
| `awaiting_user` | 执行方需要人工输入。 |
| `failed` | 查看失败原因和死信。桥只在授权允许且未达到重试上限时重试。 |
| `canceled` | 通过 `bridge cancel "$TASK_ID" --reason "取消原因"` 请求取消。只有远端确认才会记录 `cancel_confirmation=confirmed`。 |

`next` 保留父任务的目标实例和工作区，普通会话沿用原 `session_id`，新草稿需单独批准。恢复中断的已批准发送、取消时可以运行 `bridge recover`；发送适配器须按 `task_id` 去重。需要检查流转过程时查看同一数据目录里的 SQLite 与 `audit.jsonl`。[状态与存储](architecture.md)

## 配置 stdio MCP 客户端

让客户端启动与 CLI 同一虚拟环境中的 `dsh-bridge`。以下为采用 `mcpServers` 字段且支持本实现帧格式的启动器示例。将三条绝对路径替换为本机可执行文件、上文的配置和数据目录。Windows 虚拟环境中的程序通常位于 `.venv/Scripts/dsh-bridge.exe`。

```json
{
  "mcpServers": {
    "dsh-control-bridge": {
      "command": "/opt/dsh-bridge/.venv/bin/dsh-bridge",
      "args": ["--config", "/srv/dsh/bridge.toml", "--data-dir", "/srv/dsh/data", "mcp"]
    }
  }
}
```

这个进程只用 stdin/stdout 通信，无需 URL 或监听端口。v0.2.2 的 `initialize` 返回协议版本 `2024-11-05`，每条 JSON-RPC 消息须带 `Content-Length` 头和空行。如果客户端只支持一行一条 JSON 的 stdio 帧，它无法直接握手，可以使用上文的 CLI。客户端应先完成 `initialize`、`tools/list`，再以空参数调用 `inbox` 验证配置；仅运行 `dsh-bridge tools` 能检查本地工具目录，尚未验证客户端握手。[stdio 实现](../src/dsh_control_bridge/mcp_server.py)

工具有 `inbox`、`acknowledge`、`dispatch`、`status`、`cancel` 和 `diagnose`。通过 MCP 发出已批准的草稿时，`dispatch` 使用 `task_id`、`mode: "send"` 和操作者提供的 `mandate` **对象**。CLI 才接收 `--mandate` 文件路径。`accept` 和 `next` 可通过共用该数据目录的 CLI 执行。[工具清单与参数](mcp-tools.json)

## 接收签名事件与发送通知

只有需要 HTTP 事件收件箱时才运行 `serve`。将该实例的 `event_secret_env` 所指环境变量设置为私有随机密钥，接收进程与签名方使用同一值。以下示例在本机选用 `18887`；若换端口，同时改发送方 URL。此监听器的健康检查为 `GET /health`。

```bash
bridge serve --host 127.0.0.1 --port 18887
```

在第二个终端使用相同配置、相同密钥和同一事件文件。POSIX shell 下，`curl -H @-` 从管道读取签名命令输出的三个请求头；正文始终按原字节从文件读取。

```bash
CFG="$HOME/.dsh-control-bridge/demo/bridge.toml"
BODY=examples/event.stage_submitted.json
dsh-bridge --config "$CFG" sign --instance local-desktop < "$BODY" |
  curl -sS -H @- -H 'Content-Type: application/json' \
    --data-binary "@$BODY" http://127.0.0.1:18887/v1/events
```

签名覆盖时间戳、实例 ID 和原始正文。请求体上限为 64 KiB，默认验签时间窗为 300 秒。首次接受返回 HTTP 202，重复 `event_id` 返回 200，签名错误返回 401。样例带虚构任务 ID，可验证收件箱；测试任务变更时需在签名前填入与实际已发送任务匹配的绑定。事件中附带的指令和批准文字不会授权派工。用 `bridge inbox` 查看收件箱，`bridge acknowledge EVENT_ID` 标为已读。[事件样例](../examples/event.stage_submitted.json)

协调桥的出站通知在 `[notify]` 设置，默认为 `off`；`file` 写入数据目录，`webhook` 须同时配置 `webhook_url` 和 `allowed_hosts`，投递失败会记录失败状态。另一路 Desktop Host 出站通知使用独立的载荷和签名，配置见 [Host API](host-api.md)。密钥应通过对应的环境变量或受支持的私有凭据文件提供。[凭据与安全](../SECURITY.md)
