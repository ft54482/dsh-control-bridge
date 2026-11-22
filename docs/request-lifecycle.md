# 请求生命周期（Host 0.1.6）

官方 Desktop 0.2.2 的 `sessionController.cancel` 只接受 `{ sessionId }`，返回 `{ accepted: true }`。这只表示取消请求被这个会话的活动回合收下，不点名 `requestId`，也不表示回合已经结束。`prompt` 把 `requestId` 写进 `user/message` 的 `source.rpcId`。终态只认其后的 `turn/end`。

0.1.5 的 `POST /v1/cancel` 只中止桥自己的等待。0.1.6 把这件事改名为 `POST /v1/wait/stop`，`scope` 是 `bridge_wait`。它不调用官方 cancel，也不把桌面回合写成已取消。

## 状态

`recorded`：已经落盘，还不能证明官方已经收下。`accepted`：官方 `prompt` 返回了 `{ accepted: true }`，或日志里已经有本请求的 `rpcId`。`terminal`：官方 `turn/end` 已经读回，或官方明确拒绝了这次 prompt。`unknown`：崩溃窗口里对不上 `rpcId`，需要人工核对。

`completed: true` 只在官方原因是 `completed` 时出现。`bridge_timeout` 的 `terminal_scope` 是 `bridge_wait`，`model_timeout` 是 false。客户端断开或等待超时不是模型超时。

取消请求被收下（`cancel_accepted`）和官方终态是两件事。已经结束的回合保持原终态，不会被改写成 cancelled。

## 接口

`POST /v1/resume` 仍是受理并收集。相同 `request_id`、相同会话和相同内容返回同一条记录，不第二次 `prompt`。相同 id 但会话或内容不同，返回 `409 idempotency_conflict`。

`GET /v1/requests?request_id=&session_id=` 只读。授权撤销后返回 403，不读出结果。它可以用日志里的 `rpcId` 把断线后的终态补齐。

`POST /v1/cancel` 需要写授权。只有日志能证明当前未结束的回合属于这个 `request_id` 时，才调用 `sessionController.cancel({ sessionId })`。对不上、已经结束、或没有 cancel 方法时失败关闭，`desktop_cancel_called` 为 false。不结束进程，不取消别的客户端或界面上的回合。

## 存储

记录写在 allowlist 旁边的 `requests.json`。先写记录，再 `prompt`。写入失败则内存不改，并且不发送。文件损坏则插件不监听。文件可以含有脱敏后的回答，只留在本机，不进日志，不进发布包。这里不存密钥。

落盘和官方 `prompt` 之间仍有崩溃窗口。重启只按已经看见的 `rpcId` 对账；对不上就停在 `unknown`，不自动重发。这不是跨进程的 exactly-once。

## 升级、回滚和真机步骤

升级仍要先用托盘退出 Desktop。没有外部退出命令，也不要结束进程。然后：

```text
dsh plugin --profile desktop add dsh-control-bridge-host-0.1.6.tgz
```

回滚：再次托盘退出，`dsh plugin --profile desktop remove dsh-control-bridge-host`，需要时换回已经在本机验证过的 0.1.5 包。不要用旧的 profile 备份覆盖后来的修改。`requests.json` 可以留下；它不是会话历史。

0.1.6 还没有在真机上验证。若要在已经授权的演示会话上试，请求要短，不调用工具，不写文件，不碰业务会话，也不要强行结束进程。先看 `GET /v1/requests` 能不能在断开后读回终态，再单独试一次属于本桥的取消，并核对官方 `turn/end`。模拟测试不能代替这一步。
