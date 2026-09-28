---
description: "供通知生产方和网关使用的投递目标语法：Discord 频道 id 以及 Signal 群组或号码目标。"
kind: "package-library"
---

# dsh-delivery-target

[English](README.md) | 中文

## 概述

用一种语法描述通知的去向。生产方保存目标字符串，并在加载时用 `assertDeliveryTarget` 校验；每个投递方只用 `discordChannelOf` 或 `signalTargetOf` 认领自己传输方式的目标，因此 Discord 网关与 Signal 使用方不会争抢同一通知。裸 Discord 频道 id 照常可用。

## 目录

- [使用此包](#use-this-package)
- [API](#api)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

它是**库，不是服务或插件**：没有 `ctx`，不注册任何内容，不保存状态。它不拥有事件流或可变运行时数据，因此不发布运行时不变量配套模块。

| Target | Transport |
|---|---|
| `123456789012345678` 或 `discord:123456789012345678` | Discord 频道，17 到 20 位数字 |
| `signal:group:<base64 group id>` | Signal 群组；id 为恰好 32 字节的标准 base64，`+`、`/` 与 `=` 填充按原样保留 |
| `signal:number:<E.164 number>` | 单个 Signal 账户，例如 `signal:number:+15551234567` |

其他字符串均无效。请在配置或工具边界校验，使错误信息指出字段；投递方遇到无效的已保存目标时不认领该通知。

-----

<a id="api"></a>
## API

```ts
import { assertDeliveryTarget, discordChannelOf, signalTargetOf } from '@deepseek-ai/dsh-delivery-target'
```

| Export | Role |
|---|---|
| `parseDeliveryTarget(value)` | 解析出的 Discord 或 Signal 目标，否则为 `undefined` |
| `assertDeliveryTarget(value, field)` | 解析出的目标；否则抛出 `<field> must be <accepted forms>` |
| `DELIVERY_TARGET_FORMS` | 用于错误信息的可接受形式 |
| `discordChannelOf(value)` | Discord 目标的频道 id，否则为 `undefined` |
| `signalTargetOf(value)` | Signal 群组或号码目标，否则为 `undefined` |
| `formatSignalTarget(target)` | Signal 目标对应的目标字符串 |
| `parseSignalGroupId(value)`, `parseSignalNumber(value)` | 品牌类型 `SignalGroupId` 或 `SignalNumber`，否则为 `undefined` |

-----

<a id="model-experience"></a>
## 模型体验

### 投递目标

#### 模型看到的内容

本库不注册工具、模式或提示词。模型提供无法使用的 `deliver_channel` 时，cron 工具的校验错误会引用 `DELIVERY_TARGET_FORMS`。

#### Token 影响

该错误只为那次失败的工具结果增加一句话。

#### KV Cache 影响

该错误作为工具结果追加，不改变先前的请求内容。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **群组 id 只能用 base64** — Signal 群组不能用显示名称指定，因为名称既不唯一也不稳定。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
