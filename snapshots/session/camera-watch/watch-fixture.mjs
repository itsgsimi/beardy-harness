/** The camera watch on a fixed clock one minute after the fixture event, so tool results are deterministic. */
import { Config, inject, mountCameraWatch } from '@deepseek-ai/dsh-camera-watch'
import { OCCURRED_AT } from './camera-fixture.mjs'

export const name = 'camera-watch-fixture'
export { Config, inject }

export function apply(ctx, config) {
  return mountCameraWatch(ctx, config, { now: () => OCCURRED_AT + 60_000 })
}
