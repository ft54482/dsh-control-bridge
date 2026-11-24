# 已经在一台 Windows Desktop 上看到的，和还没有看到的

本文记录 Windows Desktop 上的匿名验收和隔离测试。会话标识、路径、业务名称及凭据保存在本机。

<a id="version-map"></a>

## 先分清四处“0.2.2”

文档里出现的 `0.2.2` 不是同一个东西，读证据前先对上号。本机有**三条 CLI 入口**，版本各不相同：

| 说法 | 指什么 | 版本与核对方式 |
|---|---|---|
| 目标契约 `0.2.2` / `0.2.2-rc.5` | 本插件按官方 session controller 的 `0.2.2` 形状实现与核对；这是 API 形状，不是某个 CLI | `docs/official-host-contract.md`；`plugins/dsh-control-bridge-host/package.json` 的 `dsh.compat.sessionController` |
| 隔离 Host 的 runtime（入口 1） | 启动隔离 profile 的 CLI，由操作者选，本轮用本机的 `dsh-022` 安装 | **0.2.2-rc.5**：`node C:\Users\Administrator\dsh-022\node_modules\@deepseek-ai\dsh\lib\bin.js -V`（`-V` 实测）；准备阶段曾用全局 npm 入口，真机阶段换成这条，结论以真机启动命令为准 |
| Desktop 随附 CLI（入口 2） | `D:\DeepSeek Harness` 的 Desktop 及其 `resources\runtime\cli` | 0.2.3-alpha.2（可执行文件 FileVersion；核心在 `app.asar` 内，不能直读版本号） |
| 全局 npm 包（入口 3，web 实例 3082/3084/3088） | `npm i -g @deepseek-ai/dsh`，和 Desktop 自带的不是一份 | 0.2.1-rc.3（`& "$env:APPDATA\npm\dsh.cmd" --version`） |

结论：`0.2.2` 说的是**目标 API 形状**，不是“这台机器上每个 runtime 都是 0.2.2”。三条入口分别是 Desktop 0.2.3-alpha.2、全局 npm 0.2.1-rc.3、隔离 `dsh-022` 0.2.2-rc.5；真机验收必须写明用的是哪一条入口，本轮是第三条。

模型 provider `orange-pro` 也不是内置能力：它由第三方 bundle `chengzipro-dsh-plugin@0.4.7` 的 patch 插入，本轮只装进隔离 lab profile，未改进正式 Desktop、也未改全局 npm 的三个实例。

<a id="workspace-autonomy-scope"></a>

## 工作区自主（`workspaceAutonomy`，本分支，未发布）

三态分开写，不许合并：

| 态 | 范围 | 证据 | 结论 |
| --- | --- | --- | --- |
| **implemented**（已实现） | 任务范围登记/复用工作区与写授权、按任务归属与 `confirm_task` 接管、忙会话不抢占、`revoke-workspace` 只撤授权、幂等键按 operation 绑定、撤销/降权后 `authorization_stale`、空授权首启门禁、helper 的 health 门禁与回执校验、17 固定键操作记录 | `plugins/dsh-control-bridge-host/test/autonomy-cases.js`、`test/startup-cases.js`（含子进程真监听的 `startup-probe.js`，两者由 `test/create.test.js` 导入）、`tests/test_desktop_skill.py`；CI 原样 8 文件命令 169 通过；pytest **本机 155 passed / 4 skipped**（含合并进来的 PR14 `tests/test_zcode_skills.py` 10 条），**PR17 远端 CI 记录 153 passed / 6 skipped**（Linux 环境多 2 条 skip，环境差异不是缺陷）；合并 main 之前是 145 / 4，只作历史时点；`python examples/e2e_fake.py` ok（2026-11-25 本机复跑，只跑不改） | 代码与夹具层已实现 |
| **mock**（隔离/夹具） | 上述全部行为都在进程内假服务上验证：官方 `workspaceRegistry` / `sessionController` / `sessionQuery` 是夹具形状；`startup-cases.js` 的子进程会在空闲端口上真监听并真发 `GET /v1/health`，但它连的仍是夹具 Host，不是 Desktop | 同上测试文件 | 夹具通过本身不等于真机通过，但下面的 isolated live 另算一条 |
| **live**（真机） | 装进隔离 Host 的真实 0.2.2-rc.5 运行时（profile `ws-autonomy-lab`）：真建工作区、真建会话、真派合成提示、真撤销 | **isolated live PASS (0.2.2-rc.5), 2026-11-25**；证据见任务目录 `.agent/master-control/tasks/bridge-workspace-autonomy-20261125/lab/report.md` 与 `A-*`/`B-*`/`C*`/`D-*`（主控侧记录，不在本仓库内） | **通过的是隔离 Host 验收**，不是生产 Desktop 验收，也不是发布验收 |

