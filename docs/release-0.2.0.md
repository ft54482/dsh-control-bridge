# Host 0.2.0 交付与证据

本文记录 0.2.0 的能力、证据级别、SuperAgent 闭环的阻塞，以及仍未真机验证的部分。证据分四层，不能互相代替：官方源码复核、隔离回归、脚本回归、真机。**这里没有真机结果。**

## 交付物

- Host 包 `dist/dsh-control-bridge-host-0.2.0.tgz`（sha256 `aa5891a7…e65798`，56,024 bytes），便携源码包 `dist/dsh-control-bridge-0.2.0-portable.zip`（sha256 `301da96d…e50392`，1,167,002 bytes）；完整值在 `dist/MANIFEST.json` 和同名 `.sha256`，由 `scripts/build_release.py` 解包逐文件核对（含“manifest 声明的运行时文件必须都在 tgz 里”的反向检查）。**这是本包最终重建产物；协调方先前记录的两个 hash 是上一次交卷的构建，以本文件为准。**
- 提交：`e4750c3`（0.1.6 基线）→ `f33f335`（0.2.0 功能）→ `954933e`（本轮独立复核后的修复）→ 本文档所在提交。没有 amend 既有提交。
- 版本递增到 0.2.0（插件 `package.json` 与 Python `pyproject.toml`），不再出现同版本不同 hash。
- 没有安装到现网 0.1.5，没有 push、merge 或 force-push。

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
| Python 脚本/桥回归 | 76 passed，4 skipped，9 failed（POSIX 路径/TOML 夹具假设） | 重新布防脚本、配对输出、隐藏控制台、打包清单、安装脚本静态检查；剩余失败全部是夹具把 POSIX 绝对路径写进 Windows 配置，与本轮代码无关 |
| 真机 Desktop | **未运行** | 没有安装 0.2.0、没有真机长任务/创建/取消/配对 |

Python 的 11 个失败仍是既有平台夹具问题（无盘符绝对路径写进 TOML、`os.killpg`、依赖 `node` 在 PATH）；CI 矩阵是 `ubuntu-latest`，与本轮主机插件代码无关。

## SuperAgent 官方入口：精确阻断（本轮原始证据）

- 官方 CLI：`node .dsh/profiles/superagent/node_modules/dsh-superagent/scripts/dsh-superagent.mjs --profile superagent status` → **exit 0**，health 全 ready，`manually_stopped:false`，`feishu:null`；CLI 只有 status/start/restart/stop，没有派工或建票子命令。
- 官方 HTTP（同源头）：`GET /orchestrator/api/tickets` → **200** `{"items":[],"total":0,"next_offset":null}`；`GET /orchestrator/api/threads` → 200 空。`POST /orchestrator/api/tickets`、`POST /orchestrator/api/triggers`、`POST /orchestrator/api/threads`、`GET|POST /orchestrator/api/assignment` → **404** `{"error":"Unknown operation"}`。
- 源码路由表（bundled `lib/index.js` 的 `ROUTES`）只有读取/设置/工单动作，没有创建 Trigger/Ticket/Assignment 的路由；`docs/001-domain.md` 明确 Trigger 由 Source 产生、Eval 接受后建 Ticket；`docs/006-deployment.md` 说明请求经 GitHub/Feishu 通知进入，且“人只能直接在已有 Executor Session 里写”，没有票据就没有 Executor Session。
- 唯一已配置 Source 是 GitHub 且指向业务仓库；制造事件=对业务仓库外部写（禁止）。Feishu 未配置。因此没有 Assignment/session/run 编号可填；**本项未完成，没有用 headless 或子代理冒充**。要真正走官方流水线，起点仍是对该业务仓库的一次授权 GitHub 事件，超出本包边界。

## 出站完成 webhook：代码完成，端到端未接通

