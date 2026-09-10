/** Discord's external Gateway and REST peers for the recorded Beardy conversation. */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'discord-snapshot-transport'

const USER_ID = '138391763999129600'
const CHANNEL_ID = '1472404859679670455'
const APPLICATION_ID = '1472404859679670456'
const BOT_USER_ID = '1472404859679670480'
const STATUS_TOKEN = 'snapshot-status-token'
const OUTPUT_PREFIX = 'DSH_DISCORD_SNAPSHOT '

/**
 * Install process-local transport peers before the real listener mounts.
 * @param ctx - Loader context that owns the transport replacements.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const originalFetch = globalThis.fetch
    const originalSocket = globalThis.WebSocket
    let activeSocket: FixtureSocket | undefined
    let messageSent = false
    let statusSent = false
    let nextMessage = 1
    const statusDelivered = Promise.withResolvers<void>()

    const emit = (value: unknown): void => { process.stdout.write(`${OUTPUT_PREFIX}${JSON.stringify(value)}\n`) }
    const dispatch = (type: string, data: unknown): void => {
      activeSocket?.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ op: 0, t: type, s: nextMessage++, d: data }),
      }))
    }

    class FixtureSocket extends EventTarget {
      constructor(url: string | URL) {
        super()
        if (String(url) !== 'wss://gateway.discord.gg/?v=10&encoding=json') {
          throw new Error(`Unexpected snapshot websocket: ${String(url)}`)
        }
        activeSocket = this
        queueMicrotask(() => { this.dispatchEvent(new Event('open')) })
      }

      send(value: string): void {
        const frame = JSON.parse(value) as { op: number }
        if (frame.op !== 2) throw new Error(`Unexpected snapshot gateway opcode: ${frame.op}`)
        dispatch('READY', { application: { id: APPLICATION_ID }, user: { id: BOT_USER_ID } })
      }

      close(): void {
        this.dispatchEvent(new Event('close'))
        if (activeSocket === this) activeSocket = undefined
      }
    }

    globalThis.WebSocket = FixtureSocket as unknown as typeof WebSocket
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin !== 'https://discord.com') return originalFetch(input, init)
      const method = init?.method ?? 'GET'
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      emit({ method, path: url.pathname, ...body === undefined ? {} : { body } })
      const json = (value: unknown): Response => Response.json(value)
      if (url.pathname === '/api/v10/applications/@me' && method === 'GET') {
        return json({ id: APPLICATION_ID, interactions_endpoint_url: null })
      }
      if (url.pathname === `/api/v10/applications/${APPLICATION_ID}/commands` && method === 'GET') {
        return json([{ id: '1472404859679670470', type: 1, name: 'hermes', description: 'Previous runtime' }])
      }
      if (url.pathname === `/api/v10/applications/${APPLICATION_ID}/commands` && method === 'PUT') {
        if (!messageSent) {
          messageSent = true
          setImmediate(() => {
            dispatch('MESSAGE_CREATE', {
              id: '1472404859679670457', channel_id: CHANNEL_ID, channel_type: 1,
              author: { id: USER_ID }, content: process.env.DSH_DISCORD_SNAPSHOT_TASK,
            })
          })
        }
        return json(body)
      }
      if (url.pathname === `/api/v10/channels/${CHANNEL_ID}/messages` && method === 'POST') {
        if (JSON.stringify(body).includes('DISCORD_RICH_REPLY_OK') && !statusSent) {
          statusSent = true
          setImmediate(() => {
            dispatch('INTERACTION_CREATE', {
              id: '1472404859679670458', application_id: APPLICATION_ID, token: STATUS_TOKEN,
              type: 2, channel_id: CHANNEL_ID, channel: { id: CHANNEL_ID, type: 1 },
              user: { id: USER_ID }, data: { name: 'status', type: 1 },
            })
          })
          // A pending delivery remains observable until Discord acknowledges the POST.
          await statusDelivered.promise
        }
        return json({ id: String(1472404859679670460n + BigInt(nextMessage++)) })
      }
      if (url.pathname === '/api/v10/interactions/1472404859679670458/snapshot-status-token/callback') {
        return new Response(null, { status: 204 })
      }
      if (url.pathname === `/api/v10/webhooks/${APPLICATION_ID}/${STATUS_TOKEN}/messages/@original`
        && method === 'PATCH') {
        statusDelivered.resolve()
        setImmediate(() => { emit({ complete: true }) })
        return json({ id: '1472404859679670459' })
      }
      throw new Error(`Unexpected snapshot Discord request: ${method} ${url.pathname}`)
    }
    ctx.provide('discordSnapshotTransport' as never, true as never)
    return () => {
      statusDelivered.resolve()
      activeSocket?.close()
      globalThis.fetch = originalFetch
      globalThis.WebSocket = originalSocket
    }
  })
}
