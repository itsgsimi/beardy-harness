import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SessionStore from '@deepseek-ai/dsh-session'
import * as DiscordInvariant from '../src/invariant.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  return ctx
}

describe('tool-discord invariant companion', () => {
  it('registers under the package name and leaves unrelated events alone', async () => {
    const ctx = await setup()
    await expect(ctx.plugin(DiscordInvariant).then(() => undefined)).resolves.toBeUndefined()
    const session = ctx.sessions.create()
    expect(() => {
      session.append('turn/start', { turn: 1 })
      ctx.emit('tools/change')
    }).not.toThrow()
    expect([...session.ownEvents()].map(event => event.type)).toEqual(['turn/start'])
  })

  it('releases the package name when its fiber is disposed', async () => {
    const ctx = await setup()
    const companion = ctx.plugin(DiscordInvariant)
    await companion
    await companion.dispose()
    await expect(ctx.plugin(DiscordInvariant).then(() => undefined)).resolves.toBeUndefined()
  })
})
