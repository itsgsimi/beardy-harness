---
description: "memory 组合包地图：策划 USER.md 与 MEMORY.md 的编辑工具，把少量跨会话事实保存在 Harness home 中，面向为 profile 接入持久 agent 记忆的用户。"
kind: "package-group"
---

# memory/ — 策划的跨会话记忆

[English](README.md) | 中文

## 概述

memory 组合包让 agent 拥有一份持久、可人工编辑的记录，保存适用于每个会话的事实。该能力由一个包承担：model-facing 的 `memory` 工具，编辑 Harness home 下的两个 Markdown 文件——记录用户是谁的 `USER.md` 与记录 agent 自身笔记的 `MEMORY.md`，带有严格字符上限、单行条目格式，以及面向无人值守写入的可选审批门。把内容送达未来会话不是本组合包的职责：这两个文件就是普通的 user-global instruction candidate，由 `dsh-agent-instructions` 载入每个新会话的 baseline，因此记忆不需要自己的 context plugin，也不破坏 prompt prefix cache。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)

-----

<a id="packages"></a>
## 包

| 包 | 角色 | ctx key |
|---|---|---|
| [`tool-memory/`](tool-memory/README.zh.md) | Model-facing `memory` 工具，编辑 `$DSH_HOME/USER.md` 与 `$DSH_HOME/MEMORY.md`，带上限、格式校验与审批门 | registers on `ctx.tools`, consumes `ctx.fs` |

-----

<a id="related-documentation"></a>
## 相关文档

- [策划记忆 Agent Note](../../.agents/notes/implemented/feature/2026-09-05-curated-memory.zh.md) — 为什么是两个扁平文件加一个工具，而不是存储库、embedding 或 context plugin。
- [`dsh-agent-instructions`](../context/agent-instructions/README.zh.md) — 把这两个文件作为 user-global instruction 载入每个新会话 baseline 的包。
