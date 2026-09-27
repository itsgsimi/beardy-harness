import { mkdtemp, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import ResearchService, { ResearchRunId } from '@deepseek-ai/dsh-research'
import type { ResearchOwner } from '@deepseek-ai/dsh-research/types'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import WebRuntime from '@deepseek-ai/dsh-web'
import LocalResearchService, { projectResearchRun, type Config } from '../src/index.ts'
import { DEFAULT_BUDGETS } from '../src/config.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  try {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  } finally {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  }
})

async function setup(root?: string, config: Config = { provider: 'mock', model: 'test-model' }): Promise<{
  ctx: Context
  root: string
  providerFiber: Awaited<ReturnType<Context['plugin']>>
}> {
  const path = root ?? await mkdtemp(join(tmpdir(), 'dsh-research-'))
  if (root === undefined) roots.push(path)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(path, 'sessions'), compression: 'none' })
  await ctx.plugin(LocalAttachmentStore, { dshHome: path })
  await ctx.plugin(WebRuntime)
  await ctx.plugin(AgentLoop, { agents: [] })
  const providerFiber = await ctx.plugin(LocalResearchService, config)
  return { ctx, root: path, providerFiber }
}

async function caller(ctx: Context, name: string) {
  const handle = await ctx.agents.create({ sessionId: SessionId(name) })
  return { handle, session: handle.agent.session, owner: { kind: 'session', sessionId: handle.agent.session.id } as ResearchOwner }
}

