---
description: "Signal 服务定义：发往群组或账户的持久外发消息、提供方健康状态，以及收到的数据消息。"
kind: "package-reference"
---

# @deepseek-ai/dsh-signal

[English](README.md) | 中文

## 概述

用 `ctx.signal` 向 Signal 群组或账户发送消息（可附一张已存储的图片），并以 `signal/message` 接收其他账户的消息。`send` 在提供方持久保存消息后返回，因此调用方用同一投递 id 重试时不会重复入队。本包还为 Signal 群组 id、电话号码、服务 id 和投递 id 提供品牌类型。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

挂载 [signal-cli](../signal-cli/README.zh.md) 等提供方，然后调用 `ctx.signal.send({ id, target, text, image })`。`target` 为 `{ transport: 'signal', kind: 'group', groupId }` 或 `{ transport: 'signal', kind: 'number', number }`；[delivery-target](../../util/delivery-target/README.zh.md) 的 `signalTargetOf` 解析生产方保存的 `signal:group:<id>` 与 `signal:number:<E.164>` 字符串。结果为 `{ id, state }`：新 id 的 `state` 为 `queued`，提供方已接受过的 id 为 `duplicate`。`text` 中成对的 `**bold**` 标记变为粗体，其他 Markdown 保持原样。`health()` 立即检查传输层，报告是否可达、已知时仅保留末两位的账户号码，以及待投递数量。

监听 `signal/message` 以处理收到的消息。每个载荷包含发送方共享的号码、服务 id 或资料名、群消息的群组 id、文本、发送方时间戳和附件元数据；不下载附件内容。监听器应把工作排队后立即返回，因为提供方在处理下一条消息前会等待所有监听器，并记录失败的监听器而不重试。

| Export | Role |
|---|---|
| `SignalService` | 抽象 `ctx.signal` 服务；`send`、`health` 和受保护的 `publishMessage` |
| `SignalGroupId`, `SignalNumber` | 校验 32 字节 base64 群组 id 和 E.164 号码的构造函数 |
| `SignalServiceId`, `SignalDeliveryId` | 校验 UUID 服务 id 和至多 200 个可打印字符投递 id 的构造函数 |
| `SignalSendRequest`, `SignalDeliveryResult`, `SignalHealth`, `SignalInboundMessage` | 请求、结果和事件类型 |

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

抽象服务拥有 `ctx.signal` 键和受保护的 `publishMessage`，后者并行运行每个 `signal/message` 监听器并记录每次失败。`SignalGroupId` 与 `SignalNumber` 是 [delivery-target](../../util/delivery-target/README.zh.md) 的品牌类型；目标解析归该库所有，因此生产方无需依赖本能力即可校验 Signal 目标。定义自身不保存状态，因此不发布不变量配套模块。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Signal 子系统](../../../docs/subsystems/signal.zh.md) — 投递目标、发件箱和收到的消息。
- [Signal 通知](../signal-notices/README.zh.md) — 投递摄像头、健康和定时运行通知的使用方。

-----

<a id="model-experience"></a>
## 模型体验

### Signal 服务

#### 模型看到的内容

本定义不注册工具、模式或提示词；本版本中 `signal/message` 载荷不会到达任何模型。

#### Token 影响

本定义不增加模型 token。

#### KV Cache 影响

本定义不影响请求缓存。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 目前没有使用方把 `signal/message` 变成对话；与智能体的群聊需要先有与传输无关的对话核心。
- 一条消息最多携带一张图片。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
