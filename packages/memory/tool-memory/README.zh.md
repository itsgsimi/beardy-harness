---
description: "一个面向模型的记忆工具，在 Harness home 中管理有界的核心事实和按需读取、带版本的主题文档。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-memory

[English](README.md) | 中文

## 概述

本包把简短的跨会话事实保存在 `$DSH_HOME/USER.md` 与 `$DSH_HOME/MEMORY.md`，把较长的按需文档保存在 `$DSH_HOME/memories/<slug>.md`。核心条目仍是单行项目符号；主题文档保留 frontmatter 与 Rule、Why、History 章节。`dsh-agent-instructions` 只把核心文件加载到后续会话。主题文本仅在 `memory` 读取后进入 Session。设置 `requireApproval: true` 后，每次写入都需要审批应答者。

## 目录

- [配置](#configuration)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | 存放 `USER.md` 与 `MEMORY.md` 的目录 |
| `userMaxChars` | 1375 | `USER.md` 字符上限 |
| `memoryMaxChars` | 2200 | `MEMORY.md` 字符上限 |
| `entryMaxChars` | 400 | 单条目字符上限；必须同时容纳于两个文件上限内 |
| `topicMaxChars` | 16384 | 完整主题文档的字符上限 |
| `topicMaxFiles` | 64 | 主题文件数上限，包含已退役文件 |
| `topicReadMaxChars` | 16384 | `read` 返回的主题正文上限；不得超过 `topicMaxChars` |
| `requireApproval` | false | 每次写入前向 approval service 提问 |
| `allowApprovedHomeWrites` | false | 与 `requireApproval` 同时启用后，在 `workspace-write` 中只允许已获批的精确 home 目标 |

指令加载器必须在 `userGlobalInstructionCandidates` 和 `frozenUserGlobalInstructionCandidates` 中同时列出 `USER.md` 与 `MEMORY.md`，并使用与本工具相同的 Harness home。Beardy 提供此配置。第一次请求捕获两个文件或其缺失状态；现有会话在恢复和压缩后仍保留该快照，新会话则接收后续写入。

-----

<a id="dev-note"></a>
## 开发备注

核心项目符号规则位于 `src/store.ts`；主题校验与内容版本位于 `src/topic.ts`。`src/tool.ts` 负责精确目标、审批，以及通过 `ctx.fs` 执行带版本校验的写入。启用 `allowApprovedHomeWrites` 后，仅获批文件和必要时的 `memories` 目录取得一次性文件系统许可；shell 与 subprocess 策略不会取得该许可。插件通过 `ctx.inject(['fs'], …)` 等待文件系统提供方。

-----

<a id="model-experience"></a>
## 模型体验

### Tool schema

#### What the model sees

生成的 [`memory` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-memory)保留 `user` 与 `memory` 的 add、replace、remove 调用。`target: topic` 增加 list 与 read；add 和 replace 接受完整 Markdown 文档，remove 把 `status` 改为 `retired` 并追加 History。replace 和 remove 需要 read 返回的 `expected_version`。核心文件超限与匹配歧义错误返回当前条目和剩余预算。主题错误只返回有界摘录；list 默认省略已退役主题。

#### Token effect

工具 schema 与已注册 prompt section 增加固定请求成本。每次调用及其结果都会记录。只有两个核心文件作为 baseline instruction 进入后续会话（默认共 1375 加 2200 字符）；主题正文仅在按需读取时作为有界工具结果进入。

#### KV Cache effect

prompt section 随 composition 固定。采用必需的冻结候选配置后，记忆写入不会改变现有会话的指令快照。后续会话捕获新的基线文本；压缩从会话日志恢复已捕获的记忆。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **写入是单操作的**——每次调用一个条目；多条编辑依赖带版本校验的写入失败后由模型重试，而不是批量事务。
- **当前会话不会即时刷新**——记忆写入只对后续会话可见；当前会话通过 tool result 看到它。实时 re-probe 属于 `dsh-agent-instructions`，不在本包。
- **Invariant companion**——不发布运行时 invariant companion，因为本包不追加自己的事件，除两个文件外不拥有持久记录；每次调用已被 tool registry 记为 `tool/call` 与 `tool/result` 配对，不存在可供 `./invariant` 检查的分歧观测。
- **没有语义搜索**——主题 list 返回 slug、状态与更新日期；`session_search` 负责对话回忆。核心文件中的主题指针属于另一次带版本的写入，与主题编辑不构成原子操作。
