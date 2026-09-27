/** One bounded search/fetch source for the native research snapshot. */
import { waitForStatus } from './gate.mjs'

export const name = 'native-research-web-fixture'
export const inject = ['web']

export function apply(ctx) {
  ctx.web.registerSearchProvider({
    id: 'native-research-fixture', available: () => true,
    async search(_request, signal) {
      await waitForStatus()
      signal?.throwIfAborted()
      return { sources: [{ url: 'https://example.org/native-research', title: 'Fixture source' }], truncated: false }
    },
  })
  ctx.web.registerFetchProvider({
    id: 'native-research-fixture', available: () => true,
    async fetch(_request, signal) {
      signal?.throwIfAborted()
      return { url: 'https://example.org/native-research', statusCode: 200,
        body: { kind: 'text', content: 'Fixture evidence supports the snapshot claim.' }, truncated: false }
    },
  })
}
