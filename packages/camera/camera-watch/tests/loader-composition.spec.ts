import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import RingCameraService, { RING_DING_CATEGORY } from '@deepseek-ai/dsh-camera-ring'
import type { Config as RingConfig } from '@deepseek-ai/dsh-camera-ring'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { FakeCamera, FakeClock, FakeCredentials, FakeRing, jpeg, wrappedToken } from '../../camera-ring/tests/support.ts'
import * as CameraWatch from '../src/index.ts'
import type { CameraNotice } from '../src/index.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { until, verdictText, VisionAdapter } from './support.ts'

let root: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  try {
    await ctx?.fiber.dispose()
  } finally {
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined
    ctx = undefined
  }
})

it('mounts the Definition, Ring Provider, watch Consumer, and camera tool through Loader and disposes the tool', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-camera-loader-'))
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(LocalAttachmentStore, { dshHome: root })
  await ctx.plugin(Storage)
  await ctx.plugin(storageJson, { root: join(root, 'storage') })
  await ctx.plugin(storageDomain, { backend: 'json' })
  const adapter = new VisionAdapter([textResponse(verdictText({ labels: ['person'], counts: { person: 1 },
    description: 'A person waits at the door.' }, { person_at_door: [0] }))])
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'vision-model' }) } as never)
  const credentials = new FakeCredentials()
  credentials.values.set('RING_REFRESH_TOKEN', wrappedToken('loader-inner-token'))
  ctx.provide('credentials', credentials as never)
  const ring = new FakeRing()
  const front = new FakeCamera(101, 'Front Door')
  ring.cameras = [front, new FakeCamera(202, 'Garage')]
  const clock = new FakeClock()
  clock.time = Date.now()
  class LoaderRing extends RingCameraService {
    constructor(context: Context, config: RingConfig) {
      super(context, config, { connect: ring.connect, now: clock.now, sleep: clock.sleep })
    }
  }
  const notices: CameraNotice[] = []
  ctx.on('camera/notice', (notice) => {
    notices.push(notice)
    return true
  })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-camera-ring'",
    '  config:',
    '    refreshTokenRef: RING_REFRESH_TOKEN',
    '    devices:',
    '      - { id: front-door, label: Front door, ringName: Front Door }',
    '      - { id: garage, label: Garage, ringId: 202 }',
    '    streamFallback: false',
    '    frameCount: 1',
    "- name: '@deepseek-ai/dsh-camera-watch'",
    '  config:',
    '    timezone: America/Phoenix',
    "    deliverChannelId: '123456789012345678'",
    '    policy:',
    '      vehicleDevices: [garage]',
    '',
  ].join('\n'))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  Reflect.set(ctx.loader, 'internal', {
    version: 'v2',
    async import(specifier: string) {
      if (specifier === '@deepseek-ai/dsh-camera-ring') return LoaderRing
      if (specifier === '@deepseek-ai/dsh-camera-watch') return CameraWatch
      throw new Error(`unexpected Loader import: ${specifier}`)
    },
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect(ctx.camera).toBeInstanceOf(RingCameraService)
  expect(ctx.tools.schemas().map(schema => schema.name)).toContain('camera')
  await until(() => front.listeners.size === 1, 'Ring subscription')

  front.snapshots.push(await jpeg(90))
  front.push(RING_DING_CATEGORY, '5150')
  await until(() => notices.length === 2, 'doorbell notice and follow-up')
  expect(notices[0]).toMatchObject({ id: 'camera:ring-101-5150:ding', channelId: '123456789012345678' })
  expect(notices[0]?.text).toMatch(/^\*\*Front door\*\* · \d\d:\d\d: Someone rang the doorbell$/u)
  expect(notices[0]?.image?.name).toBe('front-door-1.jpg')
  expect(notices[1]).toMatchObject({ id: 'camera:ring-101-5150', channelId: '123456789012345678' })
  const [headline, ...details] = notices[1]?.text.split('\n') ?? []
  expect(headline).toMatch(/^\*\*Front door\*\* · \d\d:\d\d: Doorbell rang(; Person at night)?$/u)
  expect(details).toEqual(['A person waits at the door.', 'Seen: person 1'])
  expect(notices[1]?.image).toBeUndefined()
  expect(adapter.requests[0]?.tools ?? []).toEqual([])

  const tool = ctx.tools.get('camera')
  expect(tool).toBeDefined()
  const read = async (): Promise<{ total: number; events: { id: string; camera: string; kind: string; notified: boolean }[] }> =>
    JSON.parse((await tool?.execute({}, {} as ToolRunContext) as { text: string }).text) as never
  let listed = await read()
  for (let attempt = 0; attempt < 500 && listed.events[0]?.notified !== true; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2))
    listed = await read()
  }
  expect(listed).toMatchObject({ total: 1, events: [{ id: 'ring-101-5150', camera: 'Front door', kind: 'ding', notified: true }] })

  const entry = [...ctx.loader.entries()].find(row => row.options.name === '@deepseek-ai/dsh-camera-watch')
  await entry?.fiber?.dispose()
  expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('camera')
})
