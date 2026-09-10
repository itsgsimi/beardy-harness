import { describe, expect, it } from 'vitest'
import type { DiscordActionRow, DiscordMessageBody } from '@deepseek-ai/dsh-tool-discord'
import { discordGatewayDomainSpec, discordMessageBody, outboxRecord } from '../src/domain.ts'
import { approvalControls, CONVERSATION_CONTROLS, DiscordPromptId, questionControls, renderCards } from '../src/presentation.ts'

const button = { type: 2, style: 1, custom_id: 'go', label: 'Go' } as const
const select = { type: 3, custom_id: 'choice', options: [{ label: 'A', value: 'a' }] } as const
const row = (components: DiscordActionRow['components']): DiscordActionRow => ({ type: 1, components })

describe('durable Discord message validation', () => {
  it('accepts current rich messages and unchanged prior delivery records', () => {
    expect(discordGatewayDomainSpec.version).toBe(3)
    expect(discordGatewayDomainSpec).not.toHaveProperty('compatibleVersions')
    const message = { content: 'Choose', embeds: [{ title: 'State', description: 'Waiting', color: 0xffffff,
      fields: [{ name: 'Session', value: 's', inline: false }], footer: { text: 'DSH' },
    }], components: [row([select])] }
    expect(discordMessageBody.parse(message)).toEqual(message)
    const legacy = { channelId: 'c', chunks: ['  old text\n', message], cursor: 1,
      ordinal: 1, createdAt: 0, nextAttemptAt: 0, attempts: 0 }
    expect(outboxRecord.parse(legacy)).toEqual(legacy)
  })

  it('counts every embed text field toward the aggregate limit', () => {
    const exact = { content: '', embeds: [{ title: 't'.repeat(256), description: 'd'.repeat(4096),
      footer: { text: 'f'.repeat(1000) }, fields: [{ name: 'n'.repeat(256), value: 'v'.repeat(392) }],
    }] }
    expect(discordMessageBody.safeParse(exact).success).toBe(true)
    expect(discordMessageBody.safeParse({ ...exact, embeds: [...exact.embeds, { description: 'x' }] }).success).toBe(false)
    expect(discordMessageBody.safeParse({ content: '', embeds: [{ description: '😀'.repeat(2048) }] }).success).toBe(true)
    expect(discordMessageBody.safeParse({ content: '', embeds: [{ description: '😀'.repeat(2049) }] }).success).toBe(false)
  })

  it.each([
    { content: '' },
    { content: '  ', embeds: [{}] },
    { content: 'x'.repeat(2001) },
    { content: '', embeds: [{ title: 'x'.repeat(257) }] },
    { content: '', embeds: [{ footer: { text: 'x'.repeat(2049) } }] },
    { content: '', embeds: [{ fields: [{ name: 'n', value: 'x'.repeat(1025) }] }] },
    { content: 'x', components: [row([button, select])] },
    { content: 'x', components: [row([select, { ...select, custom_id: 'another' }])] },
    { content: 'x', components: [row([button, button])] },
    { content: 'x', components: [row([button]), row([button])] },
    { content: 'x', components: [row([{ ...select, min_values: 2, max_values: 1 }])] },
    { content: 'x', components: [row([{ ...select, max_values: 2 }])] },
    { content: 'x', components: [row([{ ...select, options: [{ label: 'A', value: 'same' }, { label: 'B', value: 'same' }] }])] },
    { content: 'x', components: [row([{ ...select, options: [] }])] },
    { content: 'x', components: [row([{ ...button, label: '😀'.repeat(41) }])] },
    { content: 'x', components: [row([{ ...button, custom_id: 'x'.repeat(101) }])] },
    { content: 'x', components: Array.from({ length: 6 }, (_unused, index) => row([{ ...button, custom_id: String(index) }])) },
  ])('rejects a payload Discord cannot display', (body) => {
    expect(discordMessageBody.safeParse(body).success).toBe(false)
  })

  it('accepts a full button row and a selector with bounded multiple choice', () => {
    const body = { content: 'Choices', components: [
      row(Array.from({ length: 5 }, (_unused, index) => ({ ...button, custom_id: String(index) }))),
      row([{ ...select, min_values: 0, max_values: 2, options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] }]),
    ] }
    expect(discordMessageBody.parse(body)).toEqual(body)
  })
})

