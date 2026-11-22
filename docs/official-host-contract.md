# 官方 Desktop Host 契约复核（Stage A）

## 目标与环境

本文只复核官方 Host 契约，再与 `plugins/dsh-control-bridge-host` 的主张逐条对照。这是安装包源码审阅，不是真机通过：没有启动 Desktop，没有发送 prompt，也没有调用 cancel，不会写成真机结论。锚点写法是 `包名 src/文件:行`；仓库内文件用仓库相对路径。

安装的桌面壳是 `@deepseek-ai/dsh-desktop@0.2.2-rc.5`，其中 dsh 运行时同为 0.2.2-rc.5。本文引用的官方包版本均为 0.2.2-rc.5：

| 包 | 本文用法 |
| --- | --- |
| `@deepseek-ai/dsh-api-session-controller` | `sessionController` 与 Remote `session/*` 方法 |
| `@deepseek-ai/dsh-session-query`、`dsh-session` | `readSession`/`observeSession`、`SessionHeader`、`turn/end` |
| `@deepseek-ai/dsh-agent`、`dsh-agent-loop` | `agents` 注册表、`Agent`、`modelSelection` 投影、取消后写 `turn/end` |
| `@deepseek-ai/dsh-llm`、`dsh-agent-default-model`、`dsh-workspace` | `llm`、`agentDefaultModel`、`workspaceRegistry` |
| `@deepseek-ai/dsh-typert-protocol`、`dsh-api-gateway`、`dsh-api-remote-access` | Remote 取消槽、错误码、访问控制 |
| `@deepseek-ai/dsh-session-projection-cache`、`dsh-session-title`、`dsh-tool-todo` | 投影缓存行、`title` 投影、`todo/write` 事件 |
| `@deepseek-ai/dsh-web-app`、`dsh-headless`、`dsh-app-boot` | 组合是否挂载、安装兼容检查 |

## 官方接口

### 1. `sessionController.prompt(request, signal)`

| 项 | 官方事实 | 锚点 |
| --- | --- | --- |
| 请求 | `{ requestId, sessionId, mode: 'queue' \| 'steer', content, clientTimeZone? }` | `dsh-api-session-controller src/types.ts:324-332` |
| signal | 必需；第一行 `signal.throwIfAborted()`，缺失时抛 `TypeError`，不是 `RemoteError` | `src/index.ts:467-469` |
| 内容/时区校验 | 非空数组必须含非空白文本或附件，否则 `gateway/bad-request`；时区非法则 `session/invalid-time-zone` | `src/index.ts:470-482` |
| 返回 | 只有 `{ accepted: true }`，表示进入 inbox，不表示执行或完成 | `src/types.ts:335-337`；`README.md:30` |
| rpcId | Remote 方法把 `requestId` 写入 durable `user/message` 的 `source.rpcId`；空内容用 `kind: 'retry'`，否则 `'user'` | `src/index.ts:484-491`；`src/types.ts:393-404` |
| 激活 | `resolveAgent` 会 resume 冷会话并发布 live Agent，因此 prompt 可创建 Agent | `src/commands.ts:321-323`；`src/agent.ts:151-210,284-318` |
| 判重 | 重复 `requestId` 直接返回 `{ accepted: true }`，不再插入；只按 requestId 判，不比对 content 或 mode | `src/commands.ts:321-323,390-413`；`README.md:30,38` |
| 判重恢复 | receipt 从 durable 日志的 `user/message` 与 `agent/inbox/spliced` 重建，跳过 `seq < inheritedEventCount`；消息被 claim/remove 后仍算已接受 | `src/commands.ts:390-413` |
| 空内容 | `content: []` 走失败续写：仅 queue 模式、失败且 idle 时接受，否则 `session/agent-busy`（`NO_CONTINUABLE_FAILURE_OR_PENDING_INPUT`） | `src/commands.ts:324-339` |

可抛的 Remote 代码：`gateway/bad-request`、`session/invalid-time-zone`、`session/not-found`、`session/agent-busy`（含子会话归属）、`session/writer-held`、`gateway/internal`、`session/attachment-invalid`；wire 层还可能是 `gateway/arguments-invalid`、`gateway/cancelled`。未分类抛错在 wire 上折成 `gateway/internal`（`dsh-api-gateway src/index.ts:1516-1527`），进程内直调看到原始错误。

