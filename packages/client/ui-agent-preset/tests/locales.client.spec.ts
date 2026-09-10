/** Web-localized copy for the seven shipped presets and file copy for every other row. */

import { describe, expect, it } from 'vitest'
import { en, presetDisplayText, presetPickerDescription, zh } from '../src/client/locales.ts'

const translate = (bundle: typeof en) => (key: keyof typeof en): string => bundle[key]

describe('preset display copy', () => {
  it.each([
    ['standard', 'presetStandardName', 'presetStandardDescription'],
    ['beardy', 'presetBeardyName', 'presetBeardyDescription'],
    ['beardy-unattended', 'presetBeardyUnattendedName', 'presetBeardyUnattendedDescription'],
    ['beardy-discord', 'presetBeardyDiscordName', 'presetBeardyDiscordDescription'],
    ['ptc', 'presetPtcName', 'presetPtcDescription'],
    ['minimal', 'presetMinimalName', 'presetMinimalDescription'],
    ['cordis', 'presetCordisName', 'presetCordisDescription'],
  ] as const)('localizes the shipped %s preset in English and Chinese', (id, nameKey, descriptionKey) => {
    const preset = { id, trust: 'system' as const, name: 'file name', description: 'file description' }

    expect(presetDisplayText(preset, translate(en)))
      .toEqual({ name: en[nameKey], description: en[descriptionKey] })
    expect(presetDisplayText(preset, translate(zh)))
      .toEqual({ name: zh[nameKey], description: zh[descriptionKey] })
  })

  it('keeps file metadata for user and unknown system presets', () => {
    const fileCopy = { name: '我的标准', description: '团队自己的 preset。' }

    expect(presetDisplayText({ id: 'standard', trust: 'user', ...fileCopy }, translate(en)))
      .toEqual(fileCopy)
    expect(presetDisplayText({ id: 'deployment-extra', trust: 'system', ...fileCopy }, translate(en)))
      .toEqual(fileCopy)
    expect(presetDisplayText({ id: 'bare', trust: 'user' }, translate(en)))
      .toEqual({ name: 'bare' })
  })
})

describe('picker summaries', () => {
  it.each([
    ['standard', 'presetStandardSummary'],
    ['beardy', 'presetBeardySummary'],
    ['beardy-unattended', 'presetBeardyUnattendedSummary'],
    ['beardy-discord', 'presetBeardyDiscordSummary'],
    ['ptc', 'presetPtcSummary'],
    ['minimal', 'presetMinimalSummary'],
    ['cordis', 'presetCordisSummary'],
  ] as const)('localizes the shipped %s summary in English and Chinese', (id, key) => {
    const preset = { id, trust: 'system' as const, description: 'Detailed file description' }

    expect(presetPickerDescription(preset, translate(en))).toBe(en[key])
    expect(presetPickerDescription(preset, translate(zh))).toBe(zh[key])
  })

  it('uses authored descriptions for custom and unrecognized modes', () => {
    const description = 'Only tools for this project.'

    expect(presetPickerDescription({ id: 'standard', trust: 'user', description }, translate(en)))
      .toBe(description)
    expect(presetPickerDescription({ id: 'deployment-extra', trust: 'system', description }, translate(zh)))
      .toBe(description)
    expect(presetPickerDescription({ id: 'bare', trust: 'user' }, translate(en))).toBeUndefined()
    expect(presetPickerDescription({ id: 'bare', trust: 'system' }, translate(zh))).toBeUndefined()
  })
})
