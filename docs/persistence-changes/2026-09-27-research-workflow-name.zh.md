---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-27-research-workflow-name

[English](2026-09-27-research-workflow-name.md) | 中文

## 概述

为持久化的研究运行开始事件新增可选的使用方工作流名称。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-research-workflow-name
baseline: false
changes:
  - root: "event:research/started"
    previous: "2026-09-27-research-engine-events"
    after: "a75ce2460c0aff11afa12c5a18af38a952ca5d01294c8ed79bbda6f6f68f8f6c"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效：通用引擎的运行不写此字段，与此前所有运行一致。以使用方工作流启动的运行会在提示词版本和预算旁记录工作流名称；读取方仅用它识别生成报告的流程，缺失即表示通用引擎。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/research/research-local packages/fantasy/fantasy-reports：131 个测试通过；fantasy-report 无头快照回放了带此字段的已录制运行。

<a id="dev-note"></a>
## 开发备注

无。
