// Keyless assembled-browser coverage for the phone presentation of the shipped
// Web surface: one Chromium emulating a 390px touch phone, the real plugin
// graph, no overlay. The facts asserted are the ones a phone reader feels:
// nothing a reader cannot pan to sits past the screen edge, the left column is
// a drawer rather than a rail and a pick inside it is its exit, editable text
// sits at the 16px floor that stops iOS from zooming into it, and a wide
// Markdown table can be panned without a hover. The geometry report is a
// golden so a regression names the element.
//
// Zero model calls: the transcript is a closed turn assembled through the
// Session API and seeded cold, the way markdown-wide-table.e2e.ts seeds its
// tables; a stray stream would fail loud with NO_ADAPTER.
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import {
  assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'

/** Where this scenario's accepted phone forms are archived for review. */
const SHOT_DIR = fileURLToPath(new URL('../../../.artifacts/screenshots/mobile-viewport', import.meta.url))
const EXPECTED_DIR = fileURLToPath(new URL('./expected/mobile-viewport', import.meta.url))
const GOLDEN = 'geometry.expected.md'
const SEED_ID = 'mobile-viewport-web-e2e'
/** Painted into the final paragraph; the open barrier waits for it. */
const TAIL_MARKER = 'MOBILE_VIEWPORT_DONE'

const PHONE = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  locale: 'en-US',
  timezoneId: 'Asia/Shanghai',
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
} as const

/** The assistant markdown: a long link, a filling table with paths, a wide table, a fence, an unbroken token. */
function transcriptMarkdown(): string {
  return [
    '## Summary',
    '',
    `Here is a long link: https://example.com/${'segment/'.repeat(20)}file.txt`,
    '',
    '| Package | Role | Path |',
    '| --- | --- | --- |',
    '| core | product API spine with a fairly long description cell | packages/core/session/src/index.ts |',
    '| api | Remote BFF assembly | packages/api/gateway/src/stream-server.ts |',
    '',
    '| A | B | C | D | E |',
    '| --- | --- | --- | --- | --- |',
    '| one | two | three | four | five |',
    '',
    '```ts',
    'export function computeColumns(viewport: number, sidebar: number, rightbar: number): Columns { return { sidebar, center: viewport - sidebar - rightbar, rightbar } }',
    '```',
    '',
    `Unbroken: ${'a'.repeat(120)}`,
    '',
    TAIL_MARKER,
  ].join('\n')
}

/** Build one closed, invariant-checked session fixture: a user turn and the markdown reply. */
function transcriptFixture(): string {
  const session = Session.create(SessionId('mobile-viewport-source'))
  const eventTimeOrigin = new Date().setHours(12, 0, 0, 0)
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Please inspect the repository and summarize the layout with a table and code.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: 'Phone layout probe',
    messageSeqs: [user.seq],
    source: { kind: 'fallback' },
  })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: transcriptMarkdown() }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const header = {
    type: 'session',
    version: SESSION_FORMAT_VERSION,
    id: '{{sessionId}}',
    createdAt: 0,
    cwd: '{{cwd}}',
    isSeeded: false,
    delegationDepth: 0,
  }
  return [
    JSON.stringify(header),
    ...session.snapshotEvents().map(event => JSON.stringify({
      ...event,
      time: eventTimeOrigin + event.seq * 1_000,
    })),
    '',
  ].join('\n')
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png` })
}

/**
 * Elements laid out past either screen edge that a reader cannot pan to:
 * descendants of a horizontal scroll container are pannable and skipped (the
 * container itself is still checked), as is the right column's parked panel.
 */
async function overflowing(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const width = window.innerWidth
    const out: string[] = []
    const pannable = (el: HTMLElement): boolean => {
      for (let node = el.parentElement; node !== null && node !== document.body; node = node.parentElement) {
        const overflowX = getComputedStyle(node).overflowX
        if (overflowX === 'auto' || overflowX === 'scroll') return true
      }
      return false
    }
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      if (el.closest('[data-rightbar-col]') !== null || pannable(el)) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || (r.right <= width + 1 && r.left >= -1)) continue
      out.push(`${el.tagName.toLowerCase()} ${String(Math.round(r.left))}..${String(Math.round(r.right))} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 32)}"`)
    }
    return out
  })
}

