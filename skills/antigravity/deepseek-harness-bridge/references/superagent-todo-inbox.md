# SuperAgent 待办：分流、原线程答复与本地裁决

本文说明 skill `deepseek-harness-bridge` 里两个 Python 客户端的待办处理命令：`scripts/superagent.py`（只读读票）与 `scripts/github_source.py`（原线程答复、结果跟踪、本地裁决）。命令只依赖 Python 标准库与已登录的 `gh`。所有示例里的端口、仓库、账号都要换成实际值。

## 1. 边界

| 对象 | 允许的动作 | 不允许 |
| --- | --- | --- |
| 管理 API（loopback） | `GET state/sources/settings/tickets/tickets/<id>`，请求头 `x-orchestrator-request: 1` | 任何写路由；`superagent.py` 只发 GET |
| 引擎工单 | 读 Ticket / Assignment / Input / Decision / Thread | 改引擎数据库；伪造终态；`retry` / `stop` 不由本工具自动调用 |
| 原 Issue | 一次评论（`reply send --yes`，带唯一 marker） | 重复评论；编辑已发评论；对 PR 线程回话 |
| 本地状态 | `plan`、`cursor`、`verdicts.jsonl`（0600，原子写） | 写引擎 sqlite；写安装副本 |
| PR / Issue 远端 | `gh api` / `gh pr checks` 只读 | 评论、关闭、合并、打标签 |

上游现有的工单写路由只有 `POST tickets/:id/retry` 与 `POST tickets/:id/stop`（见 `src/app/api.ts` 的路由表）。因此“本地裁决通过”与“引擎终态”必须分开记录，见第 6 节。

## 2. 待办列表：`inbox`（别名 `todos`）

```powershell
$port = 3082   # 该 profile 的管理端口，按实际实例替换
python skills/deepseek-harness-bridge/scripts/superagent.py --port $port inbox --all
python skills/deepseek-harness-bridge/scripts/superagent.py --port $port inbox --limit 20 --offset 0
```

- 只列 `state=person` 的票；`--all` 按响应里的 `next_offset` 一直翻到空为止（上限 5000 张，防跑飞）。
- 输出 `total / scanned / shown / offset / limit / next_offset`，每票给：`id state stage action title updatedAt`、`latest_assignment{id,state,state_effective,report_state,report_at,ref}`、`report_summary`、`question`（含 `question_source`）、`source_thread{key,title,url,issue_number}`、`pull_requests[{number,url}]`、`actions{retry,stop}`、`delivery{undelivered,pending_inputs,last_delivered_to}`、`triage`、`triage_reason`。
- 列表按 `updatedAt` 倒序。输出始终是 JSON；`--json` 只是给脚本显式声明用。

### 2.1 最新有效 Assignment

- 按 `createdAt`（缺失时用 `startedAt`）取最新的一条。
- `state=running` 但 `turnEndedAt` 有值、且 `report.state` 不是 `progress` 时，视为**本轮已结束**：`state_effective=ended`、`stale_running_ignored=true`。本机实测五张 person 票都是这个形态（`state=running` + `report.state=ready`），不能判成 running。
- 历史票没有本机派单计划（plan 文件）也能读：列表与详情都不读本地 plan；本地 plan 只在 `local_reply` 字段里作为附加信息出现。

### 2.2 `triage` 取值

| 取值 | 判据 | 操作 |
| --- | --- | --- |
| `review_ready` | 最新 Assignment 的 `report.state=ready` 且 `undelivered=0` | 可评审、可答复、可 stop |
| `review_reported` | 有 ready 报告，但仍有 input 未投递 | 先等投递，别急着重发 |
| `blocked_missing_info` | 最新 Assignment 没有报告、或 `report.state=waiting`，且没有 ready 报告 | 回原线程补资料 |
| `retryable_failed` | 最新 Assignment 已结束、`report.state=failed` 且 `actions.retry=true` | 人工决定是否 retry（本工具不自动 retry） |
| `running` | 最新 Assignment 确实在跑（无陈旧 `turnEndedAt`） | 等 |
| `ended` | 票已终态（`ended.outcome`） | 读终态原因，不再当待办 |
| `unknown` | 不满足以上任何一条（含只拿到列表行、详情读失败） | 人工看 `detail` |

`triage` 一共 **7 个取值**：`review_ready`、`review_reported`、`blocked_missing_info`、`retryable_failed`、`running`、`ended`、`unknown`（前五个 + `unknown` 是待办六态，`ended` 是终态）。

判定顺序固定在 `triage_of()` 里：**终态最先**，所以 `ended` 票即使带着 `report.state=failed` 且 `actions.retry=true`，也只会显示 `ended`，**不会显示 `retryable_failed`**——这是有意为之的副作用，避免把已终态的票重新当待办。要看它为什么失败，读 `ended.outcome`、`latest_assignment.report_state` 与 `report_summary`。

`stop` 只表示人为停止；`acceptance.accepted` 只表示接单授权。两者都不产生 `review_ready`。

## 3. 详情：`detail <ticket_id>`

