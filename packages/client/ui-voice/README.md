---
description: "Configure and use local voice input in the harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-voice

English | [中文](README.zh.md)

## Summary

Dictate a message from the conversation composer using its microphone button. Stop recording to append the transcript to the existing draft, then review and send it normally. Cancel discards the recording. The control appears when the host provides speech transcription and uses the surrounding toolbar styles.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The web-app bundle mounts this plugin beside `ui-conversation`. Enable the host's [speech provider](../../speech/speech-whisper/README.md) to expose the microphone. Open the harness over HTTPS or localhost and grant microphone permission when recording starts.

Click the microphone, speak, and click Stop. The transcript appends without replacing existing text or attachment references. Cancel stops capture or transcription without inserting text. If another interaction temporarily owns the composer, use Insert transcript after that interaction ends.

There are no plugin configuration fields.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser plugin contributes to `conversation.input.right` through the slot registry. MediaRecorder produces a bounded recording; the control posts it to the host and calls the session input facade to append text. Capture tracks, HTTP requests, locales, and the slot contribution are released on cancellation or unload. No send action is invoked.

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

The reviewed transcript becomes ordinary `user/message` text only after the user sends the draft. Recording states, errors, and cancellation do not enter the model context.

#### Token effect

Transcribed words add user-message tokens proportional to their length. The plugin adds no tool schema or fixed prompt.

#### KV Cache effect

The transcript appends at the ordinary user-message boundary and leaves the existing request prefix unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The current voice feature has these limits.

- Browser microphone capture requires HTTPS or localhost and a compatible MediaRecorder implementation.
- Recording is explicit and bounded; there is no always-listening mode or automatic submission.
- Switching away from the composer cancels an in-progress recording.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Package tests cover bounded processing, cancellation, and lifecycle ownership.
