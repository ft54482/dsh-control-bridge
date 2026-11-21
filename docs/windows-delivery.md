# 四个阶段

这些阶段按顺序进行。缺凭证不是代码已经结束，也还没有进入真实计费。这一包只补 Windows 假进程自检，不配置真实凭证，也不做 SuperAgent 绑定。

1. **放置桥。** 把 zip 解压到一个新建的空目录。不运行 pip，不创建虚拟环境，不把文件写进 `%LOCALAPPDATA%`。包只用 Python 标准库。默认 `spawn = false`。包内没有密钥，也不复制桌面凭证。
2. **假进程自检。** 在解压目录执行下面的命令，`-PythonExe` 指向捆绑的 Python 3.12，或任何 3.11 及以上的 `python.exe`。这只改当前进程的 `PYTHONPATH`，不改用户或系统 PATH。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\Test-FakeDsh.ps1 -PythonExe D:\Python312\python.exe
```

`Install-DshBridge.ps1` 要求同时给出 `-Destination` 和 `-PythonExe`。`-Destination` 必须就是这次解压目录，否则脚本直接退出，不复制文件。

3. **凭证配置。** 还没做。以后由操作者把 `DEEPSEEK_API_KEY` 放进环境。值不进入仓库，也不从桌面登录状态复制。
4. **真实计费 smoke。** 还没做。当前包不会发模型请求，也不会启动真实 `dsh.cmd`。

普通短任务仍使用桥自己的 headless profile 和一个新建空目录。不复用 desktop，不接管已有业务会话。

## 自检必须怎样读

业务成功只有一条：退出码 0，并且 `final.reason.kind` 是 `completed`。报告里的 `check_ok=true` 只表示这项检查符合预期。

| 检查 | fake 模式 | 预期 |
| --- | --- | --- |
| success | success | `business_accepted=true` |
| nofinal | nofinal | 拒绝，`missing final event`，不是业务成功 |
| badexit | badexit | 拒绝，退出码不是 0，不是业务成功 |
| timeout | hang | 拒绝，`no accepted final`，测试进程和它的子进程已退出 |
| cancel | tree | 主动取消已确认，父子进程已退出，不是业务成功 |
| malicious | 不启动 | 恶意 session 和路径在启动前拒绝，哨兵文件不出现 |

超时和取消只把 `taskkill /F /T` 用在本次测试创建的 pid 上。pid 小于等于 4 不会发信号。退出确认比较的是该 pid 的创建时间：创建时间还在，才是同一个进程；创建时间变了或进程已经不在，就不再对这个号码发信号。

`8594a02` 那一包在用户机上只跑了前三项，`Test-FakeDsh.ps1` 退出码 0。那里的 ok 没有把 nofinal 和 badexit 写成拒绝。hang 和 tree 没有跑，所以那一次不能算 Windows 安全启动已经验收。

## 本环境没有做的 Windows 实测

开发环境是 Linux。这里跑过的是判定、PID 过滤和“恶意参数不启动进程”。下面这些仍然要等用户机重跑，不能写成已经通过：

- `fake-dsh.cmd` 本身，包括带空格的路径。
- success / nofinal / badexit 在新报告里的拒绝措辞。
- hang 的超时，以及 tree 的主动取消。
- `taskkill /F /T` 是否真的结束了测试自己创建的父子进程。
- `-PythonExe` 指向捆绑 Python 3.12 时，脚本是否没有改持久 PATH。
- 安装脚本在 Destination 不是解压目录时是否拒绝，并且没有访问 pip。
