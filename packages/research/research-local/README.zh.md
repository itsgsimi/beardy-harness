---
description: "以本地 Session 保存研究运行状态、检查所有者、协调重启并保留不可变报告附件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-research-local

[English](README.md) | 中文

## 概述

装载此提供方后，研究运行 ID、进度和报告可在进程重启后保留。它先提交运行，再向调用方确认，并通过投影持久化 Session 日志列出运行。重启会把未完成的运行标记为已中断，恢复时不会启动外部工作。此存储包目前不会调用模型，也不提供研究工具。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将提供方与 Agent 工厂、Session 存储及持久化服务、支持原样文件的附件存储一起装载。

### 何时选择

当本地研究运行的进度需要在调用方结束后保留，且报告需要不可变存储时，选择此包。在原生引擎和消费方尚未加入时，它不能替代现有的 Odysseus HTTP 工具。

### 最小配置

Loader 组合测试使用以下字段装载此提供方：

```yaml
- name: '@deepseek-ai/dsh-research-local'
  config:
    provider: mock
    model: test-model
```

`provider` 和 `model` 是必需的精确路由标签。`ownerScope` 默认为 `session`；`profile` 模式要求非空 `ownerNamespace`，并且部署必须明确为单用户。`maxReportBytes` 默认为 1048576，`maxEvidenceBytes` 默认为 8388608；两者限制完整附件字节数。[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-research-local)记录完整 schema。

### 读取与恢复

服务先在新的运行 Session 刷新 `research/started`，再在调用方刷新 `research/linked`，然后才确认 `start`。调用方的精确 `requestKey` 可在结果不明确的重试中返回同一个运行。按所有者隔离的 `list` 读取持久化运行 Session。重启后首次访问会把未完成的运行改为 `interrupted`，不会重放其工作。完成状态要求同时保存报告和证据附件；读取报告时会验证两个文件，任一文件缺失或内容变动都会失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

运行 Agent 在提供方的服务上下文中创建，并在存储层接收检查点时保持空闲。其 Session 日志是阶段和所有者的权威来源；进程内映射只保存用于释放和活跃写入的句柄。终态报告文件先保存，再写入引用它们的事件；`ctx.sessions.flush` 是提交屏障。调用方刷新失败可能留下可找到的运行 Session。某个刷新监听器拒绝时，另一个监听器仍可能已经提交运行，因此重试要检查持久日志。

运行 Session 是唯一的状态权威，报告读取时会检查附件是否存在，因此不发布运行时不变式配套插件。

| 源码 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 运行投影、提交顺序、所有者检查和恢复 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [研究定义](../research/README.zh.md) — 服务和事件类型。
- [研究子系统](../../../docs/subsystems/research.zh.md) — 运行权威与阶段 Session 关系。
- [以 Session 保存研究运行的决策](../../../.agents/notes/implemented/feature/2026-09-27-session-backed-research-runs.zh.md) — 恢复依据。

-----

<a id="model-experience"></a>
## 模型体验

模型内容由未来的研究消费方和已记录的阶段 Agent 间接产生。

#### KV 缓存影响

此存储提供方不添加提示词或工具 schema，也不会启动模型调用。它不改变模型请求；未来每个阶段 Agent 都有独立的请求历史。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 目前没有引擎或面向模型的工具启动研究工作。已启动的运行会保持开放，直到存储调用方完成、取消，或恢复过程将其标记为中断。
- 尚未创建阶段 Session。引擎创建它们之前，Session 列表和 `session_search` 需要默认排除研究阶段子 Session，同时允许通过 ID 显式查看。
- Profile 所有权仅适用于明确的单用户组合；此提供方不会认证不同的人类主体。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
