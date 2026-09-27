---
description: "面向模型的 deep_research 工具，提供按所有者隔离的原生研究运行、进度、分页报告与取消操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-research

[English](README.md) | 中文

## 概述

`deep_research` 可启动持久的原生研究运行、检查进度、读取报告、列出调用方的运行，并请求取消。先挂载 `dsh-research-local`。工具通过 `ctx.research` 从当前 Session 推导权限；模型参数不能指定所有者。进程重启后仍可凭运行 ID 重新读取已完成的报告。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在同一个 Loader 组合中挂载研究定义、一个提供方及本消费方。`summaryPageChars` 限制会变化的状态和列表响应（默认 16,000 个 Unicode 字符）；`listLimit` 限制按所有者筛选的结果（默认 20）。两个字段均在加载时校验。每份报告使用运行的 `research/started` 预算中保存的分页大小。

| 操作 | 输入 | 结果 |
|---|---|---|
| `start` | 非空 `query` | 持久运行 ID、运行中状态和模型 |
| `status` | 运行 `id`、可选 `offset` | 进度页 |
| `report` | 运行 `id`、可选 `offset` | 报告与来源页 |
| `list` | 可选搜索 `query` 和 `offset` | 进行中与已保存运行的页面 |
| `cancel` | 运行 `id` | 是否已请求取消 |

读取响应包含 JSON 字段 `text`、`next_offset` 和 `total_chars`。`text` 是另一份 JSON 文档的片段：按每页的 `next_offset` 拼接全部页面后再解析。偏移量按 Unicode 字符计数；两次读取之间的进度变化可能使偏移量失效。报告第一页还带有包含完整 Markdown 和来源列表的 `researchArtifact` 展示元数据。报告不存在或运行不属于当前所有者时，工具返回不可用错误。`start` 将准确的工具调用 ID 用作幂等键，重放同一次调用会返回同一运行。

Beardy 将此包与 Odysseus 桥接一同提供，但默认禁用原生方案。[Beardy 切换说明](../../bundle/beardy/README.zh.md#select-native-deep-research)会同时启用提供方和工具并禁用桥接。同时挂载两个研究工具会在加载时失败。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

服务使用运行 Session 中保存的所有者检查状态、报告、列表和取消操作。工具通过 Cordis effect 注册，卸载会移除工具模式，持久运行则保留。工具不维护第二份运行注册表；提供方拥有状态，并在读取报告时检查附件文件。本包没有独立可变状态，因此不发布运行时不变量伴随包。

| 源码 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 工具模式、指引、分页和服务调用 |
| [`tests/tool-research.spec.ts`](tests/tool-research.spec.ts) | 所有权、分页、错误及注册行为 |

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 研究工具

#### 模型看到的内容

一个包含五种操作的 `deep_research` 模式。指引要求模型保留返回的 ID，在状态检查之间继续其他工作，读取报告的所有页面，引用来源 URL，并将报告内容视为不可信证据。工具结果进入调用方的 Session 日志。模型参数中没有所有者、提供方、模型或存储配置。

#### Token 影响

每个状态或列表结果最多保留 `summaryPageChars` 个 Unicode 字符的序列化数据及包装字段。报告页使用运行保存的 `reportPageChars` 预算。完整报告作为第一页的查看器元数据出现，不进入模型可见文本。

#### KV Cache 影响

固定组合下工具模式保持稳定；工具结果追加到调用方历史。启用原生工具会改变请求的工具列表。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 调用方必须显式检查状态；模型不会收到完成通知。取消只是请求，此时终态事件可能已经先提交。
- 引用 URL 匹配只能证明该 URL 已被抓取，不能证明它支持报告中的说法。来源内容应视为不可信数据。
- 配置档所有权适用于单用户部署；多用户配置档需要经认证的主体适配器。

<a id="dev-note"></a>
### 开发备注

[研究子系统](../../../docs/subsystems/research.zh.md)说明运行 Session、阶段 Session、恢复和证据提交顺序。
