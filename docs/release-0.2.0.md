# Host 0.2.0 交付与证据

本文记录 0.2.0 的实现、隔离回归与验收边界。Windows Desktop 的匿名运行记录见 [真机验收](verified-scope.md)。

## 交付物

- 真机安装的 Host 包 `dsh-control-bridge-host-0.2.0.tgz`，SHA-256 `aa5891a77d14d5f0495d30c9439b971567935f0d7b0165395dcf3152f5e65798`（56,024 bytes）。`scripts/build_release.py` 逐文件核对运行时内容，并生成包含 Codex 技能和安装脚本的便携源码包。使用对应输出目录里的 `MANIFEST.json` 校验便携包。
- Codex 技能入口为 [deepseek-harness-bridge](../skills/deepseek-harness-bridge/SKILL.md)，包含 Desktop JSON/SSE 命令和官方 SuperAgent 只读查询。

## 能力与实现位置

| 能力 | 实现 | 证据 |
| --- | --- | --- |
| A. 持久请求日志 + seq 事件流 | `requests.js`、`journal.js`、`server.js`（`advanceRequest`、`/events`、`/wait`、`/stream`） | `test/control.test.js` |
| A. 同步等待与桌面任务寿命分离 | `server.js` 的 `wait:false` / `wait_ms`（上限 30 分钟） | `test/control.test.js` |
| A. 重启后按 rpcId 对账、unknown 不重发 | `advanceRequest`、`recoverStored` | `test/control.test.js`、`test/lifecycle.test.js` |
| B. provider/model/effort 目录 | `models.js`（`modelCatalog`、`effortSupport`，走 `resolveModelInfo`） | `test/control.test.js` |
| B. 单会话 effort 设置/清除/不继承 | `POST /v1/model`、`selectOnAgent`、`sameSelection` | `test/control.test.js` |
| B. requested/confirmed/execution 一致性含 effort | `selectionMatch`，`route_match`/`effort_match`/`effort_verified`/`model_match` | `test/control.test.js` |
| C. 全工作区发现 | `host_read.js`（`assembleDiscovery`）、`/v1/discover` | `test/control.test.js` |
| D. 创建工作区/会话/打开目录 | `server.js` + `paths.js`，官方 `workspaceRegistry.create` / `sessionController.create` / `openWorkspacePath` | `test/create.test.js`、`test/paths.test.js` |
| E. 恢复与竞态 | 请求/授权持久化；取消调用前重判归属；配对窗口 CAS | `test/lifecycle.test.js`、`test/create.test.js`、`test/rearm.test.js` |
| F. 文档/安装/隐藏控制台 | `docs/host-api.md`、插件 README、`windows_cmd.py` 的 `CREATE_NO_WINDOW`、`scripts/windows/Manage-DesktopHost.ps1` | `tests/test_windows_cmd.py`、`tests/test_host_install_scripts.py` |
| G. 出站完成 webhook | `outbox.js` + `server.js` 的 `notify()`；官方终态/`needs_input` → 持久 outbox → 鉴权 HTTPS；`GET /v1/outbox` 只读状态 | `test/webhook.test.js`（mock 接收端；**未端到端接通**） |

官方契约依据（0.2.2-rc.5 源码，锚点见[官方契约复核](official-host-contract.md)）：

- `sessionController.create(SessionCreateRequest)`：`workspaceId` 与 `cwd` 互斥；`workspaceId` 才 `attachSession`；目录缺省时官方会 `mkdir -p`，所以本桥先做存在性/根目录校验。
- `workspaceRegistry.create(path, title)`：只接受**已存在**目录，realpath 后幂等；不创建目录。
- `openWorkspacePath`：只在 Host 桌面打开/定位，不创建、不改写。
- `llm.resolveModelInfo().reasoning.efforts` 才是 effort 能力入口；`listModels` 没有 reasoning 字段。官方**没有 `auto` effort 值**：省略 = adapter 默认，`null` 清除。
- `state.pendingInput` / `approvalState` / `userQuestions` / `inbox` 是等待输入信号；官方没有错误消息投影，所以发现端拿不到证据就是 `unknown`。

## 证据分级

| 证据 | 结果 | 能证明什么 |
| --- | --- | --- |
| 官方源码复核 | 两份文档（0.1.6 契约 + 本轮 create/open/model 复核） | 只证明“官方源码如此” |
| Node 隔离回归（8 个测试文件） | **108 passed，0 failed** | 同一进程内的协议、失败关闭、路径安全、恢复路径、并发/重启边界、出站通知 |
| Python 脚本/桥回归 | 修正 Windows cwd 与 TOML 路径夹具后，完整套件通过 | 重新布防、打包、隐藏控制台、安装与回滚边界、技能的请求与事件协议 |
| 真机 Desktop | 在 Windows Desktop 0.2.2-rc.5 验收 | 安装、目录/会话创建、授权配对、模型 effort 真机执行、短请求交卷与 SSE 续读。见 [真机验收](verified-scope.md) |

## SuperAgent 官方入口

