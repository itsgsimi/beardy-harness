import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderAdmission } from '../src/admission.ts'

afterEach(() => { vi.useRealTimers() })

describe('provider admission', () => {
  it('grants in FIFO order and releases each slot once', async () => {
    const admission = new ProviderAdmission()
    const first = await admission.acquire('local', 1, undefined)
    const order: string[] = []
    const second = admission.acquire('local', 1, undefined).then((release) => {
      order.push('second')
      return release
    })
    const third = admission.acquire('local', 1, undefined).then((release) => {
      order.push('third')
      return release
    })

    first()
    const releaseSecond = await second
    expect(order).toEqual(['second'])
    releaseSecond()
    const releaseThird = await third
    expect(order).toEqual(['second', 'third'])
    releaseThird()
    releaseThird()
    const next = await admission.acquire('local', 1, undefined)
    next()
  })

  it('counts old active requests against a new snapshot limit', async () => {
    const admission = new ProviderAdmission()
    const old = await admission.acquire('local', 2, undefined)
    const queued = admission.acquire('local', 1, undefined)
    old()
    const release = await queued
    release()
  })

  it('removes an aborted waiter without holding its place', async () => {
    const admission = new ProviderAdmission()
    const first = await admission.acquire('local', 1, undefined)
    const controller = new AbortController()
    const aborted = admission.acquire('local', 1, undefined, controller.signal)
    const following = admission.acquire('local', 1, undefined)
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ code: 'ABORTED' })
    first()
    const releaseFollowing = await following
    releaseFollowing()

    await expect(admission.acquire('local', 1, undefined, controller.signal))
      .rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('times out a queued waiter without using its later slot', async () => {
    vi.useFakeTimers()
    const admission = new ProviderAdmission()
    const first = await admission.acquire('local', 1, undefined)
    const timedOut = admission.acquire('local', 1, 40)
    const timedOutAssertion = expect(timedOut).rejects.toMatchObject({ code: 'ADMISSION_TIMEOUT' })
    const following = admission.acquire('local', 1, undefined)
    await vi.advanceTimersByTimeAsync(40)
    await timedOutAssertion
    first()
    const releaseFollowing = await following
    releaseFollowing()
  })

  it('leaves admission unlimited when no cap is configured', async () => {
    const admission = new ProviderAdmission()
    const first = await admission.acquire('local', undefined, undefined)
    const second = await admission.acquire('local', undefined, undefined)
    first()
    second()
  })
})
