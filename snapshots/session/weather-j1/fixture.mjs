/** Recorded j1 weather response with no network access. */
import { readFileSync } from 'node:fs'

export const name = 'weather-j1-fixture'
export const inject = ['web']

export function apply(ctx) {
  const content = readFileSync(new URL('./fixture.json', import.meta.url), 'utf8')
  ctx.web.registerFetchProvider({
    id: 'weather-fixture',
    available: () => true,
    async fetch(request) {
      if (request.url !== 'https://wttr.in/Phoenix%2C%20AZ?format=j1') {
        throw new Error(`unexpected weather request: ${request.url}`)
      }
      return { url: request.url, statusCode: 200, body: { kind: 'text', content }, truncated: false }
    },
  })
}
