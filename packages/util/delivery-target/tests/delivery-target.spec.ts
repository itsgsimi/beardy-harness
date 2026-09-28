import { describe, expect, it } from 'vitest'
import {
  assertDeliveryTarget, DELIVERY_TARGET_FORMS, discordChannelOf, formatSignalTarget, parseDeliveryTarget,
  parseSignalGroupId, parseSignalNumber, signalTargetOf,
} from '../src/index.ts'

const GROUP = Buffer.alloc(32, 7).toString('base64')

describe('parseDeliveryTarget', () => {
  it('reads bare and prefixed Discord channel ids as Discord targets', () => {
    expect(parseDeliveryTarget('123456789012345678')).toEqual({ transport: 'discord', channelId: '123456789012345678' })
    expect(parseDeliveryTarget('discord:12345678901234567890')).toEqual({ transport: 'discord', channelId: '12345678901234567890' })
  })

  it('reads Signal group and number targets', () => {
    expect(parseDeliveryTarget(`signal:group:${GROUP}`)).toEqual({ transport: 'signal', kind: 'group', groupId: GROUP })
    expect(parseDeliveryTarget('signal:number:+15551234567')).toEqual({ transport: 'signal', kind: 'number', number: '+15551234567' })
  })

  it.each([
    '', '1234567890123456', '123456789012345678901', 'discord:', 'discord:abc', 'signal:', 'signal:group:',
    'signal:group:not base64', `signal:group:${Buffer.alloc(16, 1).toString('base64')}`, `signal:group:${GROUP.slice(0, -1)}`,
    'signal:number:15551234567', 'signal:number:+0555123', 'signal:number:+1', 'slack:C123', ` ${GROUP}`,
  ])('rejects %j', (value) => {
    expect(parseDeliveryTarget(value)).toBeUndefined()
  })
})

describe('real Signal group ids', () => {
  it('keeps "+", "/", and "=" of standard base64 intact through parsing and formatting', () => {
    for (const id of ['1QtO3Hub7LE5w2ErIhBrS+WLYdHawvpk03PJMnYREh8=', '+///AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=']) {
      const target = signalTargetOf(`signal:group:${id}`)
      expect(target).toEqual({ transport: 'signal', kind: 'group', groupId: id })
      expect(formatSignalTarget(target!)).toBe(`signal:group:${id}`)
      expect(parseSignalGroupId(id.replace(/=$/u, ''))).toBeUndefined()
      expect(parseSignalGroupId(id.replaceAll('+', '-').replaceAll('/', '_'))).toBeUndefined()
    }
  })
})

describe('Signal identities', () => {
  it('accepts only canonical base64 of 32 bytes as a group id', () => {
    expect(parseSignalGroupId(GROUP)).toBe(GROUP)
    const nonCanonical = `${GROUP.slice(0, 42)}B=`
    expect(Buffer.from(nonCanonical, 'base64').byteLength).toBe(32)
    expect(parseSignalGroupId(nonCanonical)).toBeUndefined()
    expect(parseSignalGroupId('abc')).toBeUndefined()
  })

  it('accepts E.164 numbers only', () => {
    expect(parseSignalNumber('+447700900123')).toBe('+447700900123')
    expect(parseSignalNumber('+1234567890123456')).toBeUndefined()
  })
})

describe('target helpers', () => {
  it('names the field and every accepted form when a configured target is invalid', () => {
    expect(assertDeliveryTarget('discord:123456789012345678', 'x: channelId')).toEqual({ transport: 'discord', channelId: '123456789012345678' })
    expect(() => assertDeliveryTarget('general', 'health: noticeChannelId')).toThrow(`health: noticeChannelId must be ${DELIVERY_TARGET_FORMS}`)
    expect(DELIVERY_TARGET_FORMS).toContain('signal:group:<base64 group id>')
  })

  it('splits targets by transport', () => {
    expect(discordChannelOf('discord:123456789012345678')).toBe('123456789012345678')
    expect(discordChannelOf('signal:number:+15551234567')).toBeUndefined()
    expect(discordChannelOf('general')).toBeUndefined()
    expect(signalTargetOf('123456789012345678')).toBeUndefined()
    expect(signalTargetOf('nope')).toBeUndefined()
    const group = signalTargetOf(`signal:group:${GROUP}`)
    expect(group).toEqual({ transport: 'signal', kind: 'group', groupId: GROUP })
    expect(formatSignalTarget(group!)).toBe(`signal:group:${GROUP}`)
    expect(formatSignalTarget(signalTargetOf('signal:number:+15551234567')!)).toBe('signal:number:+15551234567')
  })
})
