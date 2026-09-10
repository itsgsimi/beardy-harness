/** Native controls preserve the pending request and canonical answer through Discord presentation. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DiscordInteractionId } from '../src/interactions.ts'
import type { DiscordInteraction } from '../src/interactions.ts'
import { BOT_USER, CHANNEL, USER, harness, inbound } from './support.ts'

const active: ReturnType<typeof harness>[] = []
afterEach(async () => {
  await Promise.all(active.splice(0).map(h => h.router.dispose()))
  vi.unstubAllGlobals()
})
function setup(options: Parameters<typeof harness>[0] = {}) {
  const h = harness({ replyText: 'x', ...options, answerers: ['component', 'text'] })
  active.push(h)
  return h
}
function click(customId: string, overrides: Partial<Extract<DiscordInteraction, { kind: 'component' }>> = {}): Extract<DiscordInteraction, { kind: 'component' }> {
  return { kind: 'component', id: DiscordInteractionId('1472404859679670459'), applicationId: BOT_USER,
    channelId: CHANNEL, guildId: '', userId: USER, token: 'test-token', messageId: 'prompt-1', customId, values: [], ...overrides }
}
function customId(h: ReturnType<typeof harness>, index = 0): string {
  const id = h.prompts[index]?.components?.[0]?.components[0]?.custom_id
  expect(id).toBeDefined()
  return id as string
}
async function opened(options: Parameters<typeof harness>[0] = {}) {
  const h = setup(options)
  h.router.handle(inbound())
  await vi.waitFor(() => { expect(h.posted).toHaveLength(1) })
  return h
}

describe('rich Discord conversations', () => {
  it('shows command cards without starting a model session, and executes native commands without duplicate posts', async () => {
    const h = setup({ richMessages: true })
    h.router.handle(inbound({ content: '/help' }))
    await vi.waitFor(() => { expect(h.cards).toHaveLength(1) })
    expect(h.cards[0]?.embeds?.[0]?.description).toContain('**/status**')
    expect(h.cards[0]?.components?.[0]?.components).toHaveLength(3)
    expect(h.calls).not.toContain('agent-create')
    expect(await h.router.execute(CHANNEL, '/status')).toEqual({ kind: 'success', text: 'No conversation yet: your next message starts one.' })
    expect(h.cards).toHaveLength(1)
    expect(h.posted).toHaveLength(0)
    expect((await h.router.execute(CHANNEL, '/export')).kind).toBe('error')
  })

  it('binds an approval to its channel, user, prompt, and one-time request identity', async () => {
    const h = await opened()
    const result = Promise.resolve(h.emitWaterfall('approval/request', { agent: h.agent, toolName: 'bash', reason: 'Remove generated files' }))
    await vi.waitFor(() => { expect(h.prompts).toHaveLength(1) })
    const id = customId(h)
    expect(h.prompts[0]?.content).toContain('Remove generated files')
    expect(await h.router.component(click(id, { userId: '999999999999999999' }))).toContain('not available')
    expect(await h.router.component(click(id, { channelId: '1472404859679670499' }))).toContain('expired')
    expect(await h.router.component(click(id, { messageId: 'older-message' }))).toContain('expired')
    expect(await h.router.component(click(id))).toBe('Allowed once.')
    await expect(result).resolves.toBe('allowed-once')
    expect(await h.router.component(click(id))).toContain('already answered')
    await vi.waitFor(() => { expect(h.cleared).toEqual(['prompt-1']) })
  })

  it('rejects old approval buttons after replacement even if the prompt message id is reused', async () => {
    const h = await opened()
    const first = Promise.resolve(h.emitWaterfall('approval/request', { agent: h.agent, toolName: 'bash' }))
    await vi.waitFor(() => { expect(h.prompts).toHaveLength(1) })
    const old = customId(h)
    const second = Promise.resolve(h.emitWaterfall('approval/request', { agent: h.agent, toolName: 'write_file' }))
    await expect(first).resolves.toBe('cancelled')
    await vi.waitFor(() => { expect(h.prompts).toHaveLength(2) })
    expect(await h.router.component(click(old))).toContain('expired')
    const reject = h.prompts[1]?.components?.[0]?.components[1]?.custom_id as string
    expect(await h.router.component(click(reject))).toBe('Rejected.')
    await expect(second).resolves.toBe('rejected')
  })

  it('cancels a replaced approval while its network acknowledgement is still pending', async () => {
    const barrier = Promise.withResolvers<undefined>()
    const h = await opened({ promptBarrier: barrier.promise })
    try {
      const first = Promise.resolve(h.emitWaterfall('approval/request', { agent: h.agent, toolName: 'bash' }))
      await vi.waitFor(() => { expect(h.prompts).toHaveLength(1) })
      const second = Promise.resolve(h.emitWaterfall('approval/request', { agent: h.agent, toolName: 'write_file' }))
      await expect(first).resolves.toBe('cancelled')
      await vi.waitFor(() => { expect(h.prompts).toHaveLength(2) })
      barrier.resolve(undefined)
      await h.router.execute(CHANNEL, '/stop')
      await expect(second).resolves.toBe('cancelled')
    } finally { barrier.resolve(undefined) }
  })

  it('resolves select values to full canonical labels and rotates identity for each question', async () => {
    const h = await opened()
    const long = 'A'.repeat(200)
    const result = Promise.resolve(h.emitWaterfall('user-questions/request', { agent: h.agent, questions: [
      { id: 'first', question: 'Choose', options: [{ label: long }, { label: 'B' }], multiSelect: true },
      { id: 'second', question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] },
    ] }))
    await vi.waitFor(() => { expect(h.prompts).toHaveLength(1) })
    const first = customId(h)
    expect(await h.router.component(click(first, { values: ['99'] }))).toContain('not valid')
    expect(await h.router.component(click(first, { values: ['1', '2'] }))).toBe('Answer saved.')
    await vi.waitFor(() => { expect(h.prompts).toHaveLength(2) })
    expect(await h.router.component(click(first, { values: ['1'] }))).toContain('expired')
    expect(await h.router.component(click(customId(h, 1), { values: ['2'] }))).toBe('Answer saved.')
    await expect(result).resolves.toEqual({ answers: [{ id: 'first', selected: [long, 'B'] }, { id: 'second', selected: ['No'] }] })
    expect(h.cleared).toHaveLength(2)
  })

  it('ignores the late failure of a question prompt after its answer advanced to the next question', async () => {
    const firstPost = Promise.withResolvers<string>()
    const h = await opened({ promptResult: ordinal => ordinal === 1 ? firstPost.promise : Promise.resolve('prompt-2') })
    const result = Promise.resolve(h.emitWaterfall('user-questions/request', { agent: h.agent, questions: [
      { id: 'first', question: 'Choose', options: [{ label: 'A' }] },
      { id: 'second', question: 'Then?', options: [{ label: 'B' }] },
    ] }))
    try {
      await vi.waitFor(() => { expect(h.prompts).toHaveLength(1) })
      h.router.handle(inbound({ content: '1' }))
      await vi.waitFor(() => { expect(h.prompts).toHaveLength(2) })
      firstPost.reject(new Error('late delivery failure'))
      expect(await h.router.component(click(customId(h, 1), { messageId: 'prompt-2', values: ['1'] }))).toBe('Answer saved.')
      await expect(result).resolves.toEqual({ answers: [{ id: 'first', selected: ['A'] }, { id: 'second', selected: ['B'] }] })
    } finally { firstPost.resolve('prompt-1') }
  })

  it('delivers a complete assistant turn produced before an async command handler returns', async () => {
    const h = await opened()
    h.registeredCommands.set('finish', { name: 'finish', description: 'Finish a task', handler: async () => {
      h.events.push({ seq: h.events.length, type: 'turn/start', data: { turn: 2 } } as SessionEvent)
      h.events.push({ seq: h.events.length, type: 'assistant/message', data: {
        turn: 2, step: 1, message: { content: [{ type: 'text', text: 'Finished inside the command.' }] },
      } } as SessionEvent)
      h.events.push({ seq: h.events.length, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } } as SessionEvent)
      h.emitStatus(h.agent, 'idle')
      return { kind: 'success', text: 'Command finished.' }
    } })
    expect(await h.router.execute(CHANNEL, '/finish')).toEqual({ kind: 'success', text: 'Command finished.' })
    expect(h.posted.map(post => post.content)).toEqual(['x', 'Finished inside the command.'])
    h.emitStatus(h.agent, 'idle')
    expect(h.posted).toHaveLength(2)
  })

  it('keeps free text available for a question that has no select menu', async () => {
    const h = await opened()
    const result = Promise.resolve(h.emitWaterfall('user-questions/request', { agent: h.agent, questions: [{ id: 'tz', question: 'Timezone?' }] }))
    await vi.waitFor(() => { expect(h.prompts).toHaveLength(1) })
    expect(h.prompts[0]?.components).toEqual([])
    h.router.handle(inbound({ id: 'answer', content: 'America/Phoenix' }))
    await expect(result).resolves.toEqual({ answers: [{ id: 'tz', selected: [], custom: 'America/Phoenix' }] })
  })

  it('reports completion with ordered reactions without changing the final answer', async () => {
    const h = await opened({ reactionStatus: true, replyText: '**Ready**' })
    await vi.waitFor(() => { expect(h.reactions).toEqual(['add:👀', 'remove:👀', 'add:✅']) })
    expect(h.posted[0]?.content).toBe('**Ready**')
  })

  it('shows a failure card when a conversation cannot start and closes the processing reaction', async () => {
    const h = setup({ reactionStatus: true, richMessages: true, failAttach: true })
    h.router.handle(inbound())
    await vi.waitFor(() => { expect(h.cards).toHaveLength(1) })
    expect(h.cards[0]?.embeds?.[0]?.title).toBe('Request failed')
    expect(h.cards[0]?.embeds?.[0]?.description).not.toContain('attach failed')
    await vi.waitFor(() => { expect(h.reactions).toEqual(['add:👀', 'remove:👀', 'add:❌']) })
  })
})
