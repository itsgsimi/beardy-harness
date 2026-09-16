# Agent Note: 本地语音输入

Status: implemented

[English](2026-09-16-local-voice-input.md) | 中文

## Problem

下游 Harness 需要用户键入消息，即使使用麦克风或 Discord 语音消息更方便。音频需要共享转换路径，同时保留输入框中的草稿和各网关的准入策略。

## Decision

添加可选的主机服务 `dsh-speech-whisper`。它限制编码字节数、解码时长、并发数和总耗时，通过托管子进程服务运行 FFmpeg，并将 WAV 发送到配置的 whisper.cpp 端点。基础配置包含明确参数，但默认禁用语音。卸载提供程序时会取消并等待活动任务结束。

通过 `conversation.input.right` 添加 `ui-voice`，使用共享工具栏控件、语义颜色及中英文文案。麦克风需要安全浏览器上下文。停止录音通过 `SessionInput.appendDraft()` 插入文字，不替换引用节点或发送消息；取消则丢弃录音。GET 能力查询使用缓冲请求策略，POST 音频上传使用流式策略。

Discord 音频先经过准入检查，再从受限的 Discord 附件 CDN URL 下载，并由现有频道队列处理。生成的普通用户消息保留来源。标准音频文件块在 `agent/pre-step` 阶段获得转写文字，同时保留持久附件和消息标识。音频不会被解释为网关命令或批准答复。

## Alternatives considered

- 浏览器语音识别依赖浏览器专用服务，无法让 Discord 附件使用同一后端。
- 每种传输使用独立解码程序会重复资源限制和清理逻辑。共享服务可集中这些保证。
- 自动发送听写文字会剥夺用户纠正识别错误的机会，因此保留明确的发送操作。

## Consequences

此功能需要 FFmpeg 和兼容的 whisper.cpp 服务。部署可以使用 CPU 推理，无需启用 IOMMU 或更改 LLM 加速器配置。语言支持由所选模型决定；初始部署使用英语 `base.en`。实时语音通话、唤醒词和语音合成不属于此功能。

验证包括语音提供程序测试（真实 FFmpeg、字节和时长限制、取消、附件）、Discord 音频及路由测试（CDN 验证、准入、纯音频消息投递）、浏览器组件测试（录音生命周期、草稿保留、取消），以及 `apps/web/tests/voice-input.e2e.ts`（内置配置、录音、移动布局和无密钥录制的 Agent 轮次）。新录制文件位于 `snapshots/web/voice-input`。
