# 请求生命周期（Host 0.1.6）

官方 Desktop 0.2.2 的 `sessionController.cancel` 只接受 `{ sessionId }`，返回 `{ accepted: true }`。它不点名 `requestId`，也不表示回合已经结束；没有活动回合时官方同样返回 `accepted`（对 idle Agent 是 no-op），所以这个回执不能证明“某个回合被收下”。`prompt` 把 `requestId` 写进 `user/message` 的 `source.rpcId`。终态只认其后的 `turn/end`。

官方也没有 compare-and-cancel：桥只能在调用前用日志判断当前未结束回合属于自己。判断与真正调用之间仍有一个窗口，官方不保证这期间不会有别的客户端开始新回合；桥用“最近一个未结束的 `turn/start` 必须带有本请求的 `rpcId`”把窗口缩到最小，失败关闭而不是猜。

0.1.5 的 `POST /v1/cancel` 只中止桥自己的等待。0.1.6 把这件事改名为 `POST /v1/wait/stop`，`scope` 是 `bridge_wait`。它不调用官方 cancel，也不把桌面回合写成已取消。

## 状态

`recorded`：已经落盘，还不能证明官方已经收下。`accepted`：官方 `prompt` 返回了 `{ accepted: true }`，或日志里已经有本请求的 `rpcId`。`terminal`：官方 `turn/end` 已经读回，或官方明确拒绝了这次 prompt。`unknown`：崩溃窗口里对不上 `rpcId`，需要人工核对。

`completed: true` 只在官方原因是 `completed` 时出现。`bridge_timeout` 的 `terminal_scope` 是 `bridge_wait`，`model_timeout` 是 false。客户端断开或等待超时不是模型超时。

取消请求被收下（`cancel_accepted`）和官方终态是两件事。已经结束的回合保持原终态，不会被改写成 cancelled。官方没有 compare-and-cancel：桥在调用前重新读一次日志，只接受“最近一个已开始的回合、其 `user/message` 带本请求 `rpcId`、且之后没有新回合”的情况；排队中的 prompt（`user/message` 在 `turn/start` 之前）不算自有回合，不会被取消。检查与调用之间仍有极窄窗口，这是官方接口本身的边界。

## 接口

`POST /v1/resume` 仍是受理并收集。相同 `request_id`、相同会话和相同内容返回同一条记录，不第二次 `prompt`。相同 id 但会话或内容不同，返回 `409 idempotency_conflict`。

`GET /v1/requests?request_id=&session_id=` 只读。授权撤销后返回 403，不读出结果。它可以用日志里的 `rpcId` 把断线后的终态补齐。

`POST /v1/cancel` 需要写授权。只有日志能证明当前未结束的回合属于这个 `request_id` 时，才调用 `sessionController.cancel({ sessionId })`。对不上、已经结束、或没有 cancel 方法时失败关闭，`desktop_cancel_called` 为 false。没有活 Agent 的会话返回 `409 agent_not_attached`，不调用官方 cancel，也不把失败写成“桌面取消失败”。不结束进程，不取消别的客户端或界面上的回合。

## 配对窗口与授权热更新（0.1.6 Stage B）

配对窗口是文件，不是进程内快照。`bootstrap.json`（secret、到期时间、consumed、已作废 secret 的哈希）和 `bootstrap.secret` 每次请求重新读取，所以 Desktop 不用退出或重启就能重新布防并配对下一条会话。

- 只有剩余时间不超过 60 分钟、未过期、未消费、secret 至少 32 字符的窗口才算已布防。声明更长的窗口现在不布防；等剩余时间降到 60 分钟内才会生效，不会在布防时放大寿命。
- `bootstrap.json` 是权威；非空的 `bootstrap.secret` 与它不一致时按损坏窗口失败关闭，不让旧的 secret 文件盖掉重新布防的 JSON。两个文件由脚本一起写；手工只改 JSON 时要清空旧 secret 文件。
- `POST /v1/bootstrap/select` 在配对锁里串行执行，并用“这次认证所用 secret”做 compare-and-swap：只作废真正被用掉的那个窗口；期间被重新布防的新窗口保持可用；授权写盘失败时窗口不作废，可以修好后再配对。作废写入前再比一次文件戳，重布防撞上时失败关闭而不是覆盖。
- 已作废窗口的哈希与授权同一次原子写进 `allowlist.json`；即使随后 `bootstrap.json` 写失败，同一个窗口也不能再产生第二条授权。
- 作废后窗口文件只保留该 secret 的 SHA-256，重放得到 `403 bootstrap_consumed`；过期、不可读或 JSON 损坏都失败关闭，不回退到旧窗口。
- 配对只把选中的一条会话合并进 `allowlist.json`；已有授权不会丢，撤销仍是唯一的移除路径。响应里的 `granted` 明确这次写入的会话和权限。
- 这条路径不轮换长期 `host.secret`；`Prepare-DesktopHost.ps1` 也改成保留已有 host secret。
- `GET /v1/health` 增加 `bootstrap_status`、`bootstrap_armed`、`bootstrap_consumed`、`bootstrap_retired`、`bootstrap_expires_at`，操作者不用重启就能确认布防状态。health 和 membership 只接受长期 host secret；窗口只能到两条 bootstrap 路由。
- 操作脚本 `scripts/windows/Rearm-DesktopHostBootstrap.ps1` 只写 `bootstrap.secret` 和 `bootstrap.json`，前后校验 `host.secret` 与 `allowlist.json` 未变；`Pair-DesktopHost.ps1` 在窗口未布防时直接提示先重新布防。

