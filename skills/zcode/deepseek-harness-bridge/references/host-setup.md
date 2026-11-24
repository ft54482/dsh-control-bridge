# Host 安装、配对与升级

这份文件管的是本机 Harness 的**安装和授权状态**，不是日常派工。`health` 不通、要给新会话授权、或用户明确要求安装 / 升级 Host 时才读。

## 先讲清楚再动手

这里的操作会改动 Desktop 的 profile 或授权文件，或者需要退出、重开 Desktop。所以：

- 只在用户明确要求时做，不把它当成“派个任务”的顺手副作用。
- 动手前把要跑的命令、为什么、预期结果讲给用户。Desktop 里还有任务在跑时，先等它结束。
- Desktop 没有受支持的外部退出命令，只能从托盘选 **Quit DeepSeek Harness**。关窗口只是缩到托盘，不要结束进程。
- 升级前先保存授权指纹，升级后比对：
  `python scripts/desktop.py membership > <仓库以外的私有位置>/membership-before.json`
- 下面用到的路径都从 `<skill>/connection.json` 取：`bridge_root` 是当初安装 Host 用的那棵树，配对脚本在它里面；`desktop_cli` 是 Desktop 自带的 `dsh.cmd`，用它就不会和 PATH 上别的版本混用。

## A. `health` 不通

1. DeepSeek Harness Desktop 在运行吗？看托盘。
2. `connection.json` 的 `secret_file` 指向的文件还在吗？只判断是否存在，不读内容。不在了：找到当前这份 Host 的 `host.secret`（安装时生成的 `desktop-host-local` 目录里），把**路径**写回 `secret_file`。
3. 端口有人在听吗？`netstat -ano | grep LISTENING | grep "127.0.0.1:8765"`。授权名单是空的、而且 20 分钟配对窗口没开的时候，Host 根本不监听。

## B. 给一个新会话授权（配对）

往某个工作区派工，需要那个工作区里**至少一个会话**有授权；要发送任务，授权得是 `write`。

1. 在 Harness Desktop 里，于目标工作区打开一个空闲的空白会话。
2. 打开配对窗口。窗口只能用一次，不需要重启 Desktop。**注意脚本在哪**：`Rearm-DesktopHostBootstrap.ps1` 只在较新的源码树里有，当初装 Host 的 `<bridge_root>` 里没有；它默认把脚本所在的那棵树当根目录，所以从别处运行时要带 `-Root`：

   ```bash
   powershell -NoProfile -ExecutionPolicy Bypass -File "<控制面技能的检出>/scripts/windows/Rearm-DesktopHostBootstrap.ps1" -Root "<bridge_root>" -Minutes 10
   ```

   它只写窗口文件 `bootstrap.secret` 和 `bootstrap.json`，前后核对 `host.secret` 和 `allowlist.json` 没变。开窗口前看一眼 `health` 的 `bootstrap_armed`：已经是 `true`，说明有人正在配对，别覆盖他的窗口。

3. 看候选，再选一个写入。候选清单是整个 Desktop 的顶层会话，编号会随会话增减而变，所以**选定前核对那个编号对应的是哪个会话**，不要只凭标题：

   ```bash
   PYTHONPATH="<控制面技能的检出>/src" python -m dsh_control_bridge.pair_desktop --bootstrap-secret-file "<bridge_root>/desktop-host-local/bootstrap.secret"
   PYTHONPATH="<控制面技能的检出>/src" python -m dsh_control_bridge.pair_desktop --bootstrap-secret-file "<bridge_root>/desktop-host-local/bootstrap.secret" --index N --access write
   ```

   写入那一步作废窗口。还要再配一个，就回到第 2 步。会话正忙时写入授权会被拒绝。`<bridge_root>` 读 `connection.json` 的 `bridge_root`；检出的位置读另一个技能 `dsh-control-bridge` 的 `local.json`。

4. 验证：`python scripts/desktop.py granted | python scripts/sessions_table.py --cwd <目录>`。

已经授权只读的会话要改成可写，不用重新配对：

```bash
printf '%s' '{"session_id":"SESSION_ID","access":"write"}' | python scripts/desktop.py set-access --data -
```

配对只改 `allowlist.json`：不轮换长期的 `host.secret`，不启动任务，不改模型。

**配对成功不等于能发提示词。** 一个从没用过的空白会话没有模型选择，也没有在线的 Agent。往它发提示词会得到 `409 model_unknown`，什么都没有发出（2026-11-25 实测）。桥不替这样的冷会话选模型：`models` 返回的 `can_set` 是 `false`，原因是 `agent_not_attached`。要让它能用，请用户在 Desktop 里打开这个会话、在界面上选好模型；要派开发任务，再把预设选成「主控模式」。之后用 `models` 回读确认。