### 2. `sessionController.cancel(request)`

| 项 | 官方事实 | 锚点 |
| --- | --- | --- |
| 请求 | 只有 `{ sessionId }`；没有 requestId，没有 signal | `src/types.ts:366-373` |
| 返回 | `{ accepted: true }`；同步方法 | `src/commands.ts:526-540`；`src/index.ts:519-522` |
| 无 live Agent | `ctx.agents.get()` 为空即抛 `session/not-found`，文案“not attached”，不会静默成功 | `src/commands.ts:526-534` |
| 子会话 | `origin: 'subagent'` 抛 `session/agent-busy` | `src/commands.ts:535-537` |
| 活动回合 | `agent.cancel({ kind: 'user' }, { keepInbox: true })`：中止当前回合/回合间任务，保留排队与 steering 输入 | `src/commands.ts:538` |
| 无活动回合 | 仍返回 `accepted: true`，但官方 Agent 文档写明这是 no-op，不会为以后的工作预置取消 | `dsh-agent src/runtime-types.ts:205-213` |
| 回合结束 | cancel 立即返回；`turn/end` 由驱动收尾时写入，原因 `{ kind: 'aborted', reason: { kind: 'user' } }` | `dsh-agent-loop src/agent.ts:409-428`；`dsh-session src/types.ts:193-235` |
| 官方声明 | “Cancellation requires live state.” | `README.md:38` |

cancel 不接受“只取消某个 requestId 的回合”这一条件；日志判归属与真正调用之间存在窗口，官方没有 compare-and-cancel。

### 3. `sessionController.list(request, signal)` 与 `SessionSummary`

| 项 | 官方事实 | 锚点 |
| --- | --- | --- |
| 请求/返回 | `list(_request, signal)` 返回 `{ items: SessionSummary[] }`；request 只有可选 `cursor` | `src/index.ts:281-285`；`src/types.ts:246-254` |
| 行字段 | `sessionId`、`updatedAt`、`running`、`agentAvailable`、`blank`、`parentSessionId?`、`origin?`、`cwd?`、`projections?`、`formatStatus?`；没有 `profile` | `src/types.ts:154-167` |
| projections | `{ kind: 'cached' \| 'sequenced', asOfSeq, values: Partial<...> }`；`modelSelection` 的 wire 视图是 `{ lastUsed, next }`；`title` 视图是 `string \| null`；`todos`、`imageLimits` 声明 `summary: false`，不进列表行 | `src/types.ts:48-61`；`dsh-agent src/model-selection.ts:86-89`；`dsh-session-title src/index.ts:266-281`；`dsh-tool-todo src/index.ts:124-133` |
| 缺 signal | `ApiSessionList.list(signal?)` 内部只用 `signal?.throwIfAborted()`，进程内省略 signal 仍可用 | `src/list.ts:145-178` |
| 过滤与一致性 | 非 owner 逐行经 `remoteAccess.allows()` 过滤；不承诺跨会话一致快照，按工作切片让出并逐行检查取消 | `src/index.ts:284`；`README.md:46`；`dsh-api-remote-access src/index.ts:235-244` |

### 4. `state` / `observeState` / `wait`

官方存在不取消执行的等待 API：`sessionController.wait`。

| 项 | 官方事实 | 锚点 |
| --- | --- | --- |
| state | `state({ sessionId }, signal)` → `{ cursor, active, running, queue: SessionQueuedItem[] \| null, pendingInput }`；无 live Agent 时 queue 为 null | `src/types.ts:610-626`；`src/index.ts:575-578` |
| observeState | stream，先给当前 state，之后每次完整替换 | `src/index.ts:586-589`；`src/state/listener.ts:68-101` |
| wait 请求 | `{ sessionId, timeoutMs?, afterSeq?, maxMessages? }`；默认 30000ms、afterSeq=-1、maxMessages=50 | `src/types.ts:628-635`；`src/state/controller.ts:18,56-59` |
| wait 返回 | `{ reason: 'idle' \| 'input-required' \| 'timeout', state, output: { records（newest-first）, truncated } }` | `src/types.ts:637-649`；`src/history/controller.ts:126-143` |
| wait 语义 | 等到静默、待人工输入或 deadline；只取消这次等待，绝不取消 Agent 执行 | `src/index.ts:591-600`；`src/state/controller.ts:50-56` |
| wait 错误 | 边界非法 `gateway/bad-request`；会话不存在 `session/not-found`；调用方取消 `gateway/cancelled`；deadline 前一个 state 都没拿到才报 `session/wait-timeout`；监听结束 `session/observation-ended` | `src/state/controller.ts:60-122` |
| 超时形态 | deadline 到但已有 state 时是正常返回，`reason: 'timeout'`，不是错误 | `src/state/controller.ts:75-117` |

