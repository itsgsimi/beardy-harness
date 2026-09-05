/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-discord-gateway`.
 * @module @deepseek-ai/dsh-discord-gateway/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-discord-gateway'

/** Cordis companion plugin name. */
export const name = 'discord-gateway-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package appends no event of its own and owns no durable record. Each
 * admitted message reaches a Session as an ordinary `user/message`, whose logging and provenance the
 * core session already validates; Gateway connection state exists only for the live socket.
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
