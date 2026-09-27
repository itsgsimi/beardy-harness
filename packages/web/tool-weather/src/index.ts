/**
 * Current conditions and wttr.in's three-day j1 forecast through the configured web fetch
 * provider. Tool calls and results use the ordinary Session log; this plugin owns no network
 * client or persistent state.
 * @module @deepseek-ai/dsh-tool-weather
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-web'

/** Cordis Loader name. */
export const name = 'tool-weather'
/** The host provides the model tool registry and configured web fetch provider. */
export const inject = ['tools', 'web']

/** Deployment choices for the weather tool. */
export interface Config {
  /** Used when a call omits city; required so the default is deployment-owned. */
  defaultLocation: string
  /** Temperature and wind units returned to the model. Defaults to US customary. */
  units?: 'us' | 'metric'
  /** Forecast days to return, from one to wttr.in j1's maximum of three. */
  days?: number
}

/** Validated weather configuration. */
export const Config: z<Config> = z.object({
  defaultLocation: z.string().required(),
  units: z.union(['us', 'metric']).default('us'),
  days: z.number().min(1).max(3).default(3),
})

type JsonRecord = Record<string, unknown>

interface WeatherDay {
  date: string | null
  high: number | null
  low: number | null
  sun_hours: number | null
  uv_index: number | null
  sunrise: string | null
  sunset: string | null
  peak_rain_chance_pct: number | null
  peak_rain_time: string | null
  peak_rain_desc: string | null
}

interface WeatherReport {
  location: {
    name: string
    region: string | null
    country: string | null
    latitude: string | null
    longitude: string | null
  }
  observed_at: string | null
  units: { temperature: 'C' | 'F'; wind: 'km/h' | 'mph' }
  current: {
    description: string | null
    temperature: number | null
    feels_like: number | null
    humidity_pct: number | null
    wind_speed: number | null
    wind_dir: string | null
    uv_index: number | null
    cloud_cover_pct: number | null
    precip_mm: number | null
    visibility_miles: number | null
  }
  forecast: WeatherDay[]
}

function record(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : {}
}

function first(value: unknown): JsonRecord {
  return Array.isArray(value) ? record(value[0]) : {}
}

function field(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function number(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function nestedValue(value: unknown): string | null {
  return field(first(value).value)
}

/**
 * Project a wttr.in j1 document into bounded, unit-selected weather data.
 * @param payload - parsed provider JSON.
 * @param requestedLocation - caller location used when wttr.in omits the resolved area.
 * @param units - selected temperature and wind units.
 * @param days - configured forecast count, from one to three.
 * @returns current conditions and up to the requested number of daily forecasts.
 */
export function projectWeather(payload: unknown, requestedLocation: string, units: 'us' | 'metric', days: number): WeatherReport {
  const data = record(payload)
  const current = first(data.current_condition)
  if (Object.keys(current).length === 0) throw new Error('get_weather: wttr.in returned no current conditions')
  const area = first(data.nearest_area)
  const forecast = Array.isArray(data.weather) ? data.weather.slice(0, days) : []
  return {
    location: {
      name: nestedValue(area.areaName) ?? requestedLocation,
      region: nestedValue(area.region),
      country: nestedValue(area.country),
      latitude: field(area.latitude),
      longitude: field(area.longitude),
    },
    observed_at: field(current.observation_time),
    units: units === 'metric' ? { temperature: 'C', wind: 'km/h' } : { temperature: 'F', wind: 'mph' },
    current: {
      description: nestedValue(current.weatherDesc),
      temperature: number(units === 'metric' ? current.temp_C : current.temp_F),
      feels_like: number(units === 'metric' ? current.FeelsLikeC : current.FeelsLikeF),
      humidity_pct: number(current.humidity),
      wind_speed: number(units === 'metric' ? current.windspeedKmph : current.windspeedMiles),
      wind_dir: field(current.winddir16Point),
      uv_index: number(current.uvIndex),
      cloud_cover_pct: number(current.cloudcover),
      precip_mm: number(current.precipMM),
      visibility_miles: number(current.visibilityMiles),
    },
    forecast: forecast.map((value) => {
      const day = record(value)
      const hourly = Array.isArray(day.hourly) ? day.hourly.map(record) : []
      const peak = hourly.reduce<JsonRecord | undefined>((best, hour) =>
        best === undefined || (number(hour.chanceofrain) ?? 0) > (number(best.chanceofrain) ?? 0)
          ? hour : best, undefined)
      const astronomy = first(day.astronomy)
      return {
        date: field(day.date),
        high: number(units === 'metric' ? day.maxtempC : day.maxtempF),
        low: number(units === 'metric' ? day.mintempC : day.mintempF),
        sun_hours: number(day.sunHour),
        uv_index: number(day.uvIndex),
        sunrise: field(astronomy.sunrise),
        sunset: field(astronomy.sunset),
        peak_rain_chance_pct: peak === undefined ? null : number(peak.chanceofrain),
        peak_rain_time: peak === undefined ? null : field(peak.time),
        peak_rain_desc: peak === undefined ? null : nestedValue(peak.weatherDesc),
      }
    }),
  }
}

/**
 * Register the read-only tool. A provider error, non-success response, capped body, or invalid
 * JSON fails the call; the registry records the failure as a tool result.
 * @param ctx - host tool registry and web service.
 * @param config - validated location and forecast selection.
 */
export function apply(ctx: Context, config: Config): void {
  const location = config.defaultLocation.trim()
  if (location.length === 0) throw new Error('tool-weather: defaultLocation must not be empty')
  const resolved = config as Required<Config>
  const { units, days } = resolved
  if (!Number.isSafeInteger(days) || days < 1 || days > 3) {
    throw new Error('tool-weather: days must be an integer from 1 to 3')
  }
  ctx.tools.register({
    name: 'get_weather',
    description: 'Get current weather and a forecast for a location using wttr.in. '
      + 'The wttr.in j1 response contains at most three forecast days; requests for later days '
      + 'need another source. Omit city to use the configured home location.',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City, region, postal code, or airport code. Defaults to the configured home location.' },
      },
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const input = record(args)
      const city = typeof input.city === 'string' ? input.city.trim() : location
      if (city.length === 0) throw new Error('get_weather: city must not be empty')
      const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`
      const response = await ctx.web.fetch({ url }, exec.signal)
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`get_weather: wttr.in returned HTTP ${response.statusCode}`)
      }
      if (response.truncated) throw new Error('get_weather: wttr.in response was truncated')
      if (response.body.kind !== 'text') throw new Error('get_weather: expected JSON text from wttr.in')
      let payload: unknown
      try {
        payload = JSON.parse(response.body.content)
      } catch {
        throw new Error('get_weather: invalid JSON from wttr.in')
      }
      return projectWeather(payload, city, units, days)
    },
  })
}