用 `wait` 替换轮询 `observeSession` 会改变可观察行为：pendingInput（approval/question）会提前返回 `input-required`；冷会话立即返回 `idle`；idle 走 `agent.whenIdle()`，晚于 `turn/end`；输出只有 newest-first 且有 50 条默认上限，没有 turn 号；超时是返回值而不是桥自定义终态。二者不是等价实现。

### 5. `sessionQuery.readSession` / `observeSession`

| 项 | 官方事实 | 锚点 |
| --- | --- | --- |
| readSession | `readSession(id)` → `{ session: SessionHeader, inheritedEventCount, events }`；内部构造 `Session.create` 做 replay 校验，header 与事件都是快照 | `dsh-session-query src/index.ts:196-210` |
| readSession 错误 | 失败抛 `SessionQueryError`，代码为 `SESSION_QUERY_*`（如 `SESSION_QUERY_SESSION_NOT_FOUND`、`SESSION_QUERY_CORRUPT_SESSION`、`SESSION_QUERY_ABORTED`） | `dsh-session-query src/config.ts:29-47` |
| observeSession | `observeSession(id, { signal?, projectionMode?: 'all' \| 'none' })` → `SessionObservation` | `src/index.ts:140-145`；`src/observation.ts:44-49` |
| lease 形状 | `source: 'live' \| 'prepared'`、`header`、`inheritedEventCount`、`events`、`cursor`（空日志为 -1）、`revision?`、`projections?`、`retain()`、`[Symbol.dispose]()`；没有 `dispose()` 方法 | `src/observation.ts:17-41,271-344` |
| 生命周期 | live lease 的 dispose 只是标记；prepared 冷观察进入有界缓存（默认容量 5），lease 未释放会 pin 住条目 | `src/observation.ts:56-79,270-301`；`src/config.ts:12` |
| 只读性 | 不发布、不激活 Agent（readSession “without making it live”，冷观察用未发布的 `sessions.prepare`）；但冷观察占用缓存，live 观察首次读 `events` 会物化整段日志 | `src/index.ts:190-210`；`src/observation.ts:124-191,303-344` |

### 6. 插件声明的服务与形状

| inject/取用 | 官方注册 | 形状与边界 | 锚点 |
| --- | --- | --- | --- |
| `sessionController` | `dsh-api-session-controller` 的 `SessionController`，键名同名 | 见上；Desktop/Web 组合挂载，headless 不挂 | `src/index.ts:74-79,135-150`；`dsh-web-app cordis.patch.yml:117-118`；`dsh-headless cordis.patch.yml` 头注释 |
| `workspaceRegistry` | `dsh-workspace` 的 `WorkspaceRegistry` | `list()` 同步返回 `Workspace[]`；`id/title/path/sessionIds`；`sessionIds` 会过滤归档/失效成员 | `dsh-workspace src/index.ts:298-311`；`src/entity.ts:86-104` |
| `sessionQuery` | `dsh-session-query` 的抽象 `SessionQueryEngine` | Desktop 组合由具体后端提供（组合里是 `session-query-sqlite`）；`readSession`/`observeSession` 见上 | `dsh-session-query src/index.ts:98-145`；`dsh-web-app cordis.patch.yml:27` |
| `agents` | `dsh-agent` 的 `AgentRegistry`，键名 `agents` | `get(id): Agent \| undefined`；`status: 'idle' \| 'running'`；`model.current()` 无记录时退回 AgentOptions；`model.select()` 只 append `model/selection`，不校验可用性 | `dsh-agent src/index.ts:246-260,580-581`；`src/runtime-types.ts:191-213`；`src/model-selection.ts:105-120` |
| `llm` | `dsh-llm` 的 `LlmRuntime`，键名 `llm` | `listProviders(): { id, name }[]` 同步；`listModels(provider)`、`resolveCallConfig(config)` 异步；未注册 provider 抛 `LlmError` code `NO_ADAPTER` | `dsh-llm src/index.ts:369-378,497-500,733-751,903-915,1035-1037` |
| `ctx.get('agentDefaultModel')` | `dsh-agent-default-model` 的 `AgentDefaultModelConfig` | `currentSelection()` 同步返回 `{ provider, model, reasoningEffort? }`，是部署默认 | `dsh-agent-default-model src/index.ts:48-73` |

