---
description: "Discord 入站对话：一个网关 websocket，把允许用户的私信变成持久化的 DSH 会话，支持恢复、斜杠命令、正在输入反馈与主动投递，供想在 Discord 里与 agent 协作的用户阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-discord-gateway

[English](README.md) | 中文

## 概述

本包让一个人从 Discord 与 DSH agent 对话。它维持一个 Gateway v10 websocket，用凭据引用解析出的 bot token 完成 identify，并读取 `MESSAGE_CREATE` 事件：来自 `allowedUserIds` 中用户的私信——或被点名回应、且在允许清单内的服务器频道发言——会在本机（Host）上开启一个会话，在配置的工作区挂载指定的 agent 预设与权限预设，把文本作为一条带 Discord 来源信息的普通用户消息交进去，再把 agent 的回答发回消息来源的频道。每个频道对应一段对话，其身份被持久记录，因此重启、空闲释放与提醒都延续同一个会话，并和其他所有会话一起出现在 Web UI 中。重连延迟按倍增直到上限；`enabled: false` 会挂载插件但不发起连接。

## 目录

- [对话行为](#conversation-behavior)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="conversation-behavior"></a>
## 对话行为

- **持久化对话。** 会话开启的那一刻，频道的会话 id、预设与工作区就写入一条 storage-domain 记录。重启或空闲释放（`idleReleaseMs`）之后，下一条消息会恢复该会话而不是从头开始；一旦静默超过 `conversationMaxAgeMs`，下一条消息会开启全新会话并替换记录。
- **消息合并。** 在 `inboundDebounceMs` 窗口内到达的消息合并成一轮，因此连发多条短消息的人只会得到一次回答；设为 `0` 则每条消息单独回答。
- **正在输入反馈。** 入站轮次运行期间，网关会持续重发 Discord 的正在输入提示（`typingIndicator`），直到回答发出。
- **服务器频道门槛。** 服务器频道必须出现在 `allowedChannelIds` 中；在 `guildRequireMention: true`（默认）下，只有提及 bot 或回复其消息的消息会被回应。允许用户的私信总是会被回应。
- **斜杠命令。** `/new` 释放当前对话，让下一条消息开启全新会话；`/status` 报告会话 id、预设、存活或已释放状态、以及是否有轮次在运行；`/stop` 取消正在运行的轮次。其他斜杠命令经普通命令注册表交给存活的 agent 执行（`/compact` 之类）；没有存活对话时收到的命令只给出指引，不会擅自开启会话。
- **主动投递。** 网关未发起的轮次——例如 `dsh-schedule` 提醒——会在 agent 转入空闲时把其最终 assistant 文本发到频道，于是承诺过的跟进能送达提出者。

<a id="model-experience"></a>
## 模型体验

### 入站消息

#### 模型看到什么

每条被准入的 Discord 消息都以一条用户角色（user-role）消息到达，正文即消息内容，长度受 `maxInputChars` 约束；被防抖窗口合并的消息以一条按换行拼接的消息到达。该消息带有由各界面渲染成提示的来源信息：发送者的 Discord 用户 id、频道 id、消息 id，以及写明频道的摘要。关于 Discord 的其他信息都不会进入模型——没有成员角色、没有附件元数据、也没有频道里的其他消息——因此 agent 只能从本包已追加的会话历史中了解该频道此前的内容。

#### Token 影响

每条被准入的入站消息对应一条用户消息（防抖合并计为一条）；当 agent 通过 `@deepseek-ai/dsh-tool-discord` 回答时，还会有回答的工具调用与结果消息。预设斜杠命令作为同一会话上普通的、有日志记录的命令轮次运行。对话历史像其他任何会话一样增长；日志已有的内容不会重发。

#### KV Cache 影响

入站消息追加到既有会话，因此较早的轮次保持可复用，只有新消息与其后的轮次构成新的后缀。某频道的第一条消息会创建会话，其预设组成构成初始前缀；重启或空闲释放后的恢复让该前缀保持温热，而不是在新会话上重建。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **服务器频道需要开发者后台的特权开关** —— 本包仅以 `GUILD_MESSAGES | DIRECT_MESSAGES` intent 完成 identify，因此在 Discord 开发者后台为该应用启用 Message Content intent 之前，服务器频道的消息正文到达时为空。私信不受此限制，正文完整到达。
- **一个 bot token 只能由一个 Host 使用** —— 用同一 token identify 的两个进程都会收到全部事件、也都会回复；网关只应在恰好一个进程中运行。
- **仅支持文本** —— 附件、embed、回复引用与表情回应都会被忽略，过长的入站文本在 `maxInputChars` 处截断，而不是拆成多轮。
- **Discord 中没有收到确认或失败通知** —— 正在输入提示覆盖运行中的轮次，但网关在消息到达时不发送确认，轮次超时或失败时也不发频道消息；这些结果只出现在 Host 日志里。
- **空闲时的命令回答没有日志** —— 在没有存活对话时回答的 `/new`、`/status`、`/stop` 直接由持久状态作答，没有 agent 记录它们，因此这些交互永远不会进入任何会话日志。
- **主动投递是尽力而为的文本** —— 若某个已收尾轮次的投递失败，该文本会被丢弃而不是重试，且只有最终 assistant 文本会外发；中间叙述留在会话内。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

`gateway.ts` 负责 websocket 生命周期（identify、heartbeat、resume、重连退避），通过 `onStatus` 报告状态，并把每次 `READY` 中 bot 自身的用户 id 交给路由器用于提及判断。`conversation.ts` 经由 `openUnattendedSession` 与 `resumeUnattendedSession` 负责会话的开启/恢复/释放、经由 tail promise 的按频道串行执行、防抖、投递，以及把已收尾的主动轮次送达频道的 `agent/status` 空闲监听器；`turn-stopping` 在最终 assistant 文本落日志之前触发，这正是投递改挂空闲转换的原因。斜杠命令绕过串行尾链，以便 `/stop` 能触达运行中的轮次；`commands.ts` 把 `/new`、`/status`、`/stop` 注册进每个会话 Agent 的作用域，没有存活 agent 时由路由器凭持久状态作答。`domain.ts` 声明 storage-domain 记录（`discord_gateway`）。出站帖子复用 `@deepseek-ai/dsh-tool-discord` 的 `sendDiscordMessage`，因此 2000 字符分条与提及改写只存在于一处。测试用假 socket、假 agent 与内存表驱动这两半；没有任何测试会真的连接 Discord。

</details>

**运行时不变量：** 不发布伴生包。websocket、定时器、按频道的会话与打开的 storage domain 都归属于该插件 fiber，停止时一并关闭；`tests/index.spec.ts` 覆盖连接、断开与拆除。
