# 命令全集、状态机与事件契约

对照的是 v0.2.2 的 `src/dsh_control_bridge/cli.py` 和上游 `README.md`。下文 `dsh-bridge` 代表 `python "<skill>/dsh-bridge.py" --config <配置> --data-dir <数据目录>`。

## 全局选项

写在子命令**前面**：

| 选项 | 含义 |
| --- | --- |
| `--config PATH` | 桥的 TOML 配置。默认是当前目录的 `bridge.toml`，所以永远显式写 |
| `--data-dir PATH` | SQLite 和审计目录。默认是当前目录的 `data`，所以永远显式写 |
| `--json` | 输出机器可读的 JSON |
| `--version` | 打印 `dsh-bridge 0.2.2` |

退出码：`0` 成功；`2` 是桥拒绝了这个请求，比如目标未登记、缺 mandate、配置无效，原因打在 stderr。启动器自己还会用 `3` 表示没有配置检出。

## 子命令

| 命令 | 作用 | 要点 |
| --- | --- | --- |
| `self-check` | 进程内的隔离自检 | 不读配置，不碰 Harness，临时目录里跑完即删 |
| `tools` | 打印 MCP 工具目录 | 和 `docs/mcp-tools.json` 是同一份 |
| `check` | 校验配置，报告各环境变量有没有设置 | 不打印变量的值；`connected_to_harness` 恒为 `false` |
| `diagnose` | 本机预检 | 只读配置和一份脱敏事实文件，不访问网络 |
| `preflight [--facts PATH]` | 把事实文件和连接契约比对 | `calls_network` 为 `false` |
| `inbox [--instance ID] [--workspace NAME]` | 列出未确认事件和等人处理的任务 | 待批准、待验收、等待人工输入的都在这里 |
| `acknowledge EVENT_ID` | 把一条收件箱事件标成已读 | 已读不是验收通过 |
| `dispatch …` | 起草任务，或发送已批准的任务 | 见下 |
| `status TASK_ID` | 一个任务的状态、最近摘要、投递尝试和死信 | |
| `next TASK_ID` | 起草下一阶段的任务书，不发送 | 只在 `awaiting_review` 时可用 |
| `accept TASK_ID` | 负责人验收，任务变为 `done` | 只在 `awaiting_review` 时可用 |
| `cancel TASK_ID --reason TEXT` | 取消任务，并记录远端的确认 | `--reason` 必填 |
| `ingest --body FILE --instance ID` | 把一个事件文件按 webhook 的同一套校验入库 | 自己用环境变量里的密钥算签名，不开端口 |
| `sign --instance ID` | 为 stdin 上的正文打印三个签名头 | 打印 `X-DSH-Timestamp`、`X-DSH-Instance`、`X-DSH-Signature` |
| `serve [--host 127.0.0.1] [--port 8787]` | 监听签名 webhook 事件 | 只绑定本机回环地址 |
| `mcp` | 启动 stdio 的 MCP 工具服务 | 分帧和标准客户端不兼容，见 `develop.md` |
| `recover` | 续上进程中断时没做完的发送和取消 | 打印恢复记录 |
| `sessions --instance ID` | 列出配置里授权的工作区和会话元数据 | 默认不拨号，只读配置 |
| `history --instance ID --session ID [--offset N] [--limit N]` | 分页读桥自己留下的脱敏记录 | 不是官方会话日志，也不是原生 resume |
| `home --instance ID` | 打印不含密钥的 home 计划 | 列出操作者要填的字段 |

### `dispatch` 的参数

新建任务时必须给出 instance、workspace 和 executor：

```bash
dsh-bridge dispatch --instance local-desktop --workspace broadcast-cs --executor ordinary_session \
  --title "整理阶段说明" --scope "只处理当前任务书。" --acceptance "负责人接受之前不算交付。" \
  --objective "根据证据引用写一段说明。"
```

| 参数 | 含义 |
| --- | --- |
| `--instance`、`--workspace` | 目标。必须是配置里登记的组合 |
| `--executor` | `ordinary_session` 或 `superagent` |
| `--title`、`--objective` | 任务书的标题和目标 |
| `--scope`、`--acceptance` | 范围和验收标准，默认是空串 |
| `--session` | 可选。返修时带上原来的 `session_id`，普通会话会回到同一个会话 |
| `--mode` | `draft`（默认）或 `send` |
| `--mandate PATH` | `send` 时必须给。`draft` 模式下带了也不会发送：对已有任务是被忽略，对新建任务会把它存在草稿上。MCP 的 `dispatch` 工具不一样，会直接拒绝带 mandate 的草稿 |
| `--task TASK_ID` | 对已有任务操作时给 |

