# Official SuperAgent

Use `scripts/superagent.py` for the official local management API. Defaults to loopback port `3082`. Pass `--port` before the command to select an authorized isolated profile's management port. This API and the Desktop bridge have separate state and authorization.

```powershell
python superagent.py state
python superagent.py sources
python superagent.py tickets --state working --limit 10
python superagent.py tickets --state ended --limit 10
python superagent.py ticket TICKET_ID
```

The client shows status metadata and omits summaries, repository paths, and account details. List filters are `open`, `person`, `working`, `idle`, `ended`. For Assignment evidence, record the Ticket ID, Assignment ID, Assignment `state` and `ref` (the worker session), and final outcome where available. A historical Assignment establishes query access only.

To initiate new work, use an authorized Source in the intended profile. A real source event triggers Eval, which may create a Ticket and schedule an Assignment. The GitHub Source can evaluate a permitted actor's `@agent` mention in a configured repository. Check the test profile's Source, actor authorization and worker capacity before sending an authorized event. Correlate the new event to the resulting Ticket and Assignment. Refer to the [official domain model](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md) and [authorization rules](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md).
<a id="github-source"></a>

## 派发和跟踪 GitHub 工单

在技能目录中运行以下例子。先准备 Python 3.11+、已登录的 GitHub CLI，以及启用了 GitHub Source 的 SuperAgent 实例。用实际管理端口、被监听的仓库和已获授权的发送账号替换示例值。

```powershell
$port = 3082
$repo = 'OWNER/REPO'
$actor = 'YOUR-LOGIN'
$source = 'scripts/github_source.py'
python $source precheck --port $port --repo $repo --actor $actor
python $source prepare --port $port --repo $repo --actor $actor --issue 123 --request 'Reply with the test marker.'
```

`prepare` 生成本地计划并展示将要发送的事件。默认目标是已有 Issue 的评论。需要新开工单时，使用 `--kind issue --allow-new-issue --title '...' ` 替换 `--issue 123`。能否接单取决于该实例的 Source、通知和授权配置。

```powershell
$plan = Read-Host 'prepare 输出的 plan 文件路径'
python $source send --plan $plan --yes
python $source trace --plan $plan --wait 300
```

仅在获准向该仓库发送指定内容后执行 `send`。发送超时可以用 `send --plan $plan --reconcile` 只读核对。沿用原计划可避免重复发单。

验收时核对同一事件的 Ticket、Assignment、worker 报告和 Ticket 最终结果。驾驶舱的执行器数字表示实时占用，任务结束后可以回到零。票在 `person/review` 时，即使 worker 已交报告，也可能继续等待人审。GitHub 回帖还需核对其用途；接单回执本身不足以证明执行完成。Desktop 主控会话和它的子代理由 Desktop 单独跟踪。

## 待办、原线程答复与本地裁决

完整说明见 [SuperAgent 待办：分流、答复与裁决](../../../docs/superagent-todo-inbox.md)。只读边界：`superagent.py` 只发 GET；答复只向来源 Issue 发一次评论；裁决只写本地文件。

```powershell
$port = 3082                                # 该 profile 的管理端口
$sa = 'scripts/superagent.py'
$g  = 'scripts/github_source.py'
python $sa --port $port inbox --all          # 待办队列（别名 todos）；默认只取 person
python $sa --port $port detail TICKET_ID     # 全量详情 + next_actions
python $g reply prepare --port $port --ticket TICKET_ID --request '...'
python $g reply send --plan '<plan>' --yes
python $g reply trace --plan '<plan>' --check-pr
python $g reply poll --ticket TICKET_ID --port $port --resume
python $g verdict set --port $port --ticket TICKET_ID --result pass|fail|hold --evidence '<path/url>'
python $g verdict list
```

判定口径（都是实测形态，不是推测）：

- 最新有效 Assignment 按 `createdAt` 取最新；`state=running` 但 `turnEndedAt` 有值且报告不是 `progress` 时算 `state_effective=ended`。本机五张 person 票就是 `running + report.state=ready`，必须判 `review_ready`，不能判 running。
- `triage` 六态：`review_ready` / `review_reported` / `blocked_missing_info` / `retryable_failed` / `running` / `unknown`，终态票另给 `ended`。
- **Delivered to Ticket**：`inputs[].delivered=true` 且 `deliveredTo` 命中该票任一 `assignment.id`（或 `ref`，或 `ticket.id`）即算已投递，输出 `delivery: delivered_to_ticket` 与 `delivered_to_kind`。本机实测 `deliveredTo` 是 Assignment id（5/5），不是 ticket id。`undelivered=0` 只作旁证。**不需要出现新的 Decision**，不能把「需要新 Decision」写成通过条件。
- `stop` 是人为停止（`ended.by=human`、`outcome=stopped`），终态标签 `stopped_by_human`，永远不算通过；`--result pass` 会被拒绝。
- `acceptance.accepted=true` 只是接单授权；没有「ready 报告且 `undelivered=0`」的交付证据时 `pass` 被拒（`delivery_not_proven`，可用 `--force` 显式覆盖并留 warning）。
- 答复超时记 `unknown`；只有 `--reconcile` 只读核对，绝不重发。重复 marker 返回 `duplicate`，不二次评论。
- PR 检查项只能取 `gh pr checks` 或 `commits/<sha>/check-runs` + `commits/<sha>/status`；REST `pulls/<n>/checks` 是 404。空检查列表（0/0）和 `report.state=ready` 都不是验收通过。
- 事件订阅未启用：上游管理 API 没有事件流/订阅路由（`src/app/api.ts` 的 `Api` 接口只列请求-响应路由），因此 `poll` 是客户端轮询。
- 历史票（本机没有派单计划）也能读：列表/详情不依赖本地 plan。

