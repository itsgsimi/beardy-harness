/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-cron`.
 * @module @deepseek-ai/dsh-cron/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-cron'

/** Cordis companion plugin name. */
export const name = 'cron-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the durable job records are zod-validated on load and every mutation lands in
 * the storage domain before it becomes visible, so no independent observation can diverge from them.
 * Each fire reaches a Session as an ordinary `user/message` carrying cron provenance, which the core
 * session log already validates; timer state exists only while the process runs.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
