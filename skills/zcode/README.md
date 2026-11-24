# ZCode 技能

给 ZCode 用的两个技能，和本项目的 Codex 技能出自同一套客户端，基于它的发布版 v0.2.3（标签 `skill-v0.2.3`）。**状态：已完成（2026-11-25）。** 能装、能自检；SuperAgent 派工和 Desktop 主控会话（新建、发送提示词、取回结果）都在一台运行两个实例的 Windows 电脑上真机跑通。哪些验证过、哪些没有，见下面的[完成情况](#完成情况)和 [Windows 真机验收](../../docs/verified-scope.md)。

## 两个技能

| 目录 | 管什么 | 什么时候用 |
| --- | --- | --- |
| [`deepseek-harness-bridge/`](deepseek-harness-bridge/SKILL.md) | 日常派工：续接或新建 Desktop 主控会话，往 SuperAgent 派工单并跟踪到工人报告 | 把一件活交给本机的 DeepSeek Harness 去做 |
| [`dsh-control-bridge/`](dsh-control-bridge/SKILL.md) | `dsh-bridge` 命令行：起草、批准、事件入口、审计 | 需要协调桥自己的任务台账时 |

两者分工和 Codex 路径一样：日常派工用前者。后者管的是协调桥自己的任务台账，它今天还不能把任务发到真实的 Harness。

## 和 Codex 技能的关系

- **共用同一份上游客户端。** `deepseek-harness-bridge/` 里的 `scripts/desktop.py`、`scripts/superagent.py`、`scripts/github_source.py`、`references/desktop.md`、`references/superagent.md`，与 Codex 技能发布版 v0.2.3（标签 `skill-v0.2.3`）里的同名文件逐字节相同，仓库的测试守着这一点。
- **主干上的 Codex 技能可能更新。** v0.2.3 之后主干上的改动还没有同步进 ZCode 技能，目前是待办收件箱、回帖和轮询（#13）。同步之前，这里只有 v0.2.3 的能力。同步的时候要重新核对两个 SuperAgent 助手，并更新测试里钉住的哈希。
- **`SKILL.md` 是 ZCode 版。** 用中文重写，按 ZCode 的加载方式写命令，并记下了真机上碰到的判读问题。
- **多了四个助手脚本**，都只用 Python 标准库：

| 文件 | 作用 |
| --- | --- |
| `scripts/superagent_brief.py` | 从任务书文件起草 SuperAgent 工单。端口按仓库查，没有默认值；预检不能跳过 |
| `scripts/superagent_wait.py` | 一直查到工单结束才返回。只认晚于本次派工的结束；回帖里抄了标记时自动改成按 Issue 编号查 |
| `scripts/send_brief.py`、`scripts/sessions_table.py` | 往 Desktop 会话发任务书；把会话列表压成一张表 |
| `tests/` | 三套行为测试（用桩服务和假时钟，不碰真实 Harness）、变异对照、升级时的哈希比对 |

- **同名技能只加载一个。** ZCode 按发现顺序取第一个同名的技能，`~/.zcode/skills/` 排在 `~/.agents/skills/` 之前。Codex 和 ZCode 都用的话，两边各装各的即可；在 ZCode 里生效的是 `~/.zcode/skills/` 下那一份。

## 安装

前提：Python 3.11 或更新；Harness Desktop 里已装 Host 插件并配对，做法和 [Codex 路径](../../docs/windows-delivery.md#codex-desktop-setup)完全相同。要派 SuperAgent 工单，还需要一台已部署的 SuperAgent 和已登录的 GitHub CLI。要在某个工作区里新建会话，这个工作区还得在 Host 的创建范围里（在 `workspaceRoots` 之下，或把它的编号列进 `presetSessionWorkspaceIds`），否则返回 `403 outside_allowed_roots`。

1. **装日常派工技能。** 把 `deepseek-harness-bridge/` 整个目录拷进 `~/.zcode/skills/`。
2. **填本机配置。** 把其中的 `connection.example.json` 复制成 `connection.json`，按自己的电脑填写。它只放凭据**文件**的路径、端口和 SuperAgent 实例对照，凭据本身仍由 Host 保管。`superagent_instances` 里每个实例一行，写着它监听的仓库和端口。
3. **装控制面技能（可选）。** 先把本仓库克隆到所有技能目录**之外**，例如 `~/.dsh-control-bridge/repo`；再把 `dsh-control-bridge/` 整个目录拷进 `~/.zcode/skills/`，把 `local.example.json` 复制成 `local.json`，填上检出的路径。检出不要放在技能目录里，仓库自带的 `SKILL.md` 会被误认成技能。
4. **新开一个 ZCode 会话。** 技能清单在会话启动时加载。

## 验证

```bash
python ~/.zcode/skills/deepseek-harness-bridge/scripts/desktop.py health
python -I -X utf8 ~/.zcode/skills/deepseek-harness-bridge/tests/stub_host_test.py
python -I -X utf8 ~/.zcode/skills/deepseek-harness-bridge/tests/superagent_brief_test.py
python -I -X utf8 ~/.zcode/skills/deepseek-harness-bridge/tests/superagent_wait_test.py
python ~/.zcode/skills/dsh-control-bridge/dsh-bridge.py --version
```

`health` 的 `ok` 是 `true` 说明 Host 在线、凭据有效。三个行为测试各以 `RESULT: ALL PASS` 结束。装了控制面技能的话，`--version` 打印 `dsh-bridge 0.2.2`，再跑一次 `self-check`，应打印 `self-check: ok`。

之后可以在 ZCode 里说「用 SuperAgent 把某某任务派出去」，或者「找到上次做某某事的会话，接着做」。

## 完成情况

2026-11-24 至 25，在一台 Windows 电脑上，Desktop Host 0.2.2，两个 SuperAgent 实例各管一个仓库：

**已经在真机上看到**

- **SuperAgent 派工全程。** 核对、起草、发送、跟踪四步走通。首次派工从发出评论到工单以 `completed` 结束用了 4 分 26 秒；在同一张工单上追加任务用了 1 分 20 秒，派给同一个工人会话。两次仓库都没有新增提交、分支或 PR。
- **发布前，用仓库里的这一份再派一次。** 新开一张工单，让工人做一项只读统计并回帖。从发出评论到工单以 `completed` 结束用了 4 分 01 秒，工人报的两个数字与协调方独立统计的结果一致，仓库没有被改动。
- **热配对。** 不重启 Desktop 给一个工作区写入授权；桥能列出并读取这个会话。
- **Desktop 会话全程。** 在配对的工作区里新建了一个 `master-control` 会话，回读预设无误；发一条提示词，取回「官方完成」和正确的回答，不到半分钟，没有手动选模型。在另一个已有模型记录的会话上结果相同。
- **桥的只读接口。** `health`、`granted`、`discover`、`history`、`membership`。
- **助手的自检。** 三套行为测试和变异对照：把两个 SuperAgent 助手故意改坏 16 处，每一处都被测试抓住。

**还没有在真机上看到**

- 新开 Issue 的派工路径（`--kind issue`）。它走 `gh issue create`，而那台电脑的令牌没有 project 读权限。
- 给没选过模型的空白会话发提示词。`409 model_unknown`；请求里带上模型则是 `409 needs_ui`。要先在 Desktop 里给它选模型，或者新建带预设的主控会话。
- 非 Windows 系统。行为测试只在 Windows 上跑过，CI 在其他系统上跳过它们。
- 撤销授权。Host 的 `/v1/revoke` 只读过源码和文档。

**真机上发现的判读问题**，技能说明里都写了绕法，原因记在 [`dsh-control-bridge/references/develop.md`](dsh-control-bridge/references/develop.md) 的「坑四」到「坑八」：

- 两个上游客户端的默认端口不一样（3082 和 3084），一台电脑跑多个实例时会连错。
- 上游客户端认不出这台实例的接单回帖，「有最终回帖」那一项在工人还没干活时就是「是」。
- 回帖里一出现派工标记，`trace` 就报 `comment_marker_not_unique`。
- 工单结束后，发件账号在同一个 Issue 下的后续评论会追加一个任务，并改写工单结果。

## 升级

1. 从 [Releases](https://github.com/ft54482/dsh-control-bridge/releases) 取新的 Codex 技能包和它的 `.sha256`，放进一个空目录。
2. 用 `deepseek-harness-bridge/tests/hash_check.py cmp` 核对：它先核对包的哈希，再列出每个上游文件在发布包、git 标签、已装目录三处是否一致。参数写法在文件头。
3. 只替换与 Codex 技能共用的那五个文件，再读一遍新包里的 `SKILL.md`，把规则上的变化移进 ZCode 版的 `SKILL.md`。`connection.json`、`local.json` 和 ZCode 自己的文件都保留。
4. 把三个行为测试各跑一次；改过助手脚本的话，再跑 `tests/mutation_check.py`。

## English

Two skills for ZCode, built on the same clients as the Codex skill in this repository. `deepseek-harness-bridge` handles everyday dispatch to Desktop master-control sessions and to SuperAgent tickets; `dsh-control-bridge` wraps the `dsh-bridge` CLI. Install by copying each directory into `~/.zcode/skills/` and filling in the example configuration files. SuperAgent dispatch and a Desktop master-control session round trip (create the session, send a prompt, read the official completion) were verified on a Windows machine on 2026-11-24 and 25; the sections above list what was and was not verified.
