---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-27-research-run-events

[English](2026-09-27-research-run-events.md) | 中文

## 概述

新增持久化的研究运行创建、调用方关联、检查点和终态事件。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-research-run-events
baseline: false
changes:
  - root: "event:research/checkpoint"
    previous: null
    after: "e4f6dc1f097c473d7b9a0e99f31ea2b3f80fa334e8ba5728f7ed15e382413044"
    decision: same-version
  - root: "event:research/finished"
    previous: null
    after: "624e3d25a6a6bfc56db462668486fb8213a27fc70e491fa9ceaf2a5e4ee94229"
    decision: same-version
  - root: "event:research/linked"
    previous: null
    after: "428258651791def845d5cda5c471d5e38b692e4118e40def1cecae39b874b5fa"
    decision: same-version
  - root: "event:research/started"
    previous: null
    after: "98162ec1623806fed5f2ee52ef1e2499636f2dde53906b9f6d8d7b63c1d145f1"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

这四个事件根在当前 Session 格式中属于增量添加。旧日志不包含这些事件，其原有解释保持不变。不认识这些必需事件的读取方会拒绝研究运行日志，而不会将其生命周期误判为已完成。

<a id="verification"></a>
## 验证

研究本地存储单元测试和 Loader 组合测试已通过（22 个测试）。TypeScript SDK 的录制 Session 回放和 Python 高级运行时快照确认测试用的 `research/linked` 会进入事件流。持久化变更分类器报告四项同版本事件根新增。研究消费方挂载提供方之前，已发布的 SDK profile 不会产生研究事件。

<a id="dev-note"></a>
## 开发备注

无。