/** Let the drawer's slide-in and any grid transition land before geometry is read. */
async function settled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined)))
  })
}

async function geometry(page: Page, label: string): Promise<string> {
  const facts = await page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>('[data-phone]')
    const composer = document.querySelector<HTMLElement>('[data-composer-input]')
    const wide = document.querySelector<HTMLElement>('.md-table-wide')
    const fill = document.querySelector<HTMLElement>('[class*="tableFill"]')
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      columns: frame?.style.gridTemplateColumns ?? 'no phone frame',
      composerFontSize: composer === null ? 'absent' : getComputedStyle(composer).fontSize,
      drawer: document.querySelector('[data-sidebar-drawer]') !== null,
      menuControl: document.querySelector('[data-sidebar-drawer-open]') !== null,
      wideTableOverflowX: wide === null ? 'absent' : getComputedStyle(wide).overflowX,
      fillTableFits: fill === null ? 'absent' : String(fill.scrollWidth <= fill.clientWidth),
    }
  })
  return [
    `## ${label}`,
    '',
    `- document width: ${String(facts.documentWidth)} of ${String(facts.viewportWidth)}`,
    `- grid columns: ${facts.columns}`,
    `- composer font-size: ${facts.composerFontSize}`,
    `- drawer open: ${String(facts.drawer)}; open control: ${String(facts.menuControl)}`,
    `- wide table overflow-x: ${facts.wideTableOverflowX}`,
    `- three-column table fits its column: ${facts.fillTableFits}`,
    '',
  ].join('\n')
}