插件假设但官方不保证：`list` 缺 signal 会抛错（官方可省略）；`observeSession` 有 `dispose()`（官方只有 `[Symbol.dispose]`）；`llm.listProviders` 的字段名（官方 `name`，夹具 `displayName`）；`agent.model.current()` 一定是“会话记录的选择”（无记录时是部署默认）；`resolveCallConfig` 只会抛 `NO_ADAPTER`（还会按 adapter 能力拒绝不支持的 reasoning effort）。

### 7. 访问控制与“取消需要 live”

官方只对 Peer 的 Remote 调用做资源级授权：owner 直接放行；非 owner 要在每个资源上被策略允许。`session/list`、`session/search`、`session/control` 触碰 `global`，行/帧再用 `allows()` 按 Session 过滤；`state`/`observeState`/`wait` 从 `request.sessionId` 读 Session 资源（`dsh-api-session-controller README.md:40`；`dsh-api-remote-access src/index.ts:199-244`）。

本插件是进程内调用者，不是 Peer：没有 `ctx.invocation`，`allows()` 在 Remote 调用外直接返回 true（`dsh-api-remote-access src/index.ts:235-244`）。因此官方访问控制不约束这条 loopback 路径，插件自己的 allowlist 是唯一授权层；`prompt` 的 `principalOf(ctx.invocation)` 为 undefined，durable source 不写 `principal`，与操作者本人发出的 prompt 只靠 `rpcId` 区分（`src/index.ts:484-491`）。官方关于取消的明确声明是“Cancellation requires live state”（`README.md:38`）。

## 官方与夹具的差异

夹具 `plugins/dsh-control-bridge-host/test/fixtures.js` 的形状对，但语义被简化。以下行为官方源码有、夹具没有：

- prompt 判重：官方对重复 requestId 返回 `accepted` 且不插入；夹具每次调用都自增次数，没有日志判重，也没有 `inheritedEventCount`。
- prompt 异步受理：官方有附件/图片校验、`fileUploads.bindPrompt`、受理后再查 `agents.get()` 是否仍是同一 Agent；夹具在 prompt 调用内同步追加 `turn/start`、`user/message`、`request/header`、`assistant/message`、`turn/end`。
- prompt 错误面：官方可抛 not-found / writer-held / agent-busy / attachment-invalid / invalid-time-zone；夹具只抛缺 sessionId、mode 非 queue、AbortError。空内容续写分支完全没有建模。
- cancel：官方只把取消交给活动信号并立即返回，`turn/end` 异步写入且原因带 `user`；夹具同步追加 `turn/end`（`reason` 只有 `aborted`）并把行改成不忙。官方对非 live 会话抛 `session/not-found`、对 idle Agent 是 no-op 但仍 accepted、保留排队输入；夹具对任意字符串 sessionId 都返回 accepted，且没有 inbox。
- list 缺 signal：夹具主动抛 `TypeError('...requires a signal')`；官方 `list` 可以省略 signal。夹具也没有 `remoteAccess` 过滤、`formatStatus`、cached/sequenced 的 watermark 语义。
- `SessionSummary.projections`：夹具直接合成 `title`、`modelSelection` 值；官方值按注册投影的 summary 键实时/缓存算出，`todos`、`imageLimits` 等 `summary: false` 的键不会出现。
- observeSession：夹具忽略 options，额外提供非官方的 `dispose()`，每次读 `events` 都复制数组；官方是精确 cut 的 lease，只有 `[Symbol.dispose]`。
- readSession：夹具返回任意对象/数组都接受；官方总有 `SessionHeader` 与 `SESSION_QUERY_*` 错误，“legacy array” 在官方没有生产者。
- `session/state`、`observeState`、`wait`：夹具完全没有；本插件也没有使用。
- `agents.get()`：夹具只给 `status`、`session`、`model`；官方 Agent 还有 `inbox`、`whenIdle()`、`cancel()`、`followup()`、`steer()`，且冷会话 `get()` 为 undefined。
- `llm`：夹具 `listProviders` 返回 `{ id, displayName }`，官方是 `{ id, name }`（插件只读 `id`，无影响）；官方 `resolveCallConfig` 还会按能力拒绝 reasoning effort，夹具只抛 `NO_ADAPTER`。
- `agentDefaultModel`：夹具用普通函数 `globalDefault` 注入，官方是注册的服务 `agentDefaultModel`；夹具直接调用服务，也看不到 wire 层错误折叠、访问控制与 signal 注入。

