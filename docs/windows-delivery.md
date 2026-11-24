# Windows 安装与使用

使用 Codex 操作会话，从下面的安装与配对开始。维护已有 Host 可直接跳到[升级与回滚](#host-install)。运行 Python 协调桥的假进程检查请从[便携包自检](#便携包与假进程自检)开始。[文档目录](README.md)

<a id="codex-desktop-setup"></a>

## 连接 Codex 桌面端与 Harness Desktop

本节使用默认 Host 端口 8765。自定义端口请配合[端口配置与排错](ports.md#desktop-host)阅读，尤其是首次配对和每次 skill 调用的参数。

在运行 DeepSeek Harness Desktop 的同一台机器上，以本地执行环境打开 Codex。需要 Python 3.11+ 和一个已初始化的 Harness Desktop profile。技能脚本仅依赖 Python 标准库。

### 在 Desktop 安装驾驶舱

需要图形面板时，将独立的驾驶舱 TGZ 安装到正在使用的 Desktop profile。在左侧打开「Super Agent 驾驶舱」可查看主控任务、活会话和实例执行器。[驾驶舱下载、安装与核对](../plugins/dsh-superagent-cockpit/README.md)

### 安装或升级 Codex skill

个人安装可用于多个项目，目标为 `~/.agents/skills/deepseek-harness-bridge`。只在一个仓库使用时，可将目标改为该仓库内的 `.agents/skills/deepseek-harness-bridge`。已有自定义技能目录的用户可在 Codex 的技能列表核对实际加载位置，更新同一份安装。[OpenAI 技能目录说明](https://developers.openai.com/codex/skills/)

下载 [v0.2.3 独立技能包](https://github.com/ft54482/dsh-control-bridge/releases/download/skill-v0.2.3/deepseek-harness-bridge-0.2.3-skill.zip)，在下载目录运行。压缩包已有顶层技能文件夹，直接解压到 `skills` 目录即可。

```powershell
$skillRoot = Join-Path $HOME '.agents/skills'
Expand-Archive -LiteralPath './deepseek-harness-bridge-0.2.3-skill.zip' -DestinationPath $skillRoot -Force
$skill = Join-Path $skillRoot 'deepseek-harness-bridge'
$client = Join-Path $skill 'scripts/desktop.py'
python $client --help
```

若从源码安装，在本仓库的公开 Git 检出目录运行以下命令。

```powershell
$source = 'skills/deepseek-harness-bridge'
$skill = Join-Path $HOME '.agents/skills/deepseek-harness-bridge'
git ls-files -- $source | ForEach-Object {
    $target = Join-Path $skill $_.Substring($source.Length + 1)
    New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
    Copy-Item -LiteralPath $_ -Destination $target -Force
}
$client = Join-Path $skill 'scripts/desktop.py'
python $client --help
```

升级时先在公开检出中执行 `git pull --ff-only`，再重跑复制命令。它只复制 Git 追踪的技能文件。Codex 通常会发现更新；若列表仍显示旧版本，重启 Codex。首次安装也可用 Codex 内置的 `$skill-installer`，指定本仓库和 `skills/deepseek-harness-bridge` 子目录。

### 安装 Host 并完成首次配对

1. 已经配对的用户可直接做下方连接检查。首次安装或升级需要与所需能力匹配的 Host 包和同一版本的 SHA-256 校验值。若从公开源码构建，先准备 Node.js、pnpm 和 Python，在仓库根目录运行以下命令。它们在 `dist` 下生成并逐文件核验安装包、清单与 `.sha256` 文件。

   ```powershell
   New-Item -ItemType Directory -Force -Path dist | Out-Null
   Push-Location plugins/dsh-control-bridge-host
   try { pnpm pack --pack-destination ../../dist } finally { Pop-Location }
   python scripts/build_release.py --dist dist
   ```

2. 将便携源码 ZIP 解压到一个私有目录，进入其中包含 `scripts/windows` 的文件夹，后续安装和配对脚本在此运行。把同版本 Host TGZ 和校验清单保留在便于引用的位置。等待运行中的任务结束，从 Harness 托盘选择 **Quit DeepSeek Harness**。按下方[安装、升级和回滚](#host-install)命令安装刚核验的包，首次选择 `Install`，已有 Host 则选择 `Upgrade`。
3. 首次安装时运行 `.\scripts\windows\Prepare-DesktopHost.ps1 -Package <包路径>`。备份 Desktop profile 的 `cordis.patch.yml`，把生成的 `desktop-host-local/cordis-snippet.yml` 应用到其中的 Host 配置项。保管该目录下的配对与凭据文件。若要允许新建会话，启用 `allowCreateSession: true`。使用已配对的工作区 ID。若该工作区位于 `workspaceRoots` 外，将其确切 ID 加入 `presetSessionWorkspaceIds`。创建可派工的会话还需要该工作区已有可写会话授权（开启 `workspaceAutonomy` 时例外，见[工作区自主](#workspace-autonomy)）。[Host 配置示例](host-api.md)
4. 重新打开 Harness Desktop，在已登记的工作区准备一条可供配对的空闲会话。运行 `.\scripts\windows\Pair-DesktopHost.ps1` 查看编号，再加 `-Index <编号>` 授予读取权限。要续接并发送任务，配对时用 `-Index <编号> -Access write` 选择空闲会话。配对窗口过期时运行 `.\scripts\windows\Rearm-DesktopHostBootstrap.ps1` 重新开启。

### 检查 Codex 连接

让技能读取该 Host 的长期凭据文件。下面的命令只在个人技能目录写入文件路径，适用于上文首次配对时生成的位置。已有配对请改用自己现有的 `host.secret` 路径。也可给运行 Codex 的进程设置 `DSH_BRIDGE_SECRET_FILE` 指向同一文件。按步骤运行前应确认选用的是个人技能目录，项目级安装请使用环境变量。

```powershell
$secretFile = (Resolve-Path -LiteralPath './desktop-host-local/host.secret').Path
@{ secret_file = $secretFile } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $skill 'connection.json')
python $client health
python $client granted
```

`health` 返回 `ok: true`，且 `granted` 能找到目标会话后，在 Codex 打开 `$deepseek-harness-bridge` 即可查找旧任务。续接原会话支持 Host 0.1.6 起的授权操作。Host 0.2.0 增加全局元数据发现，历史正文仅对已授权的会话开放。

独立任务默认在同一工作区新建主控会话。使用 Host 0.2.2 完成从创建到首次派工的流程。先确认 `health.preset_create_verified` 为 true，并在同一 profile 安装可信的 Harness Agent 预设 `master-control`。在同一 Harness profile 的侧栏打开「插件 → 添加插件」，安装并启用可信的本地预设包。也可在有插件管理工具时使用 `install_bundle` 和 `list_plugins`。预设对该 profile 的工作区共享。首次安装预设后可在 Desktop 的预设选择器中查看“主控模式”。日常使用由 skill 创建会话并回读预设。桥只在成功读回会话实际选中的预设后才发送任务。缺少 bundle 时，可继续使用既有授权会话。SuperAgent 的派工另以 Source、Ticket 和 Assignment 作为凭据。[主控会话回读](../skills/deepseek-harness-bridge/references/desktop.md#new-work-in-master-control-mode) · [SuperAgent 用法](../skills/deepseek-harness-bridge/references/superagent.md)

## 便携包与假进程自检

本节适用于 Python 协调桥的 headless 路径。仅使用 Codex skill 与 Desktop Host 的用户可跳过本节。

1. **放置桥。** 把 zip 解压到一个新建的空目录。不运行 pip，不创建虚拟环境，不把文件写进 `%LOCALAPPDATA%`。包只用 Python 标准库。默认 `spawn = false`。包内没有密钥，也不复制桌面凭证。
2. **假进程自检。** 在解压目录执行下面的命令，`-PythonExe` 指向捆绑的 Python 3.12，或任何 3.11 及以上的 `python.exe`。这只改当前进程的 `PYTHONPATH`，不改用户或系统 PATH。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\Test-FakeDsh.ps1 -PythonExe D:\Python312\python.exe
```

`Install-DshBridge.ps1` 要求同时给出 `-Destination` 和 `-PythonExe`。`-Destination` 必须就是这次解压目录，否则脚本直接退出，不复制文件。

3. **凭证配置。** 还没做。以后由操作者把 `DEEPSEEK_API_KEY` 放进环境。值不进入仓库，也不从桌面登录状态复制。
4. **真实计费 smoke。** 还没做。当前包不会发模型请求，也不会启动真实 `dsh.cmd`。

普通短任务仍使用桥自己的 headless profile 和一个新建空目录。不复用 desktop，不接管已有业务会话。

## 自检必须怎样读

业务成功只有一条：退出码 0，并且 `final.reason.kind` 是 `completed`。报告里的 `check_ok=true` 只表示这项检查符合预期。

| 检查 | fake 模式 | 预期 |
| --- | --- | --- |
| success | success | `business_accepted=true` |
| nofinal | nofinal | 拒绝，`missing final event`，不是业务成功 |
| badexit | badexit | 拒绝，退出码不是 0，不是业务成功 |
| timeout | hang | 拒绝，`no accepted final`，测试进程和它的子进程已退出 |
| cancel | tree | 主动取消已确认，父子进程已退出，不是业务成功 |
| malicious | 不启动 | 恶意 session 和路径在启动前拒绝，哨兵文件不出现 |

超时和取消只把 `taskkill /F /T` 用在本次测试创建的 pid 上。pid 小于等于 4 不会发信号。退出确认比较的是该 pid 的创建时间：创建时间还在，才是同一个进程；创建时间变了或进程已经不在，就不再对这个号码发信号。

`8594a02` 那一包在用户机上只跑了前三项，`Test-FakeDsh.ps1` 退出码 0。那里的 ok 没有把 nofinal 和 badexit 写成拒绝。hang 和 tree 没有跑，所以那一次不能算 Windows 安全启动已经验收。

## 既有 home

`c31c6ff` 的六项无计费自检已由操作者在 Windows 上用捆绑 Python 3.12.14 跑过，success 是接受，nofinal、badexit、timeout、cancel、malicious 是拒绝。那次没有真实模型往返。

这一包加上默认关闭的共享 home。预检不改 desktop，不安装插件，不复制 `.credentials.yaml`：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\Prepare-HeadlessReuse.ps1 -PythonExe D:\Python312\python.exe -DshHome C:\path\to\existing-home
```

不加 `-Apply` 时只打印计划。`-Apply` 只备份并修改 `profiles\headless\cordis.patch.yml`。`-Rollback -Apply` 才按备份恢复。桥运行时的默认方式是数据目录里的 `--patch`，可以不改 home。

本机若要做一次最小真实调用，配置里的非敏感字段是：`home_mode=shared`、`dsh_home`、`credential_mode=official_store`、演示工作区的 `cwd`、`allow_new_session`、`occupancy=operator_confirmed_idle`、显式 `session_grants`、`timeout_seconds=120`。`spawn` 保持 false，直到那一次调用被单独打开。不要把正在忙的 desktop 业务目录写进授权。超时后不自动重试。

## Desktop 插件

官方 Desktop 是 Electron 里的 Web Host。外部客户端拿不到每次启动的 desktop 凭据。受支持的做法是在 **desktop profile** 里安装 bundle，由插件在 Host 进程内调用已经挂载的 `workspaceRegistry`、`sessionController` 和 `sessionQuery`。headless 不挂 `sessionController`；插件发现服务不在就不监听，也不把这种情况说成 Desktop 已验证。

插件包是 `dsh-control-bridge-host`。它只听 `127.0.0.1`，不改 Electron，不读启动 token，不读 `.credentials.yaml`，不调用 `selectModel`。续接用原来的 session id 和 `prompt(..., mode=queue)`，所以会话自己记下的模型选择仍由 Host 使用。

0.1.4 起，`prompt()` 的返回值按官方语义只当"受理"（`{accepted:true}`），回答从会话事件里按 `source.rpcId` 找到本请求所在回合后回收；`/v1/resume` 的超时上限 120 秒，超时返回 `completed:false` 且不重发。授权改成内存/磁盘同源：配对立即生效、撤销立即生效、保存失败不改内存。

0.1.6 增加了请求台账与 owned-turn 取消，并把配对窗口改成可重复布防的文件：`bootstrap.json` / `bootstrap.secret` 每次请求重新读取。重新布防不需要托盘退出，也不需要重启 Desktop；已经装好的 Host 下一次请求就会看到新窗口。窗口单次使用、短期、过期或 JSON 损坏时失败关闭，且不轮换长期 `host.secret`。操作命令：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\Rearm-DesktopHostBootstrap.ps1 -Minutes 20
```

它只写这两个窗口文件，前后校验 `host.secret` 与 `allowlist.json` 未变。`Prepare-DesktopHost.ps1` 再次运行时也保留已有 host secret。0.2.0 的真机热配对与重放结果见 [真机验收](verified-scope.md)。

升级前检查 Desktop 是否还有在途任务，再用应用菜单的 **退出** 或托盘的 **Quit DeepSeek Harness** 正常关闭。安装脚本等 Desktop 完全退出后才会更新插件。

`Prepare-DesktopHost.ps1` 把口令写在解压目录的 `desktop-host-local`，不写系统环境变量。空名单且没有 20 分钟发现窗口时插件不监听。打开 Desktop 后，`Pair-DesktopHost.ps1` 按标题列出会话；`Pair-DesktopHost.ps1 -Index 1` 只写入这一条只读授权并作废发现口令。发现不读正文、不启动任务、不改模型。子会话只分类，不挂到根上。列表读取失败会标明失败，不会显示成“没有历史”。

对已经授予只读的会话，可用技能的 `set-access` 命令，以所选 `session_id` 和 `access: "write"` 提交本地 JSON。Host 会拒绝对忙会话提升写权限。

安装后先保存 `GET /v1/guard/membership` 指纹，升级后再比对。缺了工作区或会话、或者子会话被抬到根上，比对失败并停止。不要用旧的 profile 备份覆盖用户后来的修改。插件不改 workspace 登记。目录只列出当前工作区 `sessionIds` 里的顶层会话。标题来自 list 投影的 `title`，没有投影时用工作区名并标明来源，不读会话正文。子会话按 list 行的 `origin: "subagent"` 分类；`origin` 缺失但带 `parentSessionId` 时保守地留在父会话下，不抬到根列表。会话模型只来自这条会话自己的记录：最后一次 `request/header` 是已经执行过的选择，其后的 `model/selection` 是尚未使用的 pending，`next` 是 `pending ?? lastUsed`。部署默认值单独叫 `global_default`，不会填进会话模型。没有记录时是 `null` 和 `model_source: "unknown"`。`POST /v1/model` 需要写授权、空闲会话和已挂上的 Agent；没有 Agent 时返回 `needs_ui` 且不改任何东西。这条冷会话路径还没有在真机上验证。

`profile` 不是官方 `SessionSummary` 字段。插件只在 desktop profile 挂载，所以 `profile: "desktop"` 是安装前提，行里带 `profile_source: "plugin_profile_assumption"`。忙只看 `running`，`agentAvailable` 表示"有活 Agent 占用"，不算忙。

插件参数见 [Host 插件说明](../plugins/dsh-control-bridge-host/README.md)。

兼容目标是带 0.2.2 session controller 的 Desktop。使用 Desktop 随附的 CLI 可以避免与 PATH 上其他版本混用。Windows Desktop 0.2.2-rc.5 上的历史测试和 0.2.2 主控会话真机结果见 [验收记录](verified-scope.md)。`desktop_install` 在遇到外壳、desktop profile 或归属不明的进程时阻断安装，独立的 SuperAgent profile 可以继续运行。

<a id="workspace-autonomy"></a>

## 工作区自主：安装、启用与回退

`workspaceAutonomy` 是操作者开关，默认关闭。关闭时插件行为与本手册其他章节完全一致；开启后，带 `task_id`+`purpose` 的调用可以把任意绝对目录登记成工作区、取得写授权，并在还没有任何写会话的工作区里建第一个写会话。Host 不检查目录可写性（只做 realpath 归一，必要时建一层），实际能写什么由该账号的文件权限决定。**不要在生产 Desktop 上直接开启。** 先在一个隔离 profile 里按下面步骤验收，确认后再决定是否对生产 profile 打开。

依据与语义见[插件说明](../plugins/dsh-control-bridge-host/README.md#workspace-autonomy-opt-in-per-operator-this-release)与 [Host API](host-api.md#workspace-autonomy-api)。

### 1. 建隔离 profile（不启动服务）

```powershell
$dsh = Read-Host 'Desktop 自带 dsh.cmd 的完整路径'
$profile = 'ws-autonomy-lab'
& $dsh $profile --from-default-profile web --dump-config
```

`--dump-config` 只生成 profile 并打印组合树后退出，不会挂载或监听；不要照抄成不带该开关的命令，否则会真的起一个 web 服务。隔离 profile 必须用自己的状态目录和端口，不复用 8765 以及 3082/3084/3088 等在用端口。用哪条 CLI 启动，就决定了这个隔离 Host 的 runtime 版本（Desktop 自带 CLI 是 0.2.3-alpha.2，全局 npm 包是 0.2.1-rc.3）；文档里四处“0.2.2”的区别见[验收范围](verified-scope.md#version-map)。

```powershell
& $dsh --version   # 记下这次验收用的 runtime 版本
```

### 2. 只在这个 profile 里装插件

```powershell
& $dsh plugin --profile $profile add "link:<仓库路径>/plugins/dsh-control-bridge-host"
& $dsh plugin --profile $profile add "link:<主控预设包路径>"
```

用 `link:` 装的是符号链接，仓库再被改动会直接生效；验收前先固定被测提交。`--dump-config` 里能看到 `dsh-control-bridge-host` 与预设两层，才说明装上了。

### 3. 写插件配置行

在 `C:\Users\<你>\.dsh\profiles\<profile>\cordis.patch.yml` 里加：

```yaml
- id: dsh-control-bridge-host
  config:
    bind: 127.0.0.1
    port: 8766                                  # 空闲端口，不要用 8765
    secretFile: <状态目录>/host.secret
    allowlistFile: <状态目录>/allowlist.json
    workspaceAutonomy: true
    allowCreateWorkspace: true
    allowCreateSession: true
    allowOpenPath: false
    busyPolicy: refuse
    workspaceRoots: [ "D:/ws-lab/roots" ]
    bootstrapFile: ""                           # 显式写明：没有配对窗口
    bootstrapSecretFile: ""
```

`secretFile` 是一个至少 32 字符的长期 bearer（64 位十六进制即可），用你自己的方式生成，写进文件，不进仓库、不进日志。`allowlistFile` 可以先写成合法空授权：

```json
{"version":1,"workspaceAllowlist":[],"sessionAllowlist":[]}
```

**不要预灌任何 grant，也不要为了让它起来去布防 bootstrap 窗口。** 空授权只在策略真的生效时才允许监听，这正是本次要验收的那条门禁。

### 4. 启动并读 health

```powershell
& $dsh $profile --no-open
# 另一个终端
$env:DSH_BRIDGE_SECRET_FILE = '<状态目录>/host.secret'
python desktop.py health --port 8766
```

判定只看三个值：`workspace_autonomy.effective` 为 `true`、`configured`/`enabled` 为 `true`、`operations` 为 `0`。若 `effective` 为 `false`，`reason` 会指出缺什么（`not_configured` / `disabled` / `allowlist_file_missing` / `workspace_create_unavailable` / `session_create_unavailable` / `session_projections_unavailable`），按它补配置，不要改成别的路径绕过。

### 5. 端到端验收（示例路径都是合成值）

```powershell
# 登记并授权一个根外目录（只登记，不建会话、不发提示词）
python desktop.py create-workspace --port 8766 --data ws.json
# ws.json: {"path":"D:\\ws-lab\\outside\\alpha","task_id":"TASK-A","purpose":"验收","create_directory":true,"client_request_key":"lab-ws-0001"}

# 同一 key 重放：应 200 且 deduplicated:true
python desktop.py create-workspace --port 8766 --data ws.json

# 建第一个写会话（还不会派任务）
python desktop.py create-session --port 8766 --data sess.json
# sess.json: {"path":"D:\\ws-lab\\outside\\alpha","task_id":"TASK-A","purpose":"验收","access":"write","agent_preset":"master-control","client_request_key":"lab-sess-0001"}

# 撤销授权：只撤授权，不删目录
python desktop.py revoke-workspace --port 8766 --data revoke.json
# revoke.json: {"workspace_id":"<上一步返回的 workspace_id>"}
```

通过判据：`create-workspace` 的回执 `started_task:false` 且 `workspace_id`/`workspace.id`/`grant.workspace_id` 同一；`create-session` 回执带 `agent_preset: "master-control"`、`agent_preset_source: "session_projection"`、`started_task:false`；重放返回 `deduplicated:true`；`revoke-workspace` 返回 `directory_intact:true`，且该目录在磁盘上仍在；撤销后再用同一 key 重放返回 `409 authorization_stale`。同一把 key 换参数（如改 `purpose`）应 `409 idempotency_key_reused`。

helper 对回执自己也会校验：回执不一致时退出码 1，并报 `workspace_receipt_unverified` / `task_receipt_unverified` / `agent_preset_unverified` / `revoke_receipt_unverified`。退出码 `0` 成功、`1` 业务失败或回执未证实、`2` 本地输入或传输错误。

### 6. 回退

1. 把 `workspaceAutonomy` 改成 `false`（或整项删掉），重启该 profile。授权仍在 `allowlist.json` 里，只是重新走旧规则：根外目录与"新写授权需要已有写会话"的限制恢复。
2. 要连授权一起收回：对每个工作区调用 `revoke-workspace`，或（确认没有其他 profile 共用该文件后）删除 `allowlist.json`。撤销不删目录、不取消在跑的回合。
3. 整个插件不想要了：`& $dsh plugin --profile $profile remove dsh-control-bridge-host`，再删掉 profile 里对应的 patch 行。

### 7. 生产启用前的门槛

任意有 OS 权限的路径都能被登记，且登记时不做可写性检查；授权本身把一个工作区的写权限交给带 bearer 的调用方，权限级别与同账号的 shell 相同。因此：

- 先隔离 profile 全过，再由操作者明确决定是否对生产 Desktop 打开；
- 打开后仍只监听 `127.0.0.1`，不要把 bearer 交给其他机器或别的用户；
- `purpose` 会原样写进 `workspace-autonomy.jsonl`，不要写机密内容；
- 生产 profile 上做的任何配置改动都要先备份 `cordis.patch.yml`，回退时按上面第 6 步改回 `false` 并重启。

## 本环境没有做的 Windows 实测

开发环境是 Linux。六项假进程自检的 Windows 结果来自操作者对 `c31c6ff` 的验收，不是这次在这里重跑的。共享 home、授权和 headless patch 只在 Linux 上用假进程和临时目录验证。下面这些还要等用户机，不能写成已经通过：

- Windows 上的符号链接或 junction 是否被拒绝。
- `Prepare-HeadlessReuse.ps1` 不加 `-Apply` 的计划，以及操作者明确 `-Apply` 后只改 headless、并能回滚。
- 真实 `dsh --profile headless --session-id` 接续一条人工授权的演示会话。
- 一次超时 120 秒、不自动重试的最小真实模型调用。这次没有发。
- 这批 headless 测试只覆盖 headless profile。Desktop Host 的独立测试见[真机验收](verified-scope.md)。

<a id="host-install"></a>

## Host 的安装、升级和回滚

升级前先记录 `GET /v1/guard/membership` 的指纹，再从托盘选择 **Quit DeepSeek Harness**。使用 Desktop 安装目录里 `resources\runtime\cli\bin\dsh.cmd`，让执行安装的 CLI 和 Desktop 运行时版本一致。

```powershell
$desktopCli = Read-Host 'Desktop 自带的 dsh.cmd 的完整路径'
$backup = Read-Host '本次安装或升级使用的私有空目录'
$package = Read-Host 'dsh-control-bridge-host-0.2.2.tgz 的完整路径'
$digest = Read-Host '同版本交付清单中的 TGZ SHA-256'
$action = Read-Host '首次安装输入 Install，升级输入 Upgrade'
powershell -ExecutionPolicy Bypass -File .\scripts\windows\Manage-DesktopHost.ps1 `
  -DshExe $desktopCli `
  -Action $action -Package $package -Sha256 $digest `
  -BackupDir $backup
```

- `Install` 用于尚未安装桥的 Desktop profile，已有版本用 `Upgrade`。Desktop 或无法确认归属的 Harness 进程仍在运行时以退出码 3 拒绝。已确认的独立 `--profile superagent --no-open` 可以继续运行。
- 脚本校验候选包 SHA-256 和包清单，在新的或空的私有目录保留候选包，从当前已安装插件的发布文件归档可回滚版本。操作后核对已安装版本和 Desktop patch 指纹。授权、密钥及工作区状态保留在原位。
- 保留备份目录，profile 的本地包依赖会引用其中的 tgz。实装与回滚使用 Desktop 随附 CLI 在隔离 profile 中验证。升级现有 Desktop 后仍需使用健康检查和工作区指纹完成真机验收。

需要回滚时，再从托盘退出 Desktop，并指定该次操作的私有备份目录。升级的回滚会校验并安装归档版本，首次安装的回滚会移除桥插件。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\Manage-DesktopHost.ps1 `
  -DshExe $desktopCli -Action Rollback -BackupDir $backup
```

重新打开 Desktop 后检查 `GET /v1/health`，然后逐项比对工作区、会话与子会话映射。升级到 0.2.0 后再检查 `GET /v1/discover`。

0.2.0 的创建和打开端点默认关闭。启用时为 `workspaceRoots` 指定允许的根目录，并启用所需的 `allowCreateSession`、`allowCreateWorkspace` 或 `allowOpenPath`。缺少对应配置时端点返回 403 和具体原因。
