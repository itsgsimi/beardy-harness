# Agent Note: 带 Discord 投递的本机（Host）级 cron 任务

Status: implemented

[English](2026-09-05-host-cron-with-discord-delivery.md) | 中文

## 问题

有些 agent 工作没有可供栖身的会话。汇总信息源与天气的晨报，或每晚的仓库检查，必须在一个真实时钟时刻运行，此时没有人到场、没有打开的会话（Session）、也没有正在进行、可以把它挂上去的模型轮次。已发布的调度器 `@deepseek-ai/dsh-schedule` 并不覆盖这种情况：它的 after、at 与 fixed-rate 规则是 agent 作用域的，并持久化在某个会话的事件日志之上，因此一条规则需要一个已经在运行的所属 Agent。主干（spine）里没有任何东西能按时间表启动工作，也没有任何东西能把结果送到一个人真正会看的地方。

## 决定

三个包，各自负责一件事。

`@deepseek-ai/dsh-cron`（`packages/cron/cron/`）通过 croner 挂载在配置中声明的任务，cron 表达式的解析、时区与夏令时算术都由 croner 负责。`assertConfig` 会在加载时拒绝重复的任务名、无法解析的表达式或时区、相对的工作区路径、以及非正数的边界值，因此一个永远跑不起来的任务会让启动失败，而不是在早上七点静默失败。每次触发都按其他所有入口相同的顺序开启一个全新会话——解析 agent 预设、解析权限预设、注册工作区、`agents.create`、attach、应用权限、命名——并把任务提示词作为一条用户消息交进去，其来源是 `{ kind: 'cron', jobName, scheduledFor }`。若下一次触发到来时上一次运行仍在进行，则记为跳过；`turnTimeoutMs` 限定一次回答的上限；`maxLiveRuns` 释放最旧的已挂载会话。本包报告结果（`answered`、`no-text-answer`、`timed-out`、`failed`），自身不做投递。

`@deepseek-ai/dsh-tool-discord`（`packages/discord/tool-discord/`）给模型一条唯一的写入路径：`discord_send` 把消息发到配置中指定的频道，超过 Discord 2000 字符上限的正文拆成连续多条消息，在设定的上限内等待 HTTP 429，并在发送前改写 `@everyone`、`@here` 与角色提及。bot token 在调用时通过凭据引用解析，因此组合（composition）文件里不会出现 token。它直接说 Discord REST——不用 SDK、不建立网关连接、不缓存 Discord 状态——这让依赖面停留在每次投递一个 HTTP 调用。

`@deepseek-ai/dsh-discord-gateway`（`packages/discord/discord-gateway/`）为想在 Discord 里工作的人把环路闭合：一个 Gateway v10 websocket 读取 `MESSAGE_CREATE`，来自允许清单用户的私信会开启一个会话，在固定工作区挂载配置好的预设组合，并把回答发回消息来源的频道。一个频道对应一个会话，因此后续消息延续同一段对话，并和其他所有会话一起可见于 Web UI。

`beardy` 组合包（bundle）把三者接在一起：当 `DISCORD_BOT_TOKEN` 能解析时挂载 `discord_send` 与网关，并由一个任务在本机时区的 07:00 发出晨报。任务、信息源与目的地都留在配置里，因此改一份 profile patch 就能修改，无需改代码。

## 考虑过的替代方案

曾否决 `discord.js` 或其他平台 SDK：这一集成只需要一个完成 identify 并读取单一事件类型的 websocket，外加每次投递一个 POST。SDK 会带来对象缓存、intent 编排，以及一套为构建 bot 应用而生的依赖树——而这里每一样都需要额外的失效推理。原始协议由 Discord 做版本管理且足够小，可以自行持有；其 opcode 与上限都是带测试的具名常量。

手写 cron 解析被否决，改用 croner：它负责表达式解析、IANA 时区与夏令时算术——一个维护中的依赖，既省掉代码，也省掉手写解析器本需要的日期边界测试（参见仓库关于「优先使用维护中的依赖」的策略）。本包只在其外保留一层薄薄的 `Scheduler` 接缝（seam），以便测试能在不等待真实时钟的情况下挂载任务。

把任务变成运行时可编辑的持久状态是推迟而非否决：既定的未来界面——由人或 agent 创建与暂停排程，并有 Client 视图——需要其自身的持久化与标识决定，先交付配置能让第一个任务保持可靠。至于扩展 `dsh-schedule`，则被否决：它的规则是 agent 作用域的、建立在单个会话事件日志之上；一个不属于任何 Agent 的本机任务在那里没有可栖身的记录。

带跨重启重试的投递队列目前被否决：它会引入本改动并不需要的持久状态、投递标识与去重问题。无法完成的发送会让其工具调用显式失败，而该次运行的结果会记录下来。

## 后果

一次定时运行就是一个普通会话：它出现在会话搜索中，其日志可重建每一次工具调用，而 `discord_send` 的结果像其他任何工具结果一样对模型可见并被记录。为无人值守的上下文组装、权限、命名都不必再发明新东西。

投递是调用那一刻的尽力而为。用尽重试次数的发送会使工具调用失败且不入队；Discord 宕机期间的运行会失去那条消息。要加持久性就需要一个自带重试标识的投递存储，这有意不属于本次改动。

任务状态只有配置——没有 Service 方法也没有面向模型的工具能在运行时创建、修改、暂停或删除任务。既定的未来状态（由人或 agent 管理排程，并有相应的 Client 界面）需要一个持久的本机级任务存储及其自身的持久化决定；`dsh-schedule` 的会话事件机制无法延伸到没有任何 Agent 所属的任务，因此那是一项独立能力，而不是本能力上的一个开关。

频道到会话的连续性被持久记录，因此重启后每个 Discord 频道会在其原有会话上继续（[决定](2026-09-05-discord-durable-conversations.zh.md)）。在开发者后台为该应用启用 Message Content intent 之前，服务器频道送达的消息正文为空；私信不需要它即可完整送达。恰好只能有一个进程用该 bot token identify，否则每条入站消息都会被回复两次。
