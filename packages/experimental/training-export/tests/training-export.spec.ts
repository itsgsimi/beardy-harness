import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime, {
  LlmAdapter, ToolCallId, createAssistantMessage, createToolResultMessage,
  type GenerateOptions, type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { encodeSegment } from '../src/paths.ts'
import * as trainingExport from '../src/index.ts'

const contexts: Context[] = []
const dirs: string[] = []

class RecordingAdapter extends LlmAdapter {
  constructor(private readonly chunks: readonly StreamChunk[]) { super() }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    for (const chunk of this.chunks) yield chunk
  }
}

async function setup(root: string, providers: string[] = ['mock']): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(trainingExport, { root, providers, enabled: true })
  return ctx
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _chunk of stream) { /* drain */ }
}

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-training-export-'))
  dirs.push(dir)
  return dir
}

const execFileAsync = promisify(execFile)

/** A real, throwaway git repository, for the workspace-capture-reuse test. */
async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-training-export-repo-'))
  dirs.push(dir)
  await execFileAsync('git', ['init', '-q'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: dir })
  await writeFile(join(dir, 'file.txt'), 'one\n', 'utf8')
  await execFileAsync('git', ['add', 'file.txt'], { cwd: dir })
  await execFileAsync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir })
  return dir
}

/** Poll for at least `minLines` complete JSONL lines; the writer's append queue settles off the caller's await. */
async function readLinesEventually(path: string, minLines: number, timeoutMs = 2000): Promise<unknown[]> {
  const start = Date.now()
  for (;;) {
    const text = await readFile(path, 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    })
    const lines = text.split('\n').filter(line => line.length > 0)
    if (lines.length >= minLines) return lines.map(line => JSON.parse(line) as unknown)
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${minLines} line(s) in ${path}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** Poll meta.json until its `title` matches — the re-write on a later `session/title` is a queued write, not a synchronous one. */
async function readMetaEventually(path: string, wantTitle: string | null, timeoutMs = 2000): Promise<Record<string, unknown>> {
  const start = Date.now()
  for (;;) {
    const meta = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    if (meta.title === wantTitle) return meta
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for meta.json title to become ${JSON.stringify(wantTitle)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  // Safe even when a test never faked timers: restores real ones unconditionally.
  vi.useRealTimers()
})

describe('training-export samples', () => {
  it('writes a sample with the folded response and hashes', async () => {
    const root = await tempRoot()
    const ctx = await setup(root)
    const session = ctx.sessions.create(SessionId('sample-basic'))
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hi' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]))
    await drain(ctx.llm.stream({
      provider: 'mock', model: 'mock-model', messages: [], system: 'be nice', sessionId: session.id,
    }))

    const dir = join(root, encodeSegment(session.id))
    const [sample] = await readLinesEventually(join(dir, 'samples.jsonl'), 1) as [Record<string, unknown>]
    expect(sample.turn).toBeNull()
    expect(sample.step).toBeNull()
    expect(sample.purpose).toBeNull()
    expect(sample.workspace).toBeNull()
    expect(sample.response).toEqual({
      content: [{ type: 'text', text: 'hi' }],
      finish: { kind: 'stop' },
      usage: { inputTokens: 10, outputTokens: 2 },
      error: null,
    })
    expect(sample.hashes).toEqual({
      system: `sha256:${createHash('sha256').update('be nice', 'utf8').digest('hex')}`,
      tools: `sha256:${createHash('sha256').update('[]', 'utf8').digest('hex')}`,
    })

    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as Record<string, unknown>
    expect(meta.version).toBe(1)
    expect(meta.sessionId).toBe(session.id)
    expect(String(meta.harness)).toMatch(/^dsh-/)
    expect(String(meta.plugin)).toMatch(/^dsh-experimental-training-export\//)
    expect(meta.agentPreset).toBeNull()
    expect(meta.title).toBeNull()
  })

  it('records the session\'s agentPreset in meta.json, and re-writes it when a title arrives after the first sample', async () => {
    const root = await tempRoot()
    const ctx = await setup(root)
    const session = ctx.sessions.create(
      SessionId('sample-agent-preset-title'), { meta: { agentPreset: 'beardy-unattended' } },
    )
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter([{ type: 'finish', reason: { kind: 'stop' } }]))

    await drain(ctx.llm.stream({ provider: 'mock', model: 'mock-model', messages: [], sessionId: session.id }))

    const dir = join(root, encodeSegment(session.id))
    // meta.json is written once, at the first sample: the title is still
    // unknown at this point, so it lands `null` alongside the preset.
    await readLinesEventually(join(dir, 'samples.jsonl'), 1)
    expect(JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'))).toMatchObject({
      agentPreset: 'beardy-unattended', title: null,
    })

    session.append('session/title', { title: 'Fix the flaky test', messageSeqs: [], source: { kind: 'fallback' } })

    const meta = await readMetaEventually(join(dir, 'meta.json'), 'Fix the flaky test')
    expect(meta).toMatchObject({ agentPreset: 'beardy-unattended', title: 'Fix the flaky test' })
  })

  it('captures a session/title that arrives before the first sample directly, with no separate re-write', async () => {
    const root = await tempRoot()
    const ctx = await setup(root)
    const session = ctx.sessions.create(SessionId('sample-title-before-first-sample'))
    session.append('session/title', { title: 'Early title', messageSeqs: [], source: { kind: 'fallback' } })
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter([{ type: 'finish', reason: { kind: 'stop' } }]))

    await drain(ctx.llm.stream({ provider: 'mock', model: 'mock-model', messages: [], sessionId: session.id }))

    const dir = join(root, encodeSegment(session.id))
    await readLinesEventually(join(dir, 'samples.jsonl'), 1)
    expect(JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'))).toMatchObject({ title: 'Early title' })
  })

  it('still writes a sample carrying the error when the downstream chain throws', async () => {
    // LlmRuntime itself normalizes an adapter throw into a terminal `error`
    // finish chunk (never a rejection), so exercising the wrapper's
    // catch-then-rethrow path needs an upstream listener that throws before
    // reaching the adapter — exactly what another plugin ahead of this one
    // in a real `llm/stream` chain (e.g. a rejected checkpoint) looks like.
    const root = await tempRoot()
    const ctx = await setup(root)
    const session = ctx.sessions.create(SessionId('sample-error'))
    ctx.on('llm/stream', (): never => { throw Object.assign(new Error('boom'), { code: 'BOOM' }) })
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter([{ type: 'finish', reason: { kind: 'stop' } }]))

    await expect(drain(ctx.llm.stream({
      provider: 'mock', model: 'mock-model', messages: [], sessionId: session.id,
    }))).rejects.toThrow('boom')

    const dir = join(root, encodeSegment(session.id))
    const [sample] = await readLinesEventually(join(dir, 'samples.jsonl'), 1) as [Record<string, unknown>]
    expect(sample.response).toMatchObject({ finish: null, error: { name: 'Error', message: 'boom', code: 'BOOM' } })
  })

  it('normalizes a non-Error throw from the downstream chain', async () => {
    const root = await tempRoot()
    const ctx = await setup(root)
    const session = ctx.sessions.create(SessionId('sample-non-error-throw'))
    ctx.on('llm/stream', (): never => { throw 'plain string failure' })
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter([{ type: 'finish', reason: { kind: 'stop' } }]))

    await expect(drain(ctx.llm.stream({
      provider: 'mock', model: 'mock-model', messages: [], sessionId: session.id,
    }))).rejects.toThrow('plain string failure')

    const dir = join(root, encodeSegment(session.id))
    const [sample] = await readLinesEventually(join(dir, 'samples.jsonl'), 1) as [Record<string, unknown>]
    expect(sample.response).toMatchObject({
      finish: null, error: { name: 'Error', message: 'plain string failure' },
    })
  })

  it('records an error finish reason as an LlmError', async () => {
    const root = await tempRoot()
    const ctx = await setup(root)
    const session = ctx.sessions.create(SessionId('sample-error-finish'))
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter([
      { type: 'finish', reason: { kind: 'error', failure: { message: 'broke', code: 'UNKNOWN' } } },
    ]))

    await drain(ctx.llm.stream({ provider: 'mock', model: 'mock-model', messages: [], sessionId: session.id }))

    const dir = join(root, encodeSegment(session.id))
    const [sample] = await readLinesEventually(join(dir, 'samples.jsonl'), 1) as [Record<string, unknown>]
    expect(sample.response).toMatchObject({
      finish: { kind: 'error', failure: { message: 'broke', code: 'UNKNOWN' } },
      error: { name: 'LlmError', message: 'broke', code: 'UNKNOWN' },
    })
  })

  it('skips workspace git calls for a non-allow-listed provider but still writes the sample', async () => {
    const root = await tempRoot()
    const ctx = await setup(root, ['other-provider'])
    const session = ctx.sessions.create(SessionId('sample-skip-git'), { meta: { cwd: process.cwd() } })
    session.append('turn/start', { turn: 1 })
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter([{ type: 'finish', reason: { kind: 'stop' } }]))

    await drain(ctx.llm.stream({ provider: 'mock', model: 'mock-model', messages: [], sessionId: session.id }))

    const dir = join(root, encodeSegment(session.id))
    const [sample] = await readLinesEventually(join(dir, 'samples.jsonl'), 1) as [Record<string, unknown>]
    expect(sample.workspace).toBeNull()
  })

  it('captures the workspace once per turn and reuses it, and resumes seq/meta across a restart', async () => {
    const root = await tempRoot()
    const repo = await initRepo()
    const sessionId = SessionId('sample-resume')

    // Pre-seed the sidecar as if an earlier process already wrote two
    // samples and the meta file, so this run must resume, not restart, both.
    const dir = join(root, encodeSegment(sessionId))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'samples.jsonl'), '{"seq":0}\n{"seq":1}\n', 'utf8')
    const seededMeta = { version: 1, sessionId, seeded: true }
    await writeFile(join(dir, 'meta.json'), JSON.stringify(seededMeta), 'utf8')

    const ctx = await setup(root, ['mock'])
    const session = ctx.sessions.create(sessionId, { meta: { cwd: repo } })
    session.append('turn/start', { turn: 1 })
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter([{ type: 'finish', reason: { kind: 'stop' } }]))

    await drain(ctx.llm.stream({ provider: 'mock', model: 'mock-model', messages: [], sessionId: session.id }))
    await drain(ctx.llm.stream({ provider: 'mock', model: 'mock-model', messages: [], sessionId: session.id }))

    const samples = await readLinesEventually(join(dir, 'samples.jsonl'), 4) as Record<string, unknown>[]
    const [, , first, second] = samples
    expect(first?.seq).toBe(2)
    expect(second?.seq).toBe(3)
    expect(first?.workspace).toEqual(second?.workspace)
    expect((first?.workspace as { head: string }).head).toMatch(/^[0-9a-f]{40}$/)

    // meta.json is untouched: the "wx"-flagged write hit EEXIST and was swallowed.
    expect(JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'))).toEqual(seededMeta)
  })

  it('starts the seq counter at 0 when an existing samples.jsonl is empty', async () => {
    const root = await tempRoot()
    const session0Id = SessionId('sample-empty-existing-file')
    const dir = join(root, encodeSegment(session0Id))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'samples.jsonl'), '', 'utf8')

    const ctx = await setup(root)
    const session = ctx.sessions.create(session0Id)
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter([{ type: 'finish', reason: { kind: 'stop' } }]))

    await drain(ctx.llm.stream({ provider: 'mock', model: 'mock-model', messages: [], sessionId: session.id }))

    const [sample] = await readLinesEventually(join(dir, 'samples.jsonl'), 1) as [Record<string, unknown>]
    expect(sample.seq).toBe(0)
  })

  it('logs and swallows a write failure instead of throwing to the caller', async () => {
    const root = await tempRoot()
    const ctx = await setup(root)
    const session = ctx.sessions.create(SessionId('sample-mkdir-failure'))
    // Block the session's sidecar directory with a plain file, so the
    // queued task's `mkdir(recursive: true)` fails.
    await writeFile(join(root, encodeSegment(session.id)), 'blocking file', 'utf8')
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter([{ type: 'finish', reason: { kind: 'stop' } }]))

    await expect(drain(ctx.llm.stream({
      provider: 'mock', model: 'mock-model', messages: [], sessionId: session.id,
    }))).resolves.toBeUndefined()

    await new Promise(resolve => setTimeout(resolve, 50))
    await expect(readFile(join(root, encodeSegment(session.id)), 'utf8')).resolves.toBe('blocking file')
  })

  it('logs and swallows a failure to resolve the seq counter', async () => {
    const root = await tempRoot()
    const ctx = await setup(root)
    const session = ctx.sessions.create(SessionId('sample-seq-failure'))
    const dir = join(root, encodeSegment(session.id))
    await mkdir(join(dir, 'samples.jsonl'), { recursive: true }) // a directory where a file is expected: readFile fails EISDIR, not ENOENT.
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter([{ type: 'finish', reason: { kind: 'stop' } }]))

    await expect(drain(ctx.llm.stream({
      provider: 'mock', model: 'mock-model', messages: [], sessionId: session.id,
    }))).resolves.toBeUndefined()

    await new Promise(resolve => setTimeout(resolve, 50))
    // meta.json is written before the seq counter is resolved, so it still lands.
    await expect(readFile(join(dir, 'meta.json'), 'utf8')).resolves.toContain('"version":1')
  })

  it('logs and swallows a failure to write meta.json', async () => {
    const root = await tempRoot()
    const ctx = await setup(root)
    const session = ctx.sessions.create(SessionId('sample-meta-failure'))
    const dir = join(root, encodeSegment(session.id))
    // Pre-create the directory read-only: `mkdir(recursive: true)` is then a
    // no-op, but `writeFile` inside it fails EACCES — not EEXIST — so
    // `writeMetaOnce` must rethrow instead of swallowing the failure.
    await mkdir(dir, { recursive: true })
    await chmod(dir, 0o500)

    try {
      ctx.llm.registerAdapter(['mock'], new RecordingAdapter([{ type: 'finish', reason: { kind: 'stop' } }]))

      await expect(drain(ctx.llm.stream({
        provider: 'mock', model: 'mock-model', messages: [], sessionId: session.id,
      }))).resolves.toBeUndefined()

      await new Promise(resolve => setTimeout(resolve, 50))
      await expect(readFile(join(dir, 'samples.jsonl'), 'utf8').catch(() => 'MISSING')).resolves.toBe('MISSING')
    } finally {
      await chmod(dir, 0o700)
    }
  })

  it('passes through an untracked session-log event type without touching the open turn', async () => {
    const root = await tempRoot()
    const ctx = await setup(root)
    const session = ctx.sessions.create(SessionId('sample-untracked-event'))

    expect(() => {
      session.append('turn/start', { turn: 1 })
      session.append('request/context', { provider: 'mock', model: 'mock-model' })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }).not.toThrow()

    const dir = join(root, encodeSegment(session.id))
    const [label] = await readLinesEventually(join(dir, 'labels.jsonl'), 1) as [Record<string, unknown>]
    expect(label).toMatchObject({ completed: true, toolCalls: 0 })
  })

  it('passes a request without a session through untouched', async () => {
    const root = await tempRoot()
    const ctx = await setup(root)
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter([{ type: 'finish', reason: { kind: 'stop' } }]))

    await drain(ctx.llm.stream({ provider: 'mock', model: 'mock-model', messages: [] }))

    await expect(readdir(root)).resolves.toEqual([])
  })

  it('calls next() exactly once', async () => {
    const root = await tempRoot()
    const ctx = await setup(root)
    const session = ctx.sessions.create(SessionId('next-once'))
    let dispatches = 0
    class CountingAdapter extends LlmAdapter {
      async * stream(): AsyncIterable<StreamChunk> {
        dispatches += 1
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['mock'], new CountingAdapter())

    await drain(ctx.llm.stream({ provider: 'mock', model: 'mock-model', messages: [], sessionId: session.id }))

    // Let the queued write settle before teardown races the directory removal.
    await readLinesEventually(join(root, encodeSegment(session.id), 'samples.jsonl'), 1)
    expect(dispatches).toBe(1)
  })

  it('records an aborted finish reason as an AbortError', async () => {
    const root = await tempRoot()
    const ctx = await setup(root)
    const session = ctx.sessions.create(SessionId('sample-aborted'))
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter([
      { type: 'finish', reason: { kind: 'aborted', failure: { message: 'cancelled', code: 'ABORTED' } } },
    ]))

    await drain(ctx.llm.stream({ provider: 'mock', model: 'mock-model', messages: [], sessionId: session.id }))

    const dir = join(root, encodeSegment(session.id))
    const [sample] = await readLinesEventually(join(dir, 'samples.jsonl'), 1) as [Record<string, unknown>]
    expect(sample.response).toMatchObject({
      finish: { kind: 'aborted', failure: { message: 'cancelled', code: 'ABORTED' } },
      error: { name: 'AbortError', message: 'cancelled', code: 'ABORTED' },
    })
  })

  it('sorts block-end blocks into index order regardless of stream order', async () => {
    const root = await tempRoot()
    const ctx = await setup(root)
    const session = ctx.sessions.create(SessionId('sample-block-order'))
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter([
      { type: 'block-end', index: 1, block: { type: 'text', text: 'second' } },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'first' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]))

    await drain(ctx.llm.stream({ provider: 'mock', model: 'mock-model', messages: [], sessionId: session.id }))

    const dir = join(root, encodeSegment(session.id))
    const [sample] = await readLinesEventually(join(dir, 'samples.jsonl'), 1) as [Record<string, unknown>]
    expect((sample.response as { content: unknown }).content).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ])
  })

  it('does not write when a request names a session the store no longer holds', async () => {
    const root = await tempRoot()
    const ctx = await setup(root)
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter([{ type: 'finish', reason: { kind: 'stop' } }]))

    await drain(ctx.llm.stream({
      provider: 'mock', model: 'mock-model', messages: [], sessionId: SessionId('never-created'),
    }))

    await expect(readdir(root)).resolves.toEqual([])
  })
})

