# 权限与授权：安装前先读

这套桥让一个 Agent（Codex、ZCode，或你自己的程序）替你操作 DeepSeek Harness：读会话历史、往会话里发任务、新建会话、在 GitHub 的 Issue 上派工单。**它刚装好时什么都不能做，每一样能力都要你本人放行。** 这是设计如此，不是装错了。

- 自己安装：先看[要由你亲自决定的几件事](#what-you-decide)，再照 [Windows 安装与使用](windows-delivery.md) 做。
- 让 Agent 代为安装：把[给负责安装的 Agent](#for-the-installing-agent)那一节的链接交给它。也可以直接对它说：「配对和改 Host 配置之前先问我，把要改的那一行给我看，我说同意再改。」

## 第一次安装先知道三件事

1. **授权只能由人给。** 配对一个会话、放开新建会话、把你的工作区加进 Host 的名单、把账号加进 SuperAgent 的发件名单，每一项都是把权限交给桥，以及通过它发任务的 Agent。代为安装的 Agent 不应该自作主张，要先把要改的那一行给你看，等你明确说同意。
2. **改 Host 的配置会让 Harness Desktop 自动重启**，里面正在跑的任务会被打断。
3. **派工是对外的动作。** SuperAgent 工单是用你的 GitHub 账号在 Issue 下发评论发出去的，看得到那个仓库的人都看得到。Desktop 会话拿着那个工作区的权限干活，任务书里的「禁止」只是约定，不是隔离。

<a id="why-it-still-refuses"></a>

## 装好了为什么还是被拒绝

Host 默认全部关闭，没放行就拒绝。每一种拒绝对应一件要由你决定的事：

| 你看到的 | 缺的是什么 | 谁来定 |
| --- | --- | --- |
| `health` 连不上 | Desktop 没开、Host 插件没装，或者还没有任何授权。授权名单是空的、配对窗口也没开的时候，Host 不监听 | 你：装好 Host，完成第一次配对 |
| HTTP 403 `session_not_allowlisted` | 这个会话没有授权。读历史要 `read`，发任务要 `write` | 你：配对这个会话 |
| HTTP 403 `read_only` | 会话只授权了 `read` | 你：把它改成 `write` |
| HTTP 403 `create_session_disabled`、`no_allowed_roots` | Host 没有开新建会话，或者没有给出允许的根目录 | 你：在 Host 配置里打开，并指定根目录 |
| HTTP 403 `workspace_not_allowlisted` | 这个工作区里还没有任何已授权的会话 | 你：先在里面配对一个会话 |
| HTTP 403 `outside_allowed_roots` | 工作区不在 `workspaceRoots` 之内，编号也没有列进 `presetSessionWorkspaceIds` | 你：把那个工作区的确切编号加进名单 |
| HTTP 403 `workspace_write_not_granted` | 要新建可写的会话，但这个工作区里还没有 `write` 授权的会话 | 你：先配对一个 `write` 的会话 |
| HTTP 409 `model_unknown`、`needs_ui`、`agent_not_attached` | 这个会话没选过模型，也没有在线的 Agent。桥不替这种会话选模型 | 你：在 Desktop 里打开它、选好模型；或者新建带预设的主控会话 |
| `precheck` 的 `actor_authorized` 没通过 | 发件账号不在这个 SuperAgent 实例的允许名单里 | 你：实例自己的配置 |

这些拒绝都发生在动作之前，没有提示词发出去。

<a id="what-you-decide"></a>

## 要由你亲自决定的几件事

按安装的先后排列。建议只放行眼前要用的那一个会话、那一个工作区。

| 你的决定 | 放开了什么 | 怎么收回 |
| --- | --- | --- |
| 配对一个会话，选 `read` 或 `write` | `read`：桥能读这个会话的历史。`write`：还能发任务、换模型、取消自己发起的请求 | Host 的 `POST /v1/revoke`，这是唯一的移除路径。它只读过源码和文档，还没有实际撤销过 |
| 在 Host 配置里打开 `allowCreateSession`，并给出 `workspaceRoots` | 桥能在这些根目录下的工作区里新建会话。路径按真实路径校验，越不出根目录 | 从配置里删掉 |
| 把一个工作区的编号加进 `presetSessionWorkspaceIds` | 桥能在这个工作区里新建带预设的会话，哪怕它在 `workspaceRoots` 之外。只此一项，不放开别的工作区，也不放开文件操作 | 从那一行里删掉这个编号 |
| 把你的 GitHub 账号列进 SuperAgent 实例的发件名单 | 这个账号在指定仓库的 Issue 里 `@` 智能体的评论会触发派工 | 实例自己的配置 |
| 安装 `master-control` 预设包 | 预设决定执行方的人设和工具权限，新建的主控会话都带着它 | 只装你自己信任的包 |

另外两样东西要保管好：

- **长期凭据 `host.secret`。** 拿到这个文件的程序，能做 Host 已经授权的全部事情，还能列出这个 Desktop profile 里所有工作区和会话的名称、目录和状态。历史正文仍然要逐个会话授权。重开配对窗口、再配对，都不会换掉它。不要外传，不要贴进聊天记录、仓库或工单。
- **`connection.json`。** 它只放凭据文件的路径、端口和实例对照，只留在本机，不进任何仓库。

<a id="another-workspace"></a>

## 要在另一个工作区里用

别的项目、别的 Agent 要在自己的工作区里通过桥新建会话，同样要走这几步，而且都由你本人决定：

1. 在那个工作区里配对一个空闲会话。要派工就选 `write`。
2. 工作区不在 `workspaceRoots` 之内的，把它的确切编号加进 `presetSessionWorkspaceIds`。工作区编号可以用技能的 `discover` 按目录查到。不要为了省事把整个磁盘设成 `workspaceRoots`。
3. 配置文件一改，Desktop 会自动重启，新配置随之生效，不用再手动重启。见下一节。

配对的做法见 [Windows 安装与使用](windows-delivery.md#codex-desktop-setup)。

<a id="config-restarts-desktop"></a>

## 改 Host 配置会让 Desktop 重启

Host 的配置在 Desktop profile 的 `cordis.patch.yml` 里。**这个文件一改，Desktop 会自动重启。** 重启会打断 Desktop 里正在跑的任务，所以改之前先确认没有任务在跑，或者等它们结束。

这一条来自 2026-11-25 在一台 Windows 电脑上的两次观察：Desktop 0.2.3-alpha.2，改完 8 到 20 秒后重启。没有做受控实验。

<a id="for-the-installing-agent"></a>

## 给负责安装的 Agent

你是代为安装和操作的一方。放行的是用户，不是你。

1. **先问，再改。** 配对、改 Host 配置（`presetSessionWorkspaceIds`、`workspaceRoots`、`allowCreateSession` 等）、改任何允许名单之前，把要改的那一行原文、它放开什么、有什么副作用告诉用户，等用户针对**这一项**明确说同意。「先做通」「你看着办」都不算同意。问的时候照这个写：「要让桥在〈工作区目录〉里新建会话，需要把这一行改成：〈原文〉。它放开的是只在这个工作区里新建带预设的会话。改完 Desktop 会自动重启。可以改吗？」
2. **被拒绝就停。** 403、409、预检不过，都是阻塞，原样报给用户：工作区、错误码、要改的那一行。不要为了让它通过而放宽 `workspaceRoots`、改允许名单、换 `gh` 的登录账号，或者用 `--skip-precheck`。
3. **改 `cordis.patch.yml` 之前，确认 Desktop 里没有任务在跑。** 只改那一行，改完把动过的行报给用户。不要拿旧的整份备份去覆盖用户后来的修改。
4. **往 GitHub 写，只在用户要这件活做的时候。** `send --yes` 里的 `--yes` 代表的是用户的同意。`prepare` 只在本机写计划，不碰 GitHub。
5. **凭据不打印、不复制、不写进文件**，也不写进任何公开产物。`connection.json`、会话编号、任务书也一样。
6. **工单结束后，不在同一个 Issue 下留评论。** 发件账号的后续评论会被引擎当成新的任务，并改写工单的结果。这是 2026-11-24 在一个实例上实测到的。验收结论写到别处。

用户拒绝或者没有回答时，保持原样，把阻塞报出来。上面的拒绝都发生在动作之前，停下来没有代价。

<a id="where-this-comes-from"></a>

## 依据

- Host 的端点、配置项和拒绝码：[Host HTTP API](host-api.md)
- 授权的写入、配对窗口和撤销：[插件说明](../plugins/dsh-control-bridge-host/README.md#authorization)
- 安装与配对的步骤：[Windows 安装与使用](windows-delivery.md)
- 哪些在真机上看到过、哪些只读过源码：[Windows 真机验收](verified-scope.md)
- 协调桥自己的安全边界，也就是事件签名、mandate、配置里不许有密钥：[安全说明](../SECURITY.md)