describe('Discord cards and controls', () => {
  const assertValid = (messages: readonly DiscordMessageBody[]): void => {
    for (const body of messages) expect(discordMessageBody.safeParse(body).success).toBe(true)
  }

  it('renders ordinary Markdown with controls only on the final card', () => {
    const text = '**Ready**\n\n' + Array.from({ length: 160 }, (_unused, index) => `- Result ${String(index)}: detail`).join('\n')
    const cards = renderCards(text, { title: 'DSH status', color: 0x336699, controls: CONVERSATION_CONTROLS })
    expect(cards.length).toBeGreaterThan(1)
    assertValid(cards)
    expect(cards[0]?.embeds?.[0]?.description).toContain('**Ready**')
    expect(cards.slice(0, -1).every(card => card.components === undefined)).toBe(true)
    expect(cards.at(-1)?.components).toEqual(CONVERSATION_CONTROLS)
    expect(cards.at(-1)?.embeds?.[0]?.footer?.text).toBe(`${String(cards.length)} / ${String(cards.length)}`)
  })

  it('splits code into bounded cards with closed fences and preserves table values', () => {
    const text = '```ts\n' + '    work();\n'.repeat(300) + '```\n\n| Name | State |\n| --- | --- |\n| Agent | Ready |'
    const cards = renderCards(text, { title: 'Result', color: 0 })
    assertValid(cards)
    const descriptions = cards.flatMap(card => card.embeds?.map(embed => embed.description ?? '') ?? [])
    for (const code of descriptions.filter(description => description.startsWith('```'))) {
      expect(code).toMatch(/^```ts\n[\s\S]*\n```$/)
      expect(code).toContain('    work();')
    }
    expect(descriptions.join('\n')).toContain('**Agent**\n• State: Ready')
  })

  it('rewrites broadcasts without changing regular mentions and suppresses empty cards', () => {
    const cards = renderCards('@everyone @here <@&123> <@456>', { title: 'Notice', color: 0 })
    expect(cards[0]?.embeds?.[0]?.description).toBe('@\u200beveryone @\u200bhere <@&123> <@456>')
    expect(renderCards(' \n', { title: 'Notice', color: 0 })).toEqual([])
    assertValid(cards)
  })

  it('bounds arbitrary card titles without cutting a Unicode character', () => {
    const cards = renderCards('Result', { title: '/' + '😀'.repeat(200), color: 0 })
    expect(cards[0]?.embeds?.[0]?.title).toBe('/' + '😀'.repeat(127))
    assertValid(cards)
    assertValid(renderCards('Result', { title: '', color: 0 }))
  })

  it('offers only one-time approval and rejection for an identified request', () => {
    const controls = approvalControls(DiscordPromptId('request-id'))
    expect(controls[0]?.components).toEqual([
      { type: 2, style: 3, custom_id: 'dsh:approval:request-id:yes', label: 'Allow once' },
      { type: 2, style: 4, custom_id: 'dsh:approval:request-id:no', label: 'Reject' },
    ])
    assertValid([{ content: 'Approve?', components: controls }])
  })

  it('keeps canonical option positions while truncating Unicode labels and descriptions', () => {
    const controls = questionControls({ id: 'q', question: 'Which?', multiSelect: true,
      options: [{ label: '😀'.repeat(60), description: '😀'.repeat(60) }, { label: 'B' }],
    }, DiscordPromptId('request-id'))
    const menu = controls[0]?.components[0]
    expect(menu?.type).toBe(3)
    if (menu?.type !== 3) throw new Error('Expected selector')
    expect(menu.max_values).toBe(2)
    expect(menu.options.map(option => option.value)).toEqual(['1', '2'])
    expect(menu.options[0]?.label).toBe('😀'.repeat(50))
    expect(menu.options[0]?.description).toBe('😀'.repeat(50))
    assertValid([{ content: 'Choose', components: controls }])
  })

  it('uses a single selection by default and keeps free text for unrepresentable choices', () => {
    const controls = questionControls({ id: 'q', question: 'Which?', options: [{ label: 'A' }] }, DiscordPromptId('request-id'))
    expect(controls[0]?.components[0]).toMatchObject({ type: 3, min_values: 1, max_values: 1 })
    expect(questionControls({ id: 'q', question: 'Explain.' }, DiscordPromptId('request-id'))).toEqual([])
    expect(questionControls({ id: 'q', question: 'Which?', options: Array.from({ length: 26 }, () => ({ label: 'A' })) }, DiscordPromptId('request-id'))).toEqual([])
  })

  it('uses a choice position when an option has an empty label', () => {
    const controls = questionControls({ id: 'q', question: 'Which?', options: [{ label: '' }] }, DiscordPromptId('request-id'))
    expect(controls[0]?.components[0]).toMatchObject({ type: 3, options: [{ label: '1', value: '1' }] })
    assertValid([{ content: 'Choose', components: controls }])
  })
})
