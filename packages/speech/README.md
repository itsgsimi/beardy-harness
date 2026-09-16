---
description: "Local speech transcription packages for browser dictation and message gateways."
kind: "package-group"
---

# speech/ — local speech input

English | [中文](README.zh.md)

## Summary

Use this group to turn voice recordings into ordinary user messages. The browser lets users review dictated text before sending. Message gateways and audio file uploads can share the same local backend.

| Package | Purpose | Service |
|---|---|---|
| [speech-whisper](speech-whisper/README.md) | Bounded decoding and whisper.cpp transcription | `ctx.speech` |

See the [speech subsystem](../../docs/subsystems/speech.md) for ownership and lifecycle, and [ui-voice](../client/ui-voice/README.md) for the browser control.
