# 四个阶段

这些阶段按顺序进行。缺凭证不是代码已经结束，也还没有进入真实计费。这一包只补 Windows 假进程自检，不配置真实凭证，也不做 SuperAgent 绑定。

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

插件包是 `dsh-control-bridge-host`。它只听 `127.0.0.1`，不改 Electron，不读启动 token，不读 `.credentials.yaml`，不调用 `selectModel`。续接用原来的 session id 和 `prompt(..., mode=queue)`，所以会话自己记下的 example-provider / example-model 仍由 Host 使用。忙或写锁被占时拒绝，不取消现有回合。

官方源码和 0.2.1 以后的问题记录都没有 `dsh desktop quit`。关窗口只会进托盘。托盘菜单 **Quit DeepSeek Harness** 会先问 Host 有没有未完成任务，确认后才退出。没有正规外部退出命令，所以这一次托盘退出不能省，也不能改成 taskkill。允许重启不等于可以丢掉还没写完的任务。

`Prepare-DesktopHost.ps1` 把口令写在解压目录的 `desktop-host-local`，不写系统环境变量。空名单且没有 20 分钟发现窗口时插件不监听。打开 Desktop 后，`Pair-DesktopHost.ps1` 按标题列出会话；`Pair-DesktopHost.ps1 -Index 1` 只写入这一条只读授权并作废发现口令。发现不读正文、不启动任务、不改模型。子会话只分类，不挂到根上。列表读取失败会标明失败，不会显示成“没有历史”。

写入要另一步：发现口令作废后，用持久口令 `python -m dsh_control_bridge.pair_desktop --grant-write --host-secret-file desktop-host-local\host.secret --index 编号`。忙会话拒绝写入。

安装后先保存 `GET /v1/guard/membership` 指纹，升级后再比对。缺了工作区或会话、或者子会话被抬到根上，比对失败并停止。不要用旧的 profile 备份覆盖用户后来的修改。插件不改 workspace 登记。目录只列出当前工作区 `sessionIds` 里的顶层会话。标题来自 list 投影的 `title`，没有投影时用工作区名并标明来源，不读会话正文。模型来自投影里的 `modelSelection`。已移出侧栏的目录不会进默认配对列表。

安装和回滚说明见 `plugins/dsh-control-bridge-host/README.md`。

兼容目标是带 0.2.2 session controller 的 Desktop（操作者看到的 CLI 是 0.2.2-rc.5）。这里没有连上真实 Desktop。Web 上能加载不等于 Desktop 已验收。

## 本环境没有做的 Windows 实测

开发环境是 Linux。六项假进程自检的 Windows 结果来自操作者对 `c31c6ff` 的验收，不是这次在这里重跑的。共享 home、授权和 headless patch 只在 Linux 上用假进程和临时目录验证。下面这些还要等用户机，不能写成已经通过：

- Windows 上的符号链接或 junction 是否被拒绝。
- `Prepare-HeadlessReuse.ps1` 不加 `-Apply` 的计划，以及操作者明确 `-Apply` 后只改 headless、并能回滚。
- 真实 `dsh --profile headless --session-id` 接续一条人工授权的演示会话。
- 一次超时 120 秒、不自动重试的最小真实模型调用。这次没有发。
- Desktop、Web、SuperAgent 仍然没有受支持的接管。