```powershell
python skills/deepseek-harness-bridge/scripts/superagent.py --port $port detail TICKET_ID
```

在 `inbox` 的字段之外补：`summary`（截断到 4000 字符，另给 `summary_truncated`）、`all_assignments`、`threads`、`subscriptions`、`channels`、`decision`、`acceptance`（含 `note: acceptance 不是交付`）、`mandate`、`ended`、`local_reply{plans,latest}`、`next_actions`。

`next_actions` 里每个动作给 `allowed` 与理由，和票自身的 `actions`、`stage` 保持一致：

- `reply`：有 Issue 线程且票未终态；
- `retry` / `stop`：跟随 `actions.retry` / `actions.stop`；
- `wait`：`triage` 是 `running`/`review_reported`，或本机有未收尾的答复计划；
- `reconcile`：本机存在 `unknown`/`sent`/`sending` 状态的答复计划（只读核对，不会重发）。

`ticket` 命令保持原有的元数据投影（含 Assignment id/state/ref），不输出标题与报告正文。

## 4. 原线程答复：`reply`

答复目标取自 Ticket 的 `threads` 里**来源 Issue**（`/issues/N`）。PR 线程（`/pull/N`）不是答复目标；只有 PR 线程时明确失败 `no_source_thread`。

### 4.1 三步

```powershell
$g = 'skills/deepseek-harness-bridge/scripts/github_source.py'
python $g reply prepare --port $port --ticket TICKET_ID --request '请补一条独立验收用例，并说明失败样本'
# 预览里核对：目标 Issue URL、正文、marker、实例端口、当前 Assignment 与报告游标、查验记录
python $g reply send --plan '<prepare 输出的 plan 路径>' --yes
python $g reply trace --plan '<同一条 plan 路径>' --check-pr
```

- `prepare` 先写查验记录（同一份 plan 的 `evidence`）：票的 `state/stage/action/ended`、最新 Assignment、`report_cursor`、`delivery`、`delivered_to_ticket`、来源线程。随后跑与派工相同的 `precheck`：`repository_matches=false`、`actor_authorized=false`、`github_source_enabled=false` 等任何强制项不过就**拒绝派工**，不写 plan。
- `prepare` 只写本地 plan，不发任何 GitHub 写请求。
- `send` 复用原有发送器：`--yes` 必需、每 plan 单写者（`O_EXCL` 锁）、发送前查重（marker 已在 Issue 上就返回 `duplicate` 不重发）、超时记 `unknown`。
- `send` 遇到 `unknown`：只有 `--reconcile` 允许继续，且只做只读核对；**绝不自动重发**。
- `trace` 以 Ticket 为锚点：marker 评论（`submitted`）、input 投递（`delivered`）、worker 读取（`worker_read`）、报告游标（`report_new`）、票终态（`ticket_terminal`）、PR 状态（`pull_request_state`，需 `--check-pr`），并给 `delivery_scope`（实际投到哪些 Assignment、哪些线程）。

### 4.2 「Delivered to Ticket」

本机实测（person 票样本 5/5）：`inputs[].delivered=true` 且 `deliveredTo` 是**该票最新 Assignment 的 id**，不是 ticket id。因此判据是：

> `inputs[].delivered=true` 且 `deliveredTo` 命中该票任一 `assignment.id`（或 `ref`），或命中 `ticket.id` —— 即视为已投递，输出 `delivery: "delivered_to_ticket"` 与 `delivered_to_kind: assignment|ticket`。

`undelivered=0` 只作旁证（没有 input 的票也是 0），不作为唯一证据。

**不需要出现新的 Decision。** `trace` 里 `new_decision_after_input` 只是信息字段，绝不是通过条件；订阅线程直接投递到票就算送达。

### 4.3 失败与退出码

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功（`trace` 到达 `delivered` 或 `ticket_terminal`） |
| 1 | 读失败 / precheck 失败 / 远端读失败 |
| 2 | 用法错误：`no_source_thread`、`empty_request`、`invalid_marker`、`evidence_required`、`not_a_reply_plan` |
| 3 | 发送状态未定或不可再发：`previous_send_unknown`、`send_locked`、`send_unknown` |

## 5. 跟踪与轮询：`reply poll`

```powershell
python $g reply poll --ticket TICKET_ID --port $port --resume
python $g reply poll --ticket TICKET_ID --port $port --watch --interval 30 --wait 600 --check-pr
```

- 游标落 `~/.codex/state/deepseek-harness-bridge/reply/cursors/<ticket>.json`（原子写、0600），字段：`submitted_comment_id`、`delivered_input_id`、`delivered_at`、`read_at`、`report_at`、`terminal_outcome`、`pull_request_state`。
- 同一游标重复轮询输出 `changed=false`、`new=[]`，不重复报「新结果」，也不会重复评论。
- `--resume` 额外回显 `resumed_from`（上次保存的游标），便于跨进程续跑。
- `--watch`/`--wait` 是**客户端轮询**。事件订阅默认关闭：上游管理 API 的路由表（`src/app/api.ts` 第 20–46 行的 `Api` 接口）里没有事件流或订阅路由，`/orchestrator/api` 只有请求-响应式路由（含少数 POST 控制操作，如 `sources/:id/labels`、`threads/:key/unsubscribe`、`triggers/:id/requeue`、`decisions/:id/dismiss`、`executor/pause`、`tickets/:id/retry|stop`）；没有可订阅的事件来源，证据不足，不启用。

