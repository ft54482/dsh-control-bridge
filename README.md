<img src="docs/assets/hero.jpg" alt="横幅封面：左侧金色光球与规划草图，经一条光带连接到右侧青色代码屏幕。图中文字为 DSH Control Bridge，以及 Grok Bot × DeepSeek Harness。这是本仓库的项目封面，表示协调代理与 DeepSeek Harness 之间的控制桥。" width="100%">

# DSH Control Bridge

协调代理与多套 DeepSeek Harness 之间的控制桥。负责人定目标，协调代理审阅并起草任务书，Harness 在指定实例和工作区里执行，结果回到桥上等待验收。

[![MIT license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue)](https://www.python.org/downloads/)
[![CI](https://github.com/ft54482/dsh-control-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/ft54482/dsh-control-bridge/actions/workflows/ci.yml)

## 这是什么

一个人把目标交给协调代理。协调代理可以是你自己运行的 Grok Bot，也可以是别的总控程序。它不直接代替 Harness 写代码或改仓库，而是通过这座桥做三件事：读事件、写成给人看的阶段摘要、把下一份任务书派回正确的实例和工作区。

DeepSeek Harness 负责执行，而且只有两条路：

- 范围清楚的小任务走 **ordinary_session**，在指定工作区里新建或续用一个普通会话。返修优先回到原来的会话。
- 需要拆开、跨步骤持续做、并且单独交付的任务走 **superagent**。桥用 `ticket_id` 和 `run_id` 跟踪这一次长程执行。

执行器说“做完了”，只表示任务进入 **待验收**。它不会自动变成交付完成，也不会自动合并、发布、扩大范围或追加预算。下一份任务书默认只起草，等人批准后再发送。

本仓库是独立的开源控制桥。Grok Bot 指负责人自己运行的协调代理，DeepSeek Harness 指执行环境。这里没有看板，也没有托管网关。

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

本地事件入口：

```bash
export DSH_BRIDGE_WEBHOOK_SECRET='choose-a-local-secret'
dsh-bridge --config examples/config.example.toml --data-dir /tmp/dsh-bridge-demo serve
```

另一个终端用同一份字节计算签名。这个密钥只存在于当前环境，不要写进仓库：

```bash
export DSH_BRIDGE_WEBHOOK_SECRET='choose-a-local-secret'
SIG=$(dsh-bridge sign < examples/event.stage_submitted.json)
curl -sS -X POST http://127.0.0.1:8787/v1/events \
  -H "Content-Type: application/json" \
  -H "X-DSH-Signature: $SIG" \
  --data-binary @examples/event.stage_submitted.json
```

样例事件里的 `instruction`、`approve` 和 `please_dispatch` 会被丢掉。没有对应任务时，事件进入收件箱，任务状态不会被改写。

## 配置

完整样例是 [`examples/config.example.toml`](examples/config.example.toml)。最小结构如下。

```toml
[bridge]
webhook_secret_env = "DSH_BRIDGE_WEBHOOK_SECRET"
allow_unsigned = false

[[instances]]
id = "local-desktop"
label = "本机 DeepSeek Harness Desktop"
kind = "desktop"
adapter = "fake"          # fake 或 harness
base_url = "http://127.0.0.1:9"
auth_env = "DSH_LOCAL_DESKTOP_TOKEN"

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

[[instances.workspaces]]
name = "broadcast-cs"
description = "另一套实例上的工作区"
```

约束：

- 实例 id、工作区名是小写 slug。工作区只在所属实例内唯一，不同实例可以同名。
- 两个实例不能共用同一个 `base_url`，也不能共用同一个 `auth_env`。
- 配置里不能出现 `token`、`secret`、`password` 或其他密钥字段，也不能写 `auto_send`。默认就是起草；发送是每一次单独的决定。
- `adapter = "fake"` 用于本地和 CI。`adapter = "harness"` 可以起草，但发送会被拒绝，直到有一份核对过的公开接口。见 [docs/local-harness.md](docs/local-harness.md)。

批准发送时另附 mandate，样例是 [`examples/mandate.example.toml`](examples/mandate.example.toml)。允许的动作只有 `dispatch` 和 `retry`。发布、合并、改验收、扩大范围、增加预算都不是这座桥能批准的动作。

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

协调代理可以读同一组工具描述：

```bash
dsh-bridge tools
```

描述文件也放在 [`docs/mcp-tools.json`](docs/mcp-tools.json)。这是工具清单，不是第二个会自动派工的运行时。

## 事件

`POST /v1/events` 要求头 `X-DSH-Signature: sha256=<hmac>`，密钥来自 `webhook_secret_env` 指向的环境变量。请求体上限 64 KiB。

只提取这些字段：`event_id`、`event_type`、`occurred_at`、`instance_id`、`workspace`、`executor`、`task_id`、`session_id`、`ticket_id`、`run_id`、`commit_sha`、`evidence`。其余内容不执行、不写入数据库、不写进摘要。证据引用必须是相对路径；桥不会按 payload 去打开文件。

`event_type` 可以是 `stage_submitted`、`error`、`awaiting_input`、`exited`、`started`、`cancel_ack`。重复的 `event_id` 记一次重复并保持原状态。签名错误不会占用这个 id。未登记的实例或工作区进入死信。

进程在“已批准但还没写回远程 id”时停掉的话，下次启动会按 `task_id` 续上。fake 适配器对同一个 `task_id` 返回同一组 id。mandate 过期之后不再续发。

## 安全

密钥只放在两处：环境变量，或 `~/.dsh-control-bridge/credentials.toml`。仓库里的 [`examples/credentials.example.toml`](examples/credentials.example.toml) 全是占位符。若 `DSH_CREDENTIALS_FILE` 指向当前 git 工作区里的文件，桥会拒绝读取。

更多约定见 [SECURITY.md](SECURITY.md)。封面图的用法见 [SOCIAL.md](SOCIAL.md)。

## 首版状态

这是 0.1.0，一个可测试的骨架，不是完整平台。

| 能力 | 状态 |
| --- | --- |
| 多实例、多工作区配置，以及无效配置的明确错误 | 已实现 |
| 签名校验、事件去重、不可信 payload | 已实现 |
| 任务状态机、SQLite、JSONL 审计、有限重试和死信 | 已实现 |
| 默认起草；mandate 仍有效才发送 | 已实现 |
| ordinary_session 与 superagent 分流 | 已实现 |
| 取消，以及远端未确认时的 `unconfirmed` | 已实现 |
| 进程中断后的 in-flight 恢复 | 已实现 |
| fake / dry-run 适配器，CI 不连接真实 Harness | 已实现 |
| CLI：`inbox`、`acknowledge`、`dispatch`、`status`、`cancel` | 已实现 |
| DeepSeek Harness 的真实创建、续跑和取消 | 探测项，适配器拒绝发送 |
| 看板、托管网关、A2A 协议、商业 Harness CI 插件 | 不在本仓库 |

真实下发还缺一份核对过的公开接口：如何打开或续上普通会话、如何创建 SuperAgent 的 ticket 与 run、如何取消、事件签名以哪份文档为准、证据文件从哪里读。在这之前，`harness` 适配器不会编造请求，也不会去调用未公开的面板接口。细节在 [docs/adapters.md](docs/adapters.md)。

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
