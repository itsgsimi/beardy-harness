/** Report plugin on fixture timers; delivered outcomes become workspace files instead of Discord messages. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Config, inject, mountReports } from '@deepseek-ai/dsh-fantasy-reports'
import { markDelivered, registerTick } from './gate.mjs'

export const name = 'fantasy-report-schedule-fixture'
export { Config, inject }

export function apply(ctx, config) {
  ctx.on('cron/run-finished', async (payload) => {
    const dir = join(process.cwd(), 'delivered', payload.deliverChannelId)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${payload.jobName}.md`), payload.outcome === 'answered' ? payload.text : `${JSON.stringify(payload.failure)}\n`)
    markDelivered()
    return true
  })
  mountReports(ctx, config, (job, onTick) => {
    registerTick(job.expression, onTick)
    return { stop() {}, nextRunAt: () => undefined }
  }, Date.now)
}
