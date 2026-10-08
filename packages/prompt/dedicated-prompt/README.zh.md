---
description: "面向单一用途模型轮次的 Agent 作用域隔离，供 camera-watch 分类与 research-local 阶段使用：一个完整系统提示词、不含工具 schema 与运行时上下文，以及固定温度。"
kind: "package-library"
---

# @deepseek-ai/dsh-dedicated-prompt

[English](README.md) | 中文

## 概述

`installDedicatedPrompt` 让一个 Agent 作用域只依据调用方提供的完整系统提示词作答。部署人设、其他所有提示词分节、运行时上下文以及所有工具 schema 都不会进入该作用域的请求，且每次请求都带上调用方指定的温度。camera-watch 分类与 research-local 阶段轮次在各自短生命周期 Agent 的 `setup` 中调用它。它只使用公开的 System Prompt 与 Agent 扩展点，并返回一个 disposer。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 何时使用

当一次模型调用必须只看到一个提示词且不带工具（例如分类器或产出 JSON 的阶段），同时仍作为普通的、有日志的 Agent 轮次运行时使用它。[camera-watch](../../camera/camera-watch/README.zh.md) 与 [research-local](../../research/research-local/README.zh.md) 是当前的使用方。

### 入口

```text
import { installDedicatedPrompt } from '@deepseek-ai/dsh-dedicated-prompt'

ctx.agents.create({ setup: agentCtx => {
  installDedicatedPrompt(agentCtx, { systemPrompt: STAGE_PROMPT, temperature: 0.2 })
} })
```

调用返回一个 disposer，用于移除全部四项注册。释放 Agent 作用域同样会移除它们。[`DedicatedPrompt`](src/index.ts) 接口说明了每个字段。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

该辅助函数在 Agent 的作用域上下文中注册四项内容。一个以人设前缀分节命名、位于部署人设前缀顺序的 `complete` 分节遮蔽其他所有分节。`suppressRuntimeContext()` 丢弃运行时上下文块。一个 `system-prompt/assemble` 监听器在链路其余部分运行后清空工具 schema，因此其他插件稍后在该作用域注册的工具同样被隐藏。一个 `agent/request` 监听器设置 `temperature`，日志中的请求头会记录它。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `installDedicatedPrompt` 与 `DedicatedPrompt` |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [系统提示词子系统](../../../docs/subsystems/system-prompt.zh.md) — 分节、完整分节与组装。
- [Agent 包](../../core/agent/README.zh.md) — Agent 作用域与 `agent/request` waterfall。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 camera-watch 分类与 research-local 阶段轮次产生影响；它们拥有本辅助函数应用到其 Agent 作用域上的完整系统提示词文本与温度。

#### KV Cache 影响

不直接造成失效；每个使用方的专用提示词是其自身 Agent 作用域的稳定前缀，该文本的任何变更由使用方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **不拦截工具执行** — 该辅助函数隐藏工具 schema，但不拒绝工具调用；每个调用方自行安装带有自身拒绝文本的 `tools.guard`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
