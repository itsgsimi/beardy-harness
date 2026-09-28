/** Camera capability vocabulary shared by providers and consumers. @module @deepseek-ai/dsh-camera/types */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Deployment-chosen device identity used in configuration, history, and model-facing results. */
export type CameraDeviceId = Branded<'CameraDeviceId'>

/** Provider-scoped identity of one device event; a repeated vendor notification repeats it. */
export type CameraEventId = Branded<'CameraEventId'>

/** One configured camera the active provider watches. */
export interface CameraDevice {
  /** Stable deployment identity, independent of the vendor's own device id. */
  readonly id: CameraDeviceId
  /** Short human label used in notices and model prompts, such as `Front door`. */
  readonly label: string
}

/** What the device reported: `ding` is a doorbell press, `motion` any motion alert. */
export type CameraEventKind = 'motion' | 'ding'

/** How a provider obtained one frame. */
export type CameraFrameSource = 'snapshot' | 'stream'

/**
 * Why a provider captured fewer frames than configured. `snapshot-unavailable` means the device
 * refused or timed out on snapshots and no stream fallback ran; `snapshot-stale` means the device
 * returned its previous snapshot again and no stream fallback ran; `stream-failed` means the
 * live-stream fallback ended without the missing frames; `storage-failed` means the attachment store
 * refused a frame.
 */
export type CameraCaptureFailure = 'snapshot-unavailable' | 'snapshot-stale' | 'stream-failed' | 'storage-failed'

/** One captured still, committed to the attachment store before its event is published. */
export interface CameraFrame {
  /** Durable normalized image reference. */
  readonly attachment: ImageAttachmentRef
  /** Milliseconds after the event's `occurredAt` when the frame was captured. */
  readonly offsetMs: number
  /** Capture path that produced the frame. */
  readonly source: CameraFrameSource
}

/** One accepted event's first stored frame, published before the provider captures the rest. */
export interface CameraPreview {
  /** Identity the complete {@link CameraEvent} repeats. */
  readonly id: CameraEventId
  /** Configured device that reported the event. */
  readonly deviceId: CameraDeviceId
  /** Reported event kind. */
  readonly kind: CameraEventKind
  /** Epoch milliseconds when the provider received the notification. */
  readonly occurredAt: number
  /** The event's first frame; the complete event lists it first. */
  readonly frame: CameraFrame
}

/** One device event and its bounded frame set, published once per accepted vendor notification. */
export interface CameraEvent {
  /** Provider-scoped identity; consumers use it for idempotent history and delivery. */
  readonly id: CameraEventId
  /** Configured device that reported the event. */
  readonly deviceId: CameraDeviceId
  /** Reported event kind. */
  readonly kind: CameraEventKind
  /** Epoch milliseconds when the provider received the notification. */
  readonly occurredAt: number
  /** Frames in capture order; empty when no frame could be captured. */
  readonly frames: readonly CameraFrame[]
  /** Present when the provider captured fewer frames than configured. */
  readonly captureFailure?: CameraCaptureFailure | undefined
}

/** Object classes a verdict can report. */
export type CameraLabel = 'person' | 'vehicle' | 'package' | 'animal'

/**
 * Dominant activity a verdict reports. `none` means nothing moving was identified; `unknown`
 * means the classifier gave no usable activity.
 */
export type CameraActivity = 'delivering' | 'lingering' | 'passing' | 'ringing' | 'none' | 'unknown'

/**
 * What the vehicles in a verdict's frames do. `arriving` and `leaving` mean a vehicle enters or
 * exits the driveway or parking spot; `passing` means a vehicle drives by without stopping;
 * `parked` means every visible vehicle stays still, even with lights or an engine on; `none` means
 * no vehicle is visible; `unknown` means the classifier gave no usable vehicle activity.
 */
export type CameraVehicleActivity = 'arriving' | 'leaving' | 'passing' | 'parked' | 'none' | 'unknown'

/** Structured classification of one event's frames. */
export interface CameraVerdict {
  /** Distinct object classes visible in any frame. */
  readonly labels: readonly CameraLabel[]
  /** Largest simultaneous count per visible class. */
  readonly counts: Readonly<Partial<Record<CameraLabel, number>>>
  /** Dominant activity across the frames. */
  readonly activity: CameraActivity
  /** What the visible vehicles do across the frames. */
  readonly vehicleActivity: CameraVehicleActivity
  /** Classifier confidence from 0 through 1. */
  readonly confidence: number
  /** One-line description of what the frames show. */
  readonly description: string
  /** Zero-based indices of frames showing at least one person, ascending. */
  readonly personFrames: readonly number[]
}
