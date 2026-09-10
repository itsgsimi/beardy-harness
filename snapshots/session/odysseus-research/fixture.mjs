/** Deterministic Odysseus HTTP report; the production tool performs the request. */
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'

export const name = 'odysseus-research-fixture'
export const inject = ['tools', 'credentials', 'settings']

export async function apply(ctx) {
  let baseURL
  await applyLoopbackServerEffect(ctx, {
    label: 'Odysseus research HTTP fixture',
    onCleanup() {},
    onListening(address) { baseURL = `http://127.0.0.1:${address.port}` },
    requestListener(req, res) {
      if (req.method !== 'POST' || req.url !== '/api/research/result-peek/rp-snapshot'
        || req.headers.authorization !== 'Bearer fixture-token') {
        res.writeHead(400); res.end('{}'); return
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ result: 'Research evidence from the 4B worker.', sources: [
        { title: 'Fixture source', url: 'https://example.org/research' },
      ] }))
    },
  })
  await ctx.loader.create({
    name: '@deepseek-ai/dsh-tool-odysseus-research',
    config: { baseURL, tokenEnv: 'ODYSSEUS_SNAPSHOT_TOKEN', endpointId: 'worker-4b',
      model: 'Qwen3.5-4B', maxRounds: 1, maxTimeSeconds: 60 },
  })
}
