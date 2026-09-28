# 摄像头事件

[English](camera.md) | 中文

[摄像头定义](../../packages/camera/camera/README.zh.md)声明设备、带已存储画面的事件以及判定。[Ring 提供方](../../packages/camera/camera-ring/README.zh.md)把门铃按下和移动警报转为事件。[摄像头监视](../../packages/camera/camera-watch/README.zh.md)对每个事件的画面分类，决定是否通知，把通知交给 Discord 网关发件箱，并用自己的历史回答 `camera` 模型工具。

## Events and frames

提供方为每个被接纳的通知发布一个 `camera/event`。事件包含配置的设备、类型（`ding` 或 `motion`）、接收时间，以及不超过配置数量的画面。每帧画面都是已提交到附件存储的 `ImageAttachmentRef`，附带它相对事件的偏移，以及它来自快照还是直播流。`captureFailure` 报告画面不足。接纳由提供方负责：重复的厂商通知、单设备冷却时间内的事件和重叠的截取都不会到达使用方。

## Verdicts and notices

判定列出可见标签（`person`、`vehicle`、`package`、`animal`）、每个标签同时出现的最大数量、主要活动、0 到 1 的置信度、一行描述，以及出现人物的画面序号。监视插件为每个事件打开一个分类 Session 来生成判定，该 Session 的 `user/message` 带有来源类型 `camera`、提示文本以及作为图像块的画面，因此模型输入可以从会话日志重建。通知原因由代码根据事件和判定计算。`camera/notice` 是串行交接：持久接收通知的监听器返回 `true`，否则监视插件会重试。通知带有由事件 ID 派生的稳定 ID，因此重试交接不会重复发送。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
<!-- END GENERATED cordis-surface -->
