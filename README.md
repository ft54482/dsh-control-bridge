<img src="docs/assets/hero.jpg" alt="横幅封面：左侧金色光球与规划草图，经一条光带连接到右侧青色代码屏幕。图中文字为 DSH Control Bridge，以及 Grok Bot × DeepSeek Harness。这是本仓库的项目封面，表示协调代理与 DeepSeek Harness 之间的控制桥。" width="100%">

# DSH Control Bridge

协调代理与多套 DeepSeek Harness 之间的控制桥。负责人定目标，协调代理审阅并起草任务书，Harness 在指定实例和工作区里执行，结果回到桥上等待验收。

[![MIT license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue)](https://www.python.org/downloads/)
[![CI](https://github.com/ft54482/dsh-control-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/ft54482/dsh-control-bridge/actions/workflows/ci.yml)

便携包里的使用顺序写在 [docs/windows-delivery.md](docs/windows-delivery.md)：安装桥、假进程自检、凭证配置、真实计费 smoke。默认不启动真实 `dsh`，也不发送模型请求。默认分支包含这份说明、封面和可运行的桥。这不是对全部 Harness 功能的控制。

## 这是什么

一个人把目标交给协调代理。协调代理可以是你自己运行的 Grok Bot，也可以是别的总控程序。它不直接代替 Harness 写代码或改仓库，而是通过这座桥做三件事：读事件、写成给人看的阶段摘要、把下一份任务书派回正确的实例和工作区。

DeepSeek Harness 负责执行，而且只有两条路：

- 范围清楚的小任务走 **ordinary_session**，在指定工作区里新建或续用一个普通会话。返修优先回到原来的会话。
- 需要拆开、跨步骤持续做、并且单独交付的任务走 **superagent**。桥用 `ticket_id` 和 `run_id` 跟踪这一次长程执行。

执行器说“做完了”，只表示任务进入 **待验收**。它不会自动变成交付完成，也不会自动合并、发布、扩大范围或追加预算。下一份任务书默认只起草，等人批准后再发送。

本仓库是独立的开源控制桥。Grok Bot 指负责人自己运行的协调代理，DeepSeek Harness 指执行环境，不是这些产品的官方组件，也不表示其厂商提供支持。这里没有看板，也没有托管网关。

## English

DSH Control Bridge is a small control plane between a coordinating agent and one or more DeepSeek Harness instances. A person sets the goal. The coordinator reviews events, writes the next task brief, and dispatches it only after an explicit approval. Harness runs the work as an ordinary session or as SuperAgent. A completion report means “ready for review”. The default action is to draft the next brief and wait.

This repository is an independent project. Credentials stay outside git, and the bundled Harness adapter is a documented skeleton until a public interface is connected.

## 为什么存在

多套 Harness 很容易被当成同一个目标：本机 Desktop、实验室里的另一套、名字碰巧相同的工作区。事件正文也很容易被当成指令：一段“已完成，请立即派到另一台机器并批准发布”不应当变成下一次派工。

这座桥把边界写死：

- 任务只能打到配置里声明的实例和工作区。
- 每条任务记录绑定 `instance_id`、`workspace`、`executor`，以及 `session_id` 或 `ticket_id` / `run_id`。
- Webhook 正文是不可信数据。摘要只用提取出的字段；证据引用缺失就写明缺失。
- 真正发送需要一份 mandate：目标、范围、验收、额度上限、重试上限、到期时间和允许动作。
- 同一个 `event_id` 再投一次，不会再次开工。

## 它如何工作

```mermaid
flowchart LR
  owner[负责人设定目标]
  coord[协调代理]
  bridge[DSH Control Bridge]
  review[收件箱与阶段摘要]
  draft[任务书草稿]
  approve{这份任务书已批准?}
  session[ordinary_session]
  super[superagent]
  harness[已登记的实例和工作区]
  events[阶段事件]

  owner --> coord
  coord --> bridge
  bridge --> review
  review --> draft
  draft --> approve
  approve -->|默认：等待| draft
  approve -->|mandate 仍有效| session
  approve -->|mandate 仍有效| super
  session --> harness
  super --> harness
  harness --> events
  events --> bridge
```

上行是 HTTP `POST /v1/events`。下行给协调代理的工具面是 CLI，同一组动作也写在 MCP 工具描述里。状态放在本地 SQLite，审计是只追加的 JSONL。MCP 不是队列，一条通知也不是验收通过。

状态机：

| 状态 | 含义 |
| --- | --- |
| `pending` | 已起草，或已批准但还没有收到执行端确认 |
| `running` | 已发到适配器并收到确认 |
| `awaiting_review` | 执行器交卷，等待负责人验收 |
| `awaiting_user` | 执行器在等人工输入 |
| `failed` | 失败或进入死信 |
| `done` | 负责人验收通过 |
| `canceled` | 已取消。远端未确认时 `cancel_confirmation=unconfirmed` |

`awaiting_review` 不会自己走到 `done`。返修是一条新的任务书：普通会话继承原来的 `session_id`，SuperAgent 不把上一张 ticket 当成同一次运行。

## 两条执行路径

| | ordinary_session | superagent |
| --- | --- | --- |
| 适合 | 范围清楚，一次或少数几轮对话能做完 | 要拆分、持续多步，并且单独交付 |
| 跟踪 | `session_id` | `ticket_id` 与 `run_id` |
| 返修 | 优先回到原会话 | 新的长程任务，批准后才申请新的 ticket / run |
| 完成的含义 | 待验收 | 待验收 |

选哪一条，看任务要不要拆开并持续交付，不看预计花了多久。小修小补不要开成 SuperAgent。

## 多实例与多工作区

每一套物理或逻辑上的 Harness 单独登记。本机 Desktop 和另一台机器上的 Harness 不能写成同一个实例，即使两边都有一个叫 `broadcast-cs` 的工作区。

样例里有两个虚构目标：

- `local-desktop`：本机 Desktop，工作区 `broadcast-cs` 与 `auto-video`
- `lab-server`：远程实例，只有 `broadcast-cs`

`auto-video` 不会授权 `lab-server`。`local-desktop` 上的 `broadcast-cs` 也不会授权 `lab-server` 上的同名工作区。样例名称不代表真实路径、客户系统或内网地址。`base_url` 使用 `127.0.0.1` 上的占位端口，fake 适配器不会连接它。

## 快速开始

需要 Python 3.11 或更新版本。运行时没有第三方依赖。

```bash
git clone https://github.com/ft54482/dsh-control-bridge.git
cd dsh-control-bridge
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
python examples/e2e_fake.py
```

这条示例全部走 fake 适配器：起草一个普通会话任务，批准后发送，收到交卷事件后进入待验收，起草下一阶段任务书但不再发送，拒绝未登记工作区，再批准一次打到另一套实例的 SuperAgent 派工。它不访问真实 Harness，也不消耗额度。

然后可以检查样例配置：

```bash
dsh-bridge --config examples/config.example.toml --data-dir /tmp/dsh-bridge-demo check
```

本地事件入口只绑定本机回环地址。每个实例使用自己的事件密钥：

```bash
export DSH_LOCAL_DESKTOP_EVENT_SECRET='choose-a-local-secret'
export DSH_LAB_SERVER_EVENT_SECRET='choose-another-local-secret'
dsh-bridge --config examples/config.example.toml --data-dir /tmp/dsh-bridge-demo serve
```

另一个终端用同一份字节计算签名。密钥只存在于当前环境，不要写进仓库：

```bash
export DSH_LOCAL_DESKTOP_EVENT_SECRET='choose-a-local-secret'
dsh-bridge --config examples/config.example.toml sign --instance local-desktop \
  < examples/event.stage_submitted.json
```

`sign` 打印三行头：`X-DSH-Timestamp`、`X-DSH-Instance`、`X-DSH-Signature`。签名覆盖 `v1`、时间戳、实例 id 和正文。时间戳超出配置窗口（默认 300 秒，最大 900 秒）会被拒绝，旧报文不能隔天重放。

```bash
curl -sS -X POST http://127.0.0.1:8787/v1/events \
  -H "Content-Type: application/json" \
  -H "X-DSH-Timestamp: <上面打印的时间戳>" \
  -H "X-DSH-Instance: local-desktop" \
  -H "X-DSH-Signature: <上面打印的签名>" \
  --data-binary @examples/event.stage_submitted.json
```

样例事件里的 `instruction`、`approve` 和 `please_dispatch` 会被丢掉。没有对应任务时，事件进入收件箱，任务状态不会被改写。

## 配置

完整样例是 [`examples/config.example.toml`](examples/config.example.toml)。最小结构如下。

```toml
[bridge]
signature_window_seconds = 300
allow_unsigned = false

[notify]
mode = "off"

[[instances]]
id = "local-desktop"
label = "本机 DeepSeek Harness Desktop"
kind = "desktop"
adapter = "fake"          # fake 或 harness
base_url = "http://127.0.0.1:9"
auth_env = "DSH_LOCAL_DESKTOP_TOKEN"
event_secret_env = "DSH_LOCAL_DESKTOP_EVENT_SECRET"

[[instances.workspaces]]
name = "broadcast-cs"
description = "示例工作区名称，不代表真实路径"

[[instances]]
id = "lab-server"
label = "实验室远程 Harness（与本机实例分开）"
kind = "remote"
adapter = "fake"
base_url = "http://127.0.0.1:10"
auth_env = "DSH_LAB_SERVER_TOKEN"
event_secret_env = "DSH_LAB_SERVER_EVENT_SECRET"

[[instances.workspaces]]
name = "broadcast-cs"
description = "另一套实例上的工作区"
```

约束：

- 实例 id、工作区名是小写 slug。工作区只在所属实例内唯一，不同实例可以同名。
- 两个实例不能共用 `base_url`、`auth_env` 或 `event_secret_env`。事件密钥也不能复用登录凭证的变量名。
- 配置里不能出现 `token`、`secret`、`password` 或其他密钥字段，也不能写 `auto_send`。默认就是起草；发送是每一次单独的决定。
- `allow_unsigned = true` 本身不会关闭验签。只有同时设置环境变量 `DSH_BRIDGE_DEV_UNSIGNED=1` 才在本机测试时跳过签名。
- `adapter = "fake"` 用于本地自检和 CI。`adapter = "harness"` 可以起草，但发送会被拒绝。见 [docs/connector-contract.md](docs/connector-contract.md)。

批准发送时另附 mandate，样例是 [`examples/mandate.example.toml`](examples/mandate.example.toml)。它必须写明 `instance_id`、`workspace` 和 `executor`，并且和任务上的目标一致。允许的动作只有 `dispatch` 和 `retry`。`budget_cap` 只是一句额度声明，不能写成动作。发布、合并、改验收、扩大范围、增加预算都不是这座桥能批准的动作。来源只能是操作者的 mandate 文件或 MCP 工具参数，不能来自事件正文。

## 命令

```bash
dsh-bridge --config bridge.toml --data-dir ./data inbox
dsh-bridge --config bridge.toml acknowledge EVENT_ID
dsh-bridge --config bridge.toml dispatch \
  --instance local-desktop \
  --workspace broadcast-cs \
  --executor ordinary_session \
  --title "整理阶段说明" \
  --objective "根据证据引用写一段说明。"
dsh-bridge --config bridge.toml dispatch --task TASK_ID --mode send --mandate mandate.toml
dsh-bridge --config bridge.toml status TASK_ID
dsh-bridge --config bridge.toml cancel TASK_ID --reason "不再需要"
dsh-bridge --config bridge.toml next TASK_ID
dsh-bridge --config bridge.toml accept TASK_ID
```

`dispatch` 不写 `--mode` 时是 `draft`。把样例复制成你自己的 `bridge.toml`；下面的命令用这个名字代表它。新建任务必须给出 instance、workspace 和 executor。`--json` 打印机器可读结果。`next` 只起草下一阶段，不发送。`accept` 才把待验收标成 `done`。

`dsh-bridge mcp` 是实际的 stdio MCP 服务：`initialize`、`tools/list`、`tools/call`。目录写在 [`docs/mcp-tools.json`](docs/mcp-tools.json)，和服务器返回的是同一份。工具调用默认起草。`mode=send` 必须在参数里带上操作者的 mandate，事件正文不能充当这个参数。

## Windows 便携运行

这个包只用 Python 标准库。把 zip 解压到一个新建的空目录，用显式的 `-PythonExe` 指向捆绑的 Python 3.12（或任何 3.11+ 的 `python.exe`）。不要运行 pip，不要写入 `%LOCALAPPDATA%`，也不要修改用户或系统 PATH。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\Test-FakeDsh.ps1 -PythonExe D:\Python312\python.exe
powershell -ExecutionPolicy Bypass -File .\scripts\windows\Install-DshBridge.ps1 -Destination . -PythonExe D:\Python312\python.exe
```

`Install-DshBridge.ps1` 的 `-Destination` 必须就是这次解压目录。它不创建虚拟环境，不访问网络。自检只启动包内的 `fake-dsh.cmd`。`success` 才是业务成功；没有 final、坏退出、超时和主动取消都必须显示为拒绝。步骤和尚未在 Windows 上重跑的项目见 [docs/windows-delivery.md](docs/windows-delivery.md)。一台 Desktop 上已经看到的范围，以及还不能写成已验证的项目，见 [docs/verified-scope.md](docs/verified-scope.md)。

`Start-DshBridge.ps1 -PythonExe D:\Python312\python.exe` 只做本机 `diagnose`。加上 `-Serve` 才在 `127.0.0.1:8787` 监听。它不启动 desktop，也不启动真实 `dsh`。

既有 home 默认不用。`home_mode = "shared"` 只打开配置里点名的工作区和 session，不能把读到历史文件当成原生 resume。Desktop 的续接走安装到 desktop profile 的 Host 插件，见 [plugins/dsh-control-bridge-host/README.md](plugins/dsh-control-bridge-host/README.md)。Host 0.2.0 在 0.1.6 的可重布防配对窗口之上，增加了持久请求日志与 SSE/长轮询、全局发现、逐会话 effort 控制，以及需要显式开启的创建/打开目录端点；完整契约见 [docs/host-api.md](docs/host-api.md)。headless 路径还在。官方 SuperAgent 的派工入口仍是关闭的，见 [docs/release-0.2.0.md](docs/release-0.2.0.md)。

Codex 可以通过 `$deepseek-harness-bridge` 操作本机 Desktop。安装技能时将 `skills/deepseek-harness-bridge` 复制到 `~/.codex/skills/`，然后按技能入口配置本机 bearer 文件路径。技能包含 Python 标准库 CLI，支持 0.1.6 的授权会话操作以及 0.2.0 的发现、创建和请求事件。见 [技能入口](skills/deepseek-harness-bridge/SKILL.md)。

## 事件

`POST /v1/events` 要求三个头：`X-DSH-Timestamp`、`X-DSH-Instance`、`X-DSH-Signature`。密钥来自该实例的 `event_secret_env`。一台实例的密钥不能给另一台实例签名。请求体上限 64 KiB。

只提取这些字段：`event_id`、`event_type`、`occurred_at`、`instance_id`、`workspace`、`executor`、`task_id`、`session_id`、`ticket_id`、`run_id`、`commit_sha`、`evidence`。其余内容不执行、不写入数据库、不写进摘要。证据引用必须是相对路径；桥不会按 payload 去打开文件。

事件不能把任务标成 `done`，不能创建或改写 mandate，不能把草稿说成已经在执行，也不能借 session id 碰到另一个实例或工作区的任务。`cancel_ack` 只确认本地已经发起的取消。`unconfirmed` 表示远端取消没有得到确认，不能当成已经停止或已经交付。

`event_type` 可以是 `stage_submitted`、`error`、`awaiting_input`、`exited`、`started`、`cancel_ack`。重复的 `event_id` 记一次重复并保持原状态。签名错误或超出时间窗不会占用这个 id。未登记的实例或工作区进入死信。

进程在“已批准但还没写回远程 id”时停掉的话，下次启动会按 `task_id` 续上，并且只有一个恢复过程能领走这次发送。fake 适配器对同一个 `task_id` 返回同一组 id。mandate 过期、来源不是操作者，或目标和任务不一致时，不再续发。

通知默认 `off`。`file` 把脱敏后的记录写进数据目录。`webhook` 只有在配置了 URL 且主机在 `allowed_hosts` 里时才会发送；失败记为 `failed`，不会被写成已送达。审计和错误文本会去掉密钥形状的片段。

## 本机连接预检

`dsh-bridge diagnose` 和 `dsh-bridge preflight` 只读配置和一份脱敏事实文件，不访问网络。当前 `connected_to_harness` 固定为 false。已记录的只读事实和仍缺的证据在 [docs/connector-contract.md](docs/connector-contract.md)。普通会话接口还没有证据。SuperAgent 文档里的 `127.0.0.1` 管理路由是管理面，本仓库不调用它，也不把它当成派工接口。Harness 主动的 webhook 回程目前没有被当成已支持的入站。

## 安全

密钥只放在两处：环境变量，或 `~/.dsh-control-bridge/credentials.toml`。仓库里的 [`examples/credentials.example.toml`](examples/credentials.example.toml) 全是占位符。若 `DSH_CREDENTIALS_FILE` 指向当前 git 工作区里的文件，桥会拒绝读取。

更多约定见 [SECURITY.md](SECURITY.md)。封面图的用法见 [SOCIAL.md](SOCIAL.md)。

## 首版状态

这是 0.1.0，一个可测试的骨架，不是完整平台。

| 能力 | 状态 |
| --- | --- |
| 多实例、多工作区配置，以及无效配置的明确错误 | 已实现 |
| 带时间窗的按实例签名、事件去重、不可信 payload | 已实现 |
| 任务状态机、SQLite、JSONL 审计、有限重试和死信 | 已实现 |
| 默认起草；mandate 绑定目标、期限和动作后才发送 | 已实现 |
| ordinary_session 与 superagent 分流 | 已实现 |
| 取消，以及远端未确认时的 `unconfirmed` | 已实现 |
| 进程中断后的 in-flight 恢复，同一次发送只会被领走一次 | 已实现 |
| fake / dry-run 适配器，CI 不连接真实 Harness | 已实现 |
| CLI，以及 stdio MCP（`dsh-bridge mcp`） | 已实现 |
| 本地自检、diagnose、preflight | 已实现 |
| 通知出站：默认关闭；失败状态可查询 | 已实现 |
| Desktop 上一条已授权既有会话的一次 resume | 插件 0.1.5 在 Windows Desktop 0.2.2-rc.5 上有一次匿名记录，见 [docs/verified-scope.md](docs/verified-scope.md)。这不是对全部 Harness 功能的控制 |
| Host 0.1.6 的请求记录、查询和官方 owned-turn 取消 | 只在夹具和官方源码核对中验证，见 [docs/request-lifecycle.md](docs/request-lifecycle.md)、[docs/official-host-contract.md](docs/official-host-contract.md) 与 [docs/release-0.1.6.md](docs/release-0.1.6.md)。还没有真机验收 |
| Host 0.1.6 的配对窗口重新布防与授权热更新 | 只在同进程夹具中验证：单次使用、过期/损坏失败关闭、不改长期 host secret、Desktop 不必重启。还没有真机验收；证据分级见 [docs/release-0.1.6.md](docs/release-0.1.6.md) |
| Host 0.2.0 的请求回传 | 真机通过 0.1.6 请求升级后查询、短任务 SSE 和断点续读。长任务跨等待窗口仍待实测。见 [真机验收](docs/verified-scope.md) |
| Host 0.2.0 的模型/effort 控制、全局发现、创建工作区/会话/打开目录 | Windows 真机通过。创建和打开需要显式配置能力开关及根目录。见 [真机验收](docs/verified-scope.md) |
| Host 0.2.0 的出站完成 webhook（持久 outbox + HMAC HTTPS） | 只有 mock 接收端的夹具结果；本机没有接收 URL/密钥，**没有端到端接通**，默认关闭。配置字段与语义见 [docs/host-api.md](docs/host-api.md) |
| 冷会话改模型、取消/超时的完整生命周期、跨工作区闭环 | 真机未验证；0.2.0 只把可隔离验证的部分做进夹具 |
| SuperAgent | 技能已用官方管理面查询历史 Ticket 和 Assignment。新派工由配置的 Source 事件进入，见 [SuperAgent 技能用法](skills/deepseek-harness-bridge/references/superagent.md) |
| 看板、托管网关、A2A 协议、商业 Harness CI 插件 | 不在本仓库 |

细节在 [docs/headless-cli.md](docs/headless-cli.md) 和 [docs/connector-contract.md](docs/connector-contract.md)。`connected_to_harness` 仍是 false：headless 进程默认不启动，SuperAgent 长任务继续拒绝。

恢复语义是至少一次：适配器必须按 `task_id` 去重。首版不计量厂商额度，`budget_cap` 只是写进 mandate 的上限声明。

## 开发

```bash
pip install -e ".[dev]"
pytest
python examples/e2e_fake.py
```

架构说明在 [docs/architecture.md](docs/architecture.md)。接入本机实例、再加第二套实例的步骤在 [docs/local-harness.md](docs/local-harness.md)。

## 许可证

[MIT](LICENSE)
