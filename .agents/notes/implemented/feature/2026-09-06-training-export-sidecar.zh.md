# Agent Note: Training-export 边车插件

Status: implemented

[English](2026-09-06-training-export-sidecar.md) | 中文

## 问题

夜间蒸馏需要 teacher 的真实派生请求及其结果，而且必须在请求实际组装处 `deepseek-harness` 捕获，不能稍后从会话日志重建。会话日志包含消息、工具调用／结果和轮次结果，但不包含适配器看到的精确压缩后、拼接后 `messages[]`；离线重新派生它意味着重新实现 dsh 的上下文组装。`SessionEventMap` 读取时也默认拒绝：任何没有所属插件的构建都会拒绝包含新 `train/*` 事件的日志，因此导出不能使用会话日志事件。

## 决定

`@deepseek-ai/dsh-experimental-training-export` 包装 `llm/stream` waterfall（与 `session-checkpoint-policy` 包装的 seam 相同）并监听会话事件流，在配置的 `root` 下为每个会话写入两个仅追加的边车文件：`samples.jsonl`（每次带 `sessionId` 的模型调用一条 `train/sample`）与 `labels.jsonl`（每次 `turn/end` 一条 `train/label`），以及一个只写一次的 `meta.json`。协议格式由 halorun checkout 中的 `docs/training-export-format.md` 规定；该包是写入方，`halorun dataset` 是读取方。

包装层把下游 `StreamChunk` 流折叠为响应（按索引顺序排列的 `block-end` 块、最后一个 `usage`、终态 `finish`，以及由终态 `error`/`aborted` 结束原因或捕获后重新抛出的异常填充的 `error`），并从 `finally` 块将样本写入队列，因此无论调用完成、中止还是抛出都会写入样本。独立的 `session/event` 监听器跟踪轮次／步骤位置（`Session` 没有公开当前轮次／步骤访问器，因此该插件自行跟踪 `turn/start`/`step/start`/`step/end`/`turn/end`）和开放轮次的运行计数：工具调用／错误、`hook/result` 结果、审批计数、轮次内压缩以及用于查找评分的 assistant 消息 id；在 `turn/end` 将该聚合关闭为 `train/label` 行。

两个监听器共享一个在 `apply()` 内创建的 `WeakMap<Session, SessionExportState>`：状态位于插件自身的 fiber 闭包中，而非模块级环境状态，且不需要显式清理；它会与 `Session` 一起被垃圾回收。每次磁盘写入都通过每会话 promise 链队列（`fs.appendFile`），每次失败都在队列内被捕获并通过 `ctx.logger` 记录，因此该插件的任何内容都不会进入 agent loop。

工作区捕获（`git rev-parse HEAD` + `git status --porcelain`、`execFile`、5 秒超时、从不抛出）每轮最多运行一次：配置的 `providers` 允许清单中的首个样本捕获它，该轮后续样本复用该快照；没有 `cwd` 的会话永久跳过它。同一次捕获还把整个工作树（已跟踪与未跟踪，遵守 `.gitignore`）快照为树对象：使用临时 `GIT_INDEX_FILE` 而非真实索引执行 `git add -A` 和 `git write-tree`，且只保留结果哈希。在 `turn/end`，系统以相同方式获取第二个快照，并在两个树哈希之间运行 `git diff --shortstat` 以构建标签的 `diff`；使用快照对快照而非已记录 `HEAD` 的 diff，修复了一个缺陷（2026-09-06）：在此之前，本来就脏的工作树会重复出现在后续每轮的 `diff` 中。`providers` 只控制这些 `git` 读取；所有提供方的样本都会写入，与 halorun 侧读取器拥有提供方过滤器的设计一致。

可选的每消息评分来自 `ctx.get('messageFeedback')`（该包的可选服务模式：使用 `import type {} from '@deepseek-ai/dsh-message-feedback'` 扩充 `Context`，并在调用处使用 `ctx.get(...)`，与 `dsh-tools` 的可选 `approval` 服务一致）；未挂载服务时为 `[]`。

### 附加字段：agentPreset、title、工具调用结果与轮次时间