- 实现：`outbox.js` + `server.js` 的 `notify()`；`GET /v1/outbox`/`GET /v1/health` 只暴露状态元数据。默认关闭。
- 覆盖：默认关闭、outbox 落盘与重启恢复、HMAC 头与稳定 `event_id`、指数退避/失败上限、幂等、脱敏（无文本/会话/cwd）、HTTPS + host allowlist + 私网 DNS 拒绝、`completed`/`failed`/`cancelled`/`needs_input`/`unknown`/`bridge_timeout` 区分。`test/webhook.test.js` 全部 mock 接收端，HTTP 200 只代表 mock 成功。
- **本机没有接收 URL 和共享密钥，没有真实投递**。需经正规安全表单填写：是否开启；HTTPS 接收 URL；共享密钥（HMAC-SHA256，`x-dsh-timestamp` + "." + body，请求头 `x-dsh-signature`）；可选 `allowedHosts`；事件白名单（至少 completed、failed、needs_input、cancelled/unknown，`bridge_timeout` 可选）；可选 `maxAttempts`/`timeoutMs`。接收端必须按 `event_id` 幂等，并用 `request_id` 唤醒父流程；通知文本不得当指令执行。

## 安装/升级/回滚脚本

`scripts/windows/Manage-DesktopHost.ps1` 只接受 `desktop` profile、`Install|Upgrade|Rollback`；检测 Desktop 在运行就以退出码 3 拒绝且不结束进程；校验 SHA-256、备份 manifest/patch/allowlist、安装后回读版本；回滚可恢复文件或旧包。它不读写 `host.secret`/`bootstrap.secret`，不碰 SuperAgent profile。`tests/test_host_install_scripts.py` 只做静态检查，脚本**没有真机执行**。

## 隔离目录闭环（官方 headless，不是 SuperAgent）

在 `%TEMP%` 下新建一次性 git 仓库，只有 `calc.py` / `test_calc.py` / `README.md`；初始测试 2 失败 1 通过。由官方 DSH `headless` profile 在**本轮显式 `--patch` overlay**（`deepseek-account` provider，不写回任何 profile 配置）执行，工作目录就是该隔离仓库：

1. 第一轮：修 `add(a, b)`；headless 会话报告并实际得到 `3 passed`。
2. 第二轮（返修）：加入新的 `test_div` 失败用例，要求实现 `div`；headless 会话实现后 `4 passed`。
3. 主控独立验收：用同一 Python 解释器重跑 `python -m pytest -q` → `4 passed`；随后在隔离仓库本地 `git commit`（不连接远端、不进入本仓库）。

结论：**闭环成立，但执行者是官方 headless 会话，不是 SuperAgent 工单**。headless CLI 在带 reasoning/stderr 输出时退出码为 1（结果文本与文件状态为准）；本闭环没有可靠的 token 计量，约 240k 只是非强制目标，不能声称费用保证。SuperAgent 官方入口的阻塞证据见上一节；按约束没有改它的配置、数据库或业务仓库。

## 仍未验证 / 已知边界

- 真机安装、真机 SSE/长任务、真机创建/打开、真机取消与配对：都没有真机结果；0.2.0 未安装到现网。
- 出站 webhook 没有真实接收端，mock 200 不算端到端；真实投递需要操作者经安全表单提供 URL/密钥。
- SuperAgent Assignment 未完成：官方入口没有建票/派工路径，证据见上节；没有 Assignment/session/run 编号，不能用 headless 冒充。
- 新建会话的模型：官方 `create` 不选模型；bridge 只在已有 live 空闲 Agent 时设置显式模型，否则 `deferred`，首次 prompt 可能 `needs_ui`/`model_unknown`。
- 官方没有 compare-and-cancel；取消是调用前重判归属，仍有极窄窗口。
- 发现状态依赖官方 projection 的挂载；缺投影只能 `unknown`，不读历史猜。
- `requests.json` 无保留期上限；每请求事件日志上限 200 条。
- Windows 隐藏控制台只覆盖桥启动的子进程（`CREATE_NO_WINDOW`）；用户自己运行 CLI 的那个控制台不会被隐藏。
- 观察窗口结束时若仍有未完成项，以本节和提交记录为准，不把未验证写成通过。
- 本报告在观察窗口内写成（2026-11-22 Asia/Shanghai），没有触线取消；剩余未完成项就是上面这些真机验收。
