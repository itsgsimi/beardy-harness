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
 * Yes-or-no questions a classifier answers about one event's frames. `person_on_property` means a
 * person on the porch, walkway, yard, or driveway, not only on the sidewalk or street;
 * `person_at_door` a person at the front door; `person_staying` a person who stays in view instead
 * of walking past; `package_present` a package lying on the property; `package_being_delivered` a
 * person carrying a package onto the property or setting one down; `vehicle_arriving` a vehicle
 * pulling in, waiting at the driveway entrance with its lights on, or standing in the driveway with a
 * door open or a person getting out; `vehicle_leaving` a vehicle backing or driving out onto the street.
 */
export type CameraQuestion =
  | 'person_on_property' | 'person_at_door' | 'person_staying' | 'package_present' | 'package_being_delivered'
  | 'vehicle_arriving' | 'vehicle_leaving'

/** One answered question: the answer and the zero-based indices of the frames that show it. */
export interface CameraAnswer {
  /** True only with at least one evidence frame. */
  readonly answer: boolean
  /** Frame indices that show the answer, ascending. */
  readonly frames: readonly number[]
}

/** Structured classification of one event's frames. */
export interface CameraVerdict {
  /** Distinct object classes visible in any frame. */
  readonly labels: readonly CameraLabel[]
  /** Largest simultaneous count per visible class. */
  readonly counts: Readonly<Partial<Record<CameraLabel, number>>>
  /** One-line description of what the frames show. */
  readonly description: string
  /** Answers to the questions the classifier was asked and answered validly. */
  readonly answers: Readonly<Partial<Record<CameraQuestion, CameraAnswer>>>
}
