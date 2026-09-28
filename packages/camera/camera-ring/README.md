---
description: "Ring provider for ctx.camera: refresh-token login by credential reference, push events, cooldowns, and bounded frame capture."
kind: "package-reference"
---

# @deepseek-ai/dsh-camera-ring

English | [中文](README.zh.md)

## Summary

Watch Ring doorbells and cameras through the unofficial [`ring-client-api`](https://github.com/dgreif/ring) library. The provider signs in with a stored refresh token, writes every rotated token back to the same credential reference, receives doorbell and motion pushes for the configured devices, and publishes each accepted event with a few stored frames. Frames come from on-demand snapshots at the event time and fixed intervals after it; when a snapshot fails, one short live stream through the host's ffmpeg supplies the rest.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Run the library's login once outside the harness (`npx -p ring-client-api@14.3.0 ring-auth-cli`), answer its email, password, and two-factor prompts, and store the printed refresh token under a credential reference in the managed credential store, such as `RING_REFRESH_TOKEN` in `$DSH_HOME/.credentials.yaml`. The provider refuses to load when the reference is unset or resolves from a read-only source such as the process environment, because a rotation it cannot write back leaves the next restart with a stale token.

| Config | Meaning |
|---|---|
| `refreshTokenRef` | Credential reference holding the refresh token; rotations are written back to it |
| `devices` | `{ id, label, ringId }` or `{ id, label, ringName }` per watched device; names match case-insensitively |
| `events` | Accepted kinds, `motion` and `ding` by default |
| `frameCount`, `frameIntervalMs` | Frames per event (default 3) and their spacing (default 10 s) |
| `snapshotTimeoutMs` | Longest wait for one snapshot |
| `streamFallback`, `ffmpegPath`, `streamSetupMs` | Live-stream fallback, the absolute ffmpeg executable it requires, and its start bound |
| `motionCooldownMs`, `dingCooldownMs` | Minimum gap between accepted events of one kind on one device |
| `dedupeWindowMs`, `dedupeMaxIds` | How long and how many vendor event ids suppress repeated pushes |
| `reconnectDelayMs`, `maxReconnectDelayMs` | Doubling retry delay after a failed connection |
| `controlCenterDisplayName` | Name Ring lists for this client among authorized devices |

A configured device that the account does not contain stops the provider with an error that lists every device name and id in the account. A connection that fails for another reason, such as an unreachable Ring API, retries with a doubling delay.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Load checks the credential reference and the ffmpeg executable, then connects in the background. The first request refreshes the token; `ring-client-api` also re-encodes the token when its push credentials change, and every new value is written through `ctx.credentials.set` in rotation order. Diagnostics replace the wrapped token and its inner Ring token with `[redacted]`.

A push is admitted once per vendor event id, only for configured kinds, only outside that device's cooldown for its kind, and, for motion, only when that device is not already capturing; doorbell presses queue behind a running capture. Each admitted event gets up to `frameCount` frames: a snapshot at the receipt time and one per interval after it. A snapshot identical to the previous one is dropped. When a snapshot fails and `streamFallback` is on, one live call runs ffmpeg with a frame-rate filter into a private temporary directory for the remaining frames, and the directory is removed afterwards. Frames are stored through `ctx.attachments` as JPEG before the event is published; a shortfall is reported on the event as `snapshot-unavailable`, `stream-failed`, or `storage-failed`. Disposal stops subscriptions, cancels waits, disconnects, and waits for captures and token writes. No invariant companion is published because the provider keeps only transient admission state.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Camera subsystem](../../../docs/subsystems/camera.md) — events, frames, and verdicts.
- [Camera watch](../camera-watch/README.md) — classification, notices, and history.

-----

<a id="model-experience"></a>
## Model Experience

### Ring provider

#### What the model sees

The provider registers no tool, schema, or prompt. Its frames reach a model only through the camera watch's logged classification `user/message`.

#### Token effect

The provider adds no model tokens.

#### KV Cache effect

The provider does not alter request caching.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Ring publishes no official API; a Ring-side change can break sign-in, pushes, or snapshots until `ring-client-api` adapts.
- Pushes arrive through Firebase Cloud Messaging, so the host needs outbound TCP 5228 to `mtalk.google.com`.
- One harness process should own a refresh token. Two processes sharing it rotate it independently and can invalidate each other.
- Snapshots stop while motion detection is off in the Ring app's modes; the stream fallback then supplies frames.
- The live stream starts a few seconds after the push, so streamed frames begin later than snapshot frames.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