### 真机看到了什么（isolated，0.2.2-rc.5）

实例：profile `ws-autonomy-lab`，Host `127.0.0.1:8766`、web `3096`，runtime 0.2.2-rc.5（本机 `dsh-022` 安装），独立状态目录，空 allowlist + 无 bootstrap 首启。

| 证据点 | 真机回执 |
| --- | --- |
| 首启（空授权、无配对窗口、无预灌） | `health` 200：`workspace_autonomy.effective:true`、`grants_count:0`、`bootstrap_status:"unconfigured"`、`allowlist_warnings:[]`；启动时无 tool-office / preset broken 告警，随后 stderr 仅一行 `[llm-deepseek-account] model listing …`（`host022-run1.err.txt`，110 B） |
| roots 外两个新工作区（`alpha2` / `beta2`） | `create-workspace` 200：`created:true`、`created_directory:true`、`started_task:false`；`create-session` 200：`agent_preset:"master-control"`、`agent_preset_source:"session_projection"`、`grant.access:"write"`、`started_task:false`；投影回读各 1 条；发提示前无 `requests.json` |
| 首轮派工 | 合成提示 202 接受 → `wait` 得 `phase:"terminal"`、`terminal_scope:"official"`、`completed:true`、`text:"OK"`、`turn:1`，`route_match` / `effort_match` / `model_match` 全 true；`history` 回读请求与回答一致 |
| 复用（B） | 同工作区再登记 `reused:true`、`created:false`、`created_directory:false`；`/v1/workspaces` 只有 1 条、该工作区 sessions 只有 1 条；第二个提示照样 official 完成（`turn:2`），未新建工作区/会话 |
| C1 并发 | 4 个并发 `create-workspace` 全 200 且同一 id（1 个 `created:true` + 3 个 `reused:true`），列表仍只 1 条 |
| C2 未知预设 | 新路径上 409 `agent-preset/invalid`（带 `detail`），目录未创建、无授权 |
| C3 任务归属 | 换 `task_id` 无 confirm → 409 `workspace_task_mismatch`（带 `existing_task_id`）；加 `confirm_task:true` → 200 且 journal 出现 `workspace_task_confirmed` |
| C4 忙会话 | 长任务 `running:true / busy:true` 时再 `resume` → 409 `busy`（`existing desktop turn was not cancelled`）、`started_task:false`；长任务随后 official completed，未被 cancel |
| C5 策略关闭对照 | 对照 profile `effective:false / reason:"disabled"`：roots 外 `create-workspace` → 400 `outside_allowed_roots`；指向 roots 外的 preset session → 400 `existing_workspace_required`；无授权工作区的 preset 写会话 → 403 `workspace_not_allowlisted`；allowlist 全程未变 |
| C6 撤销 | `revoke-workspace` 200：`revoked{workspace:true, sessions:1}`、`directory_intact:true`，目录仍在；随后对原会话 `resume` → **409 `workspace_not_allowlisted`** |
| 旁证 | 3082/3084/3088/8765 的 pid 与 StartTime 前后一致（未重启），四个在用 profile 的 `cordis.patch.yml` sha256 未变；journal 16 行；收尾 `health` `grants_count:4 / operations:16 / effective:true`；全程只监听 `127.0.0.1`、只用合成文本、无 CUA、无客户数据；正式 Desktop 8765 **零写入**（连只读 health 都没打） |