## 本仓库主张核对

| 仓库主张 | 出处 | 结论 | 官方锚点 |
| --- | --- | --- | --- |
| `prompt(request, signal)` 返回仅 `{ accepted: true }` | `README.md:15` | 已由官方源码证实 | `src/types.ts:335-337` |
| `requestId` 写入 `user/message.source.rpcId` | `README.md:15`；`docs/request-lifecycle.md:3` | 已由官方源码证实 | `src/index.ts:484-491` |
| prompt 需要 signal | `host_read.js` 注释 | 已澄清：prompt/state/wait/events/projections/search 必需，`list` 可省略；桥对 `list` 也总是传入 signal | `src/index.ts:467-469`；`src/list.ts:145` |
| 重复 requestId 官方返回 accepted、不重复插入 | `docs/request-lifecycle.md:9,17`（桥自身也判重） | 已由官方源码证实，但夹具未覆盖 | `src/commands.ts:321-323,390-413` |
| cancel 只接受 `{ sessionId }`、返回 accepted、不点名 requestId | `docs/request-lifecycle.md:3` | 已由官方源码证实 | `src/types.ts:366-373` |
| cancel 的 accepted 表示“活动回合已收下” | `docs/request-lifecycle.md` 旧版 | 已在本分支改正：idle Agent 也是 accepted 的 no-op，accepted 不能证明存在活动回合 | `dsh-agent src/runtime-types.ts:205-213` |
| cancel 之后官方终态以 `turn/end` 为准 | `docs/request-lifecycle.md:3,13` | 已由官方源码证实 | `dsh-agent-loop src/agent.ts:409-428` |
| cancel 需要 live Agent，非 live 失败关闭 | `server.js:1229-1240` | 已由官方源码证实 | `src/commands.ts:526-534`；`README.md:38` |
| 已结束的回合不会被改写成 cancelled | `docs/request-lifecycle.md:13` | 已由官方源码证实 | `dsh-session src/types.ts:203-235` |
| `list` 行是官方 `SessionSummary`，含 sessionId/running/agentAvailable/cwd/projections | `README.md:12` | 已由官方源码证实 | `src/types.ts:154-167` |
| `readSession` 返回 `{ session, inheritedEventCount, events }` | `README.md:13`；`host_read.js` 注释 | 已由官方源码证实 | `dsh-session-query src/index.ts:196-210` |
| `observeSession` 轮询比 `readSession` 便宜，且不做整段 replay 校验 | `host_read.js` 注释、`server.js:911-913` | 部分成立：live 路径成立；冷路径仍要 stat、读全量日志并 prepare | `dsh-session-query src/observation.ts:124-191` |
| `modelSelection` wire 形状是 `{ lastUsed, next }` | `host_read.js` 注释 | 已由官方源码证实 | `dsh-agent src/model-selection.ts:86-89` |
| `pending` 是“尚未被请求使用的选择” | `README.md:27` | 已在本分支按官方折叠修正：只有匹配路由且匹配 reasoning effort 的 `request/header` 才退掉 pending；新增折叠回归 | `dsh-agent src/model-selection.ts:77-85` |
| 只有 `request/header` 能证明一次请求实际使用的模型 | `README.md:28,32` | 已由官方源码证实 | `dsh-session src/types.ts:398-403` |
| `agent.model.select()` 只写会话选择，官方 `selectModel` 还会保存部署默认 | `README.md:39-40` | 已由官方源码证实 | `src/commands.ts:166-195`；`dsh-agent src/model-selection.ts:112-115` |
| `workspaceRegistry.list()` 同步返回 Workspace 列表 | `README.md:11` | 已由官方源码证实 | `dsh-workspace src/index.ts:308`；`src/entity.ts:86-104` |
| `agents.get(id)` 的 `.status`、`.model.current()`、`.model.select()` | `README.md:16` | 已由官方源码证实；`current()` 在无记录时退回 AgentOptions（部署默认） | `dsh-agent src/runtime-types.ts:191-213`；`src/model-selection.ts:105-120` |
| `llm.listProviders/listModels/resolveCallConfig` 可用于发送前拒绝不可用路由 | `README.md:17,37` | 已由官方源码证实；`NO_ADAPTER` 来自 `registration()` | `dsh-llm src/index.ts:497-500,733-751,903-915,1035-1037` |
| `agentDefaultModel.currentSelection()` 是部署默认 | `README.md:25` | 已由官方源码证实 | `dsh-agent-default-model src/index.ts:67-73` |
| Desktop 挂载 sessionController，headless 不挂 | `README.md:44` | 已由官方源码证实 | `dsh-web-app cordis.patch.yml:117-118`；`dsh-headless cordis.patch.yml` 头注释 |
| 插件声明 `compat.sessionController: "0.2.2"` | `package.json` | 已核对安装路径：官方兼容检查只读 `engines.dsh` / dsh peerDependencies，不读 `dsh.compat` | `dsh-app-boot src/plugin-compatibility.ts:55-74` |
| `POST /v1/cancel` 只停桥等待、从不调用官方 cancel | `README.md` 旧版 | 已在 0.1.6 分支改正：等待改名为 `/v1/wait/stop`，`/v1/cancel` 对自有未结束回合会调用官方 cancel | `plugins/dsh-control-bridge-host/README.md`；`server.js` |
| 取消可“不取消别的客户端或界面上的回合” | `docs/request-lifecycle.md` | 已加固但仍不是官方保证：排队中的 prompt 不算自有回合，调用前重新读日志；官方没有 compare-and-cancel，检查与调用之间仍有窗口 | `src/commands.ts:526-540` |

