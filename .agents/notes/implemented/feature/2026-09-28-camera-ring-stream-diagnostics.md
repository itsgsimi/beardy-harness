# Agent Note: Ring capture failures name their cause

Status: implemented

English | [中文](2026-09-28-camera-ring-stream-diagnostics.zh.md)

## Problem

On 2026-09-28 all 18 live Ring events recorded `captureFailure: 'stream-failed'` and carried one or two snapshot frames instead of three. `captureStream` returned `stream-failed` from three places, a refused or throwing start, a start that outlived `streamSetupMs`, and a stream that left fewer frame files than requested, and discarded the cause each time. `ring-client-api` reports signalling, WebRTC, and ffmpeg failures through its own process-global logger, which by default writes only to the `ring` debug namespace, so the journal held nothing that said why.

## Decision

**The capture result carries its diagnostics.** `CaptureResult` gains `snapshotMiss`, the snapshot that ended the snapshot phase with its reason (`stale`, `refused` with the vendor error, or `timeout`), and `streamFailure`, present exactly when `failure` is `stream-failed`, with its stage: `start-refused` with the error, `start-timeout` with `streamSetupMs`, `ended-short` when the call ended first, or `run-timeout` when the capture bound stopped it, the last two with frames written and requested. `CameraCaptureFailure` values and capture behavior are unchanged.

**The provider logs one line per cause, redacted like every other diagnostic.** A snapshot miss logs `camera-ring: snapshot <n> for <event id> <reason>; streaming the remaining <k> frame(s)` at `info`, or `…; stream fallback is off`. A stream failure logs `camera-ring: stream capture for <event id> failed at <stage>: <cause>` at `warn`.

**The library logger is routed into `ctx.logger` for the provider's lifetime.** `logError` becomes `warn` and `logInfo` becomes `debug`, both prefixed `camera-ring: ring-client-api:` and redacted. The validated boolean `vendorDebug` (default false) calls the library's `enableDebug()`, which also exposes ffmpeg's stderr, and logs `logInfo` lines at `info` so they reach a journal at the default level. The library cannot report its default logger, so disposal installs a logger that drops every line, and it has no way to turn debug off, so `vendorDebug` stays on until the process exits.

## Alternatives considered

**Add stage-specific `CameraCaptureFailure` values.** That changes the camera event contract and every consumer for what is operator diagnostics, not a model- or user-visible distinction.

**Log inside `captureFrames`.** Capture has no logger or token secrets; returning structured detail keeps it a pure seam and lets the provider redact in one place.

**Set `RingApi({ debug: true })`.** It flips the same process-global switch as `enableDebug()`, but at each connection attempt through the client factory; calling `enableDebug()` once at load keeps the switch beside the logger bridge that makes its lines visible.

## Consequences

The next failed live capture names its stage in the journal; together with a `ring-client-api:` warn line it separates a Ring refusal, a call that ended before it was answered, an ffmpeg exit, and a stream that delivered too few frames. Capture tests pin each stage and snapshot reason; provider tests pin the exact log lines, redaction, the logger bridge, and `vendorDebug`; a client test drives the real `ring-client-api/util` logger. No model-visible or session output changes, so no session snapshot changes.
