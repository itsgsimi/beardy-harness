---
description: "prompt 包组：由 Beardy 维护、用于塑造 Beardy Agent 作用域与工具向模型发送内容的辅助包，供浏览 packages/prompt/ 下各包的读者参考。"
kind: "package-group"
---

# prompt/ — 面向模型的 Beardy Agent 与工具辅助包

[English](README.md) | 中文

## 概述

prompt 包组收纳控制单一用途 Agent 作用域向模型发送内容的辅助包。[`dedicated-prompt`](dedicated-prompt/README.zh.md) 用一个由调用方拥有的完整提示词和固定温度替换该作用域组装出的提示词。[`text-tool-output`](text-tool-output/README.zh.md) 声明 Beardy 工具渲染为单个文本部分的 `{ text }` 输出。此包组基于现有的[系统提示词子系统](../../docs/subsystems/system-prompt.zh.md)，不新增服务。

## 包

| 包 | 职责 |
|---|---|
| [`dedicated-prompt`](dedicated-prompt/README.zh.md) | 为 Agent 作用域提供一个完整系统提示词，不含工具与运行时上下文 |
| [`text-tool-output`](text-tool-output/README.zh.md) | `TEXT_TOOL_OUTPUT`：单字符串工具结果的 `defineTool` 输出声明 |

## 开发备注

无。
