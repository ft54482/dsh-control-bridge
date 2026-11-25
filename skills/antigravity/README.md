# Antigravity 技能

给 Antigravity 用的两个技能，基于本仓库 `main` 分支的最新上游客户端（包含 Desktop Host 会话/工作区自主、SuperAgent 待办收件箱 `inbox`/`detail`、原线程答复 `reply`、本地裁决 `verdict`），并配套了四个标准库助手脚本与完整行为测试套件。

> [!IMPORTANT]
> **装之前先读[权限与授权](../../docs/permissions.md)。** 这套技能替 Agent 操作你的 DeepSeek Harness 和 GitHub 账号，能做什么取决于你亲自放行了什么。配对、修改 `cordis.patch.yml`（如 `presetSessionWorkspaceIds`、`workspaceRoots`、`allowCreateSession`、`workspaceAutonomy`）或修改 SuperAgent 允许名单，都要你本人针对该项明确同意。代为安装的 Agent 遇到 `403`、`409` 或 `precheck` 不过时应当停下报告，不能自作主张放宽配置。

## 两个技能

| 目录 | 管什么 | 什么时候用 |
| --- | --- | --- |
| [`deepseek-harness-bridge/`](deepseek-harness-bridge/SKILL.md) | 日常派工与管理：续接或新建 Desktop 主控会话、工作区自主（开启时）、SuperAgent 收件箱分流、GitHub 派工、原线程答复与本地裁决 | 把任务交给本机 DeepSeek Harness，或查询/审核其执行状态 |
| [`dsh-control-bridge/`](dsh-control-bridge/SKILL.md) | `dsh-bridge` 控制面命令行：隔离自检、多实例配置校验、任务台账起草、mandate 批准、签名事件入口与审计 | 需要使用协调桥自己的任务台账、审批与事件网关时 |

## 与 Codex / ZCode 技能的关系

- **同步跟踪主干最新能力。** `deepseek-harness-bridge/` 里的 `scripts/desktop.py`、`scripts/superagent.py`、`scripts/github_source.py`、`references/desktop.md`、`references/superagent.md` 及 `references/superagent-todo-inbox.md` 与本仓库 `main` 分支保持逐字节同步，由 `tests/test_antigravity_skills.py` 守护。
- **修复隔离模式导入与适配 Antigravity。** 助手脚本 `superagent_brief.py` 与 `superagent_wait.py` 在 `load_upstream()` 中自动将同级 `scripts/` 加入 `sys.path`，即使在 `python -I` 下也能正常导入已拆分的 `superagent` 模块；`send_brief.py` 使用 `agy-` 前缀生成 `request_id`。
- **助手脚本一览**（均只用 Python 3.11+ 标准库）：
  - `scripts/send_brief.py`：从 UTF-8 Markdown 文件安全发送多行任务书到 Desktop 会话（自动处理 CRLF/BOM，无转义问题）
  - `scripts/sessions_table.py`：把 `granted` / `discover` 的长 JSON 压成紧凑会话表与工作区对照
  - `scripts/superagent_brief.py`：按 `--repo` 从 `connection.json` 查出对应 SuperAgent 端口后起草工单计划
  - `scripts/superagent_wait.py`：轮询等待晚于本次 `sent_at` 的 Ticket 结束，遇工人回帖抄写 marker 时自动回退按 Issue 号查询

## 安装

前提：Python 3.11 或更新；Harness Desktop 已安装 Host 插件并完成配对（见 [Windows 安装、配对与连接检查](../../docs/windows-delivery.md#codex-desktop-setup)）。如需派发 SuperAgent 工单，还需已部署的 SuperAgent 实例与已登录的 `gh` CLI。

1. **装日常派工技能。** 将 `skills/antigravity/deepseek-harness-bridge/` 拷贝到 Antigravity 全局技能目录 `~/.gemini/config/skills/`（或当前项目的 `.agent/skills/`）。将其中 `connection.example.json` 复制为 `connection.json`，按本机填写 `secret_file` 路径、端口和 `superagent_instances`（切勿提交进版本库）。
2. **装控制面技能（可选）。** 将本仓库克隆到所有 skills 目录**之外**（例如 `~/.dsh-control-bridge/repo`，因仓库根目录自带 `SKILL.md`），再把 `skills/antigravity/dsh-control-bridge/` 拷贝到 `~/.gemini/config/skills/`，将 `local.example.json` 复制为 `local.json` 并填上仓库路径。
3. **新开一个 Antigravity 会话。** 会话启动时会自动扫描 `~/.gemini/config/skills/`（全局）和 `.agent/skills/`（工作区）下的技能。

## 验证

```powershell
python ~/.gemini/config/skills/deepseek-harness-bridge/scripts/desktop.py health
python -I -X utf8 ~/.gemini/config/skills/deepseek-harness-bridge/tests/stub_host_test.py
python -I -X utf8 ~/.gemini/config/skills/deepseek-harness-bridge/tests/superagent_brief_test.py
python -I -X utf8 ~/.gemini/config/skills/deepseek-harness-bridge/tests/superagent_wait_test.py
python -I -X utf8 ~/.gemini/config/skills/deepseek-harness-bridge/tests/mutation_check.py ~/.gemini/config/skills/deepseek-harness-bridge
python ~/.gemini/config/skills/dsh-control-bridge/dsh-bridge.py --version
python ~/.gemini/config/skills/dsh-control-bridge/dsh-bridge.py self-check
```

## English

Two skills for Antigravity, synced with the latest `main` branch clients (`desktop.py` including `workspaceAutonomy`/`revoke-workspace`, `superagent.py` with `inbox`/`detail`, and `github_source.py` with `reply`/`verdict`), plus the four stdlib helper scripts and offline test suites. Install by copying each folder into `~/.gemini/config/skills/` (or workspace `.agent/skills/`) and filling in `connection.json` / `local.json` from their `.example.json` templates without committing private paths or secrets. Before installing, read [Permissions and authorization](../../docs/permissions.md) (in Chinese).
