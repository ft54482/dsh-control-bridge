# Host 控制面 API（0.2.0）

进程内 Desktop Host 插件 `dsh-control-bridge-host` 的 loopback HTTP 契约。0.2.0 的每条能力都先按官方 0.2.2-rc.5 源码核对；夹具回归只证明协议行为和失败关闭，**不等于真机验收**。

## 鉴权与作用域

只监听 `127.0.0.1`，只接受 `Authorization: Bearer <secret>`，拒绝浏览器标记请求。两种 secret：

| Secret | 作用域 | 可达 |
| --- | --- | --- |
| 长期 `host.secret` | `host` | 全部管理/读写端点，包括全局发现、模型、创建、取消 |
| 短期配对窗口 | `bootstrap` | 只有 `GET /v1/bootstrap/catalog`、`POST /v1/bootstrap/select` |

窗口单次使用、默认 20 分钟、最长剩余寿命 60 分钟；过期/损坏/两个窗口文件互相矛盾都失败关闭。窗口写失败时，已花费窗口的 SHA-256 已随授权原子写入 `allowlist.json`，同一窗口不能产生第二条授权。重新布防只写 `bootstrap.json` / `bootstrap.secret`，不轮换 `host.secret`。

权限分成三层，互不替代：

1. **目录/状态元数据**（`/v1/discover`、`/v1/granted`、`/v1/models`）：需要 `host`，不读消息内容。
2. **历史内容**（`/v1/history`）：需要该会话的 `read` 或 `write` 授权。
3. **写操作**（`/v1/resume`、`/v1/cancel`、`/v1/access`、`/v1/revoke`）：需要该会话的 `write` 授权；创建类端点还需要配置里的能力开关和白名单根目录。

## 端点

### 读

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/health` | 进程/服务/窗口/授权状态；`bootstrap_retired` 表示授权文件已记录该窗口花费 |
| GET | `/v1/discover` | **0.2.0**：全部已注册工作区与会话的元数据，见下 |
| GET | `/v1/granted` | 已授权会话及模型状态 |
| GET | `/v1/workspaces` / `/v1/sessions` | 授权范围内的目录/会话 |
| GET | `/v1/history?session_id=` | 已授权会话的事件文本（脱敏），分页 |
| GET | `/v1/models?session_id=` | 该会话的 `last_used` / `pending` / `next` / `last_execution` |
| GET | `/v1/model-catalog` | **0.2.0**：provider → model → 官方 reasoning efforts；不可枚举时 `reasoning_efforts: null` + `unknown` |
| GET | `/v1/requests?request_id=&session_id=` | 持久请求记录；断线/重启后仍可读 |
| GET | `/v1/requests/:id/wait?timeout_ms=` | **0.2.0**：长轮询到终态；超时返回当前状态（任务继续） |
| GET | `/v1/requests/:id/events?after_seq=&timeout_ms=` | **0.2.0**：按 seq 增量取事件；无新事件时返回 heartbeat |
| GET | `/v1/requests/:id/stream` | **0.2.0**：SSE；`id:` = seq，心跳注释每 15s，终态发 `event: end` |

## 出站完成通知（0.2.0，默认关闭）

桥只做本机 loopback 观察还不够让协调方被唤醒，因此增加**上行 webhook**：官方终态（或 `needs_input`）→ 持久 outbox → 鉴权 HTTPS POST。它与官方 inbound webhook（外部请求进入 Harness 后新建 Session、fire-and-forget）是两条不同的链路，不能互相冒充。

配置（插件行；URL 与密钥只放本机安全配置）：

```yaml
    webhook:
      enabled: true
      url: https://receiver.example/dsh/complete   # 仅 HTTPS
      secret: <shared HMAC secret>                 # 不打印、不进仓库/日志/发布包
      allowedHosts: [receiver.example]             # 可选但建议
      eventTypes: [completed, failed, cancelled, needs_input, unknown]
      maxAttempts: 6
      timeoutMs: 5000
