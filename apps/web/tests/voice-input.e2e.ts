/** Real shipped web composition: microphone capture → bounded decoder → local backend → draft. */
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

describe('web voice input', () => {
  let root: string
  let backend: Server
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let transcriptions = 0
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-voice-web-'))
    backend = createServer((request, response) => {
      void (async (): Promise<void> => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(chunk as Buffer)
        const body = Buffer.concat(chunks)
        if (!body.includes(Buffer.from('RIFF')) || !body.includes(Buffer.from('recording.wav'))) {
          response.writeHead(400).end(); return
        }
        transcriptions += 1
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ text: 'Please review the latest change.' }))
      })()
    })
    await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve))
    const address = backend.address()
    if (address === null || typeof address === 'string') throw new Error('Missing backend address')
    const patch = join(root, 'voice.patch.yml')
    await writeFile(patch, `- id: speech-whisper\n  disabled: false\n  config:\n    endpoint: http://127.0.0.1:${address.port}/inference\n    ffmpegPath: ffmpeg\n    maxAudioBytes: 16777216\n    maxDurationSeconds: 180\n    timeoutMs: 10000\n    maxConcurrent: 2\n`)
    scaffold = await launchWebScaffold({ extraOverlayPath: patch, replayFixture: fileURLToPath(new URL('../../../snapshots/web/voice-input/session.v3.jsonl', import.meta.url)) })
    browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
    page = await newEnglishPage(browser)
    page.on('pageerror', (error) => { console.error('VOICE PAGE', error.message) })
    page.on('console', (message) => { if (message.type() === 'error') console.error('VOICE CONSOLE', message.text()) })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'voice-input')
  }, 180000)
  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (backend !== undefined) await new Promise<void>(resolve => backend.close(() => { resolve() }))
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })
  it('shows native microphone controls and inserts a reviewable transcript', async () => {
    const mic = page.getByRole('button', { name: 'Dictate a message' })
    await mic.waitFor({ timeout: 15000 })
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    await input.fill('Existing draft.')
    await mic.click()
    await page.getByRole('button', { name: 'Stop recording' }).waitFor()
    await page.screenshot({ path: '/tmp/dsh-voice-recording.png' })
    // The fake capture device needs one audio packet before stop.
    await page.waitForTimeout(600)
    await page.getByRole('button', { name: 'Stop recording' }).click()
    await expect.poll(() => input.innerText()).toBe('Existing draft. Please review the latest change.')
    expect(transcriptions).toBe(1)
    await mic.waitFor()
    await page.screenshot({ path: '/tmp/dsh-voice-desktop.png' })
    expect(await page.getByText('Please review the latest change.', { exact: true }).count()).toBe(0)
  })
  it('cancels without uploading and fits the phone composer', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Dictate a message' }).click()
    await page.getByRole('button', { name: 'Stop recording' }).waitFor()
    await page.getByRole('button', { name: 'Cancel recording' }).click()
    await page.getByRole('button', { name: 'Dictate a message' }).waitFor()
    expect(transcriptions).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: '/tmp/dsh-voice-phone.png' })
    const settled = scaffold.whenTurnSettled()
    await page.locator('[data-composer-input][contenteditable="true"]').first().press('Enter')
    await settled
    await page.getByText('Ready to review.', { exact: true }).waitFor()
  })
})
