---
description: "经 ctx.signal 投递目标为 Signal 群组或号码的摄像头通知、健康状态转换和定时运行结果。"
kind: "package-reference"
---

# @deepseek-ai/dsh-signal-notices

[English](README.md) | 中文

## 概述

把生产方的目标指向 Signal，即可把 Beardy 的通知发到 Signal。本使用方认领目标为 `signal:group:<base64 id>` 或 `signal:number:<E.164>` 的每个 `camera/notice`、`health/transition` 和 `cron/run-finished`，经 `ctx.signal` 把与 Discord 路径相同的文本排队，并把 Discord 目标留给 Discord 网关。

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

把它与 [signal-cli](../signal-cli/README.zh.md) 等 Signal 提供方一起挂载；它不需要配置。然后把生产方的目标设为 Signal 目的地：[camera-watch](../../camera/camera-watch/README.zh.md) 的 `deliverChannelId`、[health](../../health/health/README.zh.md) 的 `noticeChannelId`、[fantasy-reports](../../fantasy/fantasy-reports/README.zh.md) 中队伍的 `channelId` 或 `shadowChannelId`，或 [cron](../../cron/cron/README.zh.md) 中任务的 `deliverChannel`。为便于阅读，可在 YAML 中给值加引号；无论是否加引号，标准 base64 字符 `+`、`/` 和 `=` 都原样保留。

```yaml
- id: signal-cli
  name: '@deepseek-ai/dsh-signal-cli'
  config:
    baseUrl: http://127.0.0.1:8820
- id: signal-notices
  name: '@deepseek-ai/dsh-signal-notices'
- id: camera-watch
  name: '@deepseek-ai/dsh-camera-watch'
  config:
    deliverChannelId: 'signal:group:1QtO3Hub7LE5w2ErIhBrS+WLYdHawvpk03PJMnYREh8='
```

目标为 Discord、格式错误或没有目标的通知不被认领，由其所属方处理。被认领的通知在提供方持久保存后返回 `true`；之后发送与重试由提供方负责。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

每个监听器用 [delivery-target](../../util/delivery-target/README.zh.md) 的 `signalTargetOf` 解析生产方的目标。摄像头通知把已存储的画面作为消息图片。定时运行投递 [cron](../../cron/cron/README.zh.md) 的 `cronDeliveryContent` 选出的文本，即 Discord 网关发布的同一文本，投递 id 为 `cron:<session id>:<fire time>`；没有可通告内容的运行直接被接受而不发消息。摄像头和健康通知沿用生产方的 id，因此生产方重试会被识别为重复。使用方不保存状态，因此不发布不变量配套模块。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Signal 子系统](../../../docs/subsystems/signal.zh.md) — 投递目标、发件箱和收到的消息。
- [Discord 网关](../../discord/discord-gateway/README.zh.md) — 同一事件上 Discord 目标的所属方。

-----

<a id="model-experience"></a>
## 模型体验

### Signal 通知

#### 模型看到的内容

本使用方不注册工具、模式或提示词；`camera/notice`、`health/transition` 和 `cron/run-finished` 通知在生产方完成后经 Signal 发出，从不进入模型请求。

#### Token 影响

本使用方不增加模型 token。

#### KV Cache 影响

本使用方不影响请求缓存。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 目标为 Signal 的定时运行所请求的审批不会路由到 Signal，而是以不可用结束。
- 定时运行文本保留 Markdown，只有 `**bold**` 由提供方渲染为粗体。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
