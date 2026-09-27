---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-27-presented-visual

[English](2026-09-27-presented-visual.md) | 中文

## 概述

为 deliverables/presented 中的每个交付文件增加可选的已保存视觉快照。Session 写入格式仍为版本 3。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-presented-visual
baseline: false
changes:
  - root: "event:deliverables/presented"
    previous: "2026-09-11-initial"
    after: "c63a3a594df4cfda0975b91dad916d6bb62f83058fb48a049a6c923495c5561c"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

既有事件可以省略 visual，仍按普通文件交付重放。当前读取方接受字段缺失；旧读取方可以忽略可选视觉字节，并保留各文件的路径和描述。此新增字段既不改变事件封套，也不改变既有字段，因此无需相邻迁移。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/fs/tool-present/tests/present.spec.ts 通过 20 个测试，包括视觉事件重放和普通文件交付。持久化分类器对此事件根仅报告一个 optional-property-added 变更，无需提升格式版本。

<a id="dev-note"></a>
## 开发备注

无。