## 对 0.1.6 Stage A 的结论

- 已由官方源码关闭：prompt 的请求/返回/rpcId/判重、cancel 的形状与非 live 失败、`SessionSummary` 形状、`readSession`/`observeSession` 形状、六个服务的方法面、Desktop 与 headless 的组合差异、官方存在 `wait`。
- 仅由夹具证明：桥自己的幂等账本、桥的 turn 归属启发式（按 rpcId 找 turn）、超时与 `terminal_scope` 分类、模型预检的 HTTP 码映射、授权与配对流程。夹具不能证明这些与官方一致。
- 与官方源码不符或需改写：`list` 缺 signal 会抛错（夹具/旧注释，已在注释中澄清，夹具保留更严格的传入检查）；cancel 的 accepted 不等于“活动回合已收下”（已在 `request-lifecycle.md` 改写）；`observeSession` “不做 replay 校验”只对 live 成立（注释已澄清）；`pending` 的退场规则已按官方改成“匹配路由且匹配 reasoning effort 的 header 才退掉”；`README.md` 旧版的“从不调用官方 cancel”已在本分支改正；`compat.sessionController` 不被官方安装器读取（字段仅作声明，不提供安装期约束）。
- 仍需真机才能确认：真实 Desktop 上 prompt 的受理时延与判重、cancel 后 `turn/end` 的实际到达时间与原因、`observeSession` 轮询的真实成本、真实 `SessionSummary.projections` 的键集合、真机访问控制与 profile 组合。本文没有这些真机结果；不要在 Stage A 写成“官方契约已全部验证”，只把源码能证明的部分关掉，其余保持“夹具/待真机”。