describe('research run storage', () => {
  it('starts once per exact caller key and rejects reused keys with a different question', async () => {
    const { ctx } = await setup()
    const source = await caller(ctx, 'caller-key')
    const first = await (ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: '  Explain A  ', requestKey: 'call-1' })
    const again = await (ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'Explain A', requestKey: 'call-1' })
    expect(again.id).toBe(first.id)
    expect((await ctx.research.list({ owner: source.owner, limit: 10 }))).toHaveLength(1)
    await expect((ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'Explain B', requestKey: 'call-1' }))
      .rejects.toThrow(/different query/)
    expect((await ctx.sessionPersistence.list()).map(row => row.header.id)).toContain(first.id)
    await source.handle.dispose()
  })

  it('hides foreign runs across every read and cancellation', async () => {
    const { ctx } = await setup()
    const source = await caller(ctx, 'caller-owner')
    const foreign = await caller(ctx, 'caller-foreign')
    expect(ctx.research.ownerFor(source.session)).toEqual(source.owner)
    const run = await (ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'Private' })
    await expect(ctx.research.status(run.id, foreign.owner)).rejects.toThrow('research run unavailable')
    await expect(ctx.research.report(run.id, foreign.owner)).rejects.toThrow('research run unavailable')
    await expect(ctx.research.cancel(run.id, foreign.owner)).rejects.toThrow('research run unavailable')
    expect(await ctx.research.list({ owner: foreign.owner, limit: 10 })).toEqual([])
    await expect((ctx.research as LocalResearchService).startStored({ caller: foreign.session, owner: source.owner, query: 'Forge' })).rejects.toThrow(/owner/)
    await source.handle.dispose()
    await foreign.handle.dispose()
  })

  it('keeps a durable orphan when caller linkage fails and reconciles it after restart', async () => {
    const { ctx, root } = await setup()
    const source = await caller(ctx, 'caller-partial')
    const off = ctx.on('session/flush', (session) => {
      if (session.id === source.session.id) throw new Error('caller disk failed')
    })
    await expect((ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'Partial', requestKey: 'partial-key' }))
      .rejects.toThrow('caller disk failed')
    off()
    const before = await ctx.research.list({ owner: source.owner, limit: 10 })
    expect(before).toHaveLength(1)
    expect(before[0]?.phase).toBe('running')
    await source.handle.dispose()
    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)

    const reopened = (await setup(root)).ctx
    const after = await reopened.research.list({ owner: source.owner, limit: 10 })
    expect(after).toMatchObject([{ id: before[0]?.id, phase: 'interrupted' }])
    expect(await reopened.research.cancel(before[0]!.id, source.owner)).toEqual({ requested: false })
  })

  it('keeps a committed draft readable when restart interrupts its run', async () => {
    const { ctx, root } = await setup()
    const source = await caller(ctx, 'caller-draft-restart')
    const local = ctx.research as LocalResearchService
    const run = await local.startStored({ caller: source.session, owner: source.owner, query: 'Draft' })
    const draftRef = await ctx.attachments.saveFile({ data: new TextEncoder().encode('# Draft'), name: 'draft.md' })
    await local.checkpoint(run.id, source.owner, { round: 1, elapsedMs: 1, draftRef })
    await source.handle.dispose()
    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    const reopened = (await setup(root)).ctx
    expect(await reopened.research.status(run.id, source.owner)).toMatchObject({ phase: 'interrupted', reportAvailable: true })
    expect(await reopened.research.report(run.id, source.owner)).toMatchObject({ complete: false, markdown: '# Draft' })
  })

  it('does not acknowledge a run whose first run checkpoint fails', async () => {
    const { ctx } = await setup()
    const source = await caller(ctx, 'caller-flush')
    const off = ctx.on('session/flush', (session) => {
      if (session.id.startsWith('rp-native-')) throw new Error('run disk failed')
    })
    await expect((ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'Fail' }))
      .rejects.toThrow('run disk failed')
    off()
    expect((await ctx.research.list({ owner: source.owner, limit: 10 }))).toMatchObject([{ phase: 'running' }])
    await source.handle.dispose()
  })

  it('commits checkpoints and one cancellation terminal event', async () => {
    const { ctx } = await setup()
    const source = await caller(ctx, 'caller-cancel')
    const run = await (ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'Cancel' })
    const local = ctx.research as LocalResearchService
    const checkpoint = await local.checkpoint(run.id, source.owner, { round: 1, elapsedMs: 25, stageSessionId: SessionId('stage-1') })
    expect(checkpoint).toMatchObject({ round: 1, stageSessionIds: ['stage-1'] })
    // Each cancel reads its ownership before joining the mutation queue, so two
    // calls issued together queue in read-completion order. Issue the second
    // while the first holds the queue at its terminal commit.
    let second: Promise<{ requested: boolean }> | undefined
    const off = ctx.on('research/changed', ({ run: view }) => {
      if (view.id === run.id && view.phase === 'cancelled') second ??= ctx.research.cancel(run.id, source.owner)
    })
    const first = await ctx.research.cancel(run.id, source.owner)
    off()
    expect([first, await second]).toEqual([{ requested: true }, { requested: false }])
    expect((await ctx.research.status(run.id, source.owner)).phase).toBe('cancelled')
    expect(ctx.agents.get(SessionId(run.id))!.session.snapshotEvents()
      .filter(event => event.type === 'research/finished')).toHaveLength(1)
    expect(await local.checkpoint(run.id, source.owner, { round: 2, elapsedMs: 50 })).toMatchObject({ round: 1 })
    await source.handle.dispose()
  })

  it('commits files before completion and refuses a missing file on report read', async () => {
    const { ctx } = await setup()
    const source = await caller(ctx, 'caller-report')
    const run = await (ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'Report' })
    const local = ctx.research as LocalResearchService
    await local.finish(run.id, source.owner, { phase: 'completed', markdown: '# Answer', evidence: '{"sources":[]}', quality: 'verified_urls' })
    const report = await ctx.research.report(run.id, source.owner)
    expect(report).toMatchObject({ complete: true, markdown: '# Answer' })
    await unlink(ctx.attachments.fileHostPath(report.reportRef)!)
    await expect(ctx.research.report(run.id, source.owner)).rejects.toThrow()
    await source.handle.dispose()
  })

  it('keeps a run open when the second report attachment cannot be saved', async () => {
    const { ctx } = await setup()
    const source = await caller(ctx, 'caller-attachment-failure')
    const run = await (ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'Attachment order' })
    const save = ctx.attachments.saveFile.bind(ctx.attachments)
    let saved = 0
    const spy = vi.spyOn(ctx.attachments, 'saveFile').mockImplementation(async (request) => {
      if (++saved === 2) throw new Error('evidence disk failed')
      return save(request)
    })
    await expect((ctx.research as LocalResearchService).finish(run.id, source.owner, {
      phase: 'completed', markdown: '# Draft', evidence: '{}',
    })).rejects.toThrow('evidence disk failed')
    spy.mockRestore()
    expect(saved).toBe(2)
    expect((await ctx.research.status(run.id, source.owner)).phase).toBe('running')
    await expect(ctx.research.report(run.id, source.owner)).rejects.toThrow('research report unavailable')
    await source.handle.dispose()
  })

  it('rejects malformed run event order and missing reports', async () => {
    expect(projectResearchRun([])).toBeUndefined()
    const { ctx } = await setup()
    const source = await caller(ctx, 'caller-project')
    const run = await (ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'No report' })
    await expect(ctx.research.report(run.id, source.owner)).rejects.toThrow('research report unavailable')
    await expect(ctx.research.status(ResearchRunId('rp-native-missing'), source.owner)).rejects.toThrow('research run unavailable')
    await source.handle.dispose()
  })

  it('rejects invalid config and a direct abstract service mount', () => {
    expect(() => { Reflect.construct(ResearchService, [new Context()]) }).toThrow(/abstract definition/)
    const direct = new Context()
    contexts.push(direct)
    expect(new LocalResearchService(direct, { provider: 'p', model: 'm' })).toBeInstanceOf(LocalResearchService)
    for (const config of [
      { provider: ' ', model: 'm' },
      { provider: 'p', model: ' ' },
      { provider: 'p', model: 'm', ownerScope: 'profile' as const },
      { provider: 'p', model: 'm', ownerScope: 'profile' as const, ownerNamespace: ' ' },
      { provider: 'p', model: 'm', ownerNamespace: 'unexpected' },
    ]) {
      expect(() => new LocalResearchService(new Context(), config)).toThrow()
    }
  })

  it('isolates configured profile owners and validates the live caller', async () => {
    const { ctx } = await setup(undefined, {
      provider: 'mock', model: 'test-model', ownerScope: 'profile', ownerNamespace: 'home',
      maxReportBytes: 100, maxEvidenceBytes: 100,
    })
    const source = await caller(ctx, 'profile-caller')
    const owner: ResearchOwner = { kind: 'profile', namespace: 'home' }
    const other: ResearchOwner = { kind: 'profile', namespace: 'other' }
    await expect((ctx.research as LocalResearchService).startStored({ caller: source.session, owner: other, query: 'Question' })).rejects.toThrow(/configured profile/)
    await expect((ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'Question' })).rejects.toThrow(/configured profile/)
    expect(ctx.research.ownerFor(source.session)).toEqual(owner)
    const run = await (ctx.research as LocalResearchService).startStored({ caller: source.session, owner, query: 'Question' })
    expect(await ctx.research.status(run.id, owner)).toMatchObject({ id: run.id })
    await expect(ctx.research.status(run.id, other)).rejects.toThrow('research run unavailable')
    await expect(ctx.research.status(run.id, source.owner)).rejects.toThrow('research run unavailable')
    expect(await ctx.research.list({ owner: other, limit: 10 })).toEqual([])
    await source.handle.dispose()
    expect(() => ctx.research.ownerFor(source.session)).toThrow(/not live/)
    await expect((ctx.research as LocalResearchService).startStored({ caller: source.session, owner, query: 'Detached' })).rejects.toThrow(/not live/)
  })

  it('validates start inputs and filters owner-scoped listing pages', async () => {
    const { ctx } = await setup()
    const source = await caller(ctx, 'caller-list')
    await expect((ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: '  ' })).rejects.toThrow(/nonblank/)
    await expect((ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'A', requestKey: ' ' }))
      .rejects.toThrow(/requestKey/)
    await expect((ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'League', category: 'fantasy_football' }))
      .rejects.toThrow(/fantasy_football/)
    const first = await (ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'Alpha' })
    const second = await (ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'Beta' })
    expect((await ctx.research.list({ owner: source.owner, query: 'alp', limit: 5 })).map(view => view.id)).toEqual([first.id])
    expect((await ctx.research.list({ owner: source.owner, limit: 1 })).map(view => view.id)).toEqual([second.id])
    expect((await ctx.research.list({ owner: source.owner, limit: 1, cursor: second.id })).map(view => view.id)).toEqual([first.id])
    const now = vi.spyOn(Date, 'now').mockReturnValue(12345)
    try {
      const tied = [
        (await (ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'Tie one' })).id,
        (await (ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'Tie two' })).id,
      ]
      expect((await ctx.research.list({ owner: source.owner, limit: 10 })).map(view => view.id).filter(id => tied.includes(id)))
        .toEqual(tied.sort())
    } finally {
      now.mockRestore()
    }
    for (const limit of [0, 1.5]) {
      await expect(ctx.research.list({ owner: source.owner, limit })).rejects.toThrow(/limit/)
    }
    await expect(ctx.research.status(ResearchRunId('invalid'), source.owner)).rejects.toThrow('research run unavailable')
    await source.handle.dispose()
  })

  it('retains partial evidence, source references, and first terminal state', async () => {
    const { ctx } = await setup()
    const source = await caller(ctx, 'caller-partial-report')
    const run = await (ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'Sources' })
    const local = ctx.research as LocalResearchService
    const content = await ctx.attachments.saveFile({ data: new TextEncoder().encode('source body'), name: 'source.txt' })
    const record = { url: 'https://example.com', title: 'Example', retrievedAt: Date.now(),
      contentSha256: 'a'.repeat(64), content, truncated: false }
    await local.checkpoint(run.id, source.owner, { round: 2, elapsedMs: 30, source: record })
    const finished = await local.finish(run.id, source.owner, {
      phase: 'failed', reason: 'source outage', markdown: '# Partial', evidence: '{}', quality: 'partial',
    })
    expect(finished).toMatchObject({ phase: 'failed', reason: 'source outage', sourceCount: 1, reportAvailable: true })
    expect(await ctx.research.report(run.id, source.owner)).toMatchObject({ complete: false, sources: [record] })
    expect(await local.finish(run.id, source.owner, { phase: 'completed' })).toMatchObject({ phase: 'failed' })
    expect(await ctx.research.cancel(run.id, source.owner)).toEqual({ requested: false })
    await local.search(run.id, source.owner, { round: 3, query: 'late', status: 'error', urls: [] })
    expect((await ctx.research.status(run.id, source.owner)).phase).toBe('failed')
    await source.handle.dispose()
  })

  it('rejects partial file pairs and oversized complete artifacts before terminal commit', async () => {
    const { ctx } = await setup(undefined, { provider: 'mock', model: 'test-model', maxReportBytes: 3, maxEvidenceBytes: 2 })
    const source = await caller(ctx, 'caller-bounds')
    const run = await (ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'Bounds' })
    const local = ctx.research as LocalResearchService
    await expect(local.finish(run.id, source.owner, { phase: 'completed' })).rejects.toThrow(/requires report/)
    await expect(local.finish(run.id, source.owner, { phase: 'completed', markdown: 'ok' })).rejects.toThrow(/together/)
    await expect(local.finish(run.id, source.owner, { phase: 'completed', evidence: '{}' })).rejects.toThrow(/together/)
    await expect(local.finish(run.id, source.owner, { phase: 'completed', markdown: 'long', evidence: '{}' }))
      .rejects.toThrow(/byte limit/)
    await expect(local.finish(run.id, source.owner, { phase: 'completed', markdown: 'ok', evidence: 'bad' }))
      .rejects.toThrow(/byte limit/)
    expect((await ctx.research.status(run.id, source.owner)).phase).toBe('running')
    expect(await local.finish(run.id, source.owner, { phase: 'failed', reason: 'no sources' }))
      .toMatchObject({ phase: 'failed', reportAvailable: false })
    await source.handle.dispose()
  })

  it('refuses missing durability listeners and reports only flushed changes', async () => {
    const { ctx } = await setup()
    const source = await caller(ctx, 'caller-events')
    const changed: string[] = []
    ctx.on('research/changed', ({ run }) => { changed.push(run.phase) })
    const run = await (ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'Events' })
    const local = ctx.research as LocalResearchService
    expect(changed).toEqual(['running'])
    const off = ctx.on('session/flush', (session) => {
      if (session.id === SessionId(run.id)) throw new Error('checkpoint failed')
    })
    await expect(local.checkpoint(run.id, source.owner, { round: 1, elapsedMs: 1 })).rejects.toThrow('checkpoint failed')
    expect(changed).toEqual(['running'])
    off()
    await expect(local.checkpoint(run.id, source.owner, { round: 2, elapsedMs: 2 })).rejects.toThrow(/uncertain/)
    const fresh = await (ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'Fresh' })
    await local.checkpoint(fresh.id, source.owner, { round: 2, elapsedMs: 2 })
    await local.finish(fresh.id, source.owner, { phase: 'completed', reason: 'done', markdown: '# Done', evidence: '{}' })
    expect(changed).toEqual(['running', 'running', 'running', 'completed'])
    await source.handle.dispose()
  })

  it('validates event order from durable Session events', async () => {
    const session = Session.create(SessionId('projection'))
    const owner: ResearchOwner = { kind: 'session', sessionId: SessionId('caller') }
    const started = { id: ResearchRunId('rp-native-projection'), owner, callerSessionId: SessionId('caller'),
      query: 'Q', provider: 'p', model: 'm', createdAt: 1 }
    session.append('research/checkpoint', { round: 0, elapsedMs: 0 })
    expect(() => projectResearchRun(session.snapshotEvents())).toThrow(/checkpoint outside/)
    const sourceBeforeStart = Session.create(SessionId('source-before-start'))
    sourceBeforeStart.append('research/source', { round: 1, requestedUrl: 'https://example.com', status: 'error', retrievedAt: 2 })
    expect(() => projectResearchRun(sourceBeforeStart.snapshotEvents())).toThrow(/source outside/)
    const duplicate = Session.create(SessionId('duplicate'))
    duplicate.append('research/started', started)
    duplicate.append('research/started', started)
    expect(() => projectResearchRun(duplicate.snapshotEvents())).toThrow(/duplicate start/)
    const terminal = Session.create(SessionId('terminal'))
    terminal.append('research/finished', { phase: 'failed', finishedAt: 2 })
    expect(() => projectResearchRun(terminal.snapshotEvents())).toThrow(/invalid terminal/)
    const late = Session.create(SessionId('late'))
    late.append('research/started', started)
    late.append('research/finished', { phase: 'failed', finishedAt: 2 })
    late.append('research/checkpoint', { round: 1, elapsedMs: 1 })
    expect(() => projectResearchRun(late.snapshotEvents())).toThrow(/checkpoint outside/)
    const twice = Session.create(SessionId('twice'))
    twice.append('research/started', started)
    twice.append('research/finished', { phase: 'failed', finishedAt: 2 })
    twice.append('research/finished', { phase: 'failed', finishedAt: 3 })
    expect(() => projectResearchRun(twice.snapshotEvents())).toThrow(/invalid terminal/)
    const noReport = Session.create(SessionId('no-report'))
    noReport.append('research/started', started)
    noReport.append('research/finished', { phase: 'completed', finishedAt: 3 })
    expect(() => projectResearchRun(noReport.snapshotEvents())).toThrow(/has no report/)
    const { ctx } = await setup()
    const reportRef = await ctx.attachments.saveFile({ data: new TextEncoder().encode('a'), name: 'report.md' })
    const incomplete = Session.create(SessionId('incomplete'))
    incomplete.append('research/started', started)
    incomplete.append('research/finished', { phase: 'failed', finishedAt: 3, reportRef })
    expect(() => projectResearchRun(incomplete.snapshotEvents())).toThrow(/incomplete report references/)
  })

  it('rejects run logs whose start identity differs from the stored Session ID', async () => {
    const { ctx } = await setup()
    const source = await caller(ctx, 'caller-forged')
    const fake = await ctx.agents.create({ sessionId: SessionId('rp-native-forged') })
    fake.agent.session.append('research/started', {
      id: ResearchRunId('rp-native-other'), owner: source.owner, callerSessionId: source.session.id,
      query: 'Wrong identity', provider: 'mock', model: 'test-model', createdAt: Date.now(),
    })
    await ctx.sessions.flush(fake.agent.session)
    await expect(ctx.research.status(ResearchRunId('rp-native-forged'), source.owner))
      .rejects.toThrow('research run unavailable')
    await fake.dispose()
    await source.handle.dispose()
  })

  it('pages a report from a run started before budgets were recorded with the default page size', async () => {
    const { ctx } = await setup()
    const source = await caller(ctx, 'caller-unbudgeted')
    const reportRef = await ctx.attachments.saveFile({ data: new TextEncoder().encode('# Old'), name: 'report.md' })
    const evidenceRef = await ctx.attachments.saveFile({ data: new TextEncoder().encode('{}'), name: 'evidence.json' })
    const historical = await ctx.agents.create({ sessionId: SessionId('rp-native-unbudgeted') })
    historical.agent.session.append('research/started', {
      id: ResearchRunId('rp-native-unbudgeted'), owner: source.owner, callerSessionId: source.session.id,
      query: 'Before budgets', provider: 'mock', model: 'test-model', createdAt: Date.now(),
    })
    historical.agent.session.append('research/finished', { phase: 'completed', finishedAt: Date.now(), reportRef, evidenceRef })
    await ctx.sessions.flush(historical.agent.session)
    expect(await ctx.research.report(ResearchRunId('rp-native-unbudgeted'), source.owner))
      .toMatchObject({ complete: true, markdown: '# Old', pageChars: DEFAULT_BUDGETS.reportPageChars })
    await historical.dispose()
    await source.handle.dispose()
  })

  it('refuses each false durability barrier before acknowledging a start or retry', async () => {
    const { ctx } = await setup()
    const source = await caller(ctx, 'caller-false-flush')
    const original = ctx.sessions.flush.bind(ctx.sessions)
    const spy = vi.spyOn(ctx.sessions, 'flush')
    spy.mockImplementation(async session => session.id.startsWith('rp-native-') ? false : original(session))
    await expect((ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'Run false' }))
      .rejects.toThrow(/run has no durability/)
    spy.mockImplementation(async session => session.id === source.session.id ? false : original(session))
    await expect((ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'Caller false', requestKey: 'retry' }))
      .rejects.toThrow(/caller has no durability/)
    spy.mockRestore()
    const retry = await (ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'Caller false', requestKey: 'retry' })
    const retrySpy = vi.spyOn(ctx.sessions, 'flush')
    retrySpy.mockImplementation(async session => session.id === source.session.id ? false : original(session))
    await expect((ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'Caller false', requestKey: 'retry' }))
      .rejects.toThrow(/caller has no durability/)
    retrySpy.mockRestore()
    expect(retry.id).toBeDefined()
    await source.handle.dispose()
  })

  it('checks stored and streamed file sizes before returning a report', async () => {
    const { ctx } = await setup(undefined, { provider: 'mock', model: 'test-model', maxReportBytes: 3, maxEvidenceBytes: 3 })
    const source = await caller(ctx, 'caller-read-bounds')
    const reportRef = await ctx.attachments.saveFile({ data: new TextEncoder().encode('ab'), name: 'r.md' })
    const evidenceRef = await ctx.attachments.saveFile({ data: new TextEncoder().encode('{}'), name: 'e.json' })
    const add = async (label: string, bytes: number) => {
      const run = await (ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: label })
      const session = ctx.agents.get(SessionId(run.id))!.session
      session.append('research/finished', { phase: 'completed', finishedAt: Date.now(),
        reportRef: { ...reportRef, bytes }, evidenceRef })
      await ctx.sessions.flush(session)
      return run.id
    }
    const oversize = await add('oversize', 4)
    await expect(ctx.research.report(oversize, source.owner)).rejects.toThrow(/byte limit/)
    const streamed = await add('streamed', 1)
    const read = vi.spyOn(ctx.attachments, 'readFileStream')
    read.mockImplementation(async function* () { yield new TextEncoder().encode('abcd') })
    await expect(ctx.research.report(streamed, source.owner)).rejects.toThrow(/byte limit/)
    read.mockImplementation(async function* () { yield new TextEncoder().encode('a') })
    const mismatch = await add('mismatch', 2)
    await expect(ctx.research.report(mismatch, source.owner)).rejects.toThrow(/byte count changed/)
    read.mockRestore()
    await source.handle.dispose()
  })

  it('refuses writer calls after provider disposal while the unfinished run remains readable', async () => {
    const { ctx, providerFiber } = await setup()
    const source = await caller(ctx, 'caller-unloaded')
    const run = await (ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'Unload' })
    const local = ctx.research as LocalResearchService
    await providerFiber.dispose()
    await expect(local.checkpoint(run.id, source.owner, { round: 1, elapsedMs: 0 })).rejects.toThrow(/not active/)
    await expect(local.finish(run.id, source.owner, { phase: 'completed' })).rejects.toThrow(/not active/)
    await expect(local.cancel(run.id, source.owner)).rejects.toThrow(/not active/)
    await source.handle.dispose()
  })

  it('refuses failed checkpoint, terminal, cancellation, and restart barriers', async () => {
    const { ctx, root } = await setup()
    const source = await caller(ctx, 'caller-writer-flush')
    const run = await (ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'Barriers' })
    const local = ctx.research as LocalResearchService
    const original = ctx.sessions.flush.bind(ctx.sessions)
    const spy = vi.spyOn(ctx.sessions, 'flush')
    spy.mockImplementation(async session => session.id === SessionId(run.id) ? false : original(session))
    await expect(local.checkpoint(run.id, source.owner, { round: 1, elapsedMs: 1 })).rejects.toThrow(/no durability/)
    await expect(local.finish(run.id, source.owner, { phase: 'failed' })).rejects.toThrow(/uncertain/)
    await expect(local.cancel(run.id, source.owner)).rejects.toThrow(/uncertain/)
    spy.mockRestore()
    await (ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'Unfinished on restart' })
    await source.handle.dispose()
    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    const reopened = (await setup(root)).ctx
    const resumeSpy = vi.spyOn(reopened.sessions, 'flush')
    resumeSpy.mockResolvedValue(false)
    await expect((reopened.research as LocalResearchService).reconcile()).rejects.toThrow(/no durability/)
    resumeSpy.mockRestore()
  })

  it('skips live and terminal runs during explicit recovery', async () => {
    const { ctx } = await setup()
    const source = await caller(ctx, 'caller-reconcile')
    const run = await (ctx.research as LocalResearchService).startStored({ caller: source.session, owner: source.owner, query: 'Live' })
    const local = ctx.research as LocalResearchService
    await local.reconcile()
    expect((await ctx.research.status(run.id, source.owner)).phase).toBe('running')
    await local.finish(run.id, source.owner, { phase: 'completed', markdown: '# Done', evidence: '{}' })
    await local.reconcile()
    expect((await ctx.research.status(run.id, source.owner)).phase).toBe('completed')
    await source.handle.dispose()
  })
})
