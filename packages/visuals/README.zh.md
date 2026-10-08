---
description: "视觉包组：展示智能体在回合中交付的视觉快照的 Web 视图。"
kind: "package-group"
---

# packages/visuals

[English](README.md) | 中文

## 概述

Beardy 在 Web 会话中按交付记录的位置内联显示 `present_visual` 交付的图表、图片和 HTML 原型。本组包含浏览器插件；工具及其持久保存的 `visual` 字段位于 [`deliverables/tool-present`](../deliverables/tool-present/README.zh.md)。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`client-ui-visuals`](client-ui-visuals/README.zh.md) | 已交付视觉快照的内联聊天节点 | 浏览器插件 |

-----

<a id="related-documentation"></a>
## 相关文档

- [Deliverables 子系统](../../docs/subsystems/deliverables.zh.md) — `deliverables/presented` 事件及其文件声明。
- [下游补丁迁移决策](../../.agents/notes/implemented/architecture/2026-10-07-downstream-carry-into-plugins.zh.md) — Beardy 视图为何放在 Beardy 包中。

-----

<a id="dev-note"></a>
## 开发备注

无。
