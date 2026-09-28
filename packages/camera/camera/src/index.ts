/**
 * Camera service definition: the configured devices a provider watches and the events it publishes,
 * each carrying a bounded frame set already committed to the attachment store.
 * @module @deepseek-ai/dsh-camera
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  CameraActivity, CameraDevice, CameraDeviceId as CameraDeviceIdType, CameraEvent,
  CameraEventId as CameraEventIdType, CameraLabel,
} from './types.ts'

export type * from './types.ts'

/** Every object class a verdict can report, in canonical order. */
export const CAMERA_LABELS = Object.freeze(['person', 'vehicle', 'package', 'animal'] as const) satisfies readonly CameraLabel[]

/** Every activity a verdict can report, in canonical order. */
export const CAMERA_ACTIVITIES = Object.freeze(['delivering', 'lingering', 'passing', 'ringing', 'none', 'unknown'] as const) satisfies readonly CameraActivity[]

/**
 * Validate a deployment device id: lowercase letters, digits, and hyphens, starting with a letter.
 * @param value - configured id.
 * @returns branded device id.
 */
export function CameraDeviceId(value: string): CameraDeviceIdType {
  if (!/^[a-z][a-z0-9-]{0,39}$/u.test(value)) {
    throw new Error(`camera device id "${value}" must be 1 to 40 lowercase letters, digits, or hyphens starting with a letter`)
  }
  return brandString<CameraDeviceIdType>(value)
}

/**
 * Validate a provider event id: 1 to 128 letters, digits, `.`, `_`, `:`, or `-`.
 * @param value - provider-built id.
 * @returns branded event id.
 */
export function CameraEventId(value: string): CameraEventIdType {
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) throw new Error('camera event id must be 1 to 128 safe characters')
  return brandString<CameraEventIdType>(value)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Active camera provider. */
    camera: CameraService
  }
  interface Events {
    /**
     * One accepted device event whose frames are already stored. Listeners should enqueue work
     * and return; the provider awaits every listener and logs failures without retrying.
     * @param event - device, kind, receipt time, and captured frames.
     * @mode parallel
     */
    'camera/event'(event: CameraEvent): void | Promise<void>
  }
}

/** Provider-neutral camera capability; one provider owns `ctx.camera`. */
export abstract class CameraService extends Service {
  constructor(ctx: Context) {
    if (new.target === CameraService) throw new Error('load a camera provider, not the abstract definition')
    super(ctx, 'camera')
  }

  /**
   * List the configured devices this provider watches.
   * @returns devices in configuration order.
   */
  abstract devices(): readonly CameraDevice[]

  /**
   * Hand one event to every `camera/event` listener, containing listener failures so one broken
   * consumer never stops the provider or its other consumers.
   * @param event - accepted event with stored frames.
   */
  protected async publish(event: CameraEvent): Promise<void> {
    try {
      await this.ctx.parallel('camera/event', event)
    } catch (error: unknown) {
      /* v8 ignore next -- Context.parallel rejects only with an AggregateError of listener failures. */
      const reasons: unknown[] = error instanceof AggregateError ? error.errors : [error]
      for (const reason of reasons) {
        this.ctx.logger.warn(`camera: a camera/event listener failed for ${event.id}: ${reason instanceof Error ? reason.message : String(reason)}`)
      }
    }
  }
}

export default CameraService
