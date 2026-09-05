---
description: "面向模型的 Discord 投递，直接走 REST API：一个绑定频道的发送工具，带分条、限流等待与广播提及改写，供把 agent 输出接入 Discord 频道的用户阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-discord

[English](README.md) | 中文

## 概述

本包给 agent 写入 Discord 的唯一途径：`discord_send` 工具把消息发到配置中指定的频道；当 `dmUserIds` 列出了用户 id 时，也可以发给该用户的私信会话。它直接调用 Discord REST API——不用 SDK、不建立网关连接、不缓存 Discord 状态——并在发送时通过凭据引用解析 bot token。超过 Discord 2000 字符上限的正文会拆成连续多条消息；HTTP 429 响应会在配置的上限内等待；正文中的 `@everyone`、`@here` 与角色提及在发送前会被改写，因此 agent 无法向整个服务器广播。把它与凭据提供方一起挂载；该插件不注册其他东西。

## 目录

- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

模型看到生成的 [`discord_send` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-discord)：必填的 `content` 字符串，以及只有在 `dmUserIds` 非空时才出现的 `recipient` 用户 id 参数。工具描述会写明目标频道 id，并说明无法选择其他频道。返回结果报告消息落在哪个频道、用了几条消息、字符数，以及改写了多少处广播提及。

#### Token 影响

在该工具可见的每次请求中产生固定的 schema 成本。每次调用向日志会话添加一条工具调用与一条工具结果消息；投递正文作为参数在日志中只出现一次。

#### KV Cache 影响

在工具定义与可见性不变时前缀稳定。被遮蔽、配置改动增删 `recipient`、或插件生命周期变化，都可能使从该 schema 起的缓存复用失效。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **一次挂载只有一个目的地** —— 频道来自配置，因此要发往多个频道就需要每个频道一行配置；模型无法选择配置未指明的目的地。
- **投递是调用时刻尽力而为** —— 用尽重试次数的发送会使工具调用失败，且不会入队稍后重投；Discord 持续不可用时没有任何机制重新投递。
- **不读取入站消息** —— 读取 Discord 需要 `@deepseek-ai/dsh-discord-gateway`；本包只负责写入。
- **分条在词边界切分** —— 超过 2000 字符的正文会变成多条消息，Discord 把它们渲染为独立帖子，而不是一条 embed 或一个线程。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

`DISCORD_MAX_CONTENT_CHARS`、`chunkContent`、`postChannelMessage`、`openDirectMessageChannel`、`sendDiscordMessage` 与 `defangBroadcastMentions` 都是导出的，以便网关与测试复用同一条投递路径。transport 是构造函数参数，测试据此断言请求体与限流处理，而不需要真实网络。

</details>

**运行时不变量：** 不发布伴生包。本包通过自身 fiber 注册一个工具，且不持有进程级全局状态；每次挂载的注册由其归属测试覆盖。
