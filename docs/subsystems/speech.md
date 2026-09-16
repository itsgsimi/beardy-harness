# Speech input

English | [中文](speech.zh.md)

The [speech provider](../../packages/speech/speech-whisper/README.md) owns audio decoding and transcription. It exposes `ctx.speech` to admitted message consumers and the authenticated Connection routes `/api/speech/config` (buffered GET) and `/api/speech` (streaming POST) to the browser. It runs FFmpeg through the managed subprocess service, then forwards a bounded WAV to a deployment-configured whisper.cpp endpoint.

## Input ownership

The [browser control](../../packages/client/ui-voice/README.md) owns microphone permission, recording, cancellation, and draft insertion. It contributes through the composer slot and uses `SessionInput.appendDraft()` to preserve existing text and references. Recording never triggers submission.

The [Discord gateway](../../packages/discord/discord-gateway/README.md) admits senders and channels before downloading audio from Discord's attachment CDN. Its existing per-channel queue serializes transcription and subsequent turns. It adds recognized words to the original message while preserving its source metadata. Voice content is ordinary user input, not a gateway command or approval response.

The optional attachment consumer recognizes common audio filenames in standard file blocks. At `agent/pre-step`, it appends recognized words beside the durable file reference before the user message is logged. Other transports using those blocks need no separate decoder.

## Limits and lifetime

Encoded bytes, decoded duration, concurrent requests, and total time have explicit configuration limits. FFmpeg may read pipes only. Cancellation or plugin disposal aborts uploads, terminates decoder processes, and waits for pending tasks. Transcription failures do not create empty user turns.

The base profile leaves speech disabled. Browser microphone capture requires HTTPS or localhost. The inference model controls supported languages; no NPU, live-call capture, or speech synthesis is required by this feature.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
