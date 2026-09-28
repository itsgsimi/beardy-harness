/**
 * Signal notice delivery: claims `camera/notice`, `health/transition`, and `cron/run-finished`
 * whose target is a Signal group or number, and hands the same text other transports deliver to
 * `ctx.signal`, answering `true` once the provider accepted it durably. Discord targets and
 * unparseable targets are left to their owners.
 * @module @deepseek-ai/dsh-signal-notices
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-camera-watch'
import { cronDeliveryContent } from '@deepseek-ai/dsh-cron'
import { signalTargetOf } from '@deepseek-ai/dsh-delivery-target'
import type {} from '@deepseek-ai/dsh-health'
import { SignalDeliveryId } from '@deepseek-ai/dsh-signal'
import type {} from '@deepseek-ai/dsh-signal'

/** Loader name of the notice consumer. */
export const name = 'signal-notices'

/** The Signal provider receives every claimed notice. */
export const inject = ['signal']

/**
 * Queue one notice when its target is a Signal destination.
 * @param ctx - consumer context with `ctx.signal`.
 * @param target - producer's delivery target.
 * @param id - producer's stable delivery identity.
 * @param text - notice text; undefined accepts the notice without sending anything.
 * @param image - stored image for the notice.
 * @returns true after durable acceptance, or undefined for a target another transport owns.
 */
export async function deliverNotice(ctx: Context, target: string, id: string, text: string | undefined,
  image?: ImageAttachmentRef): Promise<true | undefined> {
  const destination = signalTargetOf(target)
  if (destination === undefined) return undefined
  if (text !== undefined) {
    await ctx.signal.send({ id: SignalDeliveryId(id), target: destination, text, ...image === undefined ? {} : { image } })
  }
  return true
}

/**
 * Claim Signal-targeted notices from the camera watch, health probes, and scheduled runs.
 * @param ctx - consumer context with `ctx.signal`.
 */
export function apply(ctx: Context): void {
  ctx.on('camera/notice', notice => deliverNotice(ctx, notice.channelId, notice.id, notice.text, notice.image))
  ctx.on('health/transition', transition => deliverNotice(ctx, transition.channelId, transition.id, transition.text))
  ctx.on('cron/run-finished', async (run) => {
    if (run.deliverChannelId === undefined) return undefined
    return await deliverNotice(ctx, run.deliverChannelId, `cron:${run.sessionId}:${String(run.firedAt)}`, cronDeliveryContent(run))
  })
}
