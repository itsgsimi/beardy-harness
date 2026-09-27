import { expect, it } from 'vitest'
import { paginateResearchResponse } from '../src/index.ts'

it('reassembles JSON pages by Unicode code point without splitting an emoji', () => {
  const value = { report: '🧪 evidence' }
  const serialized = JSON.stringify(value)
  let offset = 0
  let assembled = ''
  do {
    const response = paginateResearchResponse(value, offset, 3)
    const page = JSON.parse(response.text) as { text: string; next_offset: number | null; total_chars: number }
    expect(Array.from(page.text).length).toBeLessThanOrEqual(3)
    expect(page.total_chars).toBe(Array.from(serialized).length)
    assembled += page.text
    if (page.next_offset === null) break
    offset = page.next_offset
  } while (true)
  expect(assembled).toBe(serialized)
})

it('rejects an offset beyond the response and retains only supplied report metadata', () => {
  const artifact = { id: 'run', markdown: 'Report', sources: [{ url: 'https://example.org' }] }
  expect(paginateResearchResponse({}, 0, 10, artifact).artifact).toEqual(artifact)
  expect(paginateResearchResponse({}, 0, 10)).not.toHaveProperty('artifact')
  expect(() => paginateResearchResponse({}, 3, 10)).toThrow('offset exceeds the response length')
})
