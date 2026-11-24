# 端口配置与排错

先确认**哪个进程在监听、哪个客户端要连它**。以下示例把 Desktop Host 设为 `18865`、协调桥事件入口设为 `18887`；两者可独立运行。SuperAgent helper 使用该 profile 已有的管理端口，MCP 使用标准输入、输出。[选择接入方式](../README.md) · [文档目录](README.md)

<a id="desktop-host"></a>

## Desktop Host 换端口

以下 PowerShell 示例适用于 v0.2.2。假设你已按安装手册把 Host 加入同机 Harness Desktop，当前目录是包含 `src`、`scripts/windows` 的便携包或源码根目录。[安装步骤](windows-delivery.md#codex-desktop-setup)

1. **在 Host 端选择端口。** 首次使用 `Prepare-DesktopHost.ps1` 时，它生成的 `desktop-host-local/cordis-snippet.yml` 默认写入 `8765`。将该配置应用到实际 desktop profile 的 `cordis.patch.yml` 时，在 `dsh-control-bridge-host` 项的 `config` 下设置 `port: 18865` 和 `bind: 127.0.0.1`。保留同项已有的密钥文件、授权文件和工作区配置。已有安装先等任务完成，通过托盘正常退出再重新加载配置。
2. **在同一端口配对。** v0.2.2 的 `Pair-DesktopHost.ps1` 使用默认端口。改端口后，用它底层的 Python 配对命令指定 `--url`。先列出会话，再输入自己确认的编号。已完成配对且沿用相同凭据与授权时，从第 3 步开始。

   ```powershell
   $desktopPort = 18865
   $env:PYTHONPATH = (Resolve-Path ./src).Path
   $pairArgs = @('--url', "http://127.0.0.1:$desktopPort",
                 '--bootstrap-secret-file', './desktop-host-local/bootstrap.secret')
   python -m dsh_control_bridge.pair_desktop @pairArgs
   $sessionIndex = Read-Host '目标空闲会话在列表中的编号'
   python -m dsh_control_bridge.pair_desktop @pairArgs --index $sessionIndex --access read
   ```

   需要派工时，在配对命令中选 `--access write`。配对窗口过期或已消费时，在对应的便携目录重新运行 `./scripts/windows/Rearm-DesktopHostBootstrap.ps1`，再列出候选。
3. **从 skill 检查 Host。** 在同一 PowerShell 窗口运行。以下用个人 skill 目录；项目级安装请把脚本路径换成实际位置。

   ```powershell
   $desktopPort = 18865
   $client = Join-Path $HOME '.agents/skills/deepseek-harness-bridge/scripts/desktop.py'
   $env:DSH_BRIDGE_SECRET_FILE = (Resolve-Path ./desktop-host-local/host.secret).Path
   python $client health --port $desktopPort
   python $client granted --port $desktopPort
   ```

   helper 按顺序从环境变量 `DSH_BRIDGE_SECRET_FILE`、个人 skill 的 `connection.json` 中的 `secret_file`、默认路径 `~/.dsh/state/desktop-host-local/host.secret` 找长期凭据。当前 `connection.json` 仅读取凭据路径。自定义端口要在**每次**调用时传 `--port`，包括创建、续接和查询。可直接告诉 Codex「这套 Desktop Host 用 18865，每次调用 desktop.py 都带上这个端口」。如果 Codex 由桌面图标启动，使用个人 skill 下的私有 `connection.json`，或向实际启动 Codex 的环境提供凭据路径。[连接配置示例](windows-delivery.md#codex-desktop-setup)

如果调用方是 **Python 协调桥的 `desktop_host` 适配器**，在对应 `[[instances]]` 配置 `host_bind = "127.0.0.1"`、`host_port = 18865`。它用 `host_secret_env` 指定保存长期凭据**值**的环境变量。上面的 skill 使用保存凭据**文件路径**的变量。两个客户端可分别配置。[Desktop 适配器 TOML](../examples/desktop-host.example.toml)

## 协调桥的签名事件入口

只在另一个程序要投递阶段事件时运行 `serve`。先按协调桥指南安装 Python 包，在仓库根目录运行以下命令，或把参数改成自己的配置和数据目录。默认端口是 `8787`。[协调桥指南](coordinator.md)

```powershell
dsh-bridge --config examples/config.example.toml --data-dir ./data serve --host 127.0.0.1 --port 18887
```

在另一个终端运行 `Invoke-RestMethod http://127.0.0.1:18887/health` 检查监听。发送方相应改用 `http://127.0.0.1:18887/v1/events`，用对应实例的事件密钥签名。Windows 便携启动脚本对应用 `-Serve -Port 18887`。Host 可选的出站通知使用独立的 HTTPS 接收协议；接收端契约见 [Host API](host-api.md)。

## 驾驶舱

驾驶舱可直接读取一个引擎的管理地址（默认 3082）。多实例模式默认读取本机 3090 聚合服务；用 `DSH_COCKPIT_INSTANCES` 设置实例清单，用 `FLEET_PORT` 与插件的 `config.fleet` 同步更改聚合端口。可选仿真服务默认在 8770。主控任务登记表来自本地文件，活会话来自当前 Harness 宿主。[驾驶舱配置](../plugins/dsh-superagent-cockpit/README.md)

## SuperAgent 与 MCP

- **SuperAgent 管理面。** helper 默认查本机 `3082`。若你的已授权 profile 实际监听 `13082`，从仓库根运行 `python skills/deepseek-harness-bridge/scripts/superagent.py --port 13082 state`。这里 `--port` 放在子命令前。查询针对该 profile 的状态，新派工要通过它的 Source。[SuperAgent 命令](../skills/deepseek-harness-bridge/references/superagent.md)
- **协调桥 MCP。** 让客户端启动 `dsh-bridge --config … --data-dir … mcp`。配置的是可执行文件、参数和本地数据目录。v0.2.2 的 stdio 实现使用 `Content-Length` 分帧，只支持逐行 JSON 的客户端无法直接握手。[MCP 配置示例](coordinator.md) · [该协议版本的标准 stdio 约定](https://modelcontextprotocol.io/specification/2024-11-05/basic/transports)

## 按症状排查

| 现象 | 先检查 |
| --- | --- |
| 端口被占用，或 helper 报 `bridge_transport_error` | Windows 用 `Get-NetTCPConnection -LocalPort 18865 -State Listen` 查看占用者，再核对实际 profile、Host 配置、配对 URL 和本次 `--port`。 |
| 能打开 `/health`，但查不了 Desktop 会话 | `serve` 的健康路径是 `/health`。Desktop Host 的是带 bearer 的 `/v1/health`，请用 `desktop.py health --port …` 检查。 |
| HTTP 401，或 helper 在请求前提示凭据不可用 | 配对目录使用短期 `bootstrap.secret`；skill 日常使用与该 Host 相配的长期 `host.secret`。核对文件路径和启动环境。 |
| `workspace_not_allowlisted` 或 `preset_creation_unavailable` | 前者查工作区配对、确切 ID 和创建范围；后者查当前 Host 的 `preset_create_verified`。若报 `agent-preset/not-found`，检查同一 profile 是否安装了对应预设。[主控会话核验](../skills/deepseek-harness-bridge/references/desktop.md#new-work-in-master-control-mode) |
| 配置里看到 `:9`、`:10` 或多套同名工作区 | 这两个端口是 fake 示例占位。按实例 ID 和工作区定位目标，再配置该适配器实际使用的连接字段。[多实例配置](local-harness.md) |
