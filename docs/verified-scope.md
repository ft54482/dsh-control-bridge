# 已经在一台 Windows Desktop 上看到的，和还没有看到的

这不是“这座桥完全操控 DeepSeek Harness”。下面只记录一次独立本机测试的匿名结果。文档里不写真实会话 id、标题、路径、密钥或业务名称。模型用 `example-provider` / `example-model` 代替当时读到的具体标识。

## 0.1.5 上已经发生的一次往返

环境是 Windows Desktop 0.2.2-rc.5，Host 插件 0.1.5。对象是一条已经授权的既有对话。安装用的是官方 `dsh plugin` CLI。

- `health`、`granted`、`history` 成功。
- 模型读自会话日志（`session_log`），不是部署默认值。`next` 的 provider/model 与操作者预期一致，`availability.available` 为 true。
- `agent_available` 为 false，`can_set` 为 false，原因是 `agent_not_attached`。因此没有调用模型设置，resume 请求里也没有带 model。
- 一次 resume，没有重发。HTTP 200，约 4.7 秒。`accepted`、`completed` 为 true，`terminal` 与 `final.reason.kind` 都是 `completed`，回答文本是 `2`。
- `execution_model_source` 为 `request_header`。请求、确认和实际执行的 provider/model 一致，`model_match` 为 true。回合序号增加。
- 仍是原来的 session 和 cwd。历史条数从 83 增到 95，旧事件身份还在。
- 5 个正式工作区的登记和 session id 列表前后逐项相同。没有已清理的测试工作区回流，也没有子会话被提成根会话。

## 还不能写成已经验证

- `POST /v1/model` 在冷会话上的 `needs_ui`
- 操作者同时在界面里改模型
- 取消或超时之后的完整生命周期
- 跨工作区、多实例的实际工程闭环
- headless 真实 `dsh.cmd` 计费调用
- SuperAgent 派工绑定

仓库里的 Node 和 Python 测试是模拟。模拟通过不等于上面这台 Desktop 已经复测了新提交。

## 安装锁

仓库里没有名为 `install-0.1.4` 或 `install-0.1.5` 的脚本。若本机另有一份未入库脚本把任何 `DeepSeek Harness.exe` 都当成 Desktop，那份脚本不在此树里，这次不能假装已经改掉它。

仓库内的判断在 `dsh_control_bridge.desktop_install`。`DeepSeek Harness.exe --profile superagent --no-open` 不阻断安装。没有 `--profile` 的外壳、`--profile desktop` 的 Host，以及读不到命令行的同名进程，仍然阻断。脚本不结束任何进程。退出仍只能用托盘 **Quit DeepSeek Harness**。
