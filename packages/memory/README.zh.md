---
description: "memory 组合包地图：策划 USER.md 与 MEMORY.md 的编辑工具，把少量跨会话事实保存在 Harness home 中，面向为 profile 接入持久 agent 记忆的用户。"
kind: "package-group"
---

# memory/ — 策划的跨会话记忆

[English](README.md) | 中文

## 概述

memory 组合包为 agent 提供持久、可人工编辑且由所有会话共享的事实记录。其面向模型的 `memory` 工具编辑 Harness home 下两个有字符上限的 Markdown 文件：`USER.md` 描述用户，`MEMORY.md` 保存 agent 笔记。条目使用严格的单行格式，无人值守写入可选审批。`dsh-agent-instructions` 把两个文件加载到每个新会话的 baseline，因此 memory 不需要 context plugin，且保留 prompt prefix cache。

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
