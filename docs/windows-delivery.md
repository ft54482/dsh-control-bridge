# 四个阶段

这些阶段按顺序进行。缺凭证不是代码已经结束，也还没有进入真实计费。

1. **安装桥。** 只安装这个源码包和它声明的 Python 标准库依赖。默认 `spawn = false`，包内没有密钥，也没有业务目录。
2. **假进程自检。** 在 Windows 上运行 `scripts/windows/Test-FakeDsh.ps1`。它调用包内的 `fake-dsh.cmd`，不调用模型。本开发环境是 Linux，没有执行这个 `.cmd`。
3. **凭证配置。** 操作者以后把官方 headless 变量名 `DEEPSEEK_API_KEY` 设进环境。`DEEPSEEK_BASE_URL` 可选。值不进入仓库，也不从桌面登录状态复制。
4. **真实计费 smoke。** 只在假进程自检通过，并且负责人明确要求之后才进行。当前包不会发模型请求。

普通短任务使用桥自己的 headless profile 和一个新建空目录。不复用 desktop，不接管已有业务会话。长任务仍不自动派发。

## 本环境没有做的 Windows 实测

- 没有 `cmd.exe`，没有运行 `fake-dsh.cmd` 或真实 `dsh.cmd`。
- 没有执行 `taskkill /F /T`。Windows 取消整棵进程树依赖这条已公开的系统命令；这里只在 Linux 上用进程组验证了同样的“杀掉子进程并确认退出”结构。
- 带空格路径和恶意参数的检查，是对照 CPython `list2cmdline` 和 cmd 元字符规则做的，不是在 Windows 上启动批次文件。
- Python 文档写明：即使 `shell=False`，操作系统仍可能用 shell 启动 `.cmd`，并且此时 Python 不会补上 cmd 转义。因此任务正文只走 stdin，带 `% & | < > ^ !` 的路径或 session id 会在组命令行之前被拒绝。
