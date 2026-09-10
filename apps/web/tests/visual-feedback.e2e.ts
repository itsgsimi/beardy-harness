/** Authored model replay exercises real visual tools, durable bytes, and the shipped Web composition. */
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import {
  captureStableAria, compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/visual-feedback', import.meta.url))
const SHOTS = fileURLToPath(new URL('../../../.playwright-mcp/visual-feedback', import.meta.url))
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web: inline visual feedback', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ replayFixture: join(DIR, 'session.v3.jsonl'), compareReplaySession: true })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]')
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await cp(join(DIR, 'workspace'), join(scaffold.workspaceCwd, 'workspace'), { recursive: true })
    await mkdir(SHOTS, { recursive: true })
  })

  afterAll(async () => {
    try { await browser?.close() }
    finally { await scaffold?.close() }
  })

  it('shows charts, original screenshots, animated GIFs, and working isolated mockups alongside findings', async () => {
    const [prompt] = fixtureUserPrompts(await readFile(join(DIR, 'session.v3.jsonl'), 'utf8'))
    if (prompt === undefined) throw new Error('Visual fixture requires a user prompt')
    const settled = scaffold.whenTurnSettled()
    const composer = page.locator('[data-composer-input]').first()
    await composer.fill(prompt)
    await composer.press('Enter')
    const sessionId = await settled
    const session = scaffold.ctx.agents.get(sessionId)?.session
    expect(session).toBeDefined()
    const deliveries = session!.snapshotEvents().filter(event => event.type === 'deliverables/presented')
    expect(deliveries).toHaveLength(4)
    expect(session!.snapshotEvents().some(event => event.type === 'system/message'
      && JSON.stringify(event.data).includes('use it proactively'))).toBe(true)
    expect(session!.snapshotEvents().some(event => event.type === 'request/header'
      && JSON.stringify(event.data).includes('present_visual'))).toBe(true)
    await expect.poll(() => page.locator('[data-presented-visual]').count()).toBe(4)
    const cards = page.locator('[data-presented-visual]')
    await expect.poll(() => cards.locator('img').evaluateAll(images => images.every(image =>
      image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))).toBe(true)
    expect(await cards.first().textContent()).toContain('latency falls from 800 ms to 400 ms')

    const frame = page.locator('iframe[title="Interactive chart mockup"]').first().contentFrame()
    await frame.getByText('Parent isolated', { exact: true }).waitFor()
    await expect.poll(() => frame.locator('body').getAttribute('data-network')).toBe('blocked')
    await frame.getByRole('button', { name: 'Toggle data' }).click()
    expect(await frame.locator('#value').textContent()).toBe('200 ms')
    expect(await page.locator('iframe[title="Interactive chart mockup"]').getAttribute('sandbox')).toBe('allow-scripts')
    const animation = page.getByRole('img', { name: 'Interaction recording' })
    const firstFrame = await animation.screenshot()
    await expect.poll(async () => Buffer.compare(firstFrame, await animation.screenshot()), { timeout: 5000 }).not.toBe(0)
    const downloadEvent = page.waitForEvent('download')
    await cards.nth(1).getByRole('link', { name: 'Download original' }).click()
    const download = await downloadEvent
    const downloadPath = await download.path()
    expect(downloadPath).not.toBeNull()
    if (downloadPath === null) throw new Error('Browser did not retain the downloaded visual')
    expect(await readFile(downloadPath)).toEqual(await readFile(join(DIR, 'workspace/screenshot.png')))

    await cards.first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(SHOTS, 'desktop.png') })
    const aria = await captureStableAria(page, '[data-chat-flow]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(DIR, 'ui.expected.md'), aria, MODE)
    await rm(join(scaffold.workspaceCwd, 'workspace'), { recursive: true })
    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => page.locator('[data-presented-visual] img').count()).toBe(3)
    await expect.poll(() => page.locator('[data-presented-visual] img').evaluateAll(images => images.every(image =>
      image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))).toBe(true)
  })

  it('keeps visual cards and expanded controls accessible at phone widths', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      locale: 'en-US', timezoneId: 'Asia/Shanghai', storageState: await page.context().storageState(),
    })
    try {
      const mobile = await context.newPage()
      await mobile.goto(page.url(), { waitUntil: 'load' })
      await mobile.locator('[data-presented-visual]').first().waitFor()
      for (const width of [320, 390, 768]) {
        await mobile.setViewportSize({ width, height: 844 })
        const cards = mobile.locator('[data-presented-visual]')
        await cards.first().scrollIntoViewIfNeeded()
        const bounds = await cards.first().boundingBox()
        expect(bounds).not.toBeNull()
        expect(bounds!.x).toBeGreaterThanOrEqual(0)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1)
        await cards.first().getByRole('button', { name: 'Expand view' }).tap()
        const dialog = mobile.getByRole('dialog', { name: 'Response time comparison' })
        await dialog.waitFor()
        await dialog.getByRole('button', { name: 'Close visual preview' }).tap()
        if (width === 390) await mobile.screenshot({ path: join(SHOTS, 'phone.png') })
      }
    } finally { await context.close() }
  })
})
