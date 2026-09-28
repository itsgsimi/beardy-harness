# Agent Note: 经带传输标签的投递目标发送 Signal 通知

Status: implemented

[English](2026-09-28-signal-notices.md) | 中文

## 问题

Goran 希望 Beardy 的摄像头警报及其画面、探测健康状态转换和定时报告发到比 Discord 更私密的地方，并选择了 Signal 群组。每个通知生产方都保存裸 Discord 频道 id，用各自的 snowflake 模式校验，再交给只有 Discord 网关应答的串行事件，因此第二种传输方式无处接入。

## 决策

目标字符串现在标明传输方式。`@deepseek-ai/dsh-delivery-target` 是 `util/` 下的库，它把裸的或带 `discord:` 前缀的 17 到 20 位频道 id 解析为 Discord，把 id 为恰好 32 字节规范标准 base64 的 `signal:group:<id>` 解析为 Signal 群组，把 `signal:number:<E.164>` 解析为单个账户。它位于 Signal 包之外，使 health、cron、camera-watch 和 fantasy-reports 无需依赖消息能力即可校验目标。这些生产方用 `assertDeliveryTarget` 取代各自的 snowflake 检查，其错误信息指出字段和所有可接受形式；cron 还在审批之前检查配置的任务和工具参数 `deliver_channel`，而先前保存的任务保留原目标。在 `camera/notice`、`health/transition` 和 `cron/run-finished` 上，Discord 网关对非 Discord 目标返回 `undefined`，使下一个串行监听器可以认领；投递到 Signal 的 cron 运行不会得到 Discord 审批提示。`cronDeliveryContent` 从网关移到 `dsh-cron`，使两种传输方式发布相同文本。

Signal 是由三个包组成的接缝。`@deepseek-ai/dsh-signal` 定义 `ctx.signal`：`send` 在消息以投递 id 存储后返回，`health`，以及用于收到数据消息的并行事件 `signal/message`。`@deepseek-ai/dsh-signal-cli` 针对回环地址上的 signal-cli 0.14.8 守护进程实现它：经 `POST /api/v1/rpc` 的 JSON-RPC `send`、存活检查，以及 `/api/v1/events` 的 Server-Sent Events 流，后者用 `eventsource-parser` 解析，并在进程边界用 zod 校验。其发件箱沿用 Discord 网关的存储域形式（先持久化后发送、按目标排序、片段游标、倍增重试、有界回执），并在永久 JSON-RPC 错误或达到 `outboxMaxAttempts` 后放弃投递，否则错误的群组 id 会永远阻塞该目标。守护进程以 `-a <number>` 运行，因此配置文件无需 `account`；提供方记录来自 `listAccounts` 且仅保留末两位的账户，并遮蔽守护进程错误中引用的号码。`@deepseek-ai/dsh-signal-notices` 是独立的使用方，使提供方不依赖任何生产方包，今后的提供方也能复用它。

## 考虑过的替代方案

**保留裸 id，并为每个生产方增加 `transport` 字段。** 四个生产方和已保存的 cron 记录都需要第二个字段和迁移；一个带标签的字符串让现有值继续有效。

**把目标解析器放在 Signal 定义中。** 生产方会依赖一个它们并不使用的消息能力。

**在一个 JSON-RPC 批量请求中发送投递的所有片段。** 守护进程处理批量成员的顺序没有文档说明，部分失败还需要逐成员的检查点；单个请求让片段游标保持精确。

**像 Discord 发件箱一样永远重试永久错误。** 配置错误的群组会阻塞之后发往它的所有通知。

## 后果

收到的消息会被发布，但没有使用方应答；与 Beardy 的群聊需要先从 Discord 网关中提取与传输无关的对话核心。只有 `**bold**` 变为 Signal 文本样式；定时运行文本中的其他 Markdown 按原样到达。与 Discord 一样，投递至少一次。在校验之前被接受、目标无法解析的已保存 cron 任务不再被 Discord 网关认领，会停留在 cron 的交接中等待。测试在临时回环端口上运行假守护进程，从不连接 signal-cli 或 Signal。
