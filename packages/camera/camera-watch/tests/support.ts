/** Real agent loop, attachment store, and storage with a scripted vision model and fixture camera. No network is used. */

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { CameraDeviceId, CameraEventId, CameraService } from '@deepseek-ai/dsh-camera'
import type { CameraDevice, CameraEvent, CameraEventKind, CameraFrame } from '@deepseek-ai/dsh-camera'
import type { GenerateOptions, LlmResolvedModelInfo, ModelModality, StreamChunk } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { inject, mountCameraWatch } from '../src/index.ts'
import type { CameraNotice, CameraWatchDeps, Config } from '../src/index.ts'

/** 12:00 in Phoenix (UTC-7, no daylight saving time). */
export const NOON = Date.UTC(2026, 8, 27, 19, 0)
/** 23:30 in Phoenix. */
export const NIGHT = Date.UTC(2026, 8, 28, 6, 30)

/**
 * Encode a synthetic solid-colour JPEG.
 * @param shade - red channel value, so frames differ.
 * @returns JPEG bytes.
 */
export async function jpeg(shade: number): Promise<Uint8Array> {
  const image = sharp({ create: { width: 16, height: 12, channels: 3, background: { r: shade, g: 60, b: 120 } } })
  return new Uint8Array(await image.jpeg().toBuffer())
}

/** Fixture provider with a doorbell and a garage camera. */
export class FixtureCamera extends CameraService {
  devices(): readonly CameraDevice[] {
    return [{ id: CameraDeviceId('front-door'), label: 'Front door' }, { id: CameraDeviceId('garage'), label: 'Garage' }]
  }

  /**
   * Publish one event to the watch.
   * @param event - event with stored frames.
   */
  async send(event: CameraEvent): Promise<void> { await this.publish(event) }
}

/** Mock route whose declared input modalities are configurable. */
export class VisionAdapter extends MockAdapter {
  inputModalities: readonly ModelModality[] | undefined

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const info = await super.resolveModel(provider, model)
    return this.inputModalities === undefined ? info : { ...info, inputModalities: this.inputModalities }
  }
}

/** Scripted reply: fixed text (the text `hang` streams and waits for cancellation), text from the request, or raw chunks. */
export type Reply = string | ((options: GenerateOptions) => string) | StreamChunk[]

/** Running watch with its collaborators. */
export interface WatchHarness {
  readonly ctx: Context
  /** The watch plugin's own fiber, for plugin-level disposal. */
  readonly fiber: Fiber
  readonly root: string
  readonly adapter: VisionAdapter
  readonly camera: FixtureCamera
  readonly notices: CameraNotice[]
  readonly logs: { type: string; text: string }[]
  /** Scripted notice listener replies in order; the default accepts. */
  readonly noticeReplies: ('accept' | 'refuse' | 'throw')[]
  /** Store synthetic frames; equal shades store one shared object. */
  frames(count: number, offsets?: readonly number[], shades?: readonly number[]): Promise<CameraFrame[]>
  event(kind: CameraEventKind, frames: readonly CameraFrame[], options?: { id?: string; device?: string; at?: number }): CameraEvent
  sessionLog(): Promise<Record<string, unknown>[]>
  /** Mount another watch with the harness configuration, as a host restart does after disposing {@link fiber}. */
  remount(deps?: CameraWatchDeps): Fiber & PromiseLike<Fiber>
  dispose(): Promise<void>
}

/**
 * Mount the watch over a real agent loop with scripted replies.
 * @param replies - model replies in call order.
 * @param config - watch configuration; `timezone` defaults to America/Phoenix.
 * @param options - persistence, notice listener, and seams.
 * @returns running harness.
 */
