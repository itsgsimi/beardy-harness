---
description: "Harness home 上的 model-facing 策划记忆：一个工具在字符上限内编辑 USER.md 与 MEMORY.md，带 round-trip 格式守卫与可选审批门，面向必须跨会话记住事实的 profile。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-memory

[English](README.md) | 中文

## 概述

本包把跨会话事实保存在 `$DSH_HOME/USER.md` 和 `$DSH_HOME/MEMORY.md` 中：前者记录用户信息，后者保存 agent 笔记。每次 `memory` 调用增加、替换或删除一个单行条目，拒绝无法通过严格项目符号列表 round trip 的内容，并报告剩余字符预算。`dsh-agent-instructions` 把两个文件加载到后续会话；本包不会注入它们，因此写入不会改变运行中的 prompt prefix。设置 `requireApproval: true` 后，每次写入都需要 approval answerer。

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
| `requireApproval` | false | 每次写入前向 approval service 提问 |

指令加载器必须在 `userGlobalInstructionCandidates` 和 `frozenUserGlobalInstructionCandidates` 中同时列出 `USER.md` 与 `MEMORY.md`，并使用与本工具相同的 Harness home。Beardy 提供此配置。第一次请求捕获两个文件或其缺失状态；现有会话在恢复和压缩后仍保留该快照，新会话则接收后续写入。

-----

<a id="dev-note"></a>
## 开发备注

文档规则（parse、serialize、条目校验、上限算术）以纯函数形式位于 `src/store.ts`；`src/tool.ts` 负责经由 `ctx.fs` 的文件系统事务——`lstat` 拒绝符号链接、`fs.stat` 取版本、以 `replaceIfVersion` 调用 `fs.writeText`、写入前后的 `fs/observed` 事件——以及在调用时刻读取 `ctx.approval` 的审批门。plugin 通过嵌套 `ctx.inject(['fs'], …)` 等待 filesystem provider，因此挂载它不会把 fs provider 强加给没有它的 composition。

-----

<a id="model-experience"></a>
## 模型体验

### Tool schema

#### What the model sees

模型看到生成的 [`memory` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-memory)：必填 `target`（`user` 或 `memory`）、必填 `action`（`add`、`replace` 或 `remove`）、可选 `content` 条目行，以及必须恰好命中一个现有条目的可选 `old_text` 子串。结果报告 `entries`、`characters` 与 `limit`，模型始终知道剩余预算。拒绝信息均可直接行动：超限错误报出超出字符数并建议 `replace`；有歧义的 `old_text` 报出命中的条目数；漂移的文件会点名文件和第一个坏行。

#### Token effect

工具可见时每个请求有固定 schema 成本，外加约 120 token 的注册 prompt section（来自 `ctx.systemPrompt.section()`）。每次写入向会话日志追加一条 tool-call 与一条 tool-result 消息。记忆文件本身以上限内的 baseline instruction 文本进入后续会话（默认 1375 加 2200 字符）。

#### KV Cache effect

prompt section 随 composition 固定。采用必需的冻结候选配置后，记忆写入不会改变现有会话的指令快照。后续会话捕获新的基线文本；压缩从会话日志恢复已捕获的记忆。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **写入是单操作的**——每次调用一个条目；多条编辑依赖带版本校验的写入失败后由模型重试，而不是批量事务。
- **当前会话不会即时刷新**——记忆写入只对后续会话可见；当前会话通过 tool result 看到它。实时 re-probe 属于 `dsh-agent-instructions`，不在本包。
- **Invariant companion**——不发布运行时 invariant companion，因为本包不追加自己的事件，除两个文件外不拥有持久记录；每次调用已被 tool registry 记为 `tool/call` 与 `tool/result` 配对，不存在可供 `./invariant` 检查的分歧观测。
- **没有 recall 或搜索**——不在两个文件里的内容归 `session_search`；本包只策展这两个文件。