**2026-11-25 的一次做法（实测通过）。** 给一个工作区配对时没有用编号，而是在同一段程序里先读一遍候选清单，确认那个编号仍是选定的会话而且不忙，再按会话编号调 Host 的 `POST /v1/bootstrap/select`，正文是 `{"session_id": "…", "access": "write"}`。选的是工作区里一个没有标题的空白会话，它只当锚点，不往里派任务。核对：`granted` 里这个会话是 `write`、`idle`，读它的 `history` 返回 200；`health` 的 `bootstrap_armed` 回到 `false`、`bootstrap_consumed` 是 `true`；`membership` 前后一致（工作区数和会话数都没有变）。

两处容易误判：`membership` 是 Desktop 的工作区成员，不是授权清单，要看授权用 `granted`；实测的那台机器上还有别的会话在同时配对，`grants_count` 会自己变，不能拿它的差值判断自己写了几条。

**撤销一条授权。** Host 只有 `POST /v1/revoke` 这一条移除路径，正文 `{"session_id": "…"}`，口令用 `host.secret`；`desktop.py` 没有对应的子命令。这一条是读 Host 源码和文档确认的，没有实际撤销过。

## C. 新建主控会话的前提

- Host 0.2.2 或更新：`health` 的 `preset_create_verified` 为 `true`。
- Harness 的同一个 profile 里装好可信的 `master-control` 预设包（Desktop 侧栏「插件 → 添加插件」）。装好以后，一个空白会话的预设选择器里会出现「主控模式」。预设决定执行方的人设和工具权限，所以必须是用户自己信任的包。
- Host 的配置（Desktop profile 的 `cordis.patch.yml` 里 `dsh-control-bridge-host` 那一行）打开 `allowCreateSession`。工作区在 `workspaceRoots` 之外时，把它的**确切 ID** 加进 `presetSessionWorkspaceIds`；不要为此放宽文件操作的根目录。
- `presetSessionWorkspaceIds` 和 `workspaceRoots` 是 Host **启动时**读进内存的（2026-11-25 看 Host 源码确认）。改完配置要退出并重开 Desktop 才生效，会打断 Desktop 里正在跑的任务，所以这件事由用户挑时间做。被拒绝时 Host 返回 `403 outside_allowed_roots`，没有创建任何会话。
- 等不了重启的话有个手动办法，来自上游 `desktop.md`，没有实测：在 Desktop 里于目标工作区开一个空白会话，在它的预设选择器里选「主控模式」，再按 B 节配对这个会话。这样一个工作区一次只有一个可用的主控会话，再要新的就得重来一遍。

## D. 安装、升级、回滚 Host 插件

三个动作都要先从托盘退出 Desktop。包和校验值用 [Releases](https://github.com/ft54482/dsh-control-bridge/releases) 里 `MANIFEST.json` 列出的。

```bash
cd "<该版本的源码目录，或便携包的解压目录>"
powershell -NoProfile -ExecutionPolicy Bypass -Command '$env:PATH = "C:\Windows\System32;" + $env:PATH; & ".\scripts\windows\Manage-DesktopHost.ps1" -DshExe "<desktop_cli>" -Action <Install 或 Upgrade> -Package "<dsh-control-bridge-host-0.2.2.tgz>" -Sha256 "<MANIFEST.json 里的 sha256>" -BackupDir "<这次专用的私有空目录>"'
```

- 回滚：同样先退出 Desktop，再带上 `-Action Rollback -BackupDir <同一个备份目录>`。
- 脚本会核对包的 SHA-256，升级前归档可回滚的旧版本。授权、密钥和工作区状态留在原位。备份目录要留着，profile 会引用里面的 tgz。
- 重开 Desktop 后先看 `health`，再逐项比对 `membership` 指纹。少了工作区或会话，或者子会话被抬成了根会话，就算失败：停下，报告。
- 不要拿旧的 profile 备份去覆盖用户后来做的修改。

**从 Git Bash 调用时，必须带上那半句 `$env:PATH = …`。** 2026-11-24 在本机实测过原因：Git 自带的 GNU tar 在 PATH 里排在前面，脚本里的 `tar.exe` 会解析到它，GNU tar 把 `C:\…` 当成远程主机，报 `Cannot connect to C: resolve failed`，升级流程当场失败。把 System32 提到**这一次** PowerShell 调用的 PATH 最前面，就会用上 Windows 自带的 bsdtar。不要在整个 Git Bash 会话里调 PATH 的顺序：那会把 `timeout`、`sort`、`find` 这些 Unix 工具换成 Windows 的同名程序（`timeout` 会直接报语法错误）。

## E. 上游文档

都在仓库 `ft54482/dsh-control-bridge` 里：

- 安装与使用：`docs/windows-delivery.md`
- Host 的 HTTP 接口与配置项：`docs/host-api.md`
- 哪些已经在真机上验证过、哪些还没有：`docs/verified-scope.md`
- 插件说明：`plugins/dsh-control-bridge-host/README.md`