export async function watchHarness(replies: readonly Reply[], config: Partial<Config> = {}, options: {
  persistence?: boolean
  noticeListener?: boolean
  /** Leave out the delivery channel. */
  channel?: false
  deps?: CameraWatchDeps
  load?: (load: Fiber) => Promise<void>
} = {}): Promise<WatchHarness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-camera-watch-'))
  const ctx = new Context()
  const logs: { type: string; text: string }[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push({ type: message.type, text: message.args.map(String).join(' ') }) } })
  await mountAgentLoopTestDependencies(ctx)
  if (options.persistence !== false) await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(LocalAttachmentStore, { dshHome: root })
  await ctx.plugin(Storage)
  await ctx.plugin(storageJson, { root: join(root, 'storage') })
  await ctx.plugin(storageDomain, { backend: 'json' })
  const adapter = new VisionAdapter(replies.map(reply => reply === 'hang' ? 'hang' as const
    : typeof reply === 'string' ? textResponse(reply)
      : typeof reply === 'function' ? (request: GenerateOptions): StreamChunk[] => textResponse(reply(request)) : reply))
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'vision-model' }) } as never)
  await ctx.plugin(FixtureCamera)
  const camera = ctx.camera as FixtureCamera
  const notices: CameraNotice[] = []
  const noticeReplies: ('accept' | 'refuse' | 'throw')[] = []
  if (options.noticeListener !== false) {
    ctx.on('camera/notice', (notice) => {
      notices.push(notice)
      const reply = noticeReplies.shift() ?? 'accept'
      if (reply === 'throw') throw new Error('outbox full')
      return reply === 'accept' ? true : undefined
    })
  }
  const mount = (deps: CameraWatchDeps): Fiber & PromiseLike<Fiber> => ctx.plugin({
    name: 'camera-watch-test',
    inject,
    apply: (context: Context, value: Config) => mountCameraWatch(context, value, deps),
  }, { timezone: 'America/Phoenix', ...options.channel === false ? {} : { deliverChannelId: '123456789012345678' }, ...config })
  const load = mount(options.deps ?? {})
  if (options.load === undefined) await load
  else await options.load(load)
  let counter = 0
  return {
    ctx, fiber: load, root, adapter, camera, notices, logs, noticeReplies,
    async frames(count, offsets, shades) {
      const frames: CameraFrame[] = []
      for (let index = 0; index < count; index++) {
        const [attachment] = await ctx.attachments.saveImages([{ data: await jpeg(shades?.[index] ?? 20 + index * 40), mediaType: 'image/jpeg', name: `front-door-${String(index + 1)}.jpg` }])
        frames.push({ attachment: attachment!, offsetMs: offsets?.[index] ?? index * 10_000, source: 'snapshot' })
      }
      return frames
    },
    event(kind, frames, eventOptions = {}) {
      counter++
      return {
        id: CameraEventId(eventOptions.id ?? `ring-101-${String(counter)}`),
        deviceId: CameraDeviceId(eventOptions.device ?? 'front-door'),
        kind, occurredAt: eventOptions.at ?? NOON, frames,
      }
    },
    async sessionLog() {
      const files = (await readdir(join(root, 'sessions'), { recursive: true })).filter(file => file.endsWith('.jsonl'))
      const lines = await Promise.all(files.map(async file => (await readFile(join(root, 'sessions', file), 'utf8')).trim().split('\n')))
      return lines.flat().map(line => JSON.parse(line) as Record<string, unknown>)
    },
    remount: (deps = options.deps ?? {}) => mount(deps),
    async dispose() {
      try {
        await ctx.fiber.dispose()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  }
}

/**
 * JSON verdict text as a model would answer.
 * @param verdict - fields to serialize.
 * @returns JSON text.
 */
export function verdictText(verdict: Record<string, unknown>): string {
  return JSON.stringify({ labels: [], counts: {}, activity: 'none', confidence: 0.9, description: 'Quiet street.', personFrames: [], ...verdict })
}

/**
 * Wait until a condition holds, polling across macrotasks.
 * @param check - condition to wait for.
 * @param label - failure description.
 */
export async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 2_500; attempt++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error(`timed out waiting for ${label}`)
}
