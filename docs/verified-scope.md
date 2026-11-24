# 已经在一台 Windows Desktop 上看到的，和还没有看到的

本文记录 Windows Desktop 上的匿名验收和隔离测试。会话标识、路径、业务名称及凭据保存在本机。

<a id="version-map"></a>

## 先分清四处“0.2.2”

文档里出现的 `0.2.2` 不是同一个东西，读证据前先对上号：

| 说法 | 指什么 | 怎么核对 |
|---|---|---|
| 目标契约 `0.2.2` / `0.2.2-rc.5` | 本插件按官方 session controller 的 `0.2.2` 形状实现与核对 | `docs/official-host-contract.md`；`plugins/dsh-control-bridge-host/package.json` 的 `dsh.compat.sessionController` |
| 隔离 Host 的 runtime | 启动那个隔离 profile 的 CLI 版本，由操作者选，不由插件决定 | 启动命令用的那个 `dsh.cmd`：`& $dsh --version`。本机有两条入口——Desktop 自带 CLI 0.2.3-alpha.2 与全局 npm `@deepseek-ai/dsh` 0.2.1-rc.3（`& "$env:APPDATA\npm\dsh.cmd" --version`）。lab 准备阶段用的是后者，主控本轮口径为 `0.2.2-rc.5`，两者不一致时以实际启动命令为准 |
| Desktop 应用 / 自带 CLI | 操作者正在用的 DeepSeek Harness Desktop 及 `resources\runtime\cli` 里的 CLI | 0.2.3-alpha.2（`& "D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" --version`） |
| 全局 npm 包 | `npm i -g @deepseek-ai/dsh` 装的 CLI，和 Desktop 自带的不是一份 | 0.2.1-rc.3（`package.json` 的 `version`） |

结论：`0.2.2` 说的是**目标 API 形状**，不是“这台机器上每个 runtime 都是 0.2.2”。真机验收必须写明用的是哪一条入口。

<a id="workspace-autonomy-scope"></a>

## 工作区自主（`workspaceAutonomy`，本分支，未发布）

三态分开写，不许合并：

| 态 | 范围 | 证据 | 结论 |
| --- | --- | --- | --- |
| **implemented**（已实现） | 任务范围登记/复用工作区与写授权、按任务归属与 `confirm_task` 接管、忙会话不抢占、`revoke-workspace` 只撤授权、幂等键按 operation 绑定、撤销/降权后 `authorization_stale`、空授权首启门禁、helper 的 health 门禁与回执校验、17 固定键操作记录 | `plugins/dsh-control-bridge-host/test/autonomy-cases.js`、`test/startup-cases.js`（含子进程真监听的 `startup-probe.js`，两者由 `test/create.test.js` 导入）、`tests/test_desktop_skill.py`；CI 原样 8 文件命令 169 通过，`python -m pytest tests -q` 145 通过 4 跳过，`python examples/e2e_fake.py` ok（2026-11-25 本机复跑，只跑不改） | 代码与夹具层已实现 |
| **mock**（隔离/夹具） | 上述全部行为都在进程内假服务上验证：官方 `workspaceRegistry` / `sessionController` / `sessionQuery` 是夹具形状；`startup-cases.js` 的子进程会在空闲端口上真监听并真发 `GET /v1/health`，但它连的仍是夹具 Host，不是 Desktop | 同上测试文件 | 夹具通过**不等于**真机通过 |
| **live**（真机） | 装进真实 Desktop profile、真实创建会话、真实派工 | 隔离 Host 验收进行中，证据见任务目录 `.agent/master-control/tasks/bridge-workspace-autonomy-20261125/lab/`（主控侧记录，不在本仓库内） | **未通过**：真机 `health` 的 `workspace_autonomy.effective`、真机建会话与 `revoke-workspace` 都还没有证据 |

同时明确三件事：本分支**未合并**、**未发布**（`plugins/dsh-control-bridge-host/package.json` 仍是 `0.2.2`，与 `pyproject.toml`、`src/` 版本绑定）、**未安装**到任何在用 profile。不要因为隔离回归全绿就把它当成已在 Windows Desktop 上验收。

## 驾驶舱 0.1.3

在 Windows 上用 Harness Desktop 随附的 CLI（0.2.3-alpha.2）将发布 TGZ 安装到全新隔离 profile，核对了包版本和 bundle 登记。对解包后的代码运行了六项离线回归。在同一画面输入五项登记任务、十个任务槽和空闲的四个引擎执行器时，组件分别显示 5/10 与 0/4。移除 Harness 会话来源后，该项显示未知。此验证覆盖安装、组件渲染和本机聚合协议；其他 Desktop 版本及新 profile 内的完整图形交互仍待验证。[安装与各项数据来源](../plugins/dsh-superagent-cockpit/README.md)

## Codex 技能 0.2.3 · GitHub Source 派工

一次获授权的合成 Issue 触发了目标实例接单。实测观察到排队、一个执行槽被占用、worker 交回报告，随后同一张 Ticket 以 `completed` 结束。技能用同一份计划从 Issue 查回了对应的 Assignment 和 worker 会话。GitHub 的第一条机器人评论是接单回执，完成时间取自引擎记录。验证覆盖这台实例的新 Issue 路径；其他实例的 Source 配置须分别核对。[派工和追踪](../skills/deepseek-harness-bridge/references/superagent.md#github-source)

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
