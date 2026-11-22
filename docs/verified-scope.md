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

## 0.1.6 的请求生命周期与配对窗口：只有夹具证据

这一节的结论不来自真机，不能并进上面那次 0.1.5 往返。

- 阶段 A：请求记录（`requests.json`）、`GET /v1/requests` 断线后补读终态、owned-turn 取消、`POST /v1/wait/stop`、幂等冲突、`unknown` 不重发，由 `plugins/dsh-control-bridge-host/test/lifecycle.test.js` 的进程内回归覆盖；官方 0.2.2-rc.5 源码核对写在 [official-host-contract.md](official-host-contract.md)。
- 阶段 B：同一台运行中的 Host，在不重启进程的情况下重新布防 `bootstrap.json` / `bootstrap.secret`、单次使用、并发配对只成功一次、过期/超长/损坏 JSON 失败关闭、授权写盘失败不作废窗口、外部改写 `allowlist.json` 立即生效，由 `test/rearm.test.js` 覆盖；`tests/test_rearm_bootstrap.py` 只验证重新布防脚本不改长期 host secret 和授权文件。主机夹具模拟了官方 controller 的 `prompt` / `cancel` / `list` 形状，但它不是那台 Desktop。
- `health` 的 `bootstrap_armed` 等字段、`agent_not_attached` 取消拒绝、取消回执与官方 `turn/end` 分开，也只在夹具里看过。

这些都不能写成 0.1.6 已经在真机上通过。真机安装、真机取消、真机重新配对仍未做；见 [request-lifecycle.md](request-lifecycle.md) 的升级和回滚步骤，以及 [release-0.1.6.md](release-0.1.6.md) 的证据分级。

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
