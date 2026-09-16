# Agent Note: Local voice input

Status: implemented

English | [中文](2026-09-16-local-voice-input.zh.md)

## Problem

The downstream harness requires typing even when a microphone or Discord voice note would be more convenient. Audio needs a shared conversion path that preserves the composer's existing draft and each gateway's admission policy.

## Decision

Add `dsh-speech-whisper` as an optional host service. It bounds encoded bytes, decoded duration, concurrency, and elapsed time; runs FFmpeg through the managed subprocess service; and sends WAV to a configured whisper.cpp endpoint. The base profile carries explicit configuration with speech disabled. Provider disposal aborts and drains active work.

Add `ui-voice` through `conversation.input.right`, using shared toolbar controls, semantic colors, and English/Chinese copy. Microphone capture requires a secure browser context. Stop inserts text through `SessionInput.appendDraft()` without replacing reference nodes or submitting the message; Cancel discards capture. The GET capability route uses a buffered request body policy, while POST audio intake streams.

Discord audio is admitted before downloading, restricted to Discord attachment CDN URLs, and processed in the existing channel queue. The resulting ordinary user message retains its source. Standard audio file blocks gain a transcript during `agent/pre-step`, preserving the durable attachment and message identity. Audio is not interpreted as a gateway command or approval response.

## Alternatives considered

- Browser speech recognition would depend on browser-specific services and would not support Discord attachments through the same backend.
- Separate decoders per transport would duplicate resource limits and cleanup. A shared service keeps those guarantees in one place.
- Automatically sending dictated text would remove the user's opportunity to correct recognition errors. The composer therefore retains explicit submission.

## Consequences

The feature requires FFmpeg and a compatible whisper.cpp server. The deployment can use CPU inference without enabling IOMMU or changing the LLM accelerator configuration. The selected model determines supported languages; the initial deployment uses English `base.en`. Live voice calls, wake words, and speech synthesis remain outside this feature.

Validation lives in the speech provider tests (real FFmpeg, byte/duration limits, cancellation, attachments), Discord audio and routing tests (CDN validation, admission, audio-only delivery), browser component tests (capture lifetime, retained drafts, cancellation), and `apps/web/tests/voice-input.e2e.ts` (shipped composition, recording, mobile layout, and a keyless recorded agent turn). The new fixture belongs to `snapshots/web/voice-input`.