- 官方 CLI：`node .dsh/profiles/superagent/node_modules/dsh-superagent/scripts/dsh-superagent.mjs --profile superagent status` → **exit 0**，health 全 ready，`manually_stopped:false`，`feishu:null`；CLI 只有 status/start/restart/stop，没有派工或建票子命令。
- 官方 HTTP `GET /orchestrator/api/tickets` 默认列开放工单。`GET /orchestrator/api/tickets?state=ended` 可查历史，详情能读取 Assignment ID、worker 会话 `ref` 和状态。`POST /orchestrator/api/tickets`、`POST /orchestrator/api/triggers`、`POST /orchestrator/api/threads`、`GET|POST /orchestrator/api/assignment` 均返回 404 `Unknown operation`。
- 源码路由表（bundled `lib/index.js` 的 `ROUTES`）只有读取/设置/工单动作，没有创建 Trigger/Ticket/Assignment 的路由；`docs/001-domain.md` 明确 Trigger 由 Source 产生、Eval 接受后建 Ticket；`docs/006-deployment.md` 说明请求经 GitHub/Feishu 通知进入，且“人只能直接在已有 Executor Session 里写”，没有票据就没有 Executor Session。
- 一笔新 Assignment 需要已配置且健康的 Source、通过 Policy 的发送者和可执行模型。GitHub Source 还要求独立 Agent 账号对配置的仓库具备 Write。官方流程见 [SuperAgent 部署文档](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/006-deployment.md)。

## 出站完成 webhook：代码完成，端到端未接通

- 实现：`outbox.js` + `server.js` 的 `notify()`；`GET /v1/outbox`/`GET /v1/health` 只暴露状态元数据。默认关闭。
- 覆盖：默认关闭、outbox 落盘与重启恢复、HMAC 头与稳定 `event_id`、指数退避/失败上限、幂等、脱敏（无文本/会话/cwd）、HTTPS + host allowlist + 私网 DNS 拒绝、`completed`/`failed`/`cancelled`/`needs_input`/`unknown`/`bridge_timeout` 区分。`test/webhook.test.js` 全部 mock 接收端，HTTP 200 只代表 mock 成功。
- 本次保留 SSE 和轮询，出站保持关闭。启用时需要配置签名接收端，按 `event_id` 去重并按 `request_id` 关联原任务。Grok Bot 的原生 routine 使用 Bearer 和 `context` 请求体，现有 HMAC sender 需要兼容接收端完成验证和转发。

## 安装/升级/回滚脚本

`scripts/windows/Manage-DesktopHost.ps1` 面向 `desktop` profile。升级校验候选包、归档当前插件供回滚、通过官方 CLI 安装并回读版本。它让已识别的独立 SuperAgent 进程继续运行，并保留 Desktop 配置和授权状态。隔离 profile 实测安装、升级、回滚及卸载，正式 Desktop 真机完成一次 0.1.6 → 0.2.0 升级。见 [Windows 安装与回滚](windows-delivery.md)。

## 隔离目录闭环（官方 headless，不是 SuperAgent）

在 `%TEMP%` 下新建一次性 git 仓库，只有 `calc.py` / `test_calc.py` / `README.md`；初始测试 2 失败 1 通过。由官方 DSH `headless` profile 在**本轮显式 `--patch` overlay**（`deepseek-account` provider，不写回任何 profile 配置）执行，工作目录就是该隔离仓库：

1. 第一轮：修 `add(a, b)`；headless 会话报告并实际得到 `3 passed`。
2. 第二轮（返修）：加入新的 `test_div` 失败用例，要求实现 `div`；headless 会话实现后 `4 passed`。
3. 主控独立验收：用同一 Python 解释器重跑 `python -m pytest -q` → `4 passed`；随后在隔离仓库本地 `git commit`（不连接远端、不进入本仓库）。

结论：**闭环成立，但执行者是官方 headless 会话，不是 SuperAgent 工单**。headless CLI 在带 reasoning/stderr 输出时退出码为 1（结果文本与文件状态为准）；本闭环没有可靠的 token 计量，约 240k 只是非强制目标，不能声称费用保证。SuperAgent 官方入口的阻塞证据见上一节；按约束没有改它的配置、数据库或业务仓库。

## 仍未验证 / 已知边界

- 活动请求的取消和跨 Desktop 重启的真实长任务恢复尚未验收。短任务交卷和 SSE 续读已通过。
- 出站 webhook 尚无真实投递证据，本机按操作者选择使用轮询。
- 新建会话的模型：官方 `create` 不选模型；bridge 只在已有 live 空闲 Agent 时设置显式模型，否则 `deferred`，首次 prompt 可能 `needs_ui`/`model_unknown`。
- 官方没有 compare-and-cancel；取消是调用前重判归属，仍有极窄窗口。
- 发现状态依赖官方 projection 的挂载；缺投影只能 `unknown`，不读历史猜。
- `requests.json` 无保留期上限；每请求事件日志上限 200 条。
- Windows 隐藏控制台只覆盖桥启动的子进程（`CREATE_NO_WINDOW`）；用户自己运行 CLI 的那个控制台不会被隐藏。