```

缺配置时默认关闭；`GET /v1/health` 的 `outbox_enabled`、`GET /v1/outbox` 只暴露状态元数据（不含 URL、密钥、载荷正文）。`eventTypes` 白名单至少应包含交卷、错误、等待输入、退出；`bridge_timeout` 只能显式加入，且 `completed:false`。

投递语义与字段：

- 每个事件绑定 `request_id`、`rpc_id`（本桥 prompt 的 rpcId）与 `turn`；`event_id` 由 `request_id + type + session + turn` 哈希得到，重试/重启不换号。
- 载荷只有最小状态：`event_id`、`type`、`request_id`、`rpc_id`、`turn`、`terminal`、`completed`、`outcome_scope`、`sequence`、`occurred_at`；**不含**消息文本、历史、标题、cwd、工作区名、会话 id 或凭据。接收方不得把其中的文字当指令执行。
- 请求头：`x-dsh-event-id`、`x-dsh-event-type`、`x-dsh-timestamp`、`x-dsh-signature: sha256=HMAC-SHA256(secret, timestamp + "." + body)`。
- outbox 落盘（`outbox.json`，原子写 + fsync）；重启后继续未完成事件；指数退避（1s/5s/30s/2m/10m），达到 `maxAttempts` 标记失败；接收方必须按 `event_id` 幂等重放。
- SSRF：只允许 `https://`、禁止 userinfo/fragment、`allowedHosts` 不匹配拒绝、DNS 解析到回环/私网/链路本地/保留地址拒绝。URL 在投递前重新校验。
- 状态区分：`completed`、`failed`、`cancelled`、`needs_input`、`unknown`；`bridge_timeout` 仅表示桥等待结束，`completed:false`；`accepted` 不产生完成通知。
- 真实接收端 URL/密钥目前**不存在**，本版本没有端到端接通；`GET /v1/requests` 与有时限轮询仍是兜底。

## 写

| 方法 | 路径 | 条件 |
| --- | --- | --- |
| POST | `/v1/resume` | 会话 `write`；`wait:false`/`wait_ms:0` 立即 202；`wait_ms` 上限 30 分钟 |
| POST | `/v1/wait/stop` | 只停桥等待，不动桌面回合 |
| POST | `/v1/cancel` | 该请求绑定自有未结束回合才调用官方 `cancel`；调用前重新判归属 |
| POST | `/v1/model` | 会话 `write`；`reasoning_effort:null` 清除旧 effort；`auto` 不是合法值 |
| POST | `/v1/access` / `/v1/revoke` | 会话/目录授权；撤销是唯一移除路径 |
| POST | `/v1/workspaces` | `allowCreateWorkspace` + `workspaceRoots`；注册已存在目录（可选创建一层） |
| POST | `/v1/sessions` | `allowCreateSession` + `workspaceRoots`；官方 `sessionController.create`，默认 `read` 授权 |
| POST | `/v1/open` | `allowOpenPath` + `workspaceRoots`；官方 `openWorkspacePath`，只打开不创建 |

创建类端点在未配置时返回 `403 *_disabled` / `no_allowed_roots`；官方服务未挂载时返回 `501 *_unavailable`；不猜方法、不落盘伪造。路径必须是已存在目录（或显式 `create_directory:true` 创建**一层**），按 realpath 校验在根内；根本身、兄弟前缀、`..` 穿越、逃出根的符号链接都拒绝。

## 请求状态与自动感知交卷

一条 resume 请求在 `requests.json` 里持久化：`phase`、`prompt_attempted`、`accepted`、`started_task`、`requested_model`、`confirmed_selection`、`effort_unverified`、`last_seq`、终态 `response`，以及有界事件日志 `events`（`seq` 单调递增）。阶段：

`recorded → accepted → （running）→ terminal | unknown`

- `terminal`：官方 `turn/end` 已到，`completed` 只在 reason 为 `completed` 时为真；错误、取消、模型/effort 不一致各自有终态。
- `unknown`：崩溃窗口里无法证明 prompt 是否被收下；`resend:false`，**不会自动重发**，只能人工对账。
- 桥的同步等待（默认 120s，可设 `wait_ms`）与桌面任务寿命分开；`wait:false` 立即返回 202，任务继续。

**协调方怎样自动感知交卷（真实机制，不是 webhook）**：协调方持有 host secret，对 `GET /v1/requests/:id/stream` 保持一条 loopback SSE 长连接，按 `Last-Event-ID` 断点续读；收到 `event: end` 即拿到终态。没有原生唤醒时，用 `/events?after_seq=N` 或 `/wait` 做有时限的轮询补偿——这是观察，不是实时推送。`inbound webhook` 不是完成信号，本版本也不向外部推送事件。进程重启后，`advanceRequest` 用持久记录里的 rpcId 重读官方日志，能证明终态就补写 `terminal`；证明不了就留在 `unknown`，绝不重发。

参考客户端（Python 标准库，仅示例）：

```python
import http.client, json

def finish(port, secret, request_id, last_seq=0):
    conn = http.client.HTTPConnection("127.0.0.1", port)
    conn.request("GET", f"/v1/requests/{request_id}/stream", headers={
        "Authorization": f"Bearer {secret}", "Accept": "text/event-stream",
        "Last-Event-ID": str(last_seq)})
    response = conn.getresponse()
    while True:
        line = response.readline()
        if not line:
            return None                      # 连接断了：用 last_seq 重连
        text = line.decode("utf-8").rstrip("\r\n")
        if text.startswith("id: "):
            last_seq = int(text[4:])
        elif text.startswith("data: "):
            payload = json.loads(text[6:])
            if payload.get("phase") == "terminal":
                return payload              # 含 completed / terminal / text / final
        elif text.startswith(":"):
            continue                        # heartbeat
```