describe('training-export configuration', () => {
  it('rejects a relative root at load', () => {
    const ctx = new Context()
    contexts.push(ctx)
    expect(() => {
      trainingExport.apply(ctx, { root: 'relative/path', providers: ['mock'], enabled: true })
    }).toThrow(/absolute/)
  })

  it('installs no listeners when disabled', async () => {
    const root = await tempRoot()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(trainingExport, { root, providers: ['mock'], enabled: false })
    const session = ctx.sessions.create(SessionId('disabled'))
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter([{ type: 'finish', reason: { kind: 'stop' } }]))

    await drain(ctx.llm.stream({ provider: 'mock', model: 'mock-model', messages: [], sessionId: session.id }))

    await expect(readdir(root).catch(() => [])).resolves.toEqual([])
  })
})

describe('training-export labels', () => {
  it('writes a label at turn/end with the turn\'s counts', async () => {
    const root = await tempRoot()
    const ctx = await setup(root)
    const session = ctx.sessions.create(SessionId('label-basic'))

    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter([{ type: 'finish', reason: { kind: 'tool-calls' } }]))
    await drain(ctx.llm.stream({ provider: 'mock', model: 'mock-model', messages: [], sessionId: session.id }))

    const callId = ToolCallId('call-1')
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: false }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const dir = join(root, encodeSegment(session.id))
    const [label] = await readLinesEventually(join(dir, 'labels.jsonl'), 1) as [Record<string, unknown>]
    expect(label).toMatchObject({
      version: 1, kind: 'label', turn: 1, completed: true, finishReason: 'completed',
      steps: 1, toolCalls: 1, toolErrors: 0, hooks: [], compactionInTurn: false,
      approvals: { asked: 0, approved: 0, rejected: 0 }, diff: null, ratings: [],
    })
    expect(label.samples).toHaveLength(1)
  })

  it('ignores a tool/result whose callId matches no call tracked this turn', async () => {
    const root = await tempRoot()
    const ctx = await setup(root)
    const session = ctx.sessions.create(SessionId('label-orphan-tool-result'))

    session.append('turn/start', { turn: 1 })
    // No matching `tool/call` this turn — a stray or cross-turn result. The
    // existing `toolErrors` counter still increments (unchanged prior
    // behaviour), but there is no pending call to attach an outcome to.
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: ToolCallId('never-called'), content: [{ type: 'text', text: 'stray' }], isError: true }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const dir = join(root, encodeSegment(session.id))
    const [label] = await readLinesEventually(join(dir, 'labels.jsonl'), 1) as [Record<string, unknown>]
    expect(label).toMatchObject({ toolCalls: 0, toolErrors: 1, toolCallOutcomes: [] })
  })

  it('counts a failed tool result as a tool error', async () => {
    const root = await tempRoot()
    const ctx = await setup(root)
    const session = ctx.sessions.create(SessionId('label-tool-error'))

    session.append('turn/start', { turn: 1 })
    const callId = ToolCallId('call-err')
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'nope' }], isError: true }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'nope', code: 'UNKNOWN' } } })

    const dir = join(root, encodeSegment(session.id))
    const [label] = await readLinesEventually(join(dir, 'labels.jsonl'), 1) as [Record<string, unknown>]
    expect(label).toMatchObject({ completed: false, finishReason: 'error', toolCalls: 1, toolErrors: 1 })
  })

  it('computes tool-call outcomes, assistant text length, and turn timing', async () => {
    const root = await tempRoot()
    const ctx = await setup(root)
    const session = ctx.sessions.create(SessionId('label-tool-outcomes'))
    // callA/callC's blocks both live in sample 1's response, so both resolve a
    // `seq`; callB's lives in sample 2's; callD's lives in neither, so its
    // `seq` stays null even though it gets a normal, matched result.
    const callA = ToolCallId('call-a')
    const callB = ToolCallId('call-b')
    const callC = ToolCallId('call-c')
    const callD = ToolCallId('call-d')

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1000)
    session.append('turn/start', { turn: 1 })

    ctx.llm.registerAdapter(['mock-a'], new RecordingAdapter([
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello ' } },
      { type: 'block-end', index: 2, block: { type: 'tool-call', id: callA, name: 'bash', arguments: '{}' } },
      { type: 'block-end', index: 3, block: { type: 'tool-call', id: callC, name: 'write', arguments: '{}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]))
    await drain(ctx.llm.stream({ provider: 'mock-a', model: 'mock-model', messages: [], sessionId: session.id }))

    ctx.llm.registerAdapter(['mock-b'], new RecordingAdapter([
      { type: 'block-end', index: 0, block: { type: 'text', text: 'World' } },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: callB, name: 'edit', arguments: '{}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]))
    await drain(ctx.llm.stream({ provider: 'mock-b', model: 'mock-model', messages: [], sessionId: session.id }))

    const dir = join(root, encodeSegment(session.id))

    vi.setSystemTime(1500)
    session.append('tool/call', { turn: 1, step: 1, callId: callA, name: 'bash', arguments: '{}' })
    vi.setSystemTime(1800)
    session.append('tool/result', {
      turn: 1, step: 1,
      // A non-`text` block alongside the text one: `resultChars` only counts
      // the latter (still 9), exercising both sides of that filter.
      message: createToolResultMessage({
        callId: callA,
        content: [{ type: 'text', text: 'ok output' }, { type: 'reasoning', text: 'not counted' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })

    // callB never gets a `tool/result`: unmatched by turn end.
    vi.setSystemTime(2000)
    session.append('tool/call', { turn: 1, step: 2, callId: callB, name: 'edit', arguments: '{}' })

    vi.setSystemTime(2200)
    session.append('tool/call', { turn: 1, step: 1, callId: callC, name: 'write', arguments: '{}' })
    vi.setSystemTime(2400)
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: callC, content: [{ type: 'text', text: 'boom' }], isError: true }),
    }, { surfaceOp: 'append' })

    vi.setSystemTime(2600)
    session.append('tool/call', { turn: 1, step: 2, callId: callD, name: 'ghost', arguments: '{}' })
    vi.setSystemTime(2700)
    session.append('tool/result', {
      turn: 1, step: 2,
      message: createToolResultMessage({ callId: callD, content: [{ type: 'text', text: 'fine' }], isError: false }),
    }, { surfaceOp: 'append' })

    vi.setSystemTime(3000)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    // Real timers before polling: `readLinesEventually`'s own timeout tracking needs a moving `Date.now()`.
    vi.useRealTimers()

    const [sampleA, sampleB] = await readLinesEventually(join(dir, 'samples.jsonl'), 2) as [
      { seq: number }, { seq: number },
    ]
    const [label] = await readLinesEventually(join(dir, 'labels.jsonl'), 1) as [Record<string, unknown>]
    expect(label.startedAt).toBe(1000)
    expect(label.durationMs).toBe(2000)
    expect(label.assistantChars).toBe(11) // 'Hello ' (6) + 'World' (5); reasoning and tool-call args excluded.
    expect(label.toolCalls).toBe(4)
    expect(label.toolErrors).toBe(1)
    expect(label.toolCallOutcomes).toEqual([
      { seq: sampleA.seq, callId: callA, name: 'bash', isError: false, durationMs: 300, resultChars: 9 },
      { seq: sampleB.seq, callId: callB, name: 'edit', isError: null, durationMs: null, resultChars: 0 },
      { seq: sampleA.seq, callId: callC, name: 'write', isError: true, durationMs: 200, resultChars: 4 },
      { seq: null, callId: callD, name: 'ghost', isError: false, durationMs: 100, resultChars: 4 },
    ])
    expect((label.toolCallOutcomes as unknown[]).length).toBe(label.toolCalls)
    expect((label.toolCallOutcomes as { isError: boolean | null }[]).filter(outcome => outcome.isError === true))
      .toHaveLength(label.toolErrors as number)
  })

  it('computes the diff against the workspace head captured for the turn', async () => {
    const root = await tempRoot()
    const repo = await initRepo()
    const ctx = await setup(root)
    const session = ctx.sessions.create(SessionId('label-diff'), { meta: { cwd: repo } })

    session.append('turn/start', { turn: 1 })
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter([{ type: 'finish', reason: { kind: 'stop' } }]))
    await drain(ctx.llm.stream({ provider: 'mock', model: 'mock-model', messages: [], sessionId: session.id }))

    const dir = join(root, encodeSegment(session.id))
    // Wait for the sample write so the turn's workspace head is captured
    // before ending the turn (the capture itself runs off the hot path).
    await readLinesEventually(join(dir, 'samples.jsonl'), 1)
    await writeFile(join(repo, 'file.txt'), 'one\ntwo\n', 'utf8')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const [label] = await readLinesEventually(join(dir, 'labels.jsonl'), 1) as [Record<string, unknown>]
    expect(label.diff).toEqual({ files: 1, insertions: 1, deletions: 0 })
  })

  it('folds hook, approval, and in-turn compaction outcomes', async () => {
    const root = await tempRoot()
    const ctx = await setup(root)
    const session = ctx.sessions.create(SessionId('label-outcomes'))

    session.append('turn/start', { turn: 1 })
    session.append('hook/result', {
      turn: 1, point: 'PostToolUse', handlerId: 'h-1', decision: 'pass', exitCode: 0, durationMs: 5,
    })
    session.append('hook/result', {
      turn: 1, point: 'PostToolUse', handlerId: 'h-2', decision: 'stop', exitCode: 1, durationMs: 5,
    })
    session.append('hook/result', {
      turn: 1, point: 'Stop', handlerId: 'h-3', decision: 'pass', durationMs: 5,
    })
    session.append('approval/asked', { id: ApprovalRequestId('a-1'), toolName: 'bash' })
    session.append('approval/decided', { id: ApprovalRequestId('a-1'), outcome: 'allowed-once' })
    session.append('approval/asked', { id: ApprovalRequestId('a-2'), toolName: 'bash' })
    session.append('approval/decided', { id: ApprovalRequestId('a-2'), outcome: 'rejected' })
    session.append('compaction/start', { compactionId: CompactionId('c-1'), turn: 1 })
    session.append('compaction/end', { compactionId: CompactionId('c-1'), turn: 1 })
    const assistant = createAssistantMessage({
      content: [{ type: 'text', text: 'done' }], source: { provider: 'mock', model: 'mock-model' },
    })
    session.append('assistant/message', { turn: 1, step: 1, message: assistant, stream: [] }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const dir = join(root, encodeSegment(session.id))
    const [label] = await readLinesEventually(join(dir, 'labels.jsonl'), 1) as [Record<string, unknown>]
    expect(label).toMatchObject({
      hooks: [
        { name: 'PostToolUse:h-1', ok: true, exitCode: 0 },
        { name: 'PostToolUse:h-2', ok: false, exitCode: 1 },
        { name: 'Stop:h-3', ok: false },
      ],
      approvals: { asked: 2, approved: 1, rejected: 1 },
      compactionInTurn: true,
      ratings: [],
    })
  })

  it('ignores a standalone compaction transaction between turns', async () => {
    const root = await tempRoot()
    const ctx = await setup(root)
    const session = ctx.sessions.create(SessionId('label-standalone-compaction'))

    // Between turns: no open turn/turnAgg, so this must not throw and must
    // not retroactively mark a later turn's label as containing compaction.
    session.append('compaction/start', { compactionId: CompactionId('c-standalone'), turn: null })
    session.append('compaction/end', { compactionId: CompactionId('c-standalone'), turn: null })

    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const dir = join(root, encodeSegment(session.id))
    const [label] = await readLinesEventually(join(dir, 'labels.jsonl'), 1) as [Record<string, unknown>]
    expect(label).toMatchObject({ compactionInTurn: false })
  })

  it('ignores tool, hook, and approval events outside any open turn', async () => {
    const root = await tempRoot()
    const ctx = await setup(root)
    const session = ctx.sessions.create(SessionId('label-outside-turn'))

    const callId = ToolCallId('call-outside')
    expect(() => {
      session.append('tool/call', { turn: 0, step: 0, callId, name: 'bash', arguments: '{}' })
      session.append('tool/result', {
        turn: 0, step: 0,
        message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: false }),
      }, { surfaceOp: 'append' })
      session.append('hook/result', { turn: 0, point: 'Stop', handlerId: 'h', decision: 'pass', durationMs: 1 })
      session.append('approval/asked', { id: ApprovalRequestId('a-outside'), toolName: 'bash' })
      session.append('approval/decided', { id: ApprovalRequestId('a-outside'), outcome: 'rejected' })
      session.append('step/start', { turn: 0, step: 0 })
      const assistant = createAssistantMessage({
        content: [{ type: 'text', text: 'stray' }], source: { provider: 'mock', model: 'mock-model' },
      })
      session.append('assistant/message', { turn: 0, step: 0, message: assistant, stream: [] }, { surfaceOp: 'append' })
      // No matching `turn/start` ever fired, so this must not write a label either.
      session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    }).not.toThrow()

    await expect(readdir(root)).resolves.toEqual([])
  })
})

describe('training-export plugin shape', () => {
  it('keeps the Loader-safe namespace plugin shape', () => {
    expect('default' in trainingExport).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(trainingExport) as Record<string, unknown>
    expect(unwrapped).toBe(trainingExport)
    expect(unwrapped.name).toBe('training-export')
    expect(unwrapped.inject).toEqual(['llm', 'sessions'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})
