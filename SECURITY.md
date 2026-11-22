# Security

## 报告问题

如果问题涉及未公开的漏洞，请使用 GitHub Security Advisories，不要把密钥、客户数据或内部地址写进公开 issue。

## 这个版本的边界

- Webhook 正文按不可信数据处理。签名失败则不入库，因此不会被用来占掉一个 `event_id`。
- 入库内容只有允许的字段和 body 的 SHA-256。不保存原文，不执行正文里的句子，不按 payload 打开路径。
- 派工目标必须是配置中的实例和工作区，按完整名字匹配，没有前缀匹配。
- 发送需要未过期的 mandate，并且 `allowed_actions` 含有 `dispatch`。配置不能打开自动发送。
- 执行器自报完成只进入待验收。验收是 `accept`。已读是 `acknowledge`。
- 取消会请求适配器。适配器没有确认、调用失败，或远端取消仍是探测项时，本地记为 `canceled`，`cancel_confirmation` 为 `unconfirmed`。
- 项目配置拒绝内联密钥字段。私有凭证文件若位于 git 工作区内则拒绝读取。`check` 只报告是否已配置。
- `harness` 适配器不会为了“先跑起来”去请求未文档化的接口。

## 不在本版本里

本桥不代替 Harness 的账号权限，也不计量厂商额度。`budget_cap` 是 mandate 里的声明。共享密钥泄露等于对方可以向收件箱注入事件；请把它当成密钥轮换，而不是把正文里的批准当成真的。