## 状态机

| 状态 | 含义 |
| --- | --- |
| `pending` | 已起草，或者已批准但还没有收到执行端的确认 |
| `running` | 已发到适配器，并收到了确认 |
| `awaiting_review` | 执行器交卷，等负责人验收 |
| `awaiting_user` | 执行器在等人工输入 |
| `failed` | 失败，或者进了死信 |
| `done` | 负责人验收通过 |
| `canceled` | 已取消。远端未确认时 `cancel_confirmation` 是 `unconfirmed` |

几条不变的规定：

- `awaiting_review` 不会自己走到 `done`。只有 `accept` 能。
- 进入 `awaiting_review` 之后，执行器不能再靠一条 `error` 或 `started` 把任务拉走。
- 还没发送的草稿会忽略启动和交卷事件，所以一份 webhook 不能把草稿说成“已经在跑”。
- 返修是一条新的任务书。普通会话继承原来的 `session_id`；SuperAgent 不把上一张 ticket 当成同一次运行。
- 发送前检查三件事：目标已登记、mandate 没过期且包含 `dispatch`、适配器声明自己可以发送。`harness` 适配器声明不能发送，所以草稿保持草稿。
- 进程在“已批准但还没写回远程 id”时停掉，下次启动会按 `task_id` 续上，而且只有一个恢复过程能领走这次发送。`AdapterError` 在同一次发送里按 `retry_limit` 重试，次数用尽就进死信，没有无限循环。

## mandate

发送时要显式给一份 TOML 文件，样例是 `examples/mandate.example.toml`：

```toml
instance_id = "local-desktop"
workspace = "broadcast-cs"
executor = "ordinary_session"
objective = "完成任务书里已经写明的那一步。"
scope = "只处理当前任务书。不发布，不合并，不扩大范围，不增加预算。"
acceptance = "执行器返回后进入待验收。负责人接受之前不算交付。"
budget_cap = "fake-adapter-only"
retry_limit = 2
expires_at = "2099-01-01T00:00:00Z"
allowed_actions = ["dispatch", "retry"]
```

- `instance_id`、`workspace`、`executor` 必须和任务上的目标一致，否则不续发。
- `allowed_actions` 只有 `dispatch` 和 `retry`。`budget_cap` 只是一句额度声明，不能写成动作，也不会触发调用。
- mandate 过期、来源不是操作者，或者目标和任务对不上，都不再续发。
- 来源只能是操作者的 mandate 文件，或者 MCP 工具参数，不能来自事件正文。

## 事件契约

上行是 `POST /v1/events`，要带三个头：

| 头 | 内容 |
| --- | --- |
| `X-DSH-Timestamp` | Unix 秒 |
| `X-DSH-Instance` | 实例 id |
| `X-DSH-Signature` | 对 `v1`、时间戳、实例 id 和正文算出来的签名 |

- 密钥来自该实例的 `event_secret_env`。一台实例的密钥不能给另一台签名。
- 时间戳超出配置窗口会被拒绝，默认窗口 300 秒，最大 900 秒，所以旧报文不能隔天重放。请求体上限 64 KiB。
- 只提取这些字段：`event_id`、`event_type`、`occurred_at`、`instance_id`、`workspace`、`executor`、`task_id`、`session_id`、`ticket_id`、`run_id`、`commit_sha`、`evidence`。
- `event_type` 可以是 `stage_submitted`、`error`、`awaiting_input`、`exited`、`started`、`cancel_ack`。
- `stage_submitted` 把已发送的任务放到 `awaiting_review`。`cancel_ack` 只确认本地已经发起的取消。
- 重复的 `event_id` 记一次重复，状态保持原样。签名错误或超出时间窗不会占用这个 id。未登记的实例或工作区进死信。
- 没有对应任务时，事件进收件箱，任务状态不会被改写。
- `evidence` 里的引用必须是相对路径。桥不会按 payload 去打开文件，所以摘要不能把“文件里写了什么”说成已经核对过。
- `allow_unsigned = true` 本身不会关掉验签。只有同时设了环境变量 `DSH_BRIDGE_DEV_UNSIGNED=1`，才在本机测试时跳过签名。

## 通知

默认 `off`。`file` 把脱敏后的记录写进数据目录。`webhook` 只有在配置了 URL、而且主机在 `allowed_hosts` 里时才发送；失败记为 `failed`，不会被写成已送达。审计和错误文本会去掉密钥形状的片段。

## 审计

状态放在本地 SQLite。`audit.jsonl` 只追加，不回写，不记录 payload 原文和密钥。
