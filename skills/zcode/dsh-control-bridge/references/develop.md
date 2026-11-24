# 在这个仓库上开发

用户要改 `ft54482/dsh-control-bridge` 本身、跑它的测试、或者给它出发行包时读这份。平时只是使用桥，不需要读。

## 仓库布局

| 目录 | 内容 |
| --- | --- |
| `src/dsh_control_bridge/` | 控制面本体：`cli.py`、`bridge.py`、`config.py`、`mcp_server.py`、各适配器。只用 Python 标准库 |
| `plugins/dsh-control-bridge-host/` | 装进 Harness Desktop profile 的 Host 插件，Node 包 |
| `plugins/dsh-superagent-cockpit/` | Super Agent 驾驶舱，Harness Desktop 插件（0.1.3 起）；多实例聚合器 `fleet.mjs` 和主控登记工具 `masterctl.mjs` 也在里面 |
| `skills/deepseek-harness-bridge/` | 上游给 Codex 用的技能。ZCode 全局版在 `~/.zcode/skills/deepseek-harness-bridge` |
| `scripts/windows/` | Host 安装、配对、重新布防的 PowerShell 脚本，以及便携包自检 |
| `scripts/build_release.py` | 生成发行包、清单和 `.sha256` |
| `examples/` | 配置、mandate、凭据的样例，全是占位符 |
| `docs/` | 架构、Host API、Windows 交付、真机验收范围 |
| `tests/` | Python 测试；插件自己的测试在 `plugins/…/test/` |

## 跑测试

```bash
python -m pytest -q
```

`pyproject.toml` 里已经配好了 `pythonpath = ["src"]`，所以不用 `pip install -e` 就能从检出直接跑。上游的开发依赖钉的是 `pytest==9.2.0`。

2026-11-24 在本机的结果，Python 3.14.0、pytest 9.0.2：101 通过，4 跳过，1 失败。失败的那一项是 `tests/test_host_install_scripts.py::test_manage_windows_guard_and_verified_rollback`，原因见下一节，是环境造成的。

上游列出的支持版本是 Python 3.11 到 3.13。3.14 上除了那一项，其余全部通过。

## 坑一：从 Git Bash 跑安装脚本，`tar` 是错的那个

**现象。** `Manage-DesktopHost.ps1` 在守卫通过之后报错退出，stderr 里有：

```text
/usr/bin/tar: Cannot connect to C: resolve failed
```

**原因。** Git for Windows 把自己的 `usr\bin` 放在 PATH 里、排在 System32 前面。脚本第 101 行和第 135 行调用的是不带路径的 `tar.exe`，于是解析到 Git 自带的 GNU tar。GNU tar 把 `C:\…` 里的 `C:` 当成远程主机名。从 ZCode 的 Bash 工具里调用 `powershell` 也一样，因为子进程继承 Git Bash 的 PATH。

**处理。** 只在那一次 PowerShell 调用里把 System32 提到最前面，用的是 Windows 自带的 bsdtar：

```bash
powershell -NoProfile -ExecutionPolicy Bypass -Command '$env:PATH = "C:\Windows\System32;" + $env:PATH; & ".\scripts\windows\Manage-DesktopHost.ps1" …'
```

验证过：这样改以后，`test_host_install_scripts.py` 的两项都通过。

**不要在整个 Git Bash 会话里调 PATH 的顺序。** 实测 `PATH="/c/Windows/System32:$PATH"` 之后，`timeout` 变成了 Windows 的 `timeout.exe`，直接报“无效语法”。`sort`、`find` 也会被换成 Windows 的同名程序。

## 坑二：`dsh-bridge mcp` 不能直接挂进标准 MCP 客户端

上游的 `mcp_server.py` 用 `Content-Length` 分帧读请求、写响应，这是 LSP 的做法。标准 MCP stdio 用的是按行的 JSON，ZCode 也属于这一类。

2026-11-24 实测，向 `dsh-bridge mcp` 的 stdin 写入 `initialize`：

| 发送方式 | 结果 |
| --- | --- |
| `Content-Length: N` 头加正文 | 正常应答，`protocolVersion` 是 `2024-11-05` |
| 一行 JSON 然后关闭 stdin | 退出码 0，stdout 是空的，没有应答 |
| 一行 JSON 加一个空行 | 退出码 1，`ValueError: invalid content-length` |

所以标准客户端连上去，看到的要么是超时，要么是服务崩溃。在上游改成按行分帧之前，用 CLI，它和 MCP 是同一组动作。CLI 的子命令比 MCP 工具多：MCP 只暴露 `inbox`、`acknowledge`、`dispatch`、`status`、`cancel`、`diagnose` 六个工具。

