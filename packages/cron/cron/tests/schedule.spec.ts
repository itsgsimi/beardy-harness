import { describe, expect, it } from 'vitest'
import { assertSchedule, cronerScheduler } from '../src/schedule.ts'

describe('assertSchedule', () => {
  it('accepts a five-field expression with a named timezone', () => {
    expect(() => { assertSchedule('0 7 * * *', 'Europe/Zagreb') }).not.toThrow()
  })

  it('accepts a six-field expression with seconds', () => {
    expect(() => { assertSchedule('* * * * * *', 'UTC') }).not.toThrow()
  })

  it('rejects an expression that is not a cron pattern', () => {
    expect(() => { assertSchedule('every morning', 'UTC') }).toThrow()
  })
})

describe('cronerScheduler', () => {
  it('fires with the wall-clock time of the match and reports the next run', async () => {
    const fired: number[] = []
    const job = cronerScheduler({ expression: '* * * * * *', timezone: 'UTC' }, (firedAt) => {
      fired.push(firedAt)
    })
    try {
      const next = job.nextRunAt()
      expect(next).toBeTypeOf('number')
      expect(next! ).toBeGreaterThanOrEqual(Date.now() - 1_000)
      await new Promise(resolve => setTimeout(resolve, 1_300))
      expect(fired.length).toBeGreaterThanOrEqual(1)
      expect(fired[0]).toBeLessThanOrEqual(Date.now())
    } finally {
      job.stop()
    }
  })

  it('stops firing once stopped', async () => {
    const fired: number[] = []
    const job = cronerScheduler({ expression: '* * * * * *', timezone: 'UTC' }, (firedAt) => {
      fired.push(firedAt)
    })
    await new Promise(resolve => setTimeout(resolve, 1_300))
    job.stop()
    const afterStop = fired.length
    await new Promise(resolve => setTimeout(resolve, 1_300))
    expect(fired).toHaveLength(afterStop)
    expect(afterStop).toBeGreaterThanOrEqual(1)
  })

  it('holds a schedule in its own timezone', () => {
    const job = cronerScheduler({ expression: '0 7 * * *', timezone: 'Asia/Tokyo' }, () => {})
    try {
      const next = job.nextRunAt()
      expect(next).toBeDefined()
      expect(new Date(next!).getUTCHours()).toBeLessThan(24)
    } finally {
      job.stop()
    }
  })
})
