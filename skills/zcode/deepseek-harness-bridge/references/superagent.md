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
