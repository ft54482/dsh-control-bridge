# 接入实例

先用 fake 跑通，再考虑真实 Harness。真实发送今天还是探测项，见 [adapters.md](adapters.md)。

## 本机实例

1. 复制 [`examples/config.example.toml`](../examples/config.example.toml) 为你自己的 `bridge.toml`。这个文件可以进仓库的只有占位版本；带真实地址的那份不要提交。
2. 保留 `local-desktop`，`kind = "desktop"`，`adapter = "fake"`。
3. 工作区只写你允许派工的名字，例如 `broadcast-cs`。不要写本机绝对路径，也不要写客户系统的内部名称。
4. `auth_env` 填变量名，例如 `DSH_LOCAL_DESKTOP_TOKEN`。值放到 shell 环境，或放到仓库外面的私有文件。
5. 运行：

```bash
dsh-bridge --config bridge.toml --data-dir ./data check
python examples/e2e_fake.py
```

`check` 会列出实例、工作区、适配器是否可以发送，以及凭证环境变量是“已设置”还是“未设置”。它不打印变量的值。

## 再加一套实例

第二套 Harness 是另一个 `[[instances]]` 表，而不是给第一套多写一个工作区。

- 使用不同的 `id`，例如 `lab-server`
- `kind` 设为 `remote`
- `base_url` 不能和本机实例相同
- `auth_env` 使用另一变量，例如 `DSH_LAB_SERVER_TOKEN`
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

`mandate.toml` 放在仓库外，或先从 [`examples/mandate.example.toml`](../examples/mandate.example.toml) 复制后再改到期时间。

## 不要把秘密提交到 Git

- 仓库只保留 `*.example.toml`，其中的 secret 是 `replace-with-token` 这一类占位符。
- 私有文件放在 `~/.dsh-control-bridge/credentials.toml`。需要换路径时设置 `DSH_CREDENTIALS_FILE`。路径若落在当前 git 工作区里，读取会被拒绝。
- Webhook 共享密钥只放在 `DSH_BRIDGE_WEBHOOK_SECRET`，或你在配置里另起的变量名。
- `data/`、`*.sqlite` 和 `audit.jsonl` 已在 `.gitignore` 中。审计里也不应出现 payload 原文。
- 提交前看一眼 `git status`。配置加载会拒绝出现在项目文件里的 `token`、`secret`、`password` 字段，但这个检查代替不了你自己看 diff。
