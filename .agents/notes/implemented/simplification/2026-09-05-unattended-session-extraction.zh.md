# Agent Note：从三个入口插件中提取无人值守 Session 开启事务

Status: implemented

[English](2026-09-05-unattended-session-extraction.md) | 中文

## Problem

Webhook 入口、cron 调度器与 Discord 网关各自手写了相同的根 Session 开启流程：解析权限预设、解析 Agent 预设、创建工作区、挂载预设并创建 Agent、附加、应用权限预设、设置标题，以及对失败落入的任何步骤执行回滚。这些副本已经在关键处发生漂移。只有 webhook 在创建前调用 `agentPresets.standingKeyFor()`，因此 cron 与 Discord 开启的 Session 跳过了自身预设声明的 standing instructions 预热。只有 webhook 把创建 `signal` 绑定进 `agents.create()` 并在步骤之间复查取消；cron 只在创建后检查一次，Discord 则完全没有传入信号。每份副本还各自携带一份 `sleep`、超时竞速与 `lastAssistantText`。

## Decision

**由一个库拥有开启流程。** 新包 `packages/session/unattended-session/` 导出 `openUnattendedSession(ctx, spec, signal)`：完整的有序事务，含 standing key、信号绑定、在 standing/workspace/create/attach 之后的取消检查，以及带报告的回滚（已附加时先分离，再处置，各自独立 `try`，警告以 `unattended session:` 为前缀）。spec 携带调用方选定的带品牌 `sessionId`、预设名、工作区路径、标题、解析后的 `agentOptions`，以及在预设挂载后组合的可选额外 `AgentSetup`——webhook 的创建时模型选择即经此固定。提示词准入刻意留在各入口：溯源（`webhook`/`cron`/`discord` source block）由入口拥有，纳入 helper 只会为无共享收益的事强制引入判别式 spec。

**回合辅助函数一并迁移。** `sleep(ms, signal)`、返回 `'idle' | 'timeout'` 的 `awaitTurn(agent, { timeoutMs, signal, wait? })`，以及 `lastAssistantText(events, firstSeq)` 取代三份本地副本；Discord 回发器保留其已解析的 `wait` 接缝。消费方保留各自的结果日志与处置簿记（cron 的在跑上限、网关的按频道映射），因为这些是入口策略而非开启机制。

## Alternatives considered

- **保留三份副本、修补漂移。** 已否决：审查发现每份副本都漏了同类项（standing key、信号绑定、取消检查），下次新增还会再漂；副本之间只差 spec 取值，而这正是参数化辅助函数该拥有的东西。
- **把提示词准入也拉进 helper。** 已否决：溯源块（`webhook`/`cron`/`discord`）由入口拥有且形态不同，共享准入需要为每个调用方准备一个判别联合——那是一层纯转发的壳。
- **把 helper 放进 `dsh-agent` 或 `dsh-workspace`。** 已否决：两者都不拥有预设、权限、工作区、标题与 Agent 创建的组合；`session/` 下的专用叶子包名如其职。

## Consequences

Cron 与 Discord 获得了此前缺失的 standing-key 预热与提前取消；被预先取消的调度器现在在创建工作区或 Agent 之前就判定该次触发失败，而不再是创建后再处置。Webhook 行为逐字节一致：其调用顺序测试原样通过，且准入失败的回滚（发生在开启成功之后）仍留在 `dsh-webhook` 内、沿用其 `webhook:` 警告前缀——共享 helper 永远看不到已准入的提示词。两个消费方的服务依赖 import 头已经相似到触发 jscpd 克隆门禁；cron 的 import 头带了一条窄范围 `jscpd:ignore`，因为共享逻辑就是该包本身，为躲开 token 阈值而重排 import 只会掩盖这面镜子。
