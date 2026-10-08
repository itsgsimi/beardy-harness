/** Beardy's inherited composition must open and resume a browser session. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-settings'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

it('opens and reloads a Beardy workspace session', async () => {
  const beardyBundle = fileURLToPath(new URL('../../../packages/bundle/beardy', import.meta.url))
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: beardyBundle, enabled: true }] } })
  try {
    await scaffold.ctx.settings.update('agent-preset-registry', { selectedDefault: 'beardy' })
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)
      await connectFreshWorkspace(page, scaffold.workspaceCwd)
      await expect.poll(() => page.getByRole('button', { name: 'Beardy', exact: true }).isVisible()).toBe(true)
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
