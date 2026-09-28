---
description: "摄像头服务定义：配置的设备、移动与门铃事件、已存储的画面以及判定类型。"
kind: "package-reference"
---

# @deepseek-ai/dsh-camera

[English](README.md) | 中文

## 概述

使用 `ctx.camera` 了解提供方监视哪些摄像头，并以 `camera/event` 接收它们的门铃按下和移动警报。每个事件都携带一组有界画面，这些画面已存入附件存储，因此使用方可以把它们交给模型查看或附到通知上。本包还定义了使用方根据这些画面得出的结构化判定。

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

先装载 [camera-ring](../camera-ring/README.zh.md) 等提供方，再监听 `camera/event`。监听器应把工作排入队列后立即返回；提供方会等待所有监听器完成后才处理该设备的下一个事件，监听器失败时只记录日志、不重试。`devices()` 列出已配置的设备 ID 和标签，使用方用它们校验自身引用，并在提示词和通知中称呼摄像头。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

抽象服务拥有 `ctx.camera` 键、设备列表，以及受保护的 `publish`：它并行运行所有 `camera/event` 监听器，并逐一记录失败。设备 ID 由部署选定，使用小写字母和连字符；事件 ID 由提供方构造，厂商重复发送同一通知时 ID 也相同。画面是 `ImageAttachmentRef` 值，附带相对事件的截取偏移，以及它来自快照还是直播流。判定类型列出可见标签、各标签数量、主要活动、0 到 1 的置信度、一行描述，以及出现人物的画面序号。定义没有自身状态，因此不发布不变量组件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Camera 子系统](../../../docs/subsystems/camera.zh.md) — 事件、画面、判定和通知交接。
- [摄像头监视](../camera-watch/README.zh.md) — 对画面分类并发送通知的使用方。

-----

<a id="model-experience"></a>
## 模型体验

### 摄像头服务

#### 模型看到的内容

此定义不注册工具、模式或提示词。画面只有通过使用方记录在案的消息才会到达模型，例如摄像头监视发出的来源类型为 `camera` 的 `user/message`。

#### Token 影响

定义不增加模型 token。

#### KV Cache 影响

定义不改变请求缓存。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 必须有提供方才能发布事件；定义无法按需请求新画面。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
