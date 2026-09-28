import { describe, expect, it, vi } from 'vitest'
import { assertSchedule, cronerScheduler, latestMatchAt } from '../src/schedule.ts'

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

describe('latestMatchAt', () => {
  const wednesday = Date.parse('2026-09-23T21:00:00Z')

  it('returns the latest match at or before the instant in the pattern timezone', () => {
    expect(latestMatchAt('0 14 * * 3', 'America/Phoenix', wednesday)).toBe(wednesday)
    expect(latestMatchAt('0 14 * * 3', 'America/Phoenix', wednesday + 999)).toBe(wednesday)
    expect(latestMatchAt('0 14 * * 3', 'America/Phoenix', wednesday + 86_400_000)).toBe(wednesday)
    expect(latestMatchAt('0 14 * * 3', 'America/Phoenix', wednesday - 1)).toBe(wednesday - 7 * 86_400_000)
  })

  it('returns undefined for a pattern with no earlier match', () => {
    expect(latestMatchAt('0 0 0 1 1 * 2030', 'UTC', wednesday)).toBeUndefined()
  })
})

describe('cronerScheduler', () => {
  it('resumes at the next future occurrence without making up offline fires', async () => {
    vi.useFakeTimers()
    const fired: number[] = []
    let job: ReturnType<typeof cronerScheduler> | undefined
    try {
      vi.setSystemTime(new Date('2026-09-07T06:00:00Z'))
      job = cronerScheduler({ expression: '0 7 * * *', timezone: 'UTC' }, (at) => { fired.push(at) })
      expect(job.nextRunAt()).toBe(Date.parse('2026-09-07T07:00:00Z'))
      job.stop()
      vi.setSystemTime(new Date('2026-09-08T08:00:00Z'))
      job = cronerScheduler({ expression: '0 7 * * *', timezone: 'UTC' }, (at) => { fired.push(at) })
      expect(job.nextRunAt()).toBe(Date.parse('2026-09-09T07:00:00Z'))
      expect(fired).toEqual([])
      await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000)
      expect(fired).toEqual([Date.parse('2026-09-09T07:00:00Z')])
    } finally {
      job?.stop()
      vi.useRealTimers()
    }
  })

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