PR：[#17](https://github.com/ft54482/dsh-control-bridge/pull/17)（base `main`，head `agent/workspace-autonomy`，**未合并**）。

### 这次仍然没有真机证据（不许并进上面的 PASS）

- **C7 部分失败/重试**（授权落盘失败、修复路径、`projection_unverified`）：**mock-only**，真机按任务书不制造权限故障。
- **幂等键冲突 / 回放**：409 `idempotency_key_reused`、 撤销后回放 409 `authorization_stale` 只有夹具证据，真机未演练（C1 并发用的是同参数同键，不是冲突场景）。
- 只读（`access:"read"`）会话在忙时的行为、`workspaceAutonomy:{enabled:true}` 对象形态、自定义 `autonomyRecordFile`、`allowOpenPath` 写入路径、出站 webhook/outbox（`outbox_enabled:false`）、符号链接/前缀路径守卫反例：未演练，仍只有夹具。
- 生产 Desktop 8765 的 `/v1/health` 刻意未读，生产 profile **未启用**该策略。

### 与任务书不一致的地方（照实写）

1. **C6 状态码**：任务书写 `403 workspace_not_allowlisted`，实测 **409**（`resume` 走请求冲突状态码族）；语义一致，码不同。
2. **C5 的 `workspace_write_not_granted` 未复现**：同一意图的请求被更早的拒绝先挡住（`outside_allowed_roots` / `existing_workspace_required` / `workspace_not_allowlisted`），不臆造该 reason 的真机证据。
3. **C4 第一版用例没触发 busy**：长任务 3 秒内完成，第二次 `resume` 落在空档被 202 接受（未取消、未抢占）；真正的 409 `busy` 只在 `running:true` 窗口内取得。两种观察都保留：**拒绝只出现在运行窗口内，空档不是拒绝**。

同时明确三件事：本分支**未合并**、**未发布**（`plugins/dsh-control-bridge-host/package.json` 仍是 `0.2.2`，与 `pyproject.toml`、`src/` 版本绑定）、**生产未启用**（未装进任何在用 profile）。isolated live PASS 覆盖的是“隔离 Host + 真实 0.2.2-rc.5 运行时”，不要把它写成生产通过。

## 驾驶舱 0.1.3

在 Windows 上用 Harness Desktop 随附的 CLI（0.2.3-alpha.2）将发布 TGZ 安装到全新隔离 profile，核对了包版本和 bundle 登记。对解包后的代码运行了六项离线回归。在同一画面输入五项登记任务、十个任务槽和空闲的四个引擎执行器时，组件分别显示 5/10 与 0/4。移除 Harness 会话来源后，该项显示未知。此验证覆盖安装、组件渲染和本机聚合协议；其他 Desktop 版本及新 profile 内的完整图形交互仍待验证。[安装与各项数据来源](../plugins/dsh-superagent-cockpit/README.md)

## Codex 技能 0.2.3 · GitHub Source 派工

一次获授权的合成 Issue 触发了目标实例接单。实测观察到排队、一个执行槽被占用、worker 交回报告，随后同一张 Ticket 以 `completed` 结束。技能用同一份计划从 Issue 查回了对应的 Assignment 和 worker 会话。GitHub 的第一条机器人评论是接单回执，完成时间取自引擎记录。验证覆盖这台实例的新 Issue 路径；其他实例的 Source 配置须分别核对。[派工和追踪](../skills/deepseek-harness-bridge/references/superagent.md#github-source)

## ZCode 技能 · 2026-11-25

[`skills/zcode/`](../skills/zcode/README.md) 里的两个技能装在一台 Windows 电脑上，Desktop Host 0.2.2，两个 SuperAgent 实例各管一个仓库。下面是在这台电脑上看到的。

- **SuperAgent 派工全程。** `precheck`、`prepare`、`send --yes`、`trace` 四步走通。一张只要求回帖的工单，从发出评论到以 `completed` 结束用了 4 分 26 秒，Assignment 的 `report.state` 是 `ready`。随后在同一个 Issue 下追加一条带新标记的评论，同一张 Ticket 追加了第三个 Assignment，派给同一个工人会话，1 分 20 秒后以 `completed` 结束。两次仓库都没有新增提交、分支或 PR。
- **发布前，用仓库里提交的这一份再派一次。** 一项只读统计任务：从发出评论到 Ticket 以 `completed` 结束用了 4 分 01 秒，其中约两分半是工人在自己的检出里干活。工人回帖的两个数字与协调方在同一个提交上独立统计的结果一致，仓库没有被改动。
- **热配对。** 不重启 Desktop 开了一次性的配对窗口，给一个工作区的空白会话写入 `write` 授权。`granted` 里它是 `write`、`idle`，`history` 返回 200，`membership` 前后一致。
- **Desktop 会话全程。** 负责人授权后，把工作区编号加进 Host 配置的 `presetSessionWorkspaceIds`，用 `desktop.py create-session` 新建了一个 `master-control` 会话。回执里 `agent_preset` 是 `master-control`、`agent_preset_source` 是 `session_projection`、`started_task` 是 `false`。接着用 `send_brief.py` 发一条只回一行字的提示词，`wait` 返回 `phase: terminal`、`terminal_scope: official`、`completed: true`，回答正确，不到半分钟。执行模型是 Host 的全局默认，没有手动选模型。在一个已有模型记录的既有会话上也做了一次同样的往返，结果相同。
- **改 Host 配置后 Desktop 自动重启。** 两次改动 `cordis.patch.yml`，Desktop 都在 8 到 20 秒内自动重启，新配置随之生效（Desktop 0.2.3-alpha.2）。只观察到这两次，没有做受控实验。
- **工人的执行目录。** 每张工单一个目录，在分支 `agent/<同名>` 上，起点是引擎当时的 `origin/main`，不碰项目的主工作副本。
- **助手的自检。** 三套行为测试全部通过；变异对照把两个助手故意改坏 16 处，每一处都被测试抓住。

这台电脑上没有看到的：

- 新开 Issue 的派工路径（`--kind issue`）。它走 `gh issue create`，而这里的 `gh` 令牌没有 project 读权限。
- 给没选过模型的空白会话发提示词。`409 model_unknown`；请求里带上模型则是 `409 needs_ui`。要先在 Desktop 里给它选模型，或者新建带预设的主控会话。新建会话要求工作区在 Host 的创建范围里，否则是 `403 outside_allowed_roots`。
- 撤销授权（`/v1/revoke`）。只读过 Host 的源码和文档。

真机上碰到、上游 0.2.3 客户端还没有处理的四件事。绕法写在 ZCode 技能的 `SKILL.md` 里，原因写在 [`skills/zcode/dsh-control-bridge/references/develop.md`](../skills/zcode/dsh-control-bridge/references/develop.md)：

- `superagent.py` 默认连 3082，`github_source.py` 默认连 3084，一台电脑跑多个实例时会连错。
- 接单回帖以「已接单：」开头，`is_acknowledgement` 认不出它，`final_comment.present` 在工人干活前就是 `true`。
- 回帖里出现派工标记后，`trace` 报 `comment_marker_not_unique`。
- Ticket 结束后，发件账号在同一 Issue 下的评论会追加一个 Assignment，并改写 Ticket 的 `ended.outcome`。

仓库里的 `tests/test_zcode_skills.py` 守两件事：ZCode 技能里那五个上游文件与 Codex 技能发布版 v0.2.3（标签 `skill-v0.2.3`）逐字节相同；`skills/zcode/` 下没有本机的配对文件，也没有像令牌的字符串。ZCode 的行为测试只在 Windows 上运行，其他系统的 CI 跳过它们。模拟通过不等于上面这台电脑已经复测了新提交。

主干上的 Codex 技能在 #13 之后多了待办收件箱、回帖和轮询，ZCode 技能还没有同步这部分。

## 0.2.2 在已授权 Desktop 工作区的主控会话

Windows 上的 Desktop profile 从 Host 0.2.0 升级到 0.2.2 后，Codex 全程通过已安装的 `deepseek-harness-bridge` 验收。工作区和会话的既有授权均已核对。

| 操作 | 真机回执 |
| --- | --- |
| 在同一已授权工作区连续创建两个会话 | 两次均为 HTTP 200。会话 ID 不同，工作区 ID 均与目标一致。两次均从实际会话读回 `agent_preset=master-control`、`agent_preset_source=session_projection`，且 `started_task=false`。 |
| 向第一个新会话派发本地合成测试，再按原请求查询 | HTTP 202 接受，随后读到 `phase=terminal`、`terminal_scope=official`、`completed=true`。执行方为 Harness Desktop 主控会话，Codex 独立比对了返回值与本地测试文件。 |
| 继续升级前的已授权会话 | 新的算术测试到达官方完成状态，回答与独立计算一致。 |
| 指定无效预设 | HTTP 404，`agent-preset/not-found`。 |
| 指定已登记但未授权的工作区 | HTTP 403，`workspace_not_allowlisted`。 |

两次拒绝后均核对了会话列表和授权，创建数与派工数均为零。此次执行和审计凭据来自 Desktop 会话与 Codex，正式 SuperAgent Assignment 和 worker session 尚无本次实测凭据。[用 skill 复现](../skills/deepseek-harness-bridge/references/desktop.md#new-work-in-master-control-mode)

## 0.2.1 的主控会话创建

在 Windows 上，用 DeepSeek Harness Desktop 0.2.2-rc.5 随附的 CLI 启动独立的官方 Web profile。该实例使用临时工作区、仅本机监听的端口和同 ID 的合成主控预设。Codex helper 连接 Host 0.2.1，获得 `preset_create_verified: true`，并在指定工作区创建了只读的空白会话。

创建响应给出了 `agent_preset: "master-control"`、`agent_preset_source: "session_projection"` 和 `started_task: false`。独立读取该会话的官方投影，确认预设相同、`blank=true`，且没有对话轮次。核验后关闭了隔离服务。此次验证覆盖官方会话控制器的创建和回读；现用 Desktop GUI 保持原版本，未发送模型提示词或发起 SuperAgent Assignment。

## 0.1.5 上已经发生的一次往返

环境是 Windows Desktop 0.2.2-rc.5，Host 插件 0.1.5。对象是一条已经授权的既有对话。安装用的是官方 `dsh plugin` CLI。

- `health`、`granted`、`history` 成功。
- 模型读自会话日志（`session_log`），不是部署默认值。`next` 的 provider/model 与操作者预期一致，`availability.available` 为 true。
- `agent_available` 为 false，`can_set` 为 false，原因是 `agent_not_attached`。因此没有调用模型设置，resume 请求里也没有带 model。
- 一次 resume，没有重发。HTTP 200，约 4.7 秒。`accepted`、`completed` 为 true，`terminal` 与 `final.reason.kind` 都是 `completed`，回答文本是 `2`。
- `execution_model_source` 为 `request_header`。请求、确认和实际执行的 provider/model 一致，`model_match` 为 true。回合序号增加。
- 仍是原来的 session 和 cwd。历史条数从 83 增到 95，旧事件身份还在。
- 5 个正式工作区的登记和 session id 列表前后逐项相同。没有已清理的测试工作区回流，也没有子会话被提成根会话。

## 0.1.6 的请求生命周期与配对窗口：只有夹具证据

这一节的结论不来自真机，不能并进上面那次 0.1.5 往返。

- 阶段 A：请求记录（`requests.json`）、`GET /v1/requests` 断线后补读终态、owned-turn 取消、`POST /v1/wait/stop`、幂等冲突、`unknown` 不重发，由 `plugins/dsh-control-bridge-host/test/lifecycle.test.js` 的进程内回归覆盖；官方 0.2.2-rc.5 源码核对写在 [official-host-contract.md](official-host-contract.md)。
- 阶段 B：同一台运行中的 Host，在不重启进程的情况下重新布防 `bootstrap.json` / `bootstrap.secret`、单次使用、并发配对只成功一次、过期/超长/损坏 JSON 失败关闭、授权写盘失败不作废窗口、外部改写 `allowlist.json` 立即生效，由 `test/rearm.test.js` 覆盖；`tests/test_rearm_bootstrap.py` 只验证重新布防脚本不改长期 host secret 和授权文件。主机夹具模拟了官方 controller 的 `prompt` / `cancel` / `list` 形状，但它不是那台 Desktop。
- `health` 的 `bootstrap_armed` 等字段、`agent_not_attached` 取消拒绝、取消回执与官方 `turn/end` 分开，也只在夹具里看过。

这些都不能写成 0.1.6 已经在真机上通过。真机安装、真机取消、真机重新配对仍未做；见 [request-lifecycle.md](request-lifecycle.md) 的升级和回滚步骤，以及 [release-0.1.6.md](history/release-0.1.6.md) 的证据分级。

## 0.2.0 的夹具回归

这一节同样不来自真机，不能并进 0.1.5 那次往返。

- A：请求日志的 `seq`/事件流、`wait:false`、`/events`、`/wait`、SSE 心跳与 `Last-Event-ID` 断点续读、重启后按 rpcId 补写终态、`unknown` 不重发，由 `test/control.test.js` 覆盖；实现见 `journal.js` 与 `server.js` 的 `advanceRequest`。
- B：`/v1/model-catalog` 在官方可枚举时给出 `reasoning.efforts`（走 `llm.resolveModelInfo`），不可枚举时 `null` + `unknown`；`null` 清除旧 effort、省略跟随 adapter 默认、`auto` 明确拒绝；`route_match`/`effort_match`/`effort_verified`/`model_match` 分开，由 `test/control.test.js` 覆盖。
- C：`/v1/discover` 读取全部已注册工作区/会话元数据，分类/状态/分页/cwd 来源/去重由 `test/control.test.js` 覆盖；状态只从官方 list 行与投影推导，没有证据就是 `unknown`，不读历史。
- D：`/v1/workspaces`、`/v1/sessions`、`/v1/open` 的官方 create/open 调用、双开关、根目录内 realpath 校验、路径穿越/前缀/符号链接拒绝、默认 read 授权、重启后授权仍在，由 `test/create.test.js` 和 `test/paths.test.js` 覆盖。

## 0.2.0 真机验收

在 Windows Desktop 0.2.2-rc.5 上，用随附 CLI 从 0.1.6 升级至 Host 0.2.0。升级前后持久工作区文件逐字节一致，已有授权保持一致。目录投影多出五个可见工作区，一个原先分组的会话在同一 cwd 以未分组会话出现。全局发现找到了该会话，持久工作区文件原本未登记该会话 ID。

- 全局发现、授权历史、指定根下创建目录和注册工作区、新建获 read 授权的会话，以及官方打开目录均通过。根外的创建被拒绝，目标路径没有生成。
- 0.1.6 留下的官方完成记录可由 0.2.0 查询，长轮询和 SSE 能读到结束。一次用户授权的新请求返回 HTTP 202，交卷内容符合预期。`terminal_scope=official` 和 `completed=true`，路由及 `medium` effort 均由实际执行记录验证。SSE 用首帧序号重连，续传帧的序号全部大于断点。
- 在同一验收会话读回 `low`、`medium` 和清除后的 effort。`auto` 返回 HTTP 400。验收会话最终恢复 read，部署默认和现有工程会话的配置保持一致。对已完成的请求调用取消，返回 `already_terminal` 并保留官方原结果。
- 在同一 Host 进程内热重布防短期配对窗口，验收会话完成配对并保留 read，窗口重放返回 403。长期 bearer 未变化。
- Codex 技能用官方 SuperAgent 管理面成功读到已结束历史 Ticket 的 Assignment ID、开始记录及 worker session `ref`。

## 还不能写成已经验证

- 超过默认等待窗口的新长任务，以及执行期间重启后的完整恢复
- 冷会话改模型、`needs_ui` 之后的创建/派工
- 操作者同时在界面里改模型
- 对运行中自有回合执行取消，以及超时后的完整生命周期
- 跨工作区、多实例的实际工程闭环
- 通用出站通知仍待验证。早期版本的验收范围见 [0.2.0 交付记录](history/release-0.2.0.md)。

仓库里的 Node 和 Python 测试是模拟。模拟通过不等于上面这台 Desktop 已经复测了新提交。

## 安装锁

仓库里没有名为 `install-0.1.4` 或 `install-0.1.5` 的脚本。若本机另有一份未入库脚本把任何 `DeepSeek Harness.exe` 都当成 Desktop，那份脚本不在此树里，这次不能假装已经改掉它。

仓库内的判断在 `dsh_control_bridge.desktop_install` 和 `Manage-DesktopHost.ps1`。明确属于其他 profile 的 SuperAgent 进程可继续运行。默认外壳、Desktop Host 和归属不明的进程会阻断安装。用 Desktop 正常退出菜单关闭应用，再运行升级脚本。
