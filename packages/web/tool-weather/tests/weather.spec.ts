import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Web from '@deepseek-ai/dsh-web'
import type { WebFetchResult } from '@deepseek-ai/dsh-web'
import * as Weather from '../src/index.ts'

const sample: unknown = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/wttr-j1.json', import.meta.url)), 'utf8'))
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function mount(result: WebFetchResult, config: Weather.Config = { defaultLocation: 'Phoenix, AZ' }) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Web)
  const fetch = vi.fn(async () => result)
  ctx.web.registerFetchProvider({ id: 'recorded', available: () => true, fetch })
  await ctx.plugin(Weather, config)
  const call = (args: Record<string, string>) => ctx.tools.execute({
    name: 'get_weather', arguments: args, callId: ToolCallId('weather-test'), signal: new AbortController().signal,
  })
  return { ctx, fetch, call }
}

function response(body = JSON.stringify(sample), statusCode = 200, truncated = false): WebFetchResult {
  return { url: 'https://wttr.in/Phoenix?format=j1', statusCode, body: { kind: 'text', content: body }, truncated }
}

describe('get_weather', () => {
  it('fetches the configured location and returns three recorded j1 days through the tool registry', async () => {
    const { ctx, fetch, call } = await mount(response())
    expect(ctx.tools.schemas().find(item => item.name === 'get_weather')?.description).toContain('at most three')
    const result = await call({})
    expect(fetch).toHaveBeenCalledWith({ url: 'https://wttr.in/Phoenix%2C%20AZ?format=j1' }, expect.any(AbortSignal))
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      location: { name: 'Phoenix', region: 'Arizona' },
      current: { temperature: 91, wind_speed: 8, description: 'Sunny' },
      forecast: [
        { high: 96, peak_rain_chance_pct: 30, peak_rain_time: '1500' },
        { peak_rain_chance_pct: null },
        { date: '2026-09-29' },
      ],
    })
  })

  it('uses metric config, a call location, and the configured forecast day bound', async () => {
    const { fetch, call } = await mount(response(), { defaultLocation: 'Phoenix', units: 'metric', days: 1 })
    const result = await call({ city: ' Berlin ' })
    expect(fetch).toHaveBeenCalledWith({ url: 'https://wttr.in/Berlin?format=j1' }, expect.any(AbortSignal))
    expect(result.value).toMatchObject({
      units: { temperature: 'C', wind: 'km/h' },
      current: { temperature: 33, feels_like: 34, wind_speed: 13 },
      forecast: [{ high: 36, low: 23 }],
    })
  })

  it('rejects bad deployment config and empty call location', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(Web)
    await expect(ctx.plugin(Weather, { defaultLocation: ' ' })).rejects.toThrow('defaultLocation')
    await expect(ctx.plugin(Weather, { defaultLocation: 'Phoenix', days: 1.5 })).rejects.toThrow('days')
    const { call } = await mount(response())
    expect((await call({ city: ' ' })).isError).toBe(true)
  })

  it.each([
    [response('', 503), 'HTTP 503'],
    [response('[]', 200, true), 'truncated'],
    [{ ...response(), body: { kind: 'html' as const, content: '{}' } }, 'expected JSON text'],
    [response('{bad'), 'invalid JSON'],
    [response('{}'), 'no current conditions'],
  ])('records a tool failure for an unusable wttr result', async (result, detail) => {
    const { call } = await mount(result)
    const out = await call({})
    expect(out.isError).toBe(true)
    expect(JSON.stringify(out)).toContain(detail)
  })

  it('falls back on absent optional weather fields and excludes days beyond the configured bound', () => {
    const value = Weather.projectWeather({
      current_condition: [{ temp_F: 'NaN', humidity: '' }],
      weather: [{ date: 'one', hourly: [
        { chanceofrain: 'oops' }, { chanceofrain: '20' }, { chanceofrain: '0' }, { chanceofrain: 'oops' },
      ] }, [], {}, {}],
    }, 'Home', 'us', 3)
    expect(value.location.name).toBe('Home')
    expect(value.current.temperature).toBeNull()
    expect(value.forecast).toHaveLength(3)
    expect(value.forecast[0]!.peak_rain_chance_pct).toBe(20)
  })

  it('handles a missing forecast array and a non-record payload', () => {
    expect(Weather.projectWeather({ current_condition: [{ temp_F: '70' }] }, 'Home', 'us', 3).forecast).toEqual([])
    expect(() => Weather.projectWeather([], 'Home', 'us', 3)).toThrow('no current conditions')
  })
})
