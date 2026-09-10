---
description: "面向模型的 Discord 投递，直接走 REST API：一个绑定频道的发送工具，带分条、限流等待与广播提及改写，供把 agent 输出接入 Discord 频道的用户阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-discord

[English](README.md) | 中文

## 概述

本包给 agent 写入 Discord 的唯一途径：`discord_send` 工具把消息发到配置中指定的频道；当 `dmUserIds` 列出了用户 id 时，也可以发给该用户的私信会话。它直接调用 Discord REST API——不用 SDK、不建立网关连接、不缓存 Discord 状态——并在发送时通过凭据引用解析 bot token。超过 Discord 2000 字符上限的正文会拆成连续多条消息；HTTP 429 响应会在配置的上限内等待；`@everyone` 和 `@here` 会在发送前改写。传输层禁用所有提及类型，包括用户和角色通知。把它与凭据提供方一起挂载；该插件不注册其他东西。

回复保留 Discord 原生的标题、强调、列表、链接和代码。Markdown 表格转换为带标签的项目符号分组。较长的围栏代码块在跨消息切分时保留语言、缩进和原始换行；每条消息都会闭合围栏，并将围栏计入 2000 个 UTF-16 代码单元的上限。

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
- **较长回复使用多条帖子** —— 普通文本在段落、行或词边界切分；过长的代码行可能在词内切分。配置的分条上限会在任何内容发出前拒绝过长的回复。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

网关复用本包的 Markdown 格式化器、分条器和 REST 传输。类型化消息正文支持嵌入卡片、按钮和字符串选择器；消息发送和编辑始终禁用提及。共享请求辅助函数支持 bot 鉴权和交互 token 端点，拒绝重定向，将响应限制在 2 MiB 内，并从传输错误中省略带有凭据的 URL 和原因链。`postDiscordMessageBody` 对已格式化的消息应用发送器的有界限速重试和单次尝试超时，并返回已接受的响应。其他 REST 调用方负责响应状态处理和重试时机。

</details>

**运行时不变量：** 不发布伴生包。本包通过自身 fiber 注册一个工具，且不持有进程级全局状态；每次挂载的注册由其归属测试覆盖。