## 坑三：`superagent.py` 在 `python -I` 下起不来

上游技能的 `scripts/superagent.py` 有一行 `from desktop import emit`，要导入同目录的 `desktop.py`。`-I` 是隔离模式，它不会把脚本所在的目录加进模块搜索路径，于是报 `No module named 'desktop'`。上游的测试和文档都是用普通的 `python` 调用的。`desktop.py` 没有本地导入，两种方式都能跑。0.2.3 新增的 `github_source.py` 也没有本地导入，同样两种方式都能跑。

## 坑四：两个客户端的默认端口不一样

`superagent.py` 默认连 `127.0.0.1:3082`；`github_source.py` 的 `precheck`、`prepare`、`trace`、`compare` 默认连 `3084`。一台机器上跑着两个 profile 时（比如两个实例分别监听 3082 和 3084），漏写 `--port` 就连到另一个项目的实例去了。派工这一侧有 `precheck` 的 `repository_matches` 兜底，会失败，不会发错；只读的 `state`、`tickets` 没有这层保护，会安静地给出另一个项目的状态。

ZCode 适配的做法是把端口按仓库登记在 `connection.json` 的 `superagent_instances` 里，起草走 `superagent_brief.py`，它按仓库查端口，没有默认值。2026-11-24 在一台双实例的机器上，拿其中一个仓库对两个端口各跑一次 `precheck`：管它的那个端口九项全过；另一个端口只在 `repository_matches` 上失败，因为那边配的是另一个仓库。

## 坑五：`trace` 把接单回帖当成了最终回帖

`github_source.is_acknowledgement` 只认以「收到」「received」「acknowledged」「ack:」开头的评论，或者正文含 "this is by an automated agent" 的评论。实测的那台实例上，接单回帖是「已接单：……」，末尾带一个 `<!-- dsh-superagent:<id> -->` 注释，两条都不符合。结果是工人还没干活，`final_comment.present` 就是 `true`，`ack_only` 和 `acknowledgement_present` 都是 `false`。2026-11-24 在一个测试 Issue 上实测：15:40:34Z 接单回帖出现，15:40:40Z 的 `trace` 已经是 `present=true`。

判完成不看这一项，看 `ticket.state`、`ticket.ended.outcome` 和 `worker_result.report_state`。

## 坑六：回帖里一出现标记，`trace` 就对不上号

`event_of_plan` 用「哪条评论的正文里有标记」找派工事件，要求恰好一条。工人如果在回帖里抄了标记，就有两条，`trace` 返回退出码 4，`stage` 是 `read_failed`，`detail` 是 `comment_marker_not_unique`。2026-11-24 实测撞上过一次：冒烟任务书让工人「原样抄上标记」。上游自己验证的是新开 Issue 的路径，标记在 Issue 正文里，撞不上这个情况。

这时候用 `compare --issues <编号>`，它不看标记，按 Issue 编号找工单。按评论派工时，任务书里不要让工人抄标记。

## 2026-11-24 的一次完整派工实测

一个实例，一个只要求回帖、不改文件的测试 Issue：

| 时刻（UTC） | 事件 |
| --- | --- |
| 15:38:54 | 派工评论发出 |
| 15:40:30 | 引擎裁定 `accept`，`strength` 是 `explicit`，`via` 是 `addressed` |
| 15:40:34 | 接单回帖 |
| 15:41 | 占用一个执行槽，Assignment 变成 `running` |
| 15:42:51 | 工人回帖 |
| 15:43:20 | Ticket 结束，`outcome` 是 `completed`，`by` 是 `executor`；Assignment 的 `report.state` 是 `ready` |
| 15:46:24 | 在同一个 Issue 下留了一条「验证通过」的总结评论，不带标记，随后把 Issue 关闭 |
| 15:47:15 | 同一张 Ticket 追加了第二个 Assignment，`ref` 和第一个相同 |
| 15:47:28 | 第二个 Assignment 以 `dropped` 结束，工人的判断是「不需要动作」。**Ticket 的 `ended` 被改写成 `outcome: dropped`**，`summary` 也被改写 |
| 16:10:12 | 在同一个（已关闭的）Issue 下用新计划发了一条追加评论 |
| 16:11:32 | 第三个 Assignment 以 `completed` 结束，回帖 `FOLLOW-UP-OK`；Ticket 的 `ended` 又变回 `completed` |

