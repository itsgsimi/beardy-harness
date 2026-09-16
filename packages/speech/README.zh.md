---
description: "用于浏览器听写和消息网关的本地语音转写包。"
kind: "package-group"
---

# speech/ — 本地语音输入

[English](README.md) | 中文

## 概述

使用此包组可将录音转为普通用户消息。浏览器允许用户在发送前检查听写文字。消息网关和音频文件上传可以共享同一本地后端。

| 包 | 用途 | 服务 |
|---|---|---|
| [speech-whisper](speech-whisper/README.zh.md) | 有界解码和 whisper.cpp 转写 | `ctx.speech` |

参阅[语音子系统](../../docs/subsystems/speech.zh.md)了解所有权和生命周期，参阅 [ui-voice](../client/ui-voice/README.zh.md)了解浏览器控件。
