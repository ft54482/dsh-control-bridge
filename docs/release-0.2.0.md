# Host 0.2.0 交付与证据

本文记录 0.2.0 的能力、证据级别、SuperAgent 闭环的阻塞，以及仍未真机验证的部分。证据分四层，不能互相代替：官方源码复核、隔离回归、脚本回归、真机。**这里没有真机结果。**

## 交付物

- Host 包 `dist/dsh-control-bridge-host-0.2.0.tgz`（sha256 `9f7a5ea6…d7b8c1`，51,015 bytes），便携源码包 `dist/dsh-control-bridge-0.2.0-portable.zip`（sha256 `a005acb3…ffd33d`，1,123,271 bytes）；完整值在 `dist/MANIFEST.json` 和同名 `.sha256`，由 `scripts/build_release.py` 解包逐文件核对（含“manifest 声明的运行时文件必须都在 tgz 里”的反向检查）。
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
| F. 文档/安装/隐藏控制台 | `docs/host-api.md`、插件 README、`windows_cmd.py` 的 `CREATE_NO_WINDOW` | `tests/test_windows_cmd.py` |

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
| Node 隔离回归（7 个测试文件） | **102 passed，0 failed** | 同一进程内的协议、失败关闭、路径安全、恢复路径、并发/重启边界 |
| Python 脚本/桥回归 | 73 passed，3 skipped，11 failed（Windows 夹具假设） | 重新布防脚本、配对输出、隐藏控制台标志、打包文件清单；失败项与 0.1.6 基线相同 |
| 真机 Desktop | **未运行** | 没有安装 0.2.0、没有真机长任务/创建/取消/配对 |

Python 的 11 个失败仍是既有平台夹具问题（无盘符绝对路径写进 TOML、`os.killpg`、依赖 `node` 在 PATH）；CI 矩阵是 `ubuntu-latest`，与本轮主机插件代码无关。

## SuperAgent 闭环：官方入口不可用（有证据）

要求是“Harness 主控 → 官方 SuperAgent 工程师开发 → 验收 → 返修”。对本机官方 `superagent` profile 的只读核查结果：

- 管理 API 共 25 条路由（`/orchestrator/api/*`），**没有任何创建 trigger/ticket/thread/task 的路由**；`POST/PUT/PATCH/DELETE /orchestrator/api/tickets` 实测 404。
- Ticket 只能由已安装 Source 的真实事件产生；唯一 Source 是 GitHub，监听仓库为业务仓库，产生事件=对该仓库做外部写，与“不碰业务仓库”冲突；Feishu Source 未配置。
- 主会话工具里 `orchestrator_route accept` 需要已存在的 `trigger_id`；没有“凭空建票”的工具。CLI/脚本只有 start/stop/restart/status。
- 当前占用（2026-11-22T08:12Z 采样）：running=0、queued=0、tickets=0；只做了 GET。没有抢占其工单或执行槽。

因此本轮**没有调用 SuperAgent**，也没有把 headless 结果冒充成 SuperAgent。安全替代：用官方 DSH `headless` profile 在隔离目录跑开发闭环；结论只标为“官方 headless 会话结果”，不标为 SuperAgent 工单。若必须走 SuperAgent 官方流水线，唯一合规起点仍是对被监听业务仓库的授权 GitHub 事件，这超出本票边界。

## 隔离目录闭环（官方 headless，不是 SuperAgent）

在 `%TEMP%` 下新建一次性 git 仓库，只有 `calc.py` / `test_calc.py` / `README.md`；初始测试 2 失败 1 通过。由官方 DSH `headless` profile 在**本轮显式 `--patch` overlay**（`deepseek-account` provider，不写回任何 profile 配置）执行，工作目录就是该隔离仓库：

1. 第一轮：修 `add(a, b)`；headless 会话报告并实际得到 `3 passed`。
2. 第二轮（返修）：加入新的 `test_div` 失败用例，要求实现 `div`；headless 会话实现后 `4 passed`。
3. 主控独立验收：用同一 Python 解释器重跑 `python -m pytest -q` → `4 passed`；随后在隔离仓库本地 `git commit`（不连接远端、不进入本仓库）。

结论：**闭环成立，但执行者是官方 headless 会话，不是 SuperAgent 工单**。headless CLI 在带 reasoning/stderr 输出时退出码为 1（结果文本与文件状态为准）；本闭环没有可靠的 token 计量，约 240k 只是非强制目标，不能声称费用保证。SuperAgent 官方入口的阻塞证据见上一节；按约束没有改它的配置、数据库或业务仓库。

## 仍未验证 / 已知边界

- 真机安装、真机 SSE/长任务、真机创建/打开、真机取消与配对：都没有真机结果；0.2.0 未安装到现网。
- 新建会话的模型：官方 `create` 不选模型；bridge 只在已有 live 空闲 Agent 时设置显式模型，否则 `deferred`，首次 prompt 可能 `needs_ui`/`model_unknown`。
- 官方没有 compare-and-cancel；取消是调用前重判归属，仍有极窄窗口。
- 发现状态依赖官方 projection 的挂载；缺投影只能 `unknown`，不读历史猜。
- `requests.json` 无保留期上限；每请求事件日志上限 200 条。
- Windows 隐藏控制台只覆盖桥启动的子进程（`CREATE_NO_WINDOW`）；用户自己运行 CLI 的那个控制台不会被隐藏。
- 观察窗口结束时若仍有未完成项，以本节和提交记录为准，不把未验证写成通过。
- 本报告在观察窗口内写成（2026-11-22 Asia/Shanghai），没有触线取消；剩余未完成项就是上面这些真机验收。
