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
    after: "b2b7593c1e987d76d27f723640214713ef61c99e056edf55b93fb25733a7d6c4"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-27-downstream-v4-attribution"
    after: "27e5ed89fb079b8ddc0d363015e1916254a85963f6be5352e4a4737830dcdf53"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-27-downstream-v4-attribution"
    after: "2c4d5438355906bb05a9e3ecd936d3809628ce573d8de93002c8eb37e740d043"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-27-downstream-v4-attribution"
    after: "1d53335fb8a9300e52ef98428d8eddb3abd8584ce7cdce52f4910ebd5f88d4e8"
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
