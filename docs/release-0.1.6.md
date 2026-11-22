# Host 0.1.6 交付与证据（Stage A / Stage B）

本文记录 0.1.6 这一线的交付物、每类证据的边界，以及仍未真机验证的部分。证据分四层，**不能互相代替**：官方源码复核、进程内隔离回归、脚本回归、真机。这里没有真机结果。

## 交付

- Host 包：`dist/dsh-control-bridge-host-0.1.6.tgz`。运行时文件、`cordis.patch.yml`、README；不含测试和本机状态。
- 便携源码包：`dist/dsh-control-bridge-0.1.6-portable.zip`；两个产物的 SHA-256 与字节数在 `dist/MANIFEST.json` 与同名 `.sha256` 文件里，由 `scripts/build_release.py` 解包逐文件比对生成。
- 版本保持 0.1.6；没有改全局默认模型，没有调用 `sessionController.selectModel`，没有安装到真机 Desktop，没有 push/merge。

## Stage A：请求生命周期

- 官方契约复核：[official-host-contract.md](official-host-contract.md)。对象是安装包里的 `@deepseek-ai/dsh-api-session-controller@0.2.2-rc.5` 等官方包源码，记录 prompt / cancel / list / state·wait / sessionQuery / 六个服务 / 访问控制的事实与锚点，并标出夹具没有覆盖的部分。它是源码审阅，不是真机。
- 隔离回归：`plugins/dsh-control-bridge-host/test/lifecycle.test.js`。覆盖请求记录、断开客户端后的 `GET /v1/requests` 补读、owned-turn 官方取消、`POST /v1/wait/stop`、幂等（同 id 同内容 / 同 id 异内容 / 并发）、`unknown` 不重发、请求记录写失败不发送、非 live 会话取消拒绝、排队 prompt 不算自有回合。
- 本轮修正：请求记录改为与 allowlist 同级持久写（临时文件 + fsync + rename）；取消调用前重新读日志判归属，非 live 会话返回 `409 agent_not_attached`；模型 pending 退场规则按官方折叠（匹配路由且匹配 reasoning effort 的 header 才退掉）；显式 reasoning effort 不再被静默丢弃；重复请求在模型 gate 之前用账本判冲突，不再改会话模型；在途请求不再按 `request_id` 跨会话共享；排队中的 prompt 不判为自有回合。

## Stage B：配对窗口重新布防与授权热更新

- 同一进程、不重启的证据：`plugins/dsh-control-bridge-host/test/rearm.test.js`。每个用例用真实文件窗口驱动同一个 `createHostServer()` 实例，改文件前后都由同一进程响应：
  - 运行中重新布防后配对成功；旧授权保留；`host.secret` 未变；
  - 已消费窗口的重放返回 `403 bootstrap_consumed`（文件只留 SHA-256）；
  - 一个窗口在并发配对中只成功一次；
  - 过期、剩余寿命超过 60 分钟、JSON 损坏、两个窗口文件互相矛盾都失败关闭；修好后下一次请求自动恢复；
  - `bootstrap.json` 写失败时，已花费窗口的哈希已随授权原子写进 `allowlist.json`，同一窗口不能产生第二条授权；
  - 授权写盘失败不改变内存、不丢已有授权、窗口仍可重试；
  - 外部改写 `allowlist.json`（升权、撤销）下一个请求立即生效；
  - 重新布防不会写 `host.secret` 或 `allowlist.json`。
- 操作脚本：`scripts/windows/Rearm-DesktopHostBootstrap.ps1` 只写 `bootstrap.secret` 与 `bootstrap.json`，运行前后校验 `host.secret`、`allowlist.json` 哈希未变，拒绝 1–60 分钟之外或缺失前置文件的调用。`Prepare-DesktopHost.ps1` 改为保留已有 host secret，并用临时文件 + rename 写窗口。
- 配对客户端：`pair_desktop.py` 打印服务端返回的 `granted` 项，而不是 allowlist 第一行。
- 其它加固：`/v1/health` 与 `/v1/guard/membership` 只接受长期 host secret，配对窗口只能到两条 bootstrap 路由；配对请求体在配对锁之外读取并限制 16 KiB，慢客户端不能长期占住配对；allowlist 的外部变更检测从 mtime/size 改为内容哈希；`requests.json` 写入改为临时文件 + fsync + rename。

## 证据分级

| 证据 | 结果 | 能证明什么 |
| --- | --- | --- |
| 官方源码复核 | [official-host-contract.md](official-host-contract.md) | 只证明对照关系中“官方源码确实如此”的部分；不证明真机行为 |
| Node 隔离回归（4 个测试文件） | 78 passed，0 failed | 同一进程内的接口行为、失败关闭、文件原子性和竞态路径 |
| 脚本回归 `tests/test_rearm_bootstrap.py` | 6 passed | 重新布防脚本只动窗口文件、不改长期 secret/授权；配对输出指向真正写入的授权 |
| Python 桥回归（本机 Windows） | 71 passed，3 skipped，11 failed | 失败项都是测试自身的 POSIX 假设：无盘符的绝对路径写进 TOML、`os.killpg`、依赖 `node` 在 PATH。CI 矩阵是 `ubuntu-latest`，同一套用例在那里运行；这不是 0.1.6 主机插件代码的失败 |
| 真机 Desktop | 未运行 | 没有安装 0.1.6、没有真机配对、没有真机取消、没有发送 prompt |

## 仍未验证 / 已知边界

- 真机安装、真机重新配对、真机取消后的 `turn/end` 到达时间与原因、真实 `SessionSummary.projections` 键集合、轮询真实成本：都没有真机结果。
- 官方 cancel 没有 compare-and-cancel；桥在调用前重新判归属，检查与调用之间仍有极窄窗口。排队中的 prompt 不判为自有回合。
- 官方 `session/state` 的 `wait` 可以把轮询换成语义不同的等待（`input-required`、`idle`、newest-first 输出）。0.1.6 没有改用它，仍按 `observeSession`/`readSession` 收集。
- `requests.json` 目前没有容量或保留期上限；每次更新重写整个文件（重新布防脚本不碰它）。这是已知的可运维性边界，不是本轮改动。
- 重新布防脚本与 Host 的写窗口没有跨进程锁；Host 侧用文件戳 + compare-and-swap 把并发重布防变成失败关闭，但不提供事务级保证。
- 外部工具若只改 `bootstrap.json` 而不清空旧的 `bootstrap.secret`，窗口会因两个副本不一致而失败关闭；脚本会同时写两份。
- 本机 Windows 上 Python 测试的 11 个失败来自测试夹具的平台假设，未在本轮改写。
