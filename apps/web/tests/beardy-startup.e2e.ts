/** Beardy's inherited composition must open and resume a browser session. */
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

it('opens and reloads a Beardy workspace session', async () => {
  const scaffold = await launchWebScaffold({})
  try {
    await scaffold.ctx.settings.update('agent-presets', { default: 'beardy' })
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)
      await connectFreshWorkspace(page, scaffold.workspaceCwd)
      await expect.poll(() => page.getByText('Beardy mode', { exact: true }).isVisible()).toBe(true)
      await page.reload()
      await page.locator('[data-composer-input][contenteditable="true"]').waitFor()
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})
