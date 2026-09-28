import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import CameraService, { CAMERA_ACTIVITIES, CAMERA_LABELS, CameraDeviceId, CameraEventId } from '../src/index.ts'
import type { CameraDevice, CameraEvent } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

class FixtureCamera extends CameraService {
  devices(): readonly CameraDevice[] { return [{ id: CameraDeviceId('front-door'), label: 'Front door' }] }
  async send(event: CameraEvent): Promise<void> { await this.publish(event) }
}

function event(): CameraEvent {
  return {
    id: CameraEventId('ring-1-2'),
    deviceId: CameraDeviceId('front-door'),
    kind: 'ding',
    occurredAt: 1,
    frames: [{ attachment: { attachmentId: AttachmentId('sha256:a'), mediaType: 'image/jpeg', bytes: 1, width: 1, height: 1 }, offsetMs: 0, source: 'snapshot' }],
  }
}

async function mount(): Promise<{ ctx: Context; camera: FixtureCamera }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(FixtureCamera)
  return { ctx, camera: ctx.camera as FixtureCamera }
}

describe('camera identities', () => {
  it('accepts deployment device ids and rejects unsafe ones', () => {
    expect(CameraDeviceId('garage-2')).toBe('garage-2')
    for (const bad of ['', 'Front', '1door', 'a'.repeat(41), 'front door']) expect(() => CameraDeviceId(bad)).toThrow(/camera device id/)
  })

  it('accepts provider event ids and rejects unsafe ones', () => {
    expect(CameraEventId('ring-123:456.7_8')).toBe('ring-123:456.7_8')
    for (const bad of ['', 'a/b', 'x'.repeat(129)]) expect(() => CameraEventId(bad)).toThrow(/camera event id/)
  })

  it('lists labels and activities in canonical order', () => {
    expect(CAMERA_LABELS).toEqual(['person', 'vehicle', 'package', 'animal'])
    expect(CAMERA_ACTIVITIES).toEqual(['delivering', 'lingering', 'passing', 'ringing', 'none', 'unknown'])
  })
})

describe('CameraService', () => {
  it('refuses construction of the abstract definition', () => {
    const ctx = new Context()
    contexts.push(ctx)
    expect(() => { Reflect.construct(CameraService, [ctx]) }).toThrow(/load a camera provider/)
  })

  it('registers as ctx.camera and delivers events to every listener', async () => {
    const { ctx, camera } = await mount()
    const seen: string[] = []
    ctx.on('camera/event', (received) => { seen.push(`a:${received.id}`) })
    ctx.on('camera/event', async (received) => { seen.push(`b:${received.id}`) })
    await camera.send(event())
    expect(seen).toEqual(['a:ring-1-2', 'b:ring-1-2'])
    expect(camera.devices()).toEqual([{ id: 'front-door', label: 'Front door' }])
  })

  it('contains listener failures and still reaches the other listeners', async () => {
    const { ctx, camera } = await mount()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const seen: string[] = []
    ctx.on('camera/event', () => { throw new Error('first broke') })
    ctx.on('camera/event', async () => { throw 'second broke' })
    ctx.on('camera/event', (received) => { seen.push(received.id) })
    await expect(camera.send(event())).resolves.toBeUndefined()
    expect(seen).toEqual(['ring-1-2'])
    expect(warn.mock.calls.map(call => String(call[0]))).toEqual([
      'camera: a camera/event listener failed for ring-1-2: first broke',
      'camera: a camera/event listener failed for ring-1-2: second broke',
    ])
  })
})
