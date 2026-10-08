---
description: "研究包组：提供持久运行记录、本地引擎和面向模型的工具。"
kind: "package-group"
---

# packages/research

[English](README.md) | 中文

## 概述

研究运行在进程重启后仍可保留按所有者隔离的进度与报告。定义包提供服务和 Session 事件类型，本地提供方运行有界的 Web 与模型引擎，工具向调用方模型提供五种操作。

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
| [`tool-research`](tool-research/README.zh.md) | 提供 `deep_research` 操作和分页报告 | `ctx.research` 的消费方 |
| [`client-ui-research`](client-ui-research/README.zh.md) | 研究调用的 Web 报告对话框和研究工作模型设置标签页 | 浏览器插件 |

-----

<a id="related-documentation"></a>
## 相关文档

- [研究子系统](../../docs/subsystems/research.zh.md) — 运行状态和事件关系。
- [以 Session 保存研究运行的决策](../../.agents/notes/implemented/feature/2026-09-27-session-backed-research-runs.zh.md) — 所有权和恢复依据。

-----

<a id="dev-note"></a>
## 开发备注

无。
