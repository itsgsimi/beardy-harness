# Camera events

English | [中文](camera.zh.md)

The [camera definition](../../packages/camera/camera/README.md) declares devices, events with stored frames, and verdicts. The [Ring provider](../../packages/camera/camera-ring/README.md) turns doorbell presses and motion alerts into events. The [camera watch](../../packages/camera/camera-watch/README.md) classifies each event's frames, decides whether to notify, hands notices to the delivery owner of their target, and answers the `camera` model tool from its history.

## Events and frames

A provider publishes one `camera/event` per accepted notification. The event names the configured device, its kind (`ding` or `motion`), the receipt time, and up to the configured number of frames. Each frame is an `ImageAttachmentRef` already committed to the attachment store, with its offset after the event and whether a snapshot or a live stream produced it. `captureFailure` reports a shortfall: `snapshot-unavailable` for a refused or timed-out snapshot and `snapshot-stale` for a snapshot that repeats the previous one, each when no stream fallback ran, `stream-failed` when the fallback ended short, and `storage-failed` when the attachment store refused a frame. Before the rest of the capture, a provider publishes `camera/preview` with the event's identity and its first stored frame, so a consumer can act while the remaining frames are still being captured; the complete `camera/event` with the same id follows unless the provider stops. Providers own admission: duplicate vendor notifications, per-device cooldowns, and overlapping captures never reach consumers.

## Verdicts and notices

A verdict lists visible labels (`person`, `vehicle`, `package`, `animal`), the largest simultaneous count of each, the dominant activity, what the vehicles do (`arriving`, `leaving`, `passing`, `parked`, `none`, or `unknown`), a confidence from 0 to 1, a one-line description, and the indices of frames showing a person. The watch produces it from one classification Session per event whose logged system prompt is the watch's own classification prompt and whose `user/message` carries the source kind `camera`, the prompt text, and the frames as image blocks; the Session has no tools and no runtime context, so the model input is reconstructable from the session log until the watch's retention sweep deletes the event's frames. Notification reasons are computed in code from the event and the verdict. `camera/notice` is a serial handoff: the listener that durably accepts the notice returns `true`, and the watch retries otherwise. The notice carries a stable id derived from the event id, so a retried handoff cannot post twice; a doorbell press can yield two notices, an immediate one when its first frame is stored and the classified one, with distinct ids. The watch also hands over a rate-limited failure notice when the model route is unusable or classification turns keep failing, and one recovery line after the next answered classification; their ids name a fixed time window instead of an event ([watch](../../packages/camera/camera-watch/README.md#use-this-package)).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcamera--cameraservice-abstract-seam"></a>

### `ctx.camera` — `CameraService` (abstract seam)

Provider-neutral camera capability; one provider owns `ctx.camera`.

```ts cordis-catalog
/**
 * List the configured devices this provider watches.
 * @returns devices in configuration order.
 */
abstract devices(): readonly CameraDevice[]
```

Source: [`packages/camera/camera/src/index.ts`](../../packages/camera/camera/src/index.ts)

<a id="camera-events"></a>

### `camera/*` events

<a id="cameraevent--parallel"></a>

#### `camera/event` — parallel

One accepted device event whose frames are already stored. Listeners should enqueue work and return; the provider awaits every listener and logs failures without retrying.

```ts cordis-catalog
/**
 * One accepted device event whose frames are already stored. Listeners should enqueue work
 * and return; the provider awaits every listener and logs failures without retrying.
 * @param event - device, kind, receipt time, and captured frames.
 * @mode parallel
 */
'camera/event'(event: CameraEvent): void | Promise<void>
```

Source: [`packages/camera/camera/src/index.ts`](../../packages/camera/camera/src/index.ts)

<a id="cameranotice--serial"></a>

#### `camera/notice` — serial

One camera notice awaiting durable acceptance by its delivery owner.

```ts cordis-catalog
/**
 * One camera notice awaiting durable acceptance by its delivery owner.
 * @param notice - stable identity, destination channel, text, and optional frame.
 * @returns true after durable acceptance, or undefined when no listener owns delivery.
 * @mode serial
 */
'camera/notice'(notice: CameraNotice): true | undefined | Promise<true | undefined>
```

Source: [`packages/camera/camera-watch/src/index.ts`](../../packages/camera/camera-watch/src/index.ts)

<a id="camerapreview--parallel"></a>

#### `camera/preview` — parallel

One accepted event's first stored frame, published before the provider captures the rest. The complete `camera/event` with the same id follows unless the provider stops first. Listeners should enqueue work and return, because the provider awaits them before the next frame.

```ts cordis-catalog
/**
 * One accepted event's first stored frame, published before the provider captures the rest.
 * The complete `camera/event` with the same id follows unless the provider stops first. Listeners
 * should enqueue work and return, because the provider awaits them before the next frame.
 * @param preview - event identity, device, kind, receipt time, and first frame.
 * @mode parallel
 */
'camera/preview'(preview: CameraPreview): void | Promise<void>
```

Source: [`packages/camera/camera/src/index.ts`](../../packages/camera/camera/src/index.ts)
<!-- END GENERATED cordis-surface -->
