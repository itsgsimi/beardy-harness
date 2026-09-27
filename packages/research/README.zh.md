---
description: "研究包组：为原生研究引擎及其后续消费方提供持久运行记录和本地存储。"
kind: "package-group"
---

# packages/research

[English](README.md) | 中文

## 概述

研究运行可以在进程重启后保留，并保存按所有者隔离的进度与报告。定义包提供公共服务和 Session 事件类型；本地提供方保存运行和不可变报告文件。模型引擎和工具消费方是独立的后续部分。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`research`](research/README.zh.md) | 运行身份、所有者、报告、事件和服务类型 | `ctx.research` |
| [`research-local`](research-local/README.zh.md) | 持久保存、列出和协调运行及报告附件 | `ctx.research` 的提供方 |

-----

<a id="related-documentation"></a>
## 相关文档

- [研究子系统](../../docs/subsystems/research.zh.md) — 运行状态和事件关系。
- [以 Session 保存研究运行的决策](../../.agents/notes/implemented/feature/2026-09-27-session-backed-research-runs.zh.md) — 所有权和恢复依据。

-----

<a id="dev-note"></a>
## 开发备注

无。
