# Agent Note：带恢复、命令与主动投递的持久化 Discord 对话

Status: implemented

[English](2026-09-05-discord-durable-conversations.md) | 中文

## Problem

Discord 网关能回答消息，但进程一停就把一切忘了：频道到会话的映射保存在内存里，重启会让每个人不知不觉地从零开始，而任何承诺过的跟进也随做出承诺的那一轮一起消失。一个人连发几条短消息会得到逐条回答，因为每条都自成一轮。无法从 Discord 本身重置或查看一段对话，轮次运行时也没有反馈（一分钟的沉默会被当成 bot 坏了），而服务器频道只要向所有者以外开放，里面的每一条帖子都会开始干活。

## Decision

每频道一条持久记录，加上建立其上的四种行为。`domain.ts` 声明一个 storage-domain 表（`discord_gateway`，带版本号的 zod 行），把频道 id 映射到会话 id、agent 预设、工作区路径与开启/最近入站时间戳；路由器在会话开启时写入，并在每次消息到达时盖时间戳。下一条消息到来时，路由器经由 `@deepseek-ai/dsh-unattended-session` 中新增的 `resumeUnattendedSession` 助手恢复该会话——即去掉命名的开启事务——并把 `SessionPersistenceNotFoundError` 当作"日志已不存在"处理：告警、丢弃记录、重新开始。`idleReleaseMs` 在静默后释放存活的 Agent 句柄但保留记录（便于日后廉价恢复），`conversationMaxAgeMs` 过期让下一条消息替换会话，而在 `inboundDebounceMs` 窗口内的入站消息按换行合并成一轮（`0` 表示关闭）。

反馈与控制依托三个更小的接缝。入站轮次运行期间，网关每八秒重发一次 Discord 的正在输入端点（`typingIndicator`，经由 `@deepseek-ai/dsh-tool-discord` 新增的 `postTyping` 导出送达）。每次 `READY` 分发都把 bot 自身的用户 id 交给路由器；在 `guildRequireMention: true` 下，服务器帖子只有提及该 id 或回复 bot 的消息才被准入，私信依旧无条件回应。`/new`、`/status`、`/stop` 由 `commands.ts` 注册进每个会话 Agent 的作用域（于是预设命令随普通注册表机制一起挂载），并经 `ctx.commands.execute` 执行；它们绕过按频道的串行尾链，以便 `/stop` 能触达运行中的轮次；没有存活 agent 时，路由器凭持久状态作答，而不是擅自开启会话。主动投递——用 `dsh-schedule` 创建的提醒，`beardy-discord` 预设现已挂载它——会在对话空闲时为任何已收尾的轮次发出其最终 assistant 文本：监听器挂靠在 `agent/status` 的空闲转换上，因为 `turn-stopping` 在最终文本进入日志之前触发；每会话一个序号下限确保路由器等待的回复与主动扫描不会重复发帖。

## Alternatives considered

把频道映射存进会话元数据或专门服务被否决：`dsh-storage-domain` 是经认可的带版本号、zod 校验行的 KV 接缝，不需要新的 Service Definition，其生命周期（apply 时打开、stop 时关闭）与插件吻合。

在网关内部复制开启事务来实现恢复被否决，因为权限解析、预设挂载、工作区 attach、回滚与 permission-set 这些步骤正是 `openUnattendedSession` 的全部内容；第二份副本会在第一次修复时漂移。助手与姊妹函数并排住在共享包里，命名被省去，因为恢复的会话保留其原标题。

把主动投递挂在 `turn-stopping` 上在实测后被否决：该事件在最终 assistant 文本进入日志之前触发，会发出上一轮文本。空闲转换能看到已提交的文本，还覆盖由挂载在 agent 上的任何其他东西发起的轮次；入站轮次则由路由器本就持有的忙碌标志排除。

把防抖消息合并为一条用户消息胜过排成多个独立轮次：一轮对应一次思考爆发，符合人们的书写方式，让回复成比例，也避免与仍在输入的作者交错作答。提及门槛选择允许回复（而非仅限提及），因为在服务器讨论串里，回复 bot 的某条消息是最自然的延续手势。

## Consequences

网关现在注入 `commands` 与 `storageDomain`；挂载它的每个组成都必须提供两者，基础 bundle 已经如此。记录在 `/new` 与过期时被删除，但在轮次超时后保留，于是下一条消息仍恢复同一历史。已把服务器频道列入允许清单的现有部署会看到行为变化：默认要求提及，`guildRequireMention: false` 可恢复逢帖必答。每个活跃频道在其轮次运行期间每八秒多花一次 Discord API 调用，一旦提示端点失败或凭据消失即被放弃。跨重启的恢复让会话的 prompt 前缀保持完整，相比旧的"每次重启新会话"更利于 KV cache。空闲时对 `/new`、`/status`、`/stop` 的回答永不进入任何会话日志，因为不存在能记录它们的 agent；这个缺口写进了包 README，而不是用合成事件去伪造。
