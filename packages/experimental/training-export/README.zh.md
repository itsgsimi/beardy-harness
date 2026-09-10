---
description: "为从真实 agent 运行构建离线蒸馏数据集的维护者提供边车 train/sample 和 train/label 捕获，观察 llm/stream waterfall 与会话事件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-training-export

[English](README.md) | 中文

## 概述

`dsh-training-export` 在每个持久化会话旁写入边车训练数据：每次 `llm/stream` 调用写入一条 `train/sample`，每个完成的轮次写入一条 `train/label`，并保存会话元数据。样本保留适配器请求、折叠后的响应、哈希和尽力捕获的工作区快照；标签汇总工具、钩子、审批、时间、diff、assistant 文本和评分结果。监听器不添加提示词、工具 schema 或会话事件，因此缺少它时仍能读取会话。该私有实验包遵循 `halorun dataset` 消费的版本 1 格式；其约定可能随时变更。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把该插件挂载在持久化会话的组合旁，以训练数据形式捕获每次完成的模型调用和轮次。它只观察 `ctx.llm` 的 `llm/stream` waterfall 和会话事件流；从不启动、恢复或改变 agent。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | 必填 | 所有会话边车文件的绝对目录；首次写入时创建。 |
| `providers` | 必填 | 与 `GenerateOptions.provider` 匹配的非空允许清单。它只控制每轮的 `git` 读取：所有提供方的样本都会写入，`halorun dataset` 读取器自行应用过滤器。 |
| `enabled` | 必填 | 是否启用监听器。没有默认值：省略时配置校验失败，而不是静默无操作。 |

```yaml
- id: training-export
  name: '@deepseek-ai/dsh-experimental-training-export'
  config:
    root: /var/lib/dsh/training-export
    providers: ['llama.cpp']
    enabled: true
```

### 预期行为

每次带 `sessionId` 的 `llm/stream` 调用结束后，`<root>/<session-id-escaped>/samples.jsonl` 都增加一行，无论正常结束、中止还是下游抛出异常。该行包含折叠后的响应，失败时还包含 `{name, message, code?}` 错误。首个样本会写入一次 `<root>/<session-id-escaped>/meta.json`，包含会话的 `agentPreset`（`SessionHeader.agentPreset` 或 `null`）与最新已知 `title`（在 `session/title` 事件到达前为 `null`）；首个样本之后到达的标题会在同一会话队列上重写整个文件。每个 `turn/end` 会向 `<root>/<session-id-escaped>/labels.jsonl` 增加一行，包含 `startedAt`/`durationMs`（来自轮次的 `turn/start`/`turn/end` 事件时间）、该轮的样本 `seq`、工具／钩子／审批计数、`toolCallOutcomes`（每个 `tool/call` 一项，通过 `callId` 与 `tool/result` 匹配，带 `isError`/`durationMs`/`resultChars`；轮次结束时仍未匹配的调用为 `null`/`null`/`0`；还包含发出该调用的样本 `seq`）、`assistantChars`（该轮 assistant `text` 块的 UTF-8 总长度，不含推理和工具调用参数）、工作区在首个允许提供方样本和 `turn/end` 之间的 `git diff --shortstat`（所以 `diff` 只反映本轮变更，而非先前已存在的脏工作树），以及通过 `dsh-message-feedback` 为本轮 assistant 消息记录的评分。没有 `sessionId` 的请求，或指向存储已不再持有的会话的请求，会完全原样通过：在这种情况下，该插件与其他请求一样只调用 `next()`。

每次磁盘写入都通过每会话队列执行（在 promise 尾部串联 `fs.appendFile`）；写入失败由 `ctx.logger` 记录，不会进入 agent loop 或被观察的模型调用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节：点击展开</summary>

### 设计概念

该插件以与 `session-checkpoint-policy` 相同的方式包装 `llm/stream` waterfall：没有实时会话时无条件委托 `next()`，否则恰好包装一次。包装层按索引顺序把 `block-end` 分片折叠到 `response.content`，保留最后一个 `usage` 分片，并逐字记录 `finish`；终态 `error`/`aborted` 结束原因或抛出的拒绝都会填充 `response.error`，抛出的拒绝在记录后重新抛出；两种情况都会写入样本。同一折叠还把每个 `tool-call` 内容块的 id 与样本自身的 `seq` 关联，并把每个 `text` 块的 UTF-8 长度加入轮次的 `assistantChars`，两者都保存在开放轮次的聚合中，用于最终标签。另一个 `session/event` 监听器跟踪轮次／步骤位置和当前轮次的运行计数（工具调用／错误及每次调用的请求／结果时间与结果大小、钩子结果、审批计数、轮次内压缩、用于查找评分的 assistant 消息 id，以及会话最新的 `session/title`；标题在首个样本后到达时重写 `meta.json`），因为 `Session` 没有公开当前轮次／步骤访问器。两个监听器共享一个在 `apply()` 内创建的 `WeakMap<Session, …>`，因此状态属于插件自身的 fiber，不需要模块级环境状态。

