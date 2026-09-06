# Agent Note：经表情回应与回复作答的 Discord 审批与提问回答器

Status: implemented

[English](2026-09-05-discord-approval-answerers.md) | 中文

## Problem

当某个工具需要许可、或 agent 向用户提出问题时，从 Discord 工作的 agent 就会彻底停住：这两者都挂在 waterfall（`approval/request`、`user-questions/request`）上，而唯一被组装的回答器渲染的是 Web UI，Discord 频道里的人永远看不到那张卡片。轮次把待决的工具调用一直挂到超时，而人——手里正拿着这段对话所在的那台设备——却没有任何作答途径。一个无法请求许可的网关，就只能以 `danger-full-access` 运行，而这正是本部署拒绝的搭配。

## Decision

路由器把自己组装成这两条 waterfall 上的第二个监听器，把每个请求变成频道里的一条提示、配两种作答形式。审批方面，它发出 "Approval needed — tool: reason"，写明表情（✅ 本次放行、❌ 拒绝）与文本词（`yes` / `no`），然后等待；表情回应只有来自允许清单中的用户、且指向提示帖子返回的消息 id 时才敲定结果，文本行只在恰好是 `yes`/`no` 时才敲定。提问方面，它一次只发一个问题——标题、详情、编号选项，以及写明有效作答形式的提示语——并把每条回答行对照该问题解析（多选为 `1,3`，无选项时为自由文本），遇到无法解析的回复就让请求继续等待，而不是猜。待决条目存放在按频道的映射里，先于命令与防抖路径被查问，因此作答永远不会开启一轮；`answerers`（`reaction`、`text` 的子集）决定哪些形式有效，`approvalTimeoutMs` / `questionTimeoutMs` 让等待过期并在频道发出通知，`/stop` 敲定在等待的请求，同一频道上较新的请求会取消较旧的。审批结果直接映射到契约（`allowed-once` / `rejected`，所有未作答路径都是 `cancelled`）；问题以 `UserQuestionError` 的 `ASK_TIMEOUT`、`ASK_ABORTED` 或 `ASK_UNAVAILABLE` 码拒绝。经 Discord 传输发出提示是路由器的一个 seam，因此测试从不真的外呼；投递失败时审批答 `unavailable`——如实上报，绝不静默拒绝。

## Alternatives considered

轮询 Session 里的待决审批并渲染合成卡片，被否决：这两个能力已经发布了 waterfall 回答点，正是为替代界面而设计，组装一个监听器是该 seam 的预期用法，而不是绕开它。

用带回复线程的消息按消息 id 作答，被否决：服务器频道线程需要本包不持有的特权 intent；表情回应与普通文本行在两条消息 intent 加两条非特权的表情回应 intent 下就能工作，本包现在正是以这些 intent 完成 identify。

先到先得（把审批排在等待中的提示后面）被否决，改选后到者胜：agent 在第一条提示仍等待时撞上第二个受控工具，说明它已经往前走，否则那条过时的提示会把频道扣在一个没人再想要的决定上。取消是可见的，因为较旧的条目会通过契约以 `cancelled` 敲定。

接受任何消息上的任何表情来敲定审批，被否决：在共享的服务器频道里表情回应随处可见，所以在一枚表情成为许可授予之前，作者允许清单与提示消息的精确匹配都是必需的。

## Consequences

路由器现在只为自己的 agent 监听 `approval/request` 与 `user-questions/request`——其他一切经 `next()` 原样委托——并以两个额外的 Discord intent（`GUILD_MESSAGE_REACTIONS`、`DM_MESSAGE_REACTIONS`）完成 identify，它们无需后台开关。把 `answerers: [reaction]` 设为唯一的部署仍能回答审批，却无法回答问题，因为选项编号是从文本解析的；README 写明了这一点。对存在待决请求的频道，文本回答会吞掉匹配的那一行：提示在等待时把 `yes` 当闲聊打字的人实际上就投了票，这是不强制在提示中途使用命令前缀的可接受代价。每个等待中的请求都会把工具调用一直挂着，直到被回答、过期、停止或被取代；监听器拆除时会敲定所有等待，因此没有 fiber 会比插件活得更久。表情匹配依赖发消息的响应带上其 id；当它没带时，该审批降级为仅文本可答，而不是全局拒绝表情。
