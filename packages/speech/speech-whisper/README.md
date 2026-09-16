---
description: "Configure and use local voice input in the harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-speech-whisper

English | [中文](README.zh.md)

## Summary

Use a local whisper.cpp server to turn browser recordings and incoming audio files into text. Browser dictation stays in the draft until the user sends it. Discord voice messages and standard audio attachments enter the normal user-message flow after transcription. FFmpeg runs on the harness host, with byte, duration, concurrency, and time limits.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount this plugin in the host composition alongside a subprocess provider. Enable the shipped `speech-whisper` row with a profile patch. The endpoint must accept whisper.cpp's multipart `/inference` protocol. Install FFmpeg on the harness host and keep the inference endpoint private.

```yaml
- id: speech-whisper
  disabled: false
  config:
    endpoint: http://127.0.0.1:8178/inference
    ffmpegPath: ffmpeg
    maxAudioBytes: 16777216
    maxDurationSeconds: 180
    timeoutMs: 120000
    maxConcurrent: 2
```

| Field | Default | Meaning |
|---|---|---|
| `endpoint` | required | Local whisper.cpp inference URL |
| `ffmpegPath` | required | Audio decoder executable |
| `maxAudioBytes` | required | Maximum encoded upload size |
| `maxDurationSeconds` | required | Maximum decoded recording duration |
| `timeoutMs` | required | Deadline for the complete transcription |
| `maxConcurrent` | required | Maximum simultaneous transcriptions |

The base profile supplies the values shown above but leaves speech disabled. Browser capture uses the authenticated `/api/speech` route. Discord audio follows the gateway's existing admission rules. Standard audio file attachments are transcribed before the user message is committed.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The provider decodes one track into bounded 16 kHz mono PCM with a pipe-only FFmpeg protocol allowlist, wraps it in WAV, and sends it to whisper.cpp. Aborting a request or unloading the plugin terminates the subprocess and drains pending work. The optional attachment consumer adds the transcript beside the durable file reference; the Discord consumer validates CDN URLs and preserves the sender and channel identity.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Composer](../../client/ui-conversation/README.md)
- [Discord gateway](../../discord/discord-gateway/README.md)
- [Web client](../../../docs/subsystems/web-client.md)

<a id="model-experience"></a>
## Model Experience

### User transcript

#### What the model sees

Audio attachments add `Voice transcript for <filename>:` and the recognized text to the same user message. Discord adds `Voice transcript:` while retaining its ordinary message source. Browser recordings become ordinary draft text; the user controls submission.

#### Token effect

Transcribed words add user-message tokens proportional to their length. The plugin adds no tool schema or fixed prompt.

#### KV Cache effect

The transcript appends at the ordinary user-message boundary and leaves the existing request prefix unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The current voice feature has these limits.

- FFmpeg and a running compatible inference server are required.
- The model determines supported languages and recognition quality; the current deployment uses English `base.en`.
- Uploaded audio is recognized by common filename extensions. Live calls and speech output are not implemented.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Package tests cover bounded processing, cancellation, and lifecycle ownership.
