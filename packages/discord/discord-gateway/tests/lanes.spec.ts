/** Actor lane selection across durable conversations, commands, and pending controls. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNativeInteractions } from '../src/native.ts'
import { DiscordInteractionId } from '../src/interactions.ts'
import type { DiscordInteraction, DiscordInteractionTransport } from '../src/interactions.ts'
import type { ConversationLane, DiscordCommandActor } from '../src/types.ts'
import { CHANNEL, GUILD_CHANNEL, SETTINGS, USER, harness, inbound, record } from './support.ts'

const OTHER = '138391763999129601'
const LANE_USER = '138391763999129602'
const APP = '138391763999129609'
const owners: { dispose: () => Promise<void> }[] = []

const ownLane: ConversationLane = {
  userId: USER, workspacePath: '/restricted', agentPreset: 'restricted',
  permissionPreset: 'read-only', excludedPresetCommands: ['export', 'danger'],
  toolFilter: { allow: ['read_file'] },
}

function opened(options: Parameters<typeof harness>[0] = {}) {
  const h = harness({ replyText: 'answered', ...options })
  owners.push(h.router)
  return h
}

function interaction(name: string, id: string): DiscordInteraction {
  return { kind: 'command', id: DiscordInteractionId(id), applicationId: APP,
    token: 'private-response-token', userId: USER, channelId: CHANNEL, guildId: '', name, arguments: '' }
}

afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.dispose()))
})

describe('Discord actor lanes', () => {
  it('releases an existing default-lane Agent before a restricted user runs a text command', async () => {
    const lanes = new Map<string, ConversationLane>()
    const h = opened({ userLanes: lanes })
    h.router.handle(inbound())
    await vi.waitFor(() => { expect(h.table.records.get(CHANNEL)?.lane).toBeUndefined(); expect(h.posted).toHaveLength(1) })
    const oldSession = h.table.records.get(CHANNEL)?.sessionId
    lanes.set(USER, ownLane)

    h.router.handle(inbound({ id: 'command', content: '/danger' }))
    await vi.waitFor(() => { expect(h.posted).toHaveLength(2) })
    expect(h.posted[1]?.content).toContain('not available')
    expect(h.calls).toContain('dispose')
    expect(h.table.records.has(CHANNEL)).toBe(false)
    expect(h.calls).not.toContain('execute:danger')

    h.router.handle(inbound({ id: 'restricted-message', content: 'continue' }))
    await vi.waitFor(() => { expect(h.table.records.get(CHANNEL)?.lane).toBe(USER) })
    expect(h.calls).toContain('workspace:/restricted')
    expect(h.calls).toContain('permission-set:read-only')
    expect(h.calls).toContain('restrict:{"allow":["read_file"]}')
    expect(h.calls).not.toContain(`agent-resume:${oldSession}`)
  })

  it('cancels an old-lane opening before a command can observe its Agent', async () => {
    const lanes = new Map<string, ConversationLane>()
    const h = opened({ userLanes: lanes, commands: lane => [
      { name: lane.userId === USER ? 'inspect' : 'danger', description: 'Preset command' },
    ] })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const create = h.ctx.agents.create.bind(h.ctx.agents)
    vi.spyOn(h.ctx.agents, 'create').mockImplementationOnce(async (options) => {
      entered.resolve(undefined)
      await release.promise
      return await create(options)
    })
    try {
      h.router.handle(inbound())
      await entered.promise
      lanes.set(USER, ownLane)
      const help = h.router.execute(CHANNEL, { userId: USER, directMessage: true }, '/help')
      release.resolve(undefined)
      expect((await help).text).toContain('**/inspect**')
      expect(h.table.records.has(CHANNEL)).toBe(false)
      expect(h.calls).not.toContain('execute:danger')
    } finally { release.resolve(undefined) }
  })

  it('resolves /help from the admitted user before a first message or an old durable record resumes', async () => {
    const lanes = new Map([[USER, ownLane]])
    const commands = (lane: ConversationLane) => [
      { name: 'help', description: 'Show commands' },
      { name: lane.userId === USER ? 'inspect' : 'danger', description: 'Preset command' },
    ]
    const fresh = opened({ userLanes: lanes, commands })
    fresh.router.handle(inbound({ content: '/help' }))
    await vi.waitFor(() => { expect(fresh.posted).toHaveLength(1) })
    expect(fresh.posted[0]?.content).toContain('**/inspect**')
    expect(fresh.posted[0]?.content).not.toContain('/danger')
    expect(fresh.calls).not.toContain('agent-create')

    const h = opened({ userLanes: lanes, initialRecord: record(), commands })
    h.router.handle(inbound({ content: '/help' }))
    await vi.waitFor(() => { expect(h.posted).toHaveLength(1) })
    expect(h.posted[0]?.content).toContain('**/inspect**')
    expect(h.posted[0]?.content).not.toContain('/danger')
    expect(h.table.records.has(CHANNEL)).toBe(false)
    expect(h.calls).not.toContain('agent-resume:discord-old-session')
    expect(h.calls).not.toContain('agent-create')

    const controls = opened()
    expect((await controls.router.execute(CHANNEL, { userId: USER, directMessage: true }, '/help')).text)
      .toContain('**/status**')
  })

  it('applies a configured tool restriction to the shared default lane', async () => {
    const h = opened({ toolFilter: { deny: ['shell'] } })
    h.router.handle(inbound())
    await vi.waitFor(() => { expect(h.posted).toHaveLength(1) })
    expect(h.calls).toContain('restrict:{"deny":["shell"]}')
  })

  it('uses the live lane registry for help and presents commands without a response body', async () => {
    const h = opened({ replyText: 'ready', commandOutcome: { kind: 'success' } })
    h.router.handle(inbound())
    await vi.waitFor(() => { expect(h.posted).toHaveLength(1) })
    expect((await h.router.execute(CHANNEL, { userId: USER, directMessage: true }, '/help')).text)
      .toContain('**/status**')
    h.router.handle(inbound({ id: 'bodyless-command', content: '/inspect' }))
    await vi.waitFor(() => { expect(h.posted).toHaveLength(2) })
    expect(h.posted[1]?.content).toBe('Done.')
  })

  it('admits commands only from allowlisted actors in their allowed channel lane', async () => {
    const laneUser = { ...ownLane, userId: LANE_USER }
    const h = opened({ allowedUserIds: [USER, OTHER, LANE_USER], userLanes: new Map([[LANE_USER, laneUser]]) })
    const run = (channelId: string, userId: string, directMessage: boolean) =>
      h.router.execute(channelId, { userId, directMessage }, '/status')
    expect((await run(CHANNEL, '138391763999129699', true)).text).toContain('not available to you')
    expect((await run(CHANNEL, USER, false)).text).toContain('not available to you')
    expect((await run(GUILD_CHANNEL, LANE_USER, false)).text).toContain('not available to you')
    expect((await run(GUILD_CHANNEL, OTHER, false)).text).toContain('No conversation yet')
  })

  it('carries the native actor through lane catalog checks and rejects the stale live conversation', async () => {
    const lanes = new Map<string, ConversationLane>()
    const h = opened({ userLanes: lanes })
    h.router.handle(inbound())
    await vi.waitFor(() => { expect(h.posted).toHaveLength(1) })
    lanes.set(USER, ownLane)
    const reply = vi.fn<DiscordInteractionTransport['reply']>(async () => {})
    const edit = vi.fn<DiscordInteractionTransport['edit']>(async () => {})
    const native = createNativeInteractions({ signal: h.controller.signal,
      settings: SETTINGS,
      policy: { allowedUserIds: new Set([USER]), allowedChannelIds: new Set<string>(),
        laneUserIds: new Set([USER]), guildRequireMention: true, botUserId: () => APP },
      applicationId: () => APP,
      commands: (actor: DiscordCommandActor) => actor.userId === USER && actor.directMessage
        ? [{ name: 'status', description: 'Status' }, { name: 'inspect', description: 'Inspect' }]
        : [{ name: 'danger', description: 'Danger' }],
      execute: (channel, actor, line, signal) => h.router.execute(channel, actor, line, signal),
      component: (subject, signal) => h.router.component(subject, signal),
      transport: { reply, edit, followup: async () => {} }, warn: vi.fn(),
    })
    owners.push(native)

    native.handle(interaction('danger', '1472404859679670457'))
    await vi.waitFor(() => { expect(edit).toHaveBeenCalledTimes(1) })
    expect(edit.mock.calls[0]?.[1].content).toContain('no longer available')
    expect(h.table.records.has(CHANNEL)).toBe(true)

    native.handle(interaction('inspect', '1472404859679670458'))
    await vi.waitFor(() => { expect(edit).toHaveBeenCalledTimes(2) })
    expect(edit.mock.calls[1]?.[1].content).toContain('No conversation is live')
    expect(h.table.records.has(CHANNEL)).toBe(false)
    expect(h.calls).not.toContain('execute:inspect')
  })

  it('does not let a new lane settle an old prompt through text, a button, or a reaction', async () => {
    const lanes = new Map<string, ConversationLane>()
    const h = opened({ userLanes: lanes, answerers: ['component', 'reaction', 'text'] })
    h.router.handle(inbound())
    await vi.waitFor(() => { expect(h.posted).toHaveLength(1) })
    const approval = Promise.resolve(h.emitWaterfall('approval/request', { agent: h.agent, toolName: 'shell' }))
    await vi.waitFor(() => { expect(h.prompts).toHaveLength(1) })
    lanes.set(USER, ownLane)
    const customId = h.prompts[0]?.components?.[0]?.components[0]?.custom_id ?? ''
    expect(await h.router.component({ kind: 'component', id: DiscordInteractionId('1472404859679670459'),
      applicationId: APP, token: 'private-response-token', userId: USER, channelId: CHANNEL,
      guildId: '', messageId: 'prompt-1', customId, values: [] })).toContain('expired')
    h.router.handleReaction({ userId: USER, channelId: CHANNEL, messageId: 'prompt-1', emojiName: '✅' })
    h.router.handle(inbound({ id: 'new-lane-answer', content: 'yes' }))
    await expect(approval).resolves.toBe('cancelled')
    await vi.waitFor(() => { expect(h.table.records.get(CHANNEL)?.lane).toBe(USER) })
  })

  it('runs native controls as the actor and refuses own-lane controls in guild channels', async () => {
    const lanes = new Map<string, ConversationLane>()
    const h = opened({ userLanes: lanes })
    h.router.handle(inbound())
    await vi.waitFor(() => { expect(h.posted).toHaveLength(1) })
    lanes.set(USER, ownLane)
    const control = { kind: 'component' as const, id: DiscordInteractionId('1472404859679670461'),
      applicationId: APP, token: 'private-response-token', userId: USER, channelId: CHANNEL,
      guildId: '', messageId: 'old-control', customId: 'dsh:command:status', values: [] }
    expect(await h.router.component(control)).toContain('No conversation yet')
    expect(h.table.records.has(CHANNEL)).toBe(false)
    expect(h.calls).toContain('dispose')
    const guild = opened({ userLanes: new Map([[USER, ownLane]]) })
    expect(await guild.router.component({ ...control, channelId: GUILD_CHANNEL, guildId: '138391763999129603' }))
      .toContain('not available to you')
  })

  it('shares a default guild channel between admitted users while excluding own-lane users', async () => {
    const lanes = new Map([[LANE_USER, { ...ownLane, userId: LANE_USER }]])
    const h = opened({ allowedUserIds: [USER, OTHER, LANE_USER], userLanes: lanes })
    const guild = { channelId: GUILD_CHANNEL, guildId: '138391763999129603', channelType: 0 }
    h.router.handle(inbound({ ...guild, id: 'one', authorId: USER }))
    await vi.waitFor(() => { expect(h.posted).toHaveLength(1) })
    h.router.handle(inbound({ ...guild, id: 'two', authorId: OTHER }))
    await vi.waitFor(() => { expect(h.posted).toHaveLength(2) })
    h.router.handle(inbound({ ...guild, id: 'three', authorId: LANE_USER, content: '/status' }))
    expect(h.calls.filter(call => call === 'agent-create')).toHaveLength(1)
    expect(h.table.records.get(GUILD_CHANNEL)?.lane).toBeUndefined()
    expect(h.posted).toHaveLength(2)
  })

  it('allows another admitted default-lane user to answer a shared guild prompt', async () => {
    const h = opened({ allowedUserIds: [USER, OTHER], answerers: ['text'] })
    const guild = { channelId: GUILD_CHANNEL, guildId: '138391763999129603', channelType: 0 }
    h.router.handle(inbound({ ...guild, authorId: USER }))
    await vi.waitFor(() => { expect(h.posted).toHaveLength(1) })
    const approval = Promise.resolve(h.emitWaterfall('approval/request', { agent: h.agent, toolName: 'shell' }))
    await vi.waitFor(() => { expect(h.prompts).toHaveLength(1) })
    h.router.handle(inbound({ ...guild, id: 'answer', authorId: OTHER, content: 'yes' }))
    await expect(approval).resolves.toBe('allowed-once')
    expect(h.table.records.get(GUILD_CHANNEL)?.lane).toBeUndefined()
  })
})
