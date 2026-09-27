---
description: "研究服务和持久化 Session 事件类型，供创建、查看及取消按所有者隔离的运行的插件使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-research

[English](README.md) | 中文

## 概述

使用 `ctx.research` 启动持久化研究运行、查看进度、列出某个所有者的运行、读取保留的报告，或取消运行。服务需要 `research-local` 等提供方；把抽象定义作为插件加载会失败。进程重启后，运行 ID 和报告文件引用保持稳定。

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

装载一个提供方，然后向 `start` 传入活跃的调用方 Session 和可信所有者。

### 何时选择

当消费方需要在调用方结束后仍然有效的运行 ID、所有者检查和报告时，选择此服务。独立的定义包没有存储实现。

### 所有权与操作

所有者可以是调用方 Session，也可以是已配置的单用户 profile 命名空间。模型参数不能选择所有者。`start` 先持久保存运行，再把 ID 关联到调用方；精确的 `requestKey` 可让结果不明确的重试返回现有运行。`status`、`list`、`report` 和 `cancel` 使用已保存的所有者。外来 ID 和不存在的 ID 都返回相同的不可用错误。

[研究子系统参考](../../../docs/subsystems/research.zh.md)记录事件类型和当前服务签名。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

抽象服务声明按所有者隔离的操作。`ResearchRunId` 是品牌化字符串；序列化后的值也是运行 Session ID。`research/started`、`research/checkpoint` 和 `research/finished` 属于运行 Session，`research/linked` 属于调用方 Session。Session 事件映射要求能够理解这些事件的 Harness 在读取时识别全部四种类型。

本包仅声明类型和抽象服务，不拥有可变运行时状态，因此不发布运行时不变式配套插件。

| 源码 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务方法和运行 ID 接纳 |
| [`src/types.ts`](src/types.ts) | 所有者、视图、报告和持久事件类型 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [本地提供方](../research-local/README.zh.md) — 存储与恢复行为。
- [研究决策](../../../.agents/notes/implemented/feature/2026-09-27-session-backed-research-runs.zh.md) — 持久性依据。

-----

<a id="model-experience"></a>
## 模型体验

模型内容由消费方间接决定；消费方选择将哪些运行状态和报告页面传给模型。

#### KV 缓存影响

本包不添加提示词或工具 schema。定义包本身不改变模型请求；消费方决定后续上下文是追加还是替换文本。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 没有提供方时，定义包无法执行或保存运行。
- profile 所有者是可信同进程代码提供的权限值；多用户部署共享命名空间前需要经过认证的主体适配器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
