/** Conversation records whose Session was created in another workspace than the lane now uses. */
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScheduleId, createAfterScheduleRecord } from '@deepseek-ai/dsh-schedule'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { WORKSPACE_CHANGED_NOTICE } from '../src/conversation.ts'
import type { OutboxRecord } from '../src/domain.ts'
import type { ConversationLane } from '../src/types.ts'
import { CHANNEL, USER, drain, harness, inbound, record, tableFromMap } from './support.ts'

let root: string
let oldWorkspace: string
let newWorkspace: string
const harnesses: ReturnType<typeof harness>[] = []

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-discord-workspace-')))
  oldWorkspace = await realpath(await mkdtemp(join(root, 'old-')))
  newWorkspace = await realpath(await mkdtemp(join(root, 'new-')))
})

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(h => h.router.dispose()))
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

function opened(options: Parameters<typeof harness>[0]) {
  const h = harness({ replyText: 'answered', initialRecord: record(), ...options })
  harnesses.push(h)
  return h
}

describe('conversation resume after a workspace change', () => {
  it('replaces a default-lane record whose Session lives in the previous workspace on the first message after a restart', async () => {
    const h = opened({ storedCwd: oldWorkspace, workspacePath: newWorkspace })
    h.router.handle(inbound())
    await drain()
    expect(h.calls).not.toContain('agent-resume:discord-old-session')
    expect(h.calls).toContain(`workspace:${newWorkspace}`)
    expect(h.calls.filter(call => call === 'agent-create')).toHaveLength(1)
    const stored = h.table.records.get(CHANNEL)
    expect(stored?.sessionId).not.toBe('discord-old-session')
    expect(stored?.workspacePath).toBe(newWorkspace)
    expect(h.posted.map(post => post.content)).toEqual([WORKSPACE_CHANGED_NOTICE, 'answered'])
    expect(h.warnings).toContainEqual(expect.stringContaining(
      `Session discord-old-session belongs to workspace '${oldWorkspace}'`,
    ))
  })

  it('replaces a user-lane record after that lane moves to another workspace', async () => {
    const lane: ConversationLane = { userId: USER, workspacePath: newWorkspace, agentPreset: 'mamabear',
      permissionPreset: 'read-only', excludedPresetCommands: [] }
    const h = opened({ storedCwd: oldWorkspace, userLanes: new Map([[USER, lane]]),
      initialRecord: record({ lane: USER, workspacePath: oldWorkspace, agentPreset: 'mamabear' }) })
    h.router.handle(inbound())
    await drain()
    expect(h.calls).not.toContain('agent-resume:discord-old-session')
    expect(h.calls).toContain('mount:mamabear')
    expect(h.table.records.get(CHANNEL)).toMatchObject({ lane: USER, workspacePath: newWorkspace })
    expect(h.posted.map(post => post.content)).toEqual([WORKSPACE_CHANGED_NOTICE, 'answered'])
  })

  it('treats a stored cwd that no longer exists as another workspace', async () => {
    const h = opened({ storedCwd: join(root, 'deleted'), workspacePath: newWorkspace })
    h.router.handle(inbound())
    await drain()
    expect(h.calls).not.toContain('agent-resume:discord-old-session')
    expect(h.posted.map(post => post.content)).toEqual([WORKSPACE_CHANGED_NOTICE, 'answered'])
  })

  it('resumes the recorded Session when its cwd matches the lane through a symlink-free path', async () => {
    const h = opened({ storedCwd: join(newWorkspace, '.'), workspacePath: newWorkspace })
    h.router.handle(inbound())
    await drain()
    expect(h.calls).toContain('agent-resume:discord-old-session')
    expect(h.calls).not.toContain('agent-create')
    expect(h.posted.map(post => post.content)).toEqual(['answered'])
  })

  it('reports an unrelated attach failure as before without replacing the record', async () => {
    const h = opened({ storedCwd: newWorkspace, workspacePath: newWorkspace, failAttach: true })
    h.router.handle(inbound())
    await drain()
    expect(h.calls).toContain('agent-resume:discord-old-session')
    expect(h.calls).not.toContain('agent-create')
    expect(h.warnings.some(message => message.includes('message m1 failed') && message.includes('attach failed'))).toBe(true)
    expect(h.table.records.get(CHANNEL)?.sessionId).toBe('discord-old-session')
    expect(h.posted.map(post => post.content)).not.toContain(WORKSPACE_CHANGED_NOTICE)
  })

  it('reports a lane workspace that does not resolve without replacing the record', async () => {
    const h = opened({ storedCwd: oldWorkspace, workspacePath: join(root, 'missing') })
    h.router.handle(inbound())
    await drain()
    expect(h.calls).not.toContain('agent-create')
    expect(h.warnings.some(message => message.includes('message m1 failed') && message.includes('ENOENT'))).toBe(true)
    expect(h.table.records.get(CHANNEL)?.sessionId).toBe('discord-old-session')
  })

  it('leaves a reminder dormant when its conversation Session lives in the previous workspace', async () => {
    vi.useFakeTimers()
    const events: SessionEvent[] = [{
      seq: SessionSeq(0), time: Date.now(), type: 'schedule/change',
      data: { version: 1, operation: 'create',
        schedule: createAfterScheduleRecord(ScheduleId('moved'), 'Check the build', 1, Date.now(), 'Check the build') },
    }]
    const h = harness({ storedEvents: events, storedCwd: oldWorkspace, workspacePath: newWorkspace,
      initialRecord: record({ deliveredThrough: 1 }),
      outboxStorage: tableFromMap(new Map<string, OutboxRecord>()), manualWait: true })
    harnesses.push(h)
    await h.router.recover()
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => {
      expect(h.warnings).toContainEqual(expect.stringContaining('its reminder waits until the next message'))
    })
    expect(h.calls).not.toContain('agent-resume:discord-old-session')
    expect(h.table.records.get(CHANNEL)?.sessionId).toBe('discord-old-session')
  })
})
