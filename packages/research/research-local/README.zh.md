---
description: "使用 Session 保存研究引擎状态，约束网页证据与模型阶段，检查所有者并保留持久化报告。"
kind: "package-reference"
---

# @deepseek-ai/dsh-research-local

[English](README.md) | 中文

## 概述

装载此提供方后，研究可通过已配置的模型和网页提供方执行，进度与报告可在进程重启后保留。它先提交运行，再向调用方确认，在子 Session 中记录每个模型阶段，并通过投影持久化日志列出运行。重启会把未完成的运行标记为已中断，不会重放外部工作。

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

将提供方与 Agent 工厂、Session 存储及持久化服务、附件存储、精确的 LLM 路由，以及可用的 `ctx.web` 搜索和抓取提供方一起装载。

### 何时选择

当本地研究运行的进度需要在调用方结束后保留，且证据与报告需要不可变存储时，选择此包。请单独挂载[面向模型的消费方](../tool-research/README.zh.md)。

### 最小配置

Loader 组合测试使用以下字段装载此提供方：

```yaml
- name: '@deepseek-ai/dsh-research-local'
  config:
    provider: mock
    model: test-model
```

`provider` 和 `model` 是必需的精确路由标签。`ownerScope` 默认为 `session`；`profile` 模式要求非空 `ownerNamespace`，并且部署必须明确为单用户。默认运行最多四轮，同时进行两次搜索、三次抓取和一次模型调用，硬时限为 30 分钟。`stageTemperature`（0 到 2，默认 0.2）设定每个阶段请求的采样温度。所有数值预算在加载时验证，并冻结到运行事件中。[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-research-local)记录所有字段及其边界。

### 读取与恢复

服务先在新的运行 Session 刷新 `research/started`，再在调用方刷新 `research/linked`，然后才确认 `start` 并启动引擎。调用方的精确 `requestKey` 可在结果不明确的重试中返回同一个运行。按所有者隔离的 `list` 读取持久化运行 Session。重启后首次访问会把未完成的运行改为 `interrupted`，不会重放工作。每次搜索、抓取、提取、阶段 ID 和草稿在发布进度前提交。取消会中止活跃及排队中的操作；已提交的草稿保留为部分报告。完成时先保存报告与证据附件，再写入终态事件；读取报告会验证两个文件。

运行和阶段 Session 标头会保留调用方的工作区路径（如果存在），以便 Agent 销毁后仍可按明确授权读取阶段日志。

带 `workflow` 的 `start` 请求会执行该使用方流程，而不是通用引擎。其运行与阶段时限替代该运行的 `hardRunTimeoutMs` 和 `stageTimeoutMs`，并记录在 `research/started` 中。其阶段与通用运行共享提供方的模型准入，因此 `maxConcurrentModelCalls` 同时约束两者。工作流的 `stageSystemPrompt`（1 到 4000 个字符）为其阶段替代提供方的阶段系统提示词。阶段的 `temperature` 选项替代 `stageTemperature`，其 `expectJson` 检查允许一次纠正轮次：被检查拒绝的首个回答会在同一阶段 Session 中收到 `Your reply was not the requested JSON. Reply with only the JSON object in the requested format.`，且仅当纠正回答通过检查时才作为结果。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

运行 Agent 保持空闲，其 Session 日志记录状态与所有权。引擎在实时运行 Agent 下为每次模型调用创建短生命周期的子 Agent/Session，因此阶段限制也会屏蔽注册在运行作用域中的工具。它拒绝执行其余作用域工具。每个阶段 Session 通过 `@deepseek-ai/dsh-agent` 的 `installDedicatedPrompt` 仅依据一个完整的阶段系统提示词作答：部署人设、运行时上下文和所有工具 schema 都不会进入请求。每个阶段轮次只能发出一次模型请求，因此带纠正轮次的阶段最多发出两次。`ctx.web` 负责安全搜索与抓取；网页工具的共享转换器把有界 HTML 渲染为 Markdown。来源账本先附加精确抓取文本，再写入引用事件，随后记录规范化发现和草稿引用。`ctx.sessions.flush` 是进度提交屏障。调用方刷新失败可能留下可找到的运行 Session。

运行 Session 是唯一的状态权威，报告读取时会检查附件是否存在，因此不发布运行时不变式配套插件。

| 源码 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 运行投影、提交顺序、所有者检查和恢复 |
| [`src/engine.ts`](src/engine.ts) | 搜索、抓取、提取、综合、停止和报告流程 |
| [`src/stage.ts`](src/stage.ts) | 持久化的阶段轮次、JSON 纠正轮次与准入 |
| [`src/prompts.ts`](src/prompts.ts) | 版本化提示词模板、阶段系统提示词与纠正消息 |
| [`src/config.ts`](src/config.ts) | 预算解析与验证 |

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

通过 `deep_research` 消费方间接提供；该消费方决定向调用方模型提供哪些有界进度与报告分页。

#### KV 缓存影响

除非工作流另行提供，每个阶段 Session 的系统提示词为 `You are one stage of a research workflow. You have no tools and cannot search, browse, or run commands; work only from the text in the user message. Follow the output format the message asks for exactly.`。每个阶段在新的 Session 中发送一个有界提示词，因此只有后续提示词明确选择的先前页面文本才会进入上下文。父运行不会添加面向模型的工具 schema；消费方可对报告分页，而不用把完整研究记录放进调用方上下文。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- `deep_research` 消费方需要调用方 Session，并通过本提供方推导所有者权限。它与引擎分别启用。
- URL 引用检查只确认引用来自已接受的抓取来源，不能核实每项事实陈述。
- Profile 所有权仅适用于明确的单用户组合；此提供方不会认证不同的人类主体。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
