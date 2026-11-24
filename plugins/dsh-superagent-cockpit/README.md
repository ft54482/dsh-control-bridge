# DeepSeek Harness 的 Super Agent 驾驶舱

驾驶舱在 Harness Desktop 左侧增加「Super Agent 驾驶舱」。主控任务、当前 Harness 会话和各 SuperAgent 实例的工单可以在同一页查看。面板刷新只读取状态。要向引擎派工，请使用桥技能的 [GitHub Source 操作指南](https://github.com/ft54482/dsh-control-bridge/blob/main/skills/deepseek-harness-bridge/references/superagent.md#github-source)。

## 三个数字怎样读

| 页面位置 | 谁提供数据 | 数字表示什么 |
| --- | --- | --- |
| 顶部编号任务槽，例如 5/10 | 主控写入的 `superagents.json` | 登记为已创建、开发中、审计中或返工的任务占了 5 个名额。主控可以记录实际会话 ID，也可以先登记任务。 |
| 顶部「活代理」 | 当前 Harness 宿主的 agent 服务 | 当前可见的运行中会话。会话与任务需按 ID 对上，两个计数相等也不能说明是一一对应。 |
| 实例卡片的执行器，例如 0/4 | 该实例管理 API 的 `overview.executor` | 此刻正在执行的 worker 数与执行器容量。排队另计，已交报告、等待人审的工单可以出现在下方列表。 |

例如，主控有 5 项任务处于开发或审计，而一个实例刚刚做完今天唯一一单。这时同页会出现 5/10、已接单 1、执行器 0/4。核对一项具体工作时，看主控任务登记的会话 ID，或到引擎记录核对对应的 Ticket 与 Assignment。

## 安装到 Desktop

需要已有的 DeepSeek Harness Desktop；使用随 Desktop 提供的 `dsh` CLI，并选平时使用的 profile。独立运行聚合器或登记工具需要 Node.js 20 或更高版本。

1. 下载 [驾驶舱 TGZ 及 SHA-256](https://github.com/ft54482/dsh-control-bridge/releases/tag/cockpit-v0.1.3)。在 Windows 下可用 `Get-FileHash -Algorithm SHA256 .\dsh-superagent-cockpit-0.1.3.tgz` 核对摘要。
2. 把 TGZ 保存在长期保留的目录中，在该目录打开 PowerShell，把 Desktop 自带 CLI 的路径填入下面的命令。已在使用其他 profile 时，将 `desktop` 换成自己的名称。

   ```powershell
   $cli = Read-Host 'Desktop 自带 dsh.cmd 的完整路径'
   $package = (Resolve-Path './dsh-superagent-cockpit-0.1.3.tgz').Path
   & $cli plugin --profile desktop add $package
   ```

3. 重新打开对应 profile 的 Desktop，点击左栏「Super Agent 驾驶舱」。已有 SuperAgent 引擎可直接接入。首次使用引擎需先完成其 [官方部署](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/006-deployment.md)。

## 在一页看多个实例

从仓库的 `plugins/dsh-superagent-cockpit` 目录运行以下命令。只有 TGZ 时，可先在一个空目录运行 `tar -xf ./dsh-superagent-cockpit-0.1.3.tgz`，再进入解出的 `package` 目录。请将两个端口换成自己实际部署的实例。

```powershell
$env:DSH_COCKPIT_INSTANCES = '[{"port":3082,"label":"开发"},{"port":3084,"label":"验收"}]'
node ./fleet.mjs
```

保持这个进程运行，刷新驾驶舱。聚合器默认监听 `127.0.0.1:3090`，未配置实例列表时只连接本机 3082。每张卡片以自身实例名与端口为准。单实例可直接使用插件的管理 API 连接。

## 数据接入和排错

以下配置位于当前 profile 中 **dsh-superagent-cockpit 插件自己的 config**。安装包里的 `cordis.patch.yml` 给出配置位置。

| 配置项 | 默认读取位置 | 怎么核对 |
| --- | --- | --- |
| `api` | `http://127.0.0.1:3082` | 填实际引擎的管理地址，再查看实例运行信息。 |
| `fleet` | `http://127.0.0.1:3090` | 访问聚合器的 `/healthz`。更改服务端 `FLEET_PORT` 时同步修改此项。 |
| `masterState` | `~/.dsh/state/master-control/superagents.json` | 指向主控真实写入的登记表；核对任务 ID 和更新时间。 |
| `sparring` | `http://127.0.0.1:8770` | 仅在有兼容的本机仿真训练台时启用对应数据。 |

主控可使用同包的 `masterctl.mjs` 维护登记表。在项目目录中首次运行 `node <工具路径>/masterctl.mjs init --max-workers 10` 可建立十个名额。`slots --json` 查看占用。`create`、`update` 和 `audit` 分别记录任务、状态和审核结果。请由同一个主控串行写入；展示实际会话时登记其真实的 `--session-id`。已有登记表的用户直接使用原文件即可。

如顶部无法读取活会话，先确认打开的是执行该会话的 Harness 宿主。实例离线时核对相应管理端口。新环境只会看到自己的任务和工单；安装包中的程序不会从维护者机器导入历史。