授权变化（新授权、改权限、撤销）本来就在每个请求上用同一份 grant store 重新读取；`/v1/access`、`/v1/revoke` 与外部重写 `allowlist.json` 都无需重启。等待中的 resume 每轮也会重新授权，撤销后返回 `revoked_during_wait`，不会把已经排队的 prompt 撤掉。

## 存储

记录写在 allowlist 旁边的 `requests.json`。先写记录，再 `prompt`。写入失败则内存不改，并且不发送。文件损坏则插件不监听。文件可以含有脱敏后的回答，只留在本机，不进日志，不进发布包。这里不存密钥。

配对窗口写在 `bootstrap.json` 与 `bootstrap.secret`，与 `requests.json` 分开；窗口作废只改这两个文件。已花费窗口的哈希（`spentBootstrapHash`）随配对授权同一次原子写入 `allowlist.json`，这样即使窗口文件写失败也不会重复消费同一个窗口；它不碰 `requests.json`。

落盘和官方 `prompt` 之间仍有崩溃窗口。重启只按已经看见的 `rpcId` 对账；对不上就停在 `unknown`，不自动重发。这不是跨进程的 exactly-once。

## 升级、回滚和真机步骤

升级仍要先用托盘退出 Desktop。没有外部退出命令，也不要结束进程。然后：

```text
dsh plugin --profile desktop add dsh-control-bridge-host-0.2.0.tgz
```

回滚：再次托盘退出，`dsh plugin --profile desktop remove dsh-control-bridge-host`，需要时换回已经在本机验证过的 0.1.5 包。不要用旧的 profile 备份覆盖后来的修改。`requests.json` 可以留下；它不是会话历史。

0.1.6 还没有在真机上验证。阶段 A（记录、查询、owned-turn 取消、wait/stop、unknown 不重发）由 `test/lifecycle.test.js` 的隔离回归覆盖；阶段 B（重新布防、单次使用、过期/损坏失败关闭、授权热更新）由 `test/rearm.test.js` 的同进程回归覆盖，`tests/test_rearm_bootstrap.py` 只验证重新布防脚本本身。夹具和模拟不能算真机通过；安装后的真机步骤仍未做。若要在已经授权的演示会话上试，请求要短，不调用工具，不写文件，不碰业务会话，也不要强行结束进程。先看 `GET /v1/requests` 能不能在断开后读回终态，再单独试一次属于本桥的取消，并核对官方 `turn/end`。

## 0.2.0：长任务回传、发现、模型/effort、创建（仍是夹具证据）

- **请求日志**：每次状态变化追加 `seq`，`requests.json` 持久化 `phase`、`prompt_attempted`、`requested_model`、`confirmed_selection`、`effort_unverified`、终态 `response` 与有界 `events`。
- **回传**：`POST /v1/resume` 支持 `wait:false`（立即 202）和 `wait_ms`（上限 30 分钟）；`GET /v1/requests/:id/{wait,events,stream}` 提供长轮询、增量事件和 SSE（心跳、`Last-Event-ID` 断点续读）。进程重启后用持久 rpcId 重读官方日志，能证明终态就补写；证明不了留在 `unknown`，不重发。
- **自动感知**：协调方保持 loopback SSE 长连接并在终态收到 `event: end`；没有原生唤醒时用 `/events?after_seq=` 或 `/wait` 做有时限的轮询补偿。inbound webhook 不是完成信号，也不向外部推送。
- **发现**：`GET /v1/discover` 读全部已注册工作区/会话的元数据，分类 `top/subagent/worker/unknown`，状态只用官方 `running` 和投影（`approvalState`/`userQuestions`/`inbox`/`conversationContinuation`）推导，拿不准就是 `unknown`；不读历史，不去重提根。
- **模型/effort**：`GET /v1/model-catalog` 在官方能枚举时给出 `reasoning.efforts`，否则 `null` + `unknown`；`POST /v1/model` 的 `null` 清除旧 effort，省略跟随 adapter 默认，`auto` 被明确拒绝；结果分 `route_match` / `effort_match` / `effort_verified` / `model_match`，执行头缺 effort 时 `model_match:null`。
- **创建/打开**：`POST /v1/workspaces`、`POST /v1/sessions`、`POST /v1/open` 走官方 `workspaceRegistry.create` / `sessionController.create` / `openWorkspacePath`；默认全部关闭，必须同时配置 `workspaceRoots` 与对应开关。路径 realpath 校验在根内，根自身/兄弟前缀/`..`/符号链接逃逸都拒绝；新建会话默认只授 `read`，绝不改部署默认模型。
- 这些都在 `test/control.test.js`、`test/create.test.js`、`test/paths.test.js` 里用夹具和临时目录验证；**没有真机结果**，也没有安装到现网 0.1.5。