describe('web e2e: phone viewport', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const report: string[] = ['# Phone viewport geometry (390×844, touch)', '']

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, transcriptFixture(), SEED_ID)
    browser = await chromium.launch()
    page = await (await browser.newContext(PHONE)).newPage()
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[data-sidebar-drawer-open]').waitFor({ timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('starts inside the screen with the drawer control and no left rail', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-mobile-start'))
    await settled(page)
    expect(await overflowing(page)).toEqual([])
    report.push(await geometry(page, 'Start'))
    await shot(page, '01-start')
  })

  it('opens the sidebar as a drawer and leaves through a Session pick', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-mobile-drawer'))
    await page.locator('[data-sidebar-drawer-open]').click()
    const drawer = page.locator('[data-sidebar-drawer]')
    await drawer.waitFor({ timeout: 10_000 })
    await settled(page)
    expect(await page.locator('[data-sidebar-drawer-open]').count()).toBe(0)
    expect(await overflowing(page)).toEqual([])
    report.push(await geometry(page, 'Drawer open'))
    await shot(page, '02-drawer')
    const groupRow = drawer.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = drawer.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await expect.poll(() => drawer.count(), { timeout: 10_000 }).toBe(0)
    await page.locator('[data-sidebar-drawer-open]').waitFor({ timeout: 10_000 })
    await page.getByText(TAIL_MARKER, { exact: true }).waitFor({ timeout: 15_000 })
  }, 60_000)

  it('renders the seeded transcript without pushing anything unpannable past the screen', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-mobile-transcript'))
    await settled(page)
    await expect.poll(() => page.locator('.md-table-wide').count()).toBe(1)
    expect(await overflowing(page)).toEqual([])
    report.push(await geometry(page, 'Seeded transcript'))
    await shot(page, '03-transcript')
  })

  it('keeps every control of a pending multi-select question on the portrait screen', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-mobile-question'))
    const seededId = SessionId(SEED_ID)
    await expect.poll(() => scaffold.ctx.agents.get(seededId) !== undefined, { timeout: 10_000 }).toBe(true)
    const agent = scaffold.ctx.agents.get(seededId)
    if (agent === undefined) throw new Error('seeded session has no Agent')
    const description = 'A long description that wraps across several lines on a phone so the option rows take real height.'
    const asked = scaffold.ctx.userQuestions.ask({
      agent,
      questions: [{
        id: 'color', header: 'Pick one', question: 'Which color do you prefer?', multiSelect: true,
        options: [
          { label: 'Blue', description }, { label: 'Green', description }, { label: 'Red', description }, { label: 'Amber', description },
        ],
      }],
    })
    const composer = page.locator('[data-question-key]')
    await composer.waitFor({ timeout: 30_000 })
    await settled(page)
    // Header and footer controls must sit on screen; option rows live in the
    // card's own scroll body and may extend below it.
    const offscreen = await composer.evaluate(card => Array.from(card.querySelectorAll('button')).flatMap((button) => {
      if (button.closest('[data-question-scroll]') !== null) return []
      const r = button.getBoundingClientRect()
      const hidden = r.width > 0 && (r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth)
      return hidden ? [button.getAttribute('aria-label') ?? button.textContent?.trim() ?? ''] : []
    }))
    expect(offscreen).toEqual([])
    expect(await overflowing(page)).toEqual([])
    report.push(await geometry(page, 'Pending question'))
    await shot(page, '04-question')
    await composer.getByRole('button', { name: 'Skip this question' }).click()
    expect(await asked).toEqual({ answers: [{ id: 'color', selected: [] }] })
    await expect.poll(() => page.locator('[data-question-key]').count(), { timeout: 10_000 }).toBe(0)
  }, 60_000)

  it('opens the header menu inside the screen', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-mobile-header-menu'))
    const more = page.getByRole('button', { name: 'More actions' })
    await more.waitFor({ timeout: 10_000 })
    await more.click()
    const menu = page.getByRole('menu')
    await menu.waitFor({ timeout: 10_000 })
    const box = await menu.boundingBox()
    if (box === null) throw new Error('menu is not rendered')
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.viewport.width)
    expect(box.y + box.height).toBeLessThanOrEqual(PHONE.viewport.height)
    await shot(page, '05-header-menu')
    await page.keyboard.press('Escape')
    await expect.poll(() => menu.count()).toBe(0)
  })

  it('lays Settings out as a full-screen sheet with a horizontal section row', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-mobile-settings'))
    await page.locator('[data-sidebar-drawer-open]').click()
    const drawer = page.locator('[data-sidebar-drawer]')
    await drawer.waitFor({ timeout: 10_000 })
    await drawer.getByRole('button', { name: 'Settings' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor({ timeout: 10_000 })
    await settled(page)
    const box = await dialog.boundingBox()
    if (box === null) throw new Error('settings dialog is not rendered')
    expect(Math.round(box.width)).toBe(PHONE.viewport.width)
    expect(await overflowing(page)).toEqual([])
    report.push(await geometry(page, 'Settings'))
    await shot(page, '06-settings')
    await dialog.getByRole('button', { name: 'Models' }).click()
    await settled(page)
    expect(await overflowing(page)).toEqual([])
    await shot(page, '07-settings-models')
    await page.keyboard.press('Escape')
    await expect.poll(() => dialog.count(), { timeout: 10_000 }).toBe(0)
    if (await drawer.count() > 0) {
      await page.locator('[data-sidebar-drawer-scrim]').click({ position: { x: PHONE.viewport.width - 20, y: 400 } })
      await expect.poll(() => drawer.count(), { timeout: 10_000 }).toBe(0)
    }
  }, 60_000)

  it('floors editable text at 16px so the phone browser does not zoom into the composer', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-mobile-composer'))
    const composer = page.locator('[data-composer-input][contenteditable="true"]').first()
    await composer.click()
    expect(await composer.evaluate(el => Number.parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16)
    report.push(await geometry(page, 'Composer focused'))
    await shot(page, '08-composer-focus')
  })

  it('records the geometry golden and stays free of console noise', async () => {
    await compareOrRefreshGolden(`${EXPECTED_DIR}/${GOLDEN}`, report.join('\n'), webSnapshotMode())
    await assertFixtureInventory(EXPECTED_DIR, [GOLDEN])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