### 5.1 生命周期对照

| 阶段 | 证据字段 | 不成立的替代证据 |
| --- | --- | --- |
| `submitted` | 来源 Issue 上出现本 plan 的 marker 评论 | 「评论已发出」的口头结论 |
| `delivered` | `inputs[].delivered=true` 且 `deliveredTo` 命中本票 Assignment/Ticket | 出现新 Decision |
| `worker_read` | 该 input 的 `readAt` 有值 | Assignment `state=running` |
| `report_new` | 最新报告的 `at` 比游标前进 | `report.state=ready` 重复读 |
| `pending` | 还没有上述证据 | 「执行器空闲」 |
| `ticket_terminal` | `state=ended` + `ended.outcome` | `stop` 当成通过 |
| `pull_request_state` | `gh api graphql` 或 REST 的 `state/merged/isDraft/mergeStateStatus` | 「CI 通过」 |

PR 检查项只能这样取：`gh pr checks <n> --repo <r> --json ...`，或 `commits/<sha>/check-runs` + `commits/<sha>/status`。GitHub REST **没有** `GET /repos/<r>/pulls/<n>/checks`（实测 404）。空检查列表（`total=0`）与 `report.state=ready` 都不是验收通过。

## 6. 本地裁决：`verdict`

```powershell
python $g verdict set --port $port --ticket TICKET_ID --result pass --evidence 'reports/xxx.md' --check-remote
python $g verdict list [--ticket TICKET_ID]
python $g verdict show <verdict id 或 ticket id>
```

- 落盘 `~/.codex/state/deepseek-harness-bridge/local/verdicts.jsonl`（追加，0600）。**不写引擎 sqlite，不调用 stop 伪造终态。**
- 输出把 `local_verdict` 与 `engine_state` 分开：`engine_state.label` 在人为停止时是 `stopped_by_human`。
- `--result pass` 的三条闸门：
  1. 必须有 `--evidence`；
  2. 引擎显示 `stopped_by_human` → 拒绝（退出 2，`engine_state_stopped_by_human`）；
  3. 没有「ready 报告且 `undelivered=0`」的交付证据 → 拒绝（退出 2，`delivery_not_proven`）；要强行记录需显式 `--force`，并在 `warnings` 里留 `forced_pass_without_delivery`。
- 「接单 accepted 但不是交付」：当 `acceptance.accepted=true` 而交付未证时，记录的 `warnings` 含 `acceptance_is_not_delivery`。
- `--check-remote` 只读 `gh api repos/<repo>/pulls/<n>`（以及 GraphQL 的 `mergeStateStatus/reviewDecision`）与 `issues/<n>`，把 `state/merged/mergeStateStatus/reviewDecision/checks` 记进证据；不评论、不关闭、不合并。

## 7. 上游扩展项（本仓不伪造）

| 需求 | 现状 | 需要上游提供 |
| --- | --- | --- |
| 验收通过但保持 PR 开放 | 写路由只有 `retry` / `stop`；`stop` 是人为停止 | 一个「标记验收/结单」的显式路由，或验收字段 |
| 事件订阅（替代轮询） | 管理 API 无事件流路由 | SSE/WS 或 webhook 路由，并写清投递语义 |
| PR 检查项 | REST `/pulls/<n>/checks` 404 | 若走 REST，需要一个可用的检查项端点；当前用 `gh pr checks` 或 commit check-runs/status |
| 报告正文 | 详情只有 `report.state/summary/at` | 若需要全文，需上游暴露报告正文 |
| `deliveredTo` 语义 | 实测为 Assignment id | 文档写明「Assignment id 或 Ticket id」，本工具两种都接受 |

## 8. 只读核对：派工闸门

```powershell
$port = 3082                 # 该 profile 的管理端口
$repo = 'OWNER/REPO'         # 想让这个 profile 接单的仓库
$actor = 'YOUR-LOGIN'
python skills/deepseek-harness-bridge/scripts/superagent.py --port $port inbox --all
python skills/deepseek-harness-bridge/scripts/superagent.py --port $port detail <每张票>
python skills/deepseek-harness-bridge/scripts/github_source.py precheck --port $port --repo $repo --actor $actor
```

前两条只发 GET。第三条里 `checks` 中的 `repository_matches=false` 表示该 profile 的 Source 绑在另一个仓库上：**拒绝派工**，这不是缺陷，也不是需要修的对象。`reply prepare` 会跑同一套 precheck，`repository_matches=false` 时直接退出 1 且不写 plan。

只读核对也适用于生产票：`inbox` / `detail` / `reply trace` / `verdict set --check-remote` 都不发工单写请求；正式票据不要用 `send` 做测试样本，合成票或测试 profile 才用来验证答复与终态。
