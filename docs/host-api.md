# Host 控制面 API（0.2.2）

进程内 Desktop Host 插件 `dsh-control-bridge-host` 的 loopback HTTP 契约。0.2.0 的每条能力都先按官方 0.2.2-rc.5 源码核对；夹具回归只证明协议行为和失败关闭，**不等于真机验收**。本分支另加操作者开关 `workspaceAutonomy`（[工作区自主](#workspace-autonomy-api)），未发布、未合并。

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
- 真机验收使用 SSE 和有时限轮询。签名接收端尚未配置，真实 webhook 投递仍待验证。

## 写

| 方法 | 路径 | 条件 |
| --- | --- | --- |
| POST | `/v1/resume` | 会话 `write`；`wait:false`/`wait_ms:0` 立即 202；`wait_ms` 上限 30 分钟 |
| POST | `/v1/wait/stop` | 只停桥等待，不动桌面回合 |
| POST | `/v1/cancel` | 该请求绑定自有未结束回合才调用官方 `cancel`；调用前重新判归属 |
| POST | `/v1/model` | 会话 `write`；`reasoning_effort:null` 清除旧 effort；`auto` 不是合法值 |
| POST | `/v1/access` / `/v1/revoke` | 会话/目录授权；撤销是唯一移除路径 |
| POST | `/v1/workspaces` | `allowCreateWorkspace` + `workspaceRoots`；注册已存在目录（可选创建一层）。`workspaceAutonomy` 生效且带 `task_id`+`purpose` 时按[工作区自主](#workspace-autonomy-api)处理：仍要 `allowCreateWorkspace`，但不再校验根目录。 |
| POST | `/v1/sessions` | 需要 `allowCreateSession` 和允许的工作区根目录。通过官方 `sessionController.create` 创建，默认授予 `read`；传入 `agent_preset` 时还会核验预设。`workspaceAutonomy` 生效且带 `task_id`+`purpose` 时按工作区自主流程处理。 |
| POST | `/v1/workspaces/revoke` | （本分支）删除该工作区授权及其下所有会话授权；不删目录、不取消回合。 |
| POST | `/v1/open` | `allowOpenPath` + `workspaceRoots`；官方 `openWorkspacePath`，只打开不创建 |

创建类端点在未配置时返回 `403 *_disabled` / `no_allowed_roots`；官方服务未挂载时返回 `501 *_unavailable`；不猜方法、不落盘伪造。旧路径的路径必须是已存在目录（或显式 `create_directory:true` 创建**一层**），按 realpath 校验在根内；根本身、兄弟前缀、`..` 穿越、逃出根的符号链接都拒绝。工作区自主生效时的任务请求改用“绝对路径”判定（不做可写性检查，见下节），但仍只允许 `create_directory:true` 建一层。

### 新建会话时核验主控预设

Codex Skill 默认在选定的工作区新建 `master-control` 会话。该预设需由操作者安装到 Harness。在原有任务上继续工作时，Skill 直接续接原会话。

从 0.2.2 起，带预设的新会话必须使用已配对工作区的 ID。Host 比对授权目录和 Desktop 实际登记的目录。若工作区在已有 `workspaceRoots` 之外，可以在 Host 插件配置中添加 `presetSessionWorkspaceIds: ["WORKSPACE_ID"]`，仅允许在该工作区创建预设会话。新会话申请写入时，该工作区还需有现存的可写会话授权。这项配置只用于预设会话创建，原有的打开路径与创建工作区边界继续生效。**例外**：操作者开启 `workspaceAutonomy` 且 `health.workspace_autonomy.effective` 为 `true` 时，带 `task_id`+`purpose` 的请求只放宽这两条（需要已有写会话、必须在根内），其他约束不变，见[工作区自主](#workspace-autonomy-api)。

1. `GET /v1/health` 的 `preset_create_verified: true` 表明 Host 能查询预设、创建会话并读取会话当前的预设。工作区的创建权限仍单独检查。
2. 向 `POST /v1/sessions` 提交 `{"workspace_id":"WORKSPACE","agent_preset":"master-control"}`。Host 先在 Harness 注册表里解析预设，再比对创建回执和会话投影，成功后才为新会话保存桥接授权。
3. 确认响应中的 `workspace_id`、`session_id`、`agent_preset: "master-control"`、`agent_preset_source: "session_projection"` 及 `started_task: false`。需要派工时再调用 `resume`。

创建后核验失败时，先用已返回的会话 ID 到 Desktop 核对；若连接中断且没有 ID，从原工作区查找新会话，避免重复创建。使用旧 Host 时可在 Desktop 手动新建并核对标题旁的预设，再按已有授权流程继续。[Codex 操作指南](../skills/deepseek-harness-bridge/references/desktop.md#new-work-in-master-control-mode)

<a id="workspace-autonomy-api"></a>

## Workspace autonomy（本分支，未发布）

操作者开关 `workspaceAutonomy`，默认关闭。关闭时下列端点与字段都不参与：旧路径的请求与响应逐字节不变。开启且**生效**时，带 `task_id`+`purpose` 的调用可以把任意绝对目录登记成工作区、取得任务范围的写授权，并在还没有写会话的工作区里建第一个写会话。Host 不对目录做可写性检查（只做 realpath 归一，必要时建一层），真正能写什么由该账号的文件系统权限决定——这就是为什么它必须由操作者显式开启。语义与安全边界见[插件说明](../plugins/dsh-control-bridge-host/README.md#workspace-autonomy-opt-in-per-operator-this-release)和[安装与回退](windows-delivery.md#workspace-autonomy)。

### 生效判定

```yaml
- id: dsh-control-bridge-host
  config:
    allowlistFile: <file>
    workspaceAutonomy: true          # 或 { enabled: true }；缺省/false = 旧行为
    autonomyRecordFile: <file>       # 可选；默认 dirname(allowlistFile)/workspace-autonomy.jsonl
```

`effective = enabled && allowlistFile 已配置 && workspaceRegistry.create 可调用 && sessionController.create 可调用 && sessionController.projections 可调用`。`GET /v1/health` 的 `workspace_autonomy` 块：

| 字段 | 含义 |
| --- | --- |
| `configured` / `enabled` | 配置项是否存在 / 是否为真 |
| `effective` | 上述合取；只有它为 `true` 时新流程才服务请求 |
| `reason` | 生效时 `null`；否则是第一个缺口：`not_configured`、`disabled`、`allowlist_file_missing`、`workspace_create_unavailable`、`session_create_unavailable`、`session_projections_unavailable` |
| `require_task` | 恒为 `true`：新流程一律要 `task_id`+`purpose` |
| `roots_mode` | 开关为真时 `unrestricted`，否则 `configured_roots`（是声明，不是额外能力） |
| `grant_store` | `file`（配置了 `allowlistFile`）或 `memory` |
| `record_file` | 操作记录路径；已知即如实上报 |
| `operations` | 本次进程已读入加已追加的记录条数 |

已配置但未生效时**失败关闭**：带任务意图的写请求返回 `403 workspace_autonomy_not_effective`，不会回落到标准模式。

### 端点

| 方法 | 路径 | 新字段 / 行为 |
| --- | --- | --- |
| POST | `/v1/workspaces` | 新 body：`path`（绝对路径，必填）、`task_id`（1..200）、`purpose`（1..500）、`create_directory`、`confirm_task`、`client_request_key`、`title`。路径用 `fs.realpathSync.native` 归一，按归一后的路径串行，resolve → create → 再 resolve 取权威 id，然后写任务范围的 workspace 授权（`source: "autonomy"`）。不带任务意图时旧路径照原样回答；根外路径、或已登记但无授权的工作区，会要求补 `task_id`+`purpose`（`400 task_required`）。 |
| POST | `/v1/sessions` | 新 body：`path` 或 `workspace_id`，加 `task_id`、`purpose`、`agent_preset`、`access`、`model`、`confirm_task`、`client_request_key`、`title`。顺序固定：先按需登记并授权路径 → 校验 model → `sessionController.create` → 用 `sessionController.projections` 证实预设 → 再写会话授权。不带任务意图但只有新流程能服务（给了 path / 要第一个写会话 / 工作区在根外）：`400 task_required`；工作区已被撤销：`403 workspace_not_allowlisted`（补任务也修不回来）。 |
| POST | `/v1/workspaces/revoke` | body `{workspace_id}`。一次原子写里删除该 workspace 授权及其下所有 session 授权；返回 `revoked{workspace,sessions}`、`directory_intact`、`revision`。**不删目录、不取消回合**，且不属于任务范围流程（策略关闭时也可用，因为它只减不增）。 |
| GET | `/v1/health` | 增 `workspace_autonomy` 块（见上）。 |
| GET | `/v1/workspaces` | 每行增 `task_id`（拥有该工作区的任务，旧授权为 `null`）。 |

回执字段（只增不改）：

- workspace：`ok`、`workspace_id`、`workspace{id,title,path}`、`path`、`created`、`reused`、`created_directory`、`task{task_id,purpose,confirmed,previous_task_id}`、`grant{workspace_id,path}`、`autonomy{enabled,effective}`、`started_task:false`、`recorded`（追加失败时另有 `record_error`）。
- session：`ok`、`session_id`、`workspace_id`、`path`、`agent_preset`、`agent_preset_source:"session_projection"`、`access`、`grant{session_id,workspace_id,access,cwd,task_id,source}`、`model`、`revision`、`task_id`、`purpose`、`workspace_created`、`workspace_reused`、`deduplicated`、`started_task:false`、`recorded`，修复授权时多 `repaired:true`。
- revoke：`ok`、`workspace_id`、`revoked{workspace,sessions}`、`directory_intact`、`started_task:false`、`revision`。

### 错误码

| 状态 | `reason` | 触发条件 |
| --- | --- | --- |
| 400 | `task_required` | `task_id`/`purpose` 缺失、空白或超长；也表示「这个旧形状请求只有新流程能服务，请补任务」 |
| 400 | `invalid_client_request_key` | `client_request_key` 不符合 `^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$` |
| 400 | `missing_path` / `invalid_path` / `missing_directory` / `missing_parent` / `not_a_directory` / `unreadable_path` / `create_failed` | 路径解析失败：非绝对、不存在且未要求创建、父目录不存在（只允许建一层）、不是目录等 |
| 403 | `workspace_autonomy_not_effective` | 带任务意图但策略未生效（附 `autonomy_reason`） |
| 403 | `workspace_not_allowlisted` | 工作区没有授权（含撤销后） |
| 409 | `workspace_task_mismatch` | 工作区已属于另一个任务且未传 `confirm_task:true`（附 `existing_task_id`） |
| 409 | `idempotency_key_reused` | 同一 key 换了 operation 或换了参数（`previous_operation`、`mismatched`） |
| 409 | `authorization_stale` | 重放时的授权已被撤销、降权、移除或被别的任务接管（`historical` + `current.reason`） |
| 409 | `agent-preset/invalid` | 预设 id 不能解析成该确切 id |
| 409 | `agent_preset_unverified` | 会话已建，但投影没有回读该预设；去 Desktop 核对该会话，不要重试创建 |
| 409 | `session_already_granted` | 修复请求发现该会话已授权 |
| 500 | `grant_persist_failed` | 会话已建但授权落盘失败；用同一 key 重试即修复 |
| 502 | `workspace_grant_failed` | 工作区已登记但授权落盘失败（`manual_reconcile`） |
| 502 | `workspace_unresolved` / `create_returned_no_session_id` / `session/workspace-attach-failed` | 官方调用半成功；先对账再决定重试 |

### 幂等语义

`client_request_key` 是可选的全局键，绑定「一个 operation + 一组参数」。参与绑定的参数是 `task_id`、`purpose`、`path`、`workspace_id`、`agent_preset`、`access`、`model`、`confirm_task`（workspace 操作只看与工作区身份有关的字段）。

| 情形 | 结果 |
| --- | --- |
| 同 key、同 operation、同参数，授权仍有效 | `200`，回执加 `deduplicated:true` |
| 同 key，operation 不同（workspace ↔ session） | `409 idempotency_key_reused`，带 `previous_operation`，**不重放** |
| 同 key，operation 相同但参数不同 | `409 idempotency_key_reused`，带 `mismatched`（差异字段名） |
| 同 key、同参数，但授权已撤销/降权/任务变更 | `409 authorization_stale`：`historical` 是旧成功摘要，`current.reason` ∈ `revoked`、`missing`、`access_changed`、`task_changed` |

补充约束：一次 Session 请求内部为路径做的登记**不消费**调用方的 key（记录 `client_request_key:null`、`parent_key` 指向该请求），所以 Session 重试不会重放 workspace 回执；`confirm_task` 的接管记录同样只作证据、不绑定 key；修复路径（`repaired:true`）在重放前重新核验授权，撤销过的 workspace 不会被重试复活。

### 操作记录

`workspace-autonomy.jsonl`，一行一个 JSON 对象，固定 17 个键：`at`、`op`、`operation`（`workspace` 或 `session`）、`workspace_id`、`path`、`task_id`、`purpose`、`session_id`、`preset`、`access`、`client_request_key`、`parent_key`、`request_hash`、`request`、`phase`、`result`、`reason`（不适用写 `null`），成功行再加 `receipt`，撤销行加 `revoked`。行分两类：**绑定行**（`workspace_create`/`workspace_reuse`/`workspace_grant_failed`、`session_create`/`session_grant`/`session_grant_failed`）回答调用方并占有 key；**证据行**（`workspace_task_confirmed`、`workspace_revoke`）只记录发生过什么，既不绑定 key 也不降级已有绑定。记录不含 bearer、密钥、提示词正文。追加失败只报 `recorded:false` + `record_error`，不回滚已落盘的授权。`purpose` 原样保存。

### 首次启动门禁

从未配对过的 profile 没有授权（空数组，或文件不存在）。只有在下列条件同时成立时才允许监听并从零创建：

1. 策略**真的生效**（`effective:true`，不是配置项存在）；
2. 长期 secret 可读且长度 ≥ 32；
3. 官方服务已挂载（`sessionController`、`workspaceRegistry`、`sessionQuery`）；
4. 绑定 `127.0.0.1`；
5. 授权文件缺失，或是合法的空授权——零字节、坏 JSON、结构非法仍是 `allowlist_unreadable`。

不预灌任何授权（第一条授权才创建文件），也不需要布防配对窗口；窗口仍然只在没有策略时作为另一条入口，不能用来绕过未生效的策略。其余拒绝理由全部保留：默认关闭 + 空授权 → `no steady allowlist and no armed bootstrap`；缺 secret / 缺服务 / 非 loopback → 原拒绝；授权文件不可读 → `allowlist_unreadable`。启动结果另报 `autonomy{configured,enabled,effective,reason}`。隔离 profile 的复跑步骤见[安装与回退](windows-delivery.md#workspace-autonomy)；四处“0.2.2”分别指什么，见[验收范围](verified-scope.md#version-map)。

## 请求状态与自动感知交卷

一条 resume 请求在 `requests.json` 里持久化：`phase`、`prompt_attempted`、`accepted`、`started_task`、`requested_model`、`confirmed_selection`、`effort_unverified`、`last_seq`、终态 `response`，以及有界事件日志 `events`（`seq` 单调递增）。阶段：

`recorded → accepted → （running）→ terminal | unknown`

- `terminal`：官方 `turn/end` 已到，`completed` 只在 reason 为 `completed` 时为真；错误、取消、模型/effort 不一致各自有终态。
- `unknown`：崩溃窗口里无法证明 prompt 是否被收下；`resend:false`，**不会自动重发**，只能人工对账。
- 桥的同步等待（默认 120s，可设 `wait_ms`）与桌面任务寿命分开；`wait:false` 立即返回 202，任务继续。

协调方可以通过 `GET /v1/requests/:id/stream` 观察请求，使用 `Last-Event-ID` 断点续读。收到 `event: end` 后查看 `phase`，再通过 `/v1/requests` 确认 `terminal_scope` 和完整结果。也可以用 `/events?after_seq=N` 或 `/wait` 做有时限的轮询。启用出站 webhook 后，还可由接收端处理完成通知。进程重启后，`advanceRequest` 用持久记录里的 rpcId 重读官方日志，能证明终态就补写 `terminal`，证明不了就留在 `unknown`。

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
                return payload              # 状态帧。完整结果通过 /v1/requests 读取。
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
| 工作区自主：任务范围登记/复用/写授权、任务归属与 `confirm_task`、忙会话不抢占、撤销只撤授权 | 隔离回归（本分支，未发布） | `test/autonomy-cases.js`（经 `test/create.test.js` 导入） |
| 工作区自主：幂等键按 operation 绑定、`idempotency_key_reused`、撤销/降权后 `authorization_stale`、修复不复活撤销 | 隔离回归（本分支，未发布） | `test/autonomy-cases.js` |
| 工作区自主：空授权首启门禁（生效即监听、未生效仍拒、零字节仍拒、不预灌） | 隔离回归（本分支，未发布） | `test/startup-cases.js`、`test/startup-probe.js` |
| 真机安装、发现、创建、打开、配对、短任务终态与 SSE 续读 | Windows Desktop 实测 | 见 [真机验收](verified-scope.md) |

## 已知边界

- 控制面只监听 loopback。出站 webhook 需单独配置 HTTPS 接收端，唤醒和展示由接收端负责。
- 官方没有 compare-and-cancel；取消是“调用前重读并拒绝已变化”，不是事务级保证。
- 新建会话的模型选择：`create` 不选模型；bridge 只在已有 live Agent 且空闲时设置显式模型，否则返回 `source:deferred`，首次 prompt 可能得到 `needs_ui`/`model_unknown`。不修改部署默认。
- 全局发现的状态依赖官方 projection；未挂载相应 projection 时只能 `unknown`；不读历史来猜。
- `requests.json` 目前没有保留期上限；事件日志每请求最多保留 200 条。
- 活动回合取消、真实长任务跨等待窗口，以及外部通知交付仍待真机验证。
