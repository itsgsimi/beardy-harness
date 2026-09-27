/** Exercise feedback services and research run events before the SDK closes the recorded root turn. */
export const name = 'snapshot-feedback-producer'
export const inject = ['agents', 'sessions', 'commands', 'messageFeedback', 'sessionFeedback']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Composed runtime services.
 */
export function apply(ctx) {
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (agent.session.header.parentSession !== undefined) return
    const messages = agent.session.deriveMessages()
    const message = messages.findLast(message => message.role === 'assistant')
    if (message === undefined) throw new Error('feedback snapshot requires an assistant message')
    const command = await ctx.commands.execute(agent, '/feedback The session needs a clearer explanation.', [], signal)
    if (command?.result.kind !== 'success') throw new Error('feedback command did not succeed')
    const recorded = await ctx.sessionFeedback.record({ sessionId: agent.id, category: 'other' })
    if (!recorded.ok) throw new Error(recorded.error.code)
    const target = { sessionId: agent.id, messageId: message.id }
    const created = await ctx.messageFeedback.put({ ...target, rating: 'negative', note: 'Explain the result.', category: 'task-result', ifVersion: null })
    if (!created.ok) throw new Error(created.error.code)
    const edited = await ctx.messageFeedback.put({ ...target, rating: 'positive', note: 'The explanation is clear now.', ifVersion: created.value.version })
    if (!edited.ok) throw new Error(edited.error.code)
    const deleted = await ctx.messageFeedback.delete({ ...target, ifVersion: edited.value.version })
    if (!deleted.ok) throw new Error(deleted.error.code)
    if (JSON.stringify(agent.session.deriveMessages()) !== JSON.stringify(messages)) {
      throw new Error('feedback changed model-visible messages')
    }
    const run = await ctx.agents.create({ sessionId: 'rp-native-sdk-probe', meta: { cwd: agent.session.header.cwd } })
    try {
      const session = run.agent.session
      session.append('research/started', {
        id: 'rp-native-sdk-probe', owner: { kind: 'session', sessionId: agent.session.id }, callerSessionId: agent.session.id,
        query: 'SDK event projection', provider: 'fixture', model: 'fixture', createdAt: 0,
      })
      session.append('research/checkpoint', { round: 1, elapsedMs: 1, queries: ['SDK event projection'] })
      session.append('research/search', { round: 1, query: 'SDK event projection', status: 'error', urls: [], reason: 'fixture outage' })
      session.append('research/source', { round: 1, requestedUrl: 'https://example.com/research', status: 'error', retrievedAt: 0,
        reason: 'fixture outage' })
      session.append('research/finding', { round: 1, url: 'https://example.com/research', accepted: false,
        reason: 'no fetched text' })
      session.append('research/finished', { phase: 'failed', reason: 'fixture outage', finishedAt: 1 })
      if (!await ctx.sessions.flush(session)) throw new Error('research SDK fixture has no durability provider')
    } finally {
      await run.dispose()
    }
    agent.session.append('research/linked', { id: 'rp-native-sdk-probe' })
  })
}
