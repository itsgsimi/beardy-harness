---
description: "Camera service definition: configured devices, motion and doorbell events, stored frames, and verdict types."
kind: "package-reference"
---

# @deepseek-ai/dsh-camera

English | [中文](README.zh.md)

## Summary

Use `ctx.camera` to learn which cameras a provider watches and to receive their doorbell presses and motion alerts as `camera/event`. Each event carries a bounded set of frames already stored in the attachment store, so consumers can show them to a model or attach them to a notice. The package also defines the structured verdict that consumers produce from those frames.

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

Mount a provider such as [camera-ring](../camera-ring/README.md), then listen for `camera/event`. A listener should queue its work and return; the provider waits for every listener before its next event on that device and logs a listener failure without retrying it. Listen for `camera/preview` to act on an event before its capture ends: it carries the event's id, device, kind, receipt time, and first stored frame, and the provider awaits its listeners before capturing the next frame. `devices()` lists the configured device ids and labels, which consumers use to validate their own references and to name cameras in prompts and notices.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The abstract service owns the `ctx.camera` key, the device list, and the protected `publish` and `publishPreview`, which run every `camera/event` or `camera/preview` listener in parallel and log each failure. Device ids are deployment-chosen, lowercase, and hyphenated; event ids are provider-built and repeat when a vendor repeats a notification. Frames are `ImageAttachmentRef` values with their capture offset from the event and whether a snapshot or a live stream produced them. The verdict type lists visible labels, per-label counts, the dominant activity, the vehicle activity (`arriving`, `leaving`, `passing`, `parked`, `none`, or `unknown`), a confidence from 0 to 1, a one-line description, and the frame indices showing a person. `CAMERA_LABELS`, `CAMERA_ACTIVITIES`, `CAMERA_VEHICLE_ACTIVITIES`, and `CAMERA_CAPTURE_FAILURES` list each closed set in canonical order. No invariant companion is published because the definition keeps no state of its own.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Camera subsystem](../../../docs/subsystems/camera.md) — events, frames, verdicts, and the notice handoff.
- [Camera watch](../camera-watch/README.md) — the consumer that classifies frames and notifies.

-----

<a id="model-experience"></a>
## Model Experience

### Camera service

#### What the model sees

This definition registers no tool, schema, or prompt. Frames reach a model only through a consumer's logged message, such as the camera watch's `user/message` with source kind `camera`.

#### Token effect

The definition adds no model tokens.

#### KV Cache effect

The definition does not alter request caching.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A provider is required to publish events; the definition has no way to request a new frame on demand.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