## 全局发现

`GET /v1/discover?workspace_id=&kind=&status=&offset=&limit=`：

- 来源是官方 `workspaceRegistry.list()` + `sessionController.list()`；**不受授权白名单限制**（这是操作者已授权的全局视图），但不读消息内容。
- `kind`: `top` / `subagent` / `worker` / `unknown`；有 parent 的子会话不会被提根。
- `status`: `running` / `waiting_input` / `error` / `terminal` / `unknown`。`running` 来自 list 行；`waiting_input` 来自官方 `approvalState` / `userQuestions` / `inbox` 投影；`error` 来自 `conversationContinuation` 或显式状态；官方没有错误消息投影，所以拿不准就是 `unknown`，不会伪造终态。
- `cwd` 只来自会话行或工作区路径，`cwd_source` 标 `session_row` / `workspace` / `missing`。
- 分页稳定排序、按 session_id 去重；`counts` / `status_counts` 基于过滤后的全集；`includes_history:false`。

## 模型与思考深度

- 目录来自官方 `llm.listProviders()/listModels()`；effort 只在官方能枚举时给出（`llm.resolveModelInfo().reasoning.efforts` 或 `sessionController.modelCatalog()`），否则 `null` + `unknown`，不硬编。
- 设置单会话：`POST /v1/model` 或 resume 的 `model`。请求 effort 不在官方枚举中 → `409 unsupported_reasoning_effort`；无法枚举时接受并标 `effort_unverified:true`。
- 省略 effort = 跟随 adapter 默认，**不继承**上次 effort；`reasoning_effort:null` 显式清除。`auto` 不是官方值，传它会得到明确拒绝。
- 结果同时保留 `requested_model` / `confirmed_selection` / `execution_model`；一致性分 `route_match` / `effort_match` / `effort_verified` / `model_match`。只有路由和 effort 都可证且相等时 `model_match` 才为 true；执行头缺 effort 时 `effort_verified:false`、`model_match:null`，不拿模型名冒充。

## 配置（插件行）

```yaml
- id: dsh-control-bridge-host
  config:
    allowlistFile: C:/.../desktop-host-local/allowlist.json
    secretFile: C:/.../desktop-host-local/host.secret
    bootstrapFile: C:/.../desktop-host-local/bootstrap.json
    bootstrapSecretFile: C:/.../desktop-host-local/bootstrap.secret
    requestsFile: C:/.../desktop-host-local/requests.json
    # 以下默认关闭/为空；启用创建能力必须同时给根目录
    workspaceRoots: [C:/work]
    allowCreateSession: true
    allowCreateWorkspace: true
    allowOpenPath: true
```

## 能力矩阵

| 能力 | 状态 | 证据 |
| --- | --- | --- |
| 请求记录、断开后查询、重启后查询、`unknown` 不重发 | 隔离回归 | `lifecycle.test.js`、`control.test.js` |
| 长轮询 / SSE / heartbeat / seq / 断点续读 | 隔离回归 | `control.test.js` |
| 单会话模型 + effort + 清除 + 不一致拒绝 | 隔离回归 | `control.test.js` |
| 全工作区发现（分类/状态/分页/cwd 来源） | 隔离回归 | `control.test.js` |
| 创建工作区 / 新建会话 / 授权 / 打开目录 | 隔离回归（官方 API） | `create.test.js`、`paths.test.js` |
| 路径安全（穿越/前缀/根/符号链接） | 隔离回归 | `paths.test.js` |
| 配对窗口重新布防、单次使用、失败关闭 | 隔离回归 | `rearm.test.js` |
| 真机安装、真机取消/配对/创建、真实长任务回传 | **未验证** | 见 `verified-scope.md` |

## 已知边界

- 没有外部推送/唤醒；协调方必须能访问 loopback（或经自己的安全隧道）。默认不监听外网。
- 官方没有 compare-and-cancel；取消是“调用前重读并拒绝已变化”，不是事务级保证。
- 新建会话的模型选择：`create` 不选模型；bridge 只在已有 live Agent 且空闲时设置显式模型，否则返回 `source:deferred`，首次 prompt 可能得到 `needs_ui`/`model_unknown`。不修改部署默认。
- 全局发现的状态依赖官方 projection；未挂载相应 projection 时只能 `unknown`；不读历史来猜。
- `requests.json` 目前没有保留期上限；事件日志每请求最多保留 200 条。
- 以上全部是夹具结果。真机 Desktop 验收仍未做。