`meta.json` 增加了 `agentPreset`（`session.header.agentPreset ?? null`，即读取 `parentSessionId`/`delegationDepth`/`cwd`/`createdAt` 时已使用的同一 header）与 `title`（最新 `session/title` 事件的文本，到达前为 `null`）。由于 `meta.json` 在其他情况下只在首个样本时写入一次，后续到达的 `session/title` 会使用共享 `buildMeta()` 重写整个文件；首次写入也使用同一构建器，且重写在同一每会话队列上执行，不在热路径中。`session/title` 与 `hook/result`/`approval/*`/`compaction/*` 一样进入该插件的 `SessionEventMap` switch，通过类型专用的 `import type {} from '@deepseek-ai/dsh-session-title'`（已添加到 `peerDependencies`/`devDependencies` 和对应 `tsconfig.json` 项目引用）。`labels.jsonl` 增加了 `startedAt`/`durationMs`（轮次自身的 `turn/start`/`turn/end` 事件时间）、`assistantChars`（折叠每个样本响应时求和，与现有每轮聚合一起保存）和 `toolCallOutcomes`：每个 `tool/call` 一项，在已计数 `toolCalls`/`toolErrors` 的同一开放轮次聚合中通过 `callId` 跟踪调用及其匹配 `tool/result`，同时在折叠每个样本响应内容时填充 `callId → seq` 映射，使标签可说明哪个样本的响应实际请求了某个调用。

### 包位置

该包位于 `packages/experimental/training-export`，名为 `@deepseek-ai/dsh-experimental-training-export`（`private: true`，无 `publishConfig`），与 `packages/experimental/` 下的其他包一致：`check-workspace-constraints` 要求该目录中所有包使用 `dsh-experimental-` NPM 前缀，且发布包不得依赖它们。nightly-distill 计划为该能力使用的工作名是“`dsh-training-export`”；已交付的 NPM 名称和 Cordis 插件 `name`（`training-export`）与该简称的差异仅为强制实验前缀。

## 考虑过的替代方案

**会话日志 `train/*` 事件。**已拒绝：`SessionEventMap` 读取时必须完整理解（默认拒绝），因此任何没有该插件的构建都会拒绝包含它们的日志。边车文件完全避免格式版本升级与拒绝，理由与 `dsh-message-feedback` 对评分的处理相同。

**重新读取 `samples.jsonl`/`labels.jsonl` 以根据已写入 seq 检查 `train/label.samples` 的运行时不变式。**已拒绝：此工作区中的每个现有包不变式都检查 `session.events` 或其他自有进程内结构，而从不检查文件内容；边车文件按设计位于该权威事件流之外。因此 `src/invariant.ts` 是已记录的空配套工具，改由该包自身的测试覆盖该关系。

**模块级环境 `WeakMap`，仿照 `session-telemetry` 的 `handoffCursor`。**已拒绝：该模式存在于后者，是因为重新接管的 fiber 必须在 HMR 重载后恢复历史。该插件没有此需求；在 `apply()` 内创建的 fiber 局部 `WeakMap` 更简单，且与现有的 session-checkpoint-policy 式仅监听插件一致。

## 后果

- 没有挂载 `dsh-experimental-training-export` 时持久化的会话不受影响：它写入的内容不会改变会话响应字段，且不需要升级格式版本。
- 插件加载或重新加载（进程重启、HMR）时已经开始的轮次不会产生 `train/label` 行：内存中的轮次跟踪无法跨重载保留，与 `seq` 计数器不同；后者通过计数现有 `samples.jsonl` 行恢复。
- 评分是 `turn/end` 时的快照；此后添加的评分需要格式文档中延期的 `halorun dataset --refresh-ratings` 路径，而非该插件。

## 测试

`packages/experimental/training-export/src` 的单文件分支覆盖率为 96%，在两处未达到 `test:coverage` 门禁的 100%，两者都是特意保留的缺口：`captureWorkspaceHead` 中 `git rev-parse` 成功后 `git status` 立即失败（不 mock `execFile` 时无法用测试设置重现的真实 `git` 时序），以及实际挂载 `ctx.get('messageFeedback')` 后 `resolveRatings` 的路径（为此建立其整个存储域／会话持久化栈对该包不划算；评分映射逻辑除这两次调用外没有其他分支）。其他所有分支都已覆盖，包括同一轮的两次调用复用工作区捕获、在模拟重启后恢复 seq／meta，以及开放轮次内外的每种已跟踪会话事件。附加字段没有增加缺口：匹配／报错／未匹配的 `toolCallOutcomes` 项、本轮未匹配任何已跟踪调用的 `tool/result`、排除推理和工具调用块的 `assistantChars`、首次写入中的 `agentPreset`/`title`、后续 `session/title` 触发的 `meta.json` 重写（首次写入前后均覆盖），以及 `startedAt`/`durationMs` 均使用 `vi.useFakeTimers({ toFake: ['Date'] })` 以确定性事件时间测试。
