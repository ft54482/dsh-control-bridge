# 在 Python 协调桥中登记多个实例

这份示例供使用 `dsh-bridge` CLI 或 MCP 的操作者演练实例路由。两个目标都使用 fake；可在没有 Harness 的机器上验证同名工作区如何分别授权。要连接已有 Desktop 会话或独立 CLI 进程，请按目标选择[执行适配器](adapters.md)。Codex skill 直接连接 Desktop 的步骤见 [Windows 使用指南](windows-delivery.md#codex-desktop-setup)。

## 本机实例

1. 复制 [`examples/config.example.toml`](../examples/config.example.toml) 为你自己的 `bridge.toml`。这个文件可以进仓库的只有占位版本；带真实地址的那份不要提交。
2. 保留 `local-desktop`，`kind = "desktop"`，`adapter = "fake"`。
3. 在 fake 示例中，`instances.workspaces.name` 填允许派工的工作区别名，例如 `broadcast-cs`。真实适配器还会在独立字段中绑定本机工作目录。
4. `auth_env` 填变量名，例如 `DSH_LOCAL_DESKTOP_TOKEN`。值放到 shell 环境，或放到仓库外面的私有文件。
5. 运行：

```bash
dsh-bridge --config bridge.toml --data-dir ./data check
python examples/e2e_fake.py
```

`check` 会列出实例、工作区、适配器和凭证变量是否已设置。它只读本地配置。示例脚本用自己的隔离配置演示两套 fake 实例，执行结果与真实 Harness 连通性独立。

## 再加一套实例

第二套 Harness 是另一个 `[[instances]]` 表，而不是给第一套多写一个工作区。

- 使用不同的 `id`，例如 `lab-server`
- `kind` 设为 `remote`
- `base_url` 不能和本机实例相同
- `auth_env`、`event_secret_env` 分别使用该实例独有的变量名，例如 `DSH_LAB_SERVER_TOKEN`、`DSH_LAB_SERVER_EVENT_SECRET`
- 工作区列表只包含这套实例上允许的名字。同名工作区不会自动打通

派工时必须同时给出 instance 和 workspace：

```bash
dsh-bridge --config bridge.toml dispatch \
  --instance lab-server \
  --workspace broadcast-cs \
  --executor superagent \
  --title "长程示例" \
  --objective "需要拆分并单独交付的步骤。"
```

这条命令只起草。发送还要：

```bash
dsh-bridge --config bridge.toml dispatch \
  --task TASK_ID \
  --mode send \
  --mandate /path/to/mandate.toml
```

在仓库外复制[授权文件样例](../examples/mandate.example.toml)，把 `instance_id`、`workspace`、`executor` 改成上面任务的 `lab-server`、`broadcast-cs`、`superagent`，并填写该任务的范围、额度与到期时间。这里只会得到 fake 适配器生成的标识。要跟踪正式 Assignment，参见 [SuperAgent 指南](../skills/deepseek-harness-bridge/references/superagent.md)。

## 不要把秘密提交到 Git

- 仓库只保留 `*.example.toml`，其中的 secret 是 `replace-with-token` 这一类占位符。
- 私有文件放在 `~/.dsh-control-bridge/credentials.toml`。需要换路径时设置 `DSH_CREDENTIALS_FILE`。路径若落在当前 git 工作区里，读取会被拒绝。
- 用于签发入站事件的密钥放在对应实例的 `event_secret_env` 所指定的环境变量中。
- `data/`、`*.sqlite` 和 `audit.jsonl` 已在 `.gitignore` 中。审计里也不应出现 payload 原文。
- 提交前看一眼 `git status`。配置加载会拒绝出现在项目文件里的 `token`、`secret`、`password` 字段，但这个检查代替不了你自己看 diff。
