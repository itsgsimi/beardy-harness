/** Shared RSS, weather, and configuration fixtures for the brief collector tests. */
import type {} from '@deepseek-ai/dsh-cron'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { WebFetchResult } from '@deepseek-ai/dsh-web'
import type { CollectorConfig } from '../src/collector.ts'
import type { Config } from '../src/index.ts'

export const at = Date.parse('2026-09-08T14:05:00Z')
export const collectorConfig: CollectorConfig = {
  timezone: 'America/Phoenix',
  feeds: [{ name: 'A', url: 'https://a.example/rss' }, { name: 'B', url: 'https://b.example/rss' }],
  weather: { city: 'Phoenix', url: 'https://weather.example/j1' },
  itemsPerFeed: 5, maxItems: 3, lookbackHours: 36, timeoutMs: 30_000,
  titleChars: 180, summaryChars: 280,
}
export const item = (title: string, url: string, date = 'Tue, 08 Sep 2026 12:00:00 GMT'): string =>
  `<item><title>${title}</title><link>${url}</link><pubDate>${date}</pubDate><description><![CDATA[<p>A &amp; B <b>summary</b></p>]]></description></item>`
export const rss = (items: string): string => `<rss version="2.0"><channel><title>News</title>${items}</channel></rss>`
export const weather = JSON.stringify({ weather: [
  { date: '2026-09-07', maxtempF: '111', mintempF: '88' },
  { date: '2026-09-08', maxtempF: '103', mintempF: '84', maxtempC: '39', mintempC: 29, uvIndex: '', hourly: [{ chanceofrain: '0' }, { chanceofrain: '9' }, {}] },
] })
export const response = (content: string, statusCode = 200): WebFetchResult => ({
  url: 'https://fixture.example', statusCode, truncated: false, body: { kind: 'text', content },
})
export const config: Config = { ...collectorConfig, jobName: 'morning-brief-4b-test', maxTokens: 768, packetMaxChars: 6000 }
/** The plugin fixture configuration with replaced fields. */
export const configWith = (patch: Partial<Config>): Config => Object.assign({}, config, patch)
export const cronMessage = (jobName = config.jobName): UserMessage => createUserMessage({
  content: [{ type: 'text', text: 'Old coordinator instructions and continuity notes' }],
  source: { kind: 'cron', jobName, scheduledFor: at, form: 'notice', summary: 'Cron job' },
})
