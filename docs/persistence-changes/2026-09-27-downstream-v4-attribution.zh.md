---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-27-downstream-v4-attribution

[English](2026-09-27-downstream-v4-attribution.md) | 中文

## 概述

在 V4 记录中加入下游 Discord 和 cron 消息来源、技能提示来源、已捕获的用户记忆以及可选的展示视觉信息。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-downstream-v4-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "08348dba2b18a0f5f93340a147b63421fd4b9f1c8b5b839f047d8f74408d412e"
    decision: same-version
  - root: "event:deliverables/presented"
    previous: "2026-09-11-initial"
    after: "c63a3a594df4cfda0975b91dad916d6bb62f83058fb48a049a6c923495c5561c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "061fac9576f9394bfad5043d69ad58e419dd36313ba79f67298f889c61b86acf"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "10432669237d646344b3c11376cd99c3af38539879fe69e790c655d722a2455c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "0781a212498552eb2b2e4f2e66769577096b0b7dca64ead23410009298c17613"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

现有 V4 消息仍然有效。Discord、cron 和技能提示来源只标记已保留的消息内容；未加载这些生产者的读取方仍保留来源种类和 JSON 元数据，无须生产者参与。指令基线中冻结的用户文件以及每个展示文件保存的 `visual` 都是可选字段，缺失时沿用原有读取路径。旧版读取方可以忽略视觉字节，同时保留文件路径和描述。V3 迁移保留直接来源和已捕获的指令数据。旧版 V4 读取方保留未知来源种类并忽略可选字段。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/client/ui-settings-plugins/tests/research-card.client.spec.tsx packages/session/session-format-v3-to-v4/tests/message-sources.spec.ts：15 个测试通过；pnpm run typecheck 通过。

<a id="dev-note"></a>
## 开发备注

无。
