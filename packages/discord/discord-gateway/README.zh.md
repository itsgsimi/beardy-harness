---
description: "Discord 入站对话：一个网关 websocket，把允许用户的私信变成 DSH 会话，并把每个回答发回消息来源的频道，供想在 Discord 里与 agent 协作的用户阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-discord-gateway

[English](README.md) | 中文

## 概述

本包让一个人从 Discord 与 DSH agent 对话。它维持一个 Gateway v10 websocket，用凭据引用解析出的 bot token 完成 identify，并读取 `MESSAGE_CREATE` 事件：来自 `allowedUserIds` 中用户的私信——或允许清单内服务器频道的发言——会在本机（Host）上开启一个会话，在配置的工作区挂载指定的 agent 预设与权限预设，把文本作为一条带 Discord 来源信息的普通用户消息交进去，再把 agent 的回答发回消息来源的频道。每个频道对应一个会话，因此后续消息延续同一段对话，并和其他所有会话一起出现在 Web UI 中。重连延迟按倍增直到上限；`enabled: false` 会挂载插件但不发起连接。

## 目录

- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="model-experience"></a>
## 模型体验

### 入站消息

#### 模型看到什么

每条入站 Discord 消息都以一条用户角色（user-role）消息到达，正文即消息内容，长度受 `maxInputChars` 约束。该消息带有由各界面渲染成提示的来源信息：发送者的 Discord 用户 id、频道 id、消息 id，以及写明频道的摘要。关于 Discord 的其他信息都不会进入模型——没有成员角色、没有附件元数据、也没有频道里的其他消息——因此 agent 只能从本包已追加的会话历史中了解该频道此前的内容。

#### Token 影响

每条入站 Discord 消息对应一条用户消息；当 agent 通过 `@deepseek-ai/dsh-tool-discord` 回答时，还会有回答的工具调用与结果消息。对话历史像其他任何会话一样增长；日志已有的内容不会重发。

#### KV Cache 影响

入站消息追加到既有会话，因此较早的轮次保持可复用，只有新消息与其后的轮次构成新的后缀。某频道的第一条消息会创建会话，其预设组成构成初始前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **服务器频道需要开发者后台的特权开关** —— 本包仅以 `GUILD_MESSAGES | DIRECT_MESSAGES` intent 完成 identify，因此在 Discord 开发者后台为该应用启用 Message Content intent 之前，服务器频道的消息正文到达时为空。私信不受此限制，正文完整到达。
- **对话连续性只存在于进程内** —— 频道到会话的映射保存在内存中，因此重启后每个频道会从一个新会话开始，而不是继续上一个。
- **一个 bot token 只能由一个 Host 使用** —— 用同一 token identify 的两个进程都会收到全部事件、也都会回复；网关只应在恰好一个进程中运行。
- **仅支持文本** —— 附件、embed、回复引用与表情回应都会被忽略，过长的入站文本在 `maxInputChars` 处截断，而不是拆成多轮。
- **Discord 中没有进度反馈** —— 一轮运行时本包不发任何东西：没有正在输入提示、没有收到确认，轮次超时或失败时也没有消息。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

`gateway.ts` 负责 websocket 生命周期（identify、heartbeat、resume、重连退避），并通过 `onStatus` 报告状态；`conversation.ts` 负责会话创建、经由 tail promise 的按频道串行执行、以及投递。出站帖子复用 `@deepseek-ai/dsh-tool-discord` 的 `sendDiscordMessage`，因此 2000 字符分条与提及改写只存在于一处。测试用假 socket 与假 agent 驱动这两半；没有任何测试会真的连接 Discord。

</details>

**运行时不变量：** 不发布伴生包。websocket、定时器与按频道的会话都归属于该插件 fiber，停止时一并关闭；`tests/index.spec.ts` 覆盖连接、断开与拆除。
