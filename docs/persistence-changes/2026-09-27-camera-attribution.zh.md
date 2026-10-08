---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-27-camera-attribution

[English](2026-09-27-camera-attribution.md) | 中文

## 概述

为 V4 记录加入摄像头监视的 `camera` 用户消息来源归属。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-camera-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-27-downstream-v4-attribution"
    after: "7c1987d9b1c801697bbbc560ffbc083d81950d0f9227e811083e1c9cdaa50ec3"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-27-downstream-v4-attribution"
    after: "acf82f65e2a2c1f8a273e62e55094ec9db8bf6a033a5c6c32dd0f0ca1d9cbbc8"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-27-downstream-v4-attribution"
    after: "19668724e4be71c8e670166ba64b8ece58b8785aead9cd3984dd22b49d534f78"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-27-downstream-v4-attribution"
    after: "3ffa848524b9772a269f2edbd5f09cd671558b854546970fabd8107cf9f9f6f2"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有 V4 消息仍然有效。`camera` 类型只为分类 Session 的提示消息标注来源，该消息的文本和图像块保持不变；没有摄像头监视的读取方会保留该类型及其 JSON 元数据，并照常派生消息。较旧的 V4 读取方会保留未知来源类型。没有 V3 Session 带有此类型，因此迁移不受影响。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/camera/camera-watch/tests/watch.spec.ts：22 个测试通过；pnpm run typecheck 通过。

<a id="dev-note"></a>
## 开发备注

无。