工人的执行目录是 `~/.dsh/state/superagent/work/<短名>-<票号前 12 位>`，分支 `agent/<同名>`，起点是当时的 `origin/main`，不碰项目的主工作副本。仓库没有新增提交、分支或 PR。

没有实测的：新开 Issue 的路径（`--kind issue`）。它走 `gh issue create`，而那台机器的 `gh` 令牌没有 project 读权限。

## 坑七：工单结束后的后续评论，会追加任务并改写工单结果

上面那张表里 15:46 到 15:47 的事：Ticket 已经以 `completed` 结束，发件账号又在同一个 Issue 下发了一条评论。引擎把它当成这条线程的跟进消息，在同一张 Ticket 上追加了第二个 Assignment，派给同一个工人会话。工人判断没有事可做，于是第二个 Assignment 以 `dropped` 结束，Ticket 的 `ended.outcome` 从 `completed` 变成了 `dropped`。

两点后果：

- 验收后想去 Issue 下写一句「通过」，就会多花一次工人调用，还会把工单结果改掉。
- 工单结果要在它结束的那一刻读并记下来。之后读到的，可能是后续某一轮的结果。

同一条机制用对了就是返修：在同一个 Issue 下发一条带新标记的评论，Ticket 上追加一个 Assignment，还是原来那个工人会话。16:10 那次就是这样走的，Issue 关着也不影响。

ZCode 的 `superagent_wait.py` 据此只认晚于计划 `sent_at` 的结束：追加任务刚发出时，Ticket 还挂着上一轮的 `ended`，不能当成这一轮做完了。

## 坑八：两个配对脚本对「根目录在哪」的假设不一样

`Rearm-DesktopHostBootstrap.ps1` 有 `-Root` 参数，默认把脚本所在的那棵树当根目录，去它下面的 `desktop-host-local` 写窗口文件。`Pair-DesktopHost.ps1` 没有 `-Root`，也只能用脚本所在那棵树下的 `desktop-host-local\bootstrap.secret` 和 `src`。实测的那台机器上，`desktop-host-local` 在当初装 Host 的那棵旧树里，那棵树没有 `Rearm`；新检出里有 `Rearm`，却没有状态目录。于是两个包装脚本没法从同一个地方跑。

2026-11-25 的做法：`Rearm` 从新检出里跑、带 `-Root` 指向旧树；配对那一步绕过包装脚本，直接 `python -m dsh_control_bridge.pair_desktop --bootstrap-secret-file <状态目录>\bootstrap.secret`。两个包装脚本本身这次没有运行过。

另外两条实测认识：候选清单的编号是整个 Desktop 的顶层会话，会随会话增减而变，按编号选之前要核对编号对应的会话；`GET /v1/guard/membership` 是 Desktop 的工作区成员，不是授权清单。

## 发行包

[Releases](https://github.com/ft54482/dsh-control-bridge/releases) 里每个版本有下面几样。v0.2.2 那个发布里另有一份 `MANIFEST.json`，列出每个文件的字节数和 SHA-256；0.2.3 的技能包和 0.1.3 的驾驶舱各只带一个 `.sha256`：

| 文件 | 用途 |
| --- | --- |
| `deepseek-harness-bridge-<版本>-skill.zip` | 给 Codex 用的独立技能包。0.2.3 是 6 个文件（`SKILL.md`、两份参考、三个脚本），不含任何本机路径。包内换行符是 CRLF |
| `dsh-control-bridge-<版本>-portable.zip` | 便携源码包，解压即用 |
| `dsh-control-bridge-host-<版本>.tgz` | Desktop Host 插件 |
| `dsh-superagent-cockpit-<版本>.tgz` | Super Agent 驾驶舱插件（0.1.3 起） |

安装任何一样之前，先拿 `.sha256` 文件核对。

## 上游自己的证据纪律

写文档、下结论时照这个标准来，别把级别说高了：

- 夹具回归通过，只说明协议行为和失败关闭是对的，**不等于真机验收**。
- 哪些已经在真机上看到、哪些还没有，以 `docs/verified-scope.md` 为准。比如超过默认等待窗口的长任务、冷会话改模型、对运行中回合的取消、跨工作区多实例闭环，都还没在真机上验证。
- `health` 只描述服务和授权，不认证运行时版本，也不是验收。

## 改 Host 相关的东西

Host 的安装、配对、升级、回滚步骤在另一个技能里：`~/.zcode/skills/deepseek-harness-bridge/references/host-setup.md`。那些操作会改动本机 Desktop 的 profile 和授权文件，只在用户明确要求时做。
