# 语音输入

[English](speech.md) | 中文

[语音提供程序](../../packages/speech/speech-whisper/README.zh.md)负责音频解码和转写。它向已准入的消息消费者提供 `ctx.speech`，并向浏览器提供需要身份验证的 Connection 路由 `/api/speech/config`（缓冲 GET）和 `/api/speech`（流式 POST）。它通过托管子进程服务运行 FFmpeg，再将有界 WAV 发送到部署配置指定的 whisper.cpp 端点。

## 输入所有权

[浏览器控件](../../packages/client/ui-voice/README.zh.md)负责麦克风权限、录音、取消和草稿插入。它通过输入框插槽挂载，并使用 `SessionInput.appendDraft()` 保留现有文字和引用。录音不会触发发送。

[Discord 网关](../../packages/discord/discord-gateway/README.zh.md)在从 Discord 附件 CDN 下载音频之前检查发送者和频道。现有的频道队列按顺序执行转写和后续轮次。它将识别文字追加到原始消息并保留来源元数据。语音内容作为普通用户输入处理，不作为网关命令或批准答复。

可选附件消费者识别标准文件块中常见的音频文件名。在 `agent/pre-step` 阶段，它在持久文件引用旁追加识别文字，然后才记录用户消息。使用这些文件块的其他传输无需单独的解码程序。

## 限制和生命周期

编码字节数、解码时长、并发请求和总时间都有明确的配置限制。FFmpeg 仅可读取管道。取消或卸载插件会中止上传、终止解码进程并等待正在进行的任务结束。转写失败不会创建空用户轮次。

基础配置默认禁用语音。浏览器麦克风需要 HTTPS 或 localhost。语言支持取决于推理模型；此功能无需 NPU，也不包含实时通话捕获或语音合成。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxspeech--speechwhisper"></a>

### `ctx.speech` — `SpeechWhisper`

Speech remains outside the model loop; consumers submit the resulting text normally.

```ts cordis-catalog
/**
 * Transcribe bounded encoded audio with caller cancellation and provider shutdown.
 * @param data - encoded recording; ownership transfers to this call.
 * @param signal - caller cancellation, combined with the provider deadline and lifetime.
 * @returns trimmed recognized text, or an empty string when no speech is detected.
 */
transcribe(data: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<string>
```

Source: [`packages/speech/speech-whisper/src/index.ts`](../../packages/speech/speech-whisper/src/index.ts)
<!-- END GENERATED cordis-surface -->
