---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-27-research-engine-events

[English](2026-09-27-research-engine-events.md) | 中文

## 概述

记录受限的研究引擎设置、网页搜索与抓取结果，以及规范化来源发现和阶段会话引用。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-research-engine-events
baseline: false
changes:
  - root: "event:research/checkpoint"
    previous: "2026-09-27-research-run-events"
    after: "2dcdb67f2a13f8dcc596b04867df89eafed49c5202efaa69b58942be90c74ab7"
    decision: same-version
  - root: "event:research/finding"
    previous: null
    after: "2328d6dc1706dfd6cc74a1e299de3b1714cb9fd49217c0a37187be1befa0c77a"
    decision: same-version
  - root: "event:research/search"
    previous: null
    after: "52261b4041cd97429dbfd487040d4829dfe0ab225e067cbaf1aa1e8b951d98a9"
    decision: same-version
  - root: "event:research/source"
    previous: null
    after: "2a51521026afc8af908bb4dd436f5194339657b9cf0d0bc6297909fa0f29fd81"
    decision: same-version
  - root: "event:research/started"
    previous: "2026-09-27-research-run-events"
    after: "529706ff9af0dab0db17b170e4dca4a814abad1ca1157125ce7e33e5311071f3"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新的搜索、来源和发现事件在当前会话格式中属于增量变化。开始和检查点载荷增加可选字段，来源元数据增加可选的抓取字段。旧研究日志仍可读取。不认识新必需事件名称的读取端会拒绝引擎运行日志，避免静默遗漏证据。

<a id="verification"></a>
## 验证

研究、网页、会话控制器和会话查询的定向测试通过（208 个测试）。持久化分类器检查同版本新增事件与可选字段变更。模拟模型和网页提供方覆盖阶段请求重建与取消路径。

<a id="dev-note"></a>
## 开发备注

无。
