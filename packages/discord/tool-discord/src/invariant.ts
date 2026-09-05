/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-discord`.
 * @module @deepseek-ai/dsh-tool-discord/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-discord'

/** Cordis companion plugin name. */
export const name = 'tool-discord-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package appends no event of its own and owns no durable record. Every
 * call is logged as a `tool/call` and `tool/result` pair by the tool registry, which validates that
 * relation; delivery itself happens outside the session log.
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
