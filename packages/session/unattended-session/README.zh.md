---
description: "面向无人值守入口的共享开启与等待机制，供接入 webhook、cron 或 Discord 入口或排查半开启 Session 的维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-unattended-session

[English](README.md) | 中文

## 概述

`dsh-unattended-session` 通过单一事务，从没有人在前等待的入口开启一个根 Agent Session：解析权限预设、解析 Agent 预设并取其 standing key、创建工作区、在绑定调用方取消信号的条件下创建 Agent 并挂载预设、附加、应用权限预设、设置标题——并对失败或取消落入的任何步骤执行回滚。它是普通库而非 Cordis 插件：webhook 入口、cron 调度器与 Discord 网关以各自的 Session id 前缀、标题、模型选项与额外 setup 调用 `openUnattendedSession()`，因此解析顺序、取消检查与回滚不会在它们之间漂移。提示词准入留给各调用方，因为每个入口的溯源不同。回合边界辅助函数（`awaitTurn`、`sleep`、`lastAssistantText`）为每次回合等待设界，而无需手工重新竞速。事务约定在前；内部细节放在下方可折叠的开发者章节中。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

作为入口作者，先构造 spec，经由辅助函数开启，然后准入你自己的提示词。作为部署方，本包无需任何配置；每个可调项都在消费插件自己的配置中。

### 开启一个 Session

`openUnattendedSession(ctx, spec, signal)` 接受一个 `UnattendedSessionSpec`：由调用方选定的带品牌 `sessionId`、`agentPreset`、`permissionPreset`、绝对 `workspacePath`、`title`、`agentOptions`（provider、model、可选 `maxTokens`），以及在预设挂载后于 Agent 作用域内组合的可选 `setup`——webhook 用它固定创建时的模型选择。它返回 `sessionId`、`AgentHandle` 与已附加的 `Workspace`，调用方保留后者以便后续分离或处置。Agent 创建之前的失败或取消不留任何残留；之后的失败会处置该 Agent，若附加已成功则先分离。

### 等待一个回合

`awaitTurn(agent, { timeoutMs, signal, wait? })` 让 Agent 的 idle promise 与时间界限竞速，报告 `'idle'` 或 `'timeout'`；被拒绝的等待接缝或被拒绝的 idle promise 同样报告 `'timeout'`。`sleep(ms, signal)` 是默认延迟接缝。`lastAssistantText(events, firstSeq)` 返回在 `firstSeq` 之后（含）提交的最后一条非空 assistant 文本，即无人值守调用方回发或记录的内容。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本节解释该事务；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 设计理念

由一处拥有开启序列，使三个入口插件不会漂移。下列顺序与回滚即每个消费测试钉住的约定：解析权限预设、解析 Agent 预设、取 standing key、取消检查、创建工作区、取消检查、创建 Agent（`setup` 内挂载预设、绑定信号）、取消检查、附加、取消检查、应用权限预设、设置标题。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/open.ts`](src/open.ts) | Spec 与结果类型、开启事务与带报告的回滚 |
| [`src/turn.ts`](src/turn.ts) | `sleep`、有界的 `awaitTurn` 竞速与 `lastAssistantText` |

### 回滚约定

创建之后区域内的失败按此顺序先分离（仅在已附加时）再处置；每个回滚步骤运行在自己的 `try` 中，回滚失败经 `ctx.logger.warn` 以 `unattended session:` 前缀报告，同时原始错误照常传播。调用方的 `signal` 既绑定进 Agent 创建，又在步骤之间复查，因此被取消的调度器或监听器绝不会留下一个已挂载、运行中的 Session。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当开启事务本身不够用时阅读这些页面。它们从消费方走向该事务驱动的各个服务。

- [Webhook 入口](../../webhook/webhook/README.zh.md) —— 每个经过验证的投递开启一个 Session 并准入自己的提示词。
- [Cron 调度器](../../cron/cron/README.zh.md) —— 每次任务触发在回合界限内开启一个 Session。
- [Discord 网关](../../discord/discord-gateway/README.zh.md) —— 每个会话频道开启一个 Session。
- [Agent 预设](../../preset/agent-presets/README.zh.md) —— 事务最先执行的解析、standing key 与挂载。
- [工作区注册表](../../workspace/workspace/README.zh.md) —— 工作区创建与 Session 附加。

-----

<a id="model-experience"></a>
## 模型体验

### 被开启 Session 的请求

#### 模型看到什么

没有直接内容。本包不发起任何模型请求、不写入任何会话事件；被开启的 Session 经 `ctx.agents.create()` 记录其常规事件，各入口用 `followup()` 准入提示词，落为携带该入口溯源的 `user/message`。回滚失败只进入 `ctx.logger.warn`，绝不进入 Session 日志或模型表面。

#### Token 影响

自身不消耗 token；被开启的 Session 只在入口准入的提示词下消耗 token。

#### KV Cache 影响

无。既不使主请求缓存失效，也不自带请求封装。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义了被接受的开启事务形态。它们是当前包的约束。

- **仅报告的回滚** —— 失败的分离或处置只会被警告，不重试也不升级；原始失败原样传播。
- **无持久的开启记录** —— 半开启的尝试只留下运行时警告；Session 日志从 Agent 创建开始，不携带任何自身事务状态。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。辅助函数在两次开启之间不持有任何状态；顺序、回滚与取消由其自身测试演练，并被三个消费插件的调用顺序测试钉住。
