---
description: "Beardy 工具共享的 TEXT_TOOL_OUTPUT defineTool 输出声明，用于完整结果只是一段文本的工具。"
kind: "package-library"
---

# @deepseek-ai/dsh-text-tool-output

[English](README.md) | 中文

## 概述

`TEXT_TOOL_OUTPUT` 是一个 `defineTool` 输出声明，适用于规范值为 `{ text }`（一个必需字符串）的工具。模型以单个文本部分接收该字符串。[tool-fantasy](../../fantasy/tool-fantasy/README.zh.md) 与 [camera-watch](../../camera/camera-watch/README.zh.md) 把它作为各自工具的 `output` 传入。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 入口

```text
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TEXT_TOOL_OUTPUT } from '@deepseek-ai/dsh-text-tool-output'

ctx.tools.register(defineTool({ name, description, parameters, output: TEXT_TOOL_OUTPUT, execute: async () => ({ text }) }))
```

工具注册表按声明的 schema 校验返回值，因此缺少字符串 `text` 的结果会作为无效工具输出失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `TEXT_TOOL_OUTPUT`：`{ text }` 对象 schema 及其单部分渲染器 |

-----

<a id="model-experience"></a>
## 模型体验

间接生效：tool-fantasy 与 camera-watch 拥有各自的工具 schema 与结果文本，本声明只把该文本渲染为一个文本部分。

#### KV Cache effect

无直接影响；每个工具结果都是由调用工具拥有的仅追加历史。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅限文本** — 该声明不携带结构化字段，需要呈现元数据的工具应声明自己的输出 schema。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

None.

</details>