### 源码对照表

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、`llm/stream` 包装层与 `session/event` 监听器 |
| [`src/writer.ts`](src/writer.ts) | 每会话状态、仅追加队列，以及 `samples.jsonl`/`labels.jsonl`/`meta.json` 写入器 |
| [`src/workspace.ts`](src/workspace.ts) | `git rev-parse`/`status`/`diff` 读取与临时索引树快照（`execFile`、5 秒超时、从不抛出） |
| [`src/hash.ts`](src/hash.ts) | `hashes.system`/`hashes.tools` 的 SHA-256 和规范（键排序）JSON |
| [`src/paths.ts`](src/paths.ts) | 会话 id 路径转义（与 `dsh-session-persistence-jsonl` 的 `encodeSegment` 一致）和边车布局 |

### 工作区捕获

每轮最多运行一对 `git rev-parse HEAD` + `git status --porcelain`：允许清单提供方的首个样本捕获它，该轮的后续样本（无论提供方是否在允许清单中）都复用同一快照。同一个首样本还通过临时 `GIT_INDEX_FILE` 把整个工作树（已跟踪与未跟踪，遵守 `.gitignore`）写为树对象，从不使用真实索引，且只保留其哈希。没有 `cwd` 的会话，或仅有非允许提供方样本的轮次，完全不运行 `git`。在 `turn/end`，系统以相同方式获取第二个树快照，并在两个哈希之间运行 `git diff --shortstat` 来构建标签的 `diff`，因此轮次开始前已经脏的工作树不会被算作本轮变更。

</details>

**运行时不变式：**不发布配套工具。该插件写入的 `samples`/`labels` 关系按设计跨越两个位于权威会话日志外的边车文件；没有进程内事件流或服务携带可供运行时检查读取的关系，因此由该包自身的测试覆盖它。

-----

<a id="model-experience"></a>
## 模型体验

无。模型不会看到该插件添加的任何内容：无提示词文本、工具 schema 或会话日志事件；它只观察 `llm/stream` waterfall 和会话事件，写入模型从不读取的外部边车文件。

#### KV Cache 影响

该插件从不构造或重写请求，因此不会使提供方缓存失效、扩展或替换它；所有效果都严格发生在响应组装完成之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅在标签时获取评分**：`train/label.ratings` 是轮次结束时的快照；此后添加的评分不会被该插件捕获。格式文档为这种情况保留 `halorun dataset --refresh-ratings`；该插件不实现它。
- **除 `samples.jsonl` 行数外，不跨重启恢复 seq／轮次**：每会话 `seq` 计数器在进程重启后正确恢复（它计数现有行），但内存中的轮次／步骤跟踪和开放轮次的运行聚合无法在重启或 HMR 重载后保留：插件加载或重新加载时已经开始的轮次不会产生标签。
- **`hooks[].name` 是合成的 `point:handlerId` 连接**：`hook/result` 没有单一的“钩子名”字段；格式文档自身的示例（`post-edit:test`）只是说明，不是字面源字段。
- **两个分支未测试，而非用 mock 代替**：一是 `captureWorkspaceHead` 中 `git rev-parse` 成功后 `git status` 立即失败（没有 mock `execFile` 时，真实 `git` 的时序情况无法通过测试设置重现）；二是实际挂载 `messageFeedback` 后 `resolveRatings` 的路径（建立完整的存储域／会话持久化栈相对于该包自身的测试并不划算；映射本身已直接根据 `MessageFeedbackItem`/`MessageFeedbackListResult` 响应字段测试）。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文：点击展开</summary>

参见 [`.agents/notes/implemented/feature/2026-09-06-training-export-sidecar.md`](../../../.agents/notes/implemented/feature/2026-09-06-training-export-sidecar.zh.md)。

</details>
