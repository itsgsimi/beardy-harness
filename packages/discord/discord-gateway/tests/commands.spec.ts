import { describe, expect, it } from 'vitest'
import { registerGatewayCommands } from '../src/commands.ts'
import { CHANNEL, drain, harness, inbound } from './support.ts'

describe('registerGatewayCommands', () => {
  function collector() {
    const definitions = new Map<string, { description: string; handler: () => unknown }>()
    const agentCtx = {
      commands: { register: (definition: { name: string; description: string; handler: () => unknown }) => {
        definitions.set(definition.name, definition)
        return () => { definitions.delete(definition.name) }
      } },
    }
    return { agentCtx, definitions }
  }

  it('registers the three gateway commands with descriptions', () => {
    const { agentCtx, definitions } = collector()
    registerGatewayCommands(agentCtx as never, {
      startFresh: async () => 'fresh',
      status: () => 'status text',
      stopTurn: () => 'stop text',
    })
    expect([...definitions.keys()].sort()).toEqual(['new', 'status', 'stop'])
    for (const definition of definitions.values()) expect(definition.description).not.toBe('')
  })

  it('routes each handler to its router operation', async () => {
    const { agentCtx, definitions } = collector()
    registerGatewayCommands(agentCtx as never, {
      startFresh: async () => 'fresh',
      status: () => 'status text',
      stopTurn: () => 'stop text',
    })
    expect(await (definitions.get('new') as never as { handler: () => Promise<{ text: string }> }).handler()).toEqual({ kind: 'success', text: 'fresh' })
    expect((definitions.get('status') as never as { handler: () => { text: string } }).handler().text).toBe('status text')
    expect((definitions.get('stop') as never as { handler: () => { text: string } }).handler().text).toBe('stop text')
  })
})

describe('command dispatch through the router', () => {
  it('answers /status from durable state without opening a session', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handle(inbound({ content: '/status' }))
    await drain()
    expect(h.posted[0]?.content).toBe('No conversation yet: your next message starts one.')
    expect(h.calls).not.toContain('agent-create')
  })

  it('answers /stop with nothing running', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handle(inbound({ content: '/stop' }))
    await drain()
    expect(h.posted[0]?.content).toBe('Nothing is running in this conversation.')
  })

  it('answers a preset command for an unknown name', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handle(inbound({ content: '/bogus' }))
    await drain()
    expect(h.posted[0]?.content).toBe('No conversation is live: send a message first, then /bogus works.')
  })

  it('dispatches a preset command through the command registry once a conversation is live', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handle(inbound())
    await drain()
    h.router.handle(inbound({ id: 'm2', content: '/compact' }))
    await drain()
    expect(h.calls).toContain('execute:compact')
    expect(h.posted.some(entry => entry.content === 'ran /compact')).toBe(true)
  })

  it('posts the error text of a failing command', async () => {
    const h = harness({ replyText: 'x', commandOutcome: { kind: 'error', text: 'Nothing to compact.' } })
    h.router.handle(inbound())
    await drain()
    h.router.handle(inbound({ id: 'm2', content: '/compact' }))
    await drain()
    expect(h.posted.some(entry => entry.content === 'Nothing to compact.')).toBe(true)
  })

  it('reports a command whose result carries no text as done', async () => {
    const h = harness({ replyText: 'x', commandOutcome: { kind: 'success' } })
    h.router.handle(inbound())
    await drain()
    h.router.handle(inbound({ id: 'm2', content: '/compact' }))
    await drain()
    expect(h.posted.some(entry => entry.content === 'Done.')).toBe(true)
  })

  it('answers an unknown command for a live conversation', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handle(inbound())
    await drain()
    h.router.handle(inbound({ id: 'm2', content: '/bogus arg' }))
    await drain()
    expect(h.posted.some(entry => entry.content === '/bogus is not a known command.')).toBe(true)
  })

  it('cancels the running turn for /stop and reports it', async () => {
    const h = harness({ replyText: 'x', hang: true, turnTimeoutMs: 5_000 })
    h.router.handle(inbound())
    await drain()
    h.router.handle(inbound({ id: 'm2', content: '/stop' }))
    await drain()
    expect(h.calls).toContain('cancel:{"kind":"user"}')
    expect(h.posted.some(entry => entry.content === 'Cancelled the running turn.')).toBe(true)
    h.releaseIdle()
  })

  it('shows live state and the session id for /status', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handle(inbound())
    await drain()
    h.router.handle(inbound({ id: 'm2', content: '/status' }))
    await drain()
    const status = h.posted.find(entry => entry.content.startsWith('Session:'))?.content ?? ''
    expect(status).toContain(`discord-${CHANNEL}`)
    expect(status).toContain('Agent preset: beardy')
    expect(status).toContain('Permission preset: danger-full-access')
    expect(status).toContain('State: live')
    expect(status).toContain('Idle.')
  })

  it('reports a released conversation for /status after idle release', async () => {
    const h = harness({ replyText: 'x', idleReleaseMs: 5 })
    h.router.handle(inbound())
    await drain()
    h.router.handle(inbound({ id: 'm2', content: '/status' }))
    await drain()
    const status = h.posted.find(entry => entry.content.startsWith('Session:'))?.content ?? ''
    expect(status).toContain('State: released (resumes on your next message)')
  })

  it('answers /new with nothing to release', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handle(inbound({ content: '/new' }))
    await drain()
    expect(h.posted[0]?.content).toBe('Fresh conversation: your next message starts a new Session.')
    expect(h.calls).not.toContain('agent-create')
  })

  it('reports a running turn for /status while one hangs', async () => {
    const h = harness({ replyText: 'x', hang: true, turnTimeoutMs: 5_000 })
    h.router.handle(inbound())
    await drain()
    h.router.handle(inbound({ id: 'm2', content: '/status' }))
    await drain()
    const status = h.posted.find(entry => entry.content.startsWith('Session:'))?.content ?? ''
    expect(status).toContain('Turn in progress.')
    h.releaseIdle()
  })

  it('skips the arrival stamp when /new deleted the record mid-turn', async () => {
    const h = harness({ replyText: 'x', hang: true, turnTimeoutMs: 5_000 })
    h.router.handle(inbound())
    await drain()
    h.router.handle(inbound({ id: 'm2', content: '/new' }))
    await drain()
    h.releaseIdle()
    await drain()
    expect(h.calls.filter(call => call.startsWith('put:'))).toHaveLength(1)
  })

  it('warns when a command line fails inside the dispatcher', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handle(inbound())
    await drain()
    // /new releases the conversation; make that release fail loudly at the record layer.
    h.table.delete = async () => { throw new Error('storage down') }
    h.router.handle(inbound({ id: 'm2', content: '/new' }))
    await drain()
    expect(h.warnings.some(message => message.includes('command for message m2 failed'))).toBe(true)
  })
})
