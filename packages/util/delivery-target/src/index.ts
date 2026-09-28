/**
 * Transport-tagged notice delivery targets. A producer stores one target string per destination
 * and every delivery owner claims only the targets of its own transport, so two gateways mounted
 * together never compete for the same notice.
 *
 * Accepted forms:
 * - `123456789012345678` or `discord:123456789012345678`: a Discord channel id of 17 to 20 digits;
 * - `signal:group:<base64 group id>`: a Signal group, whose id is the standard base64 of 32 bytes;
 * - `signal:number:<E.164 number>`: one Signal account, such as `signal:number:+15551234567`.
 *
 * @module @deepseek-ai/dsh-delivery-target
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Discord channel id of 17 to 20 digits. */
export type DiscordChannelId = Branded<'DiscordChannelId'>

/** Signal group id: the standard base64 encoding of a 32-byte group identifier. */
export type SignalGroupId = Branded<'SignalGroupId'>

/** Signal account phone number in E.164 form. */
export type SignalNumber = Branded<'SignalNumber'>

/** A Signal destination: one group, or one account by phone number. */
export type SignalDeliveryTarget =
  | { readonly transport: 'signal'; readonly kind: 'group'; readonly groupId: SignalGroupId }
  | { readonly transport: 'signal'; readonly kind: 'number'; readonly number: SignalNumber }

/** A Discord destination. */
export interface DiscordDeliveryTarget {
  readonly transport: 'discord'
  readonly channelId: DiscordChannelId
}

/** One parsed delivery target. */
export type DeliveryTarget = DiscordDeliveryTarget | SignalDeliveryTarget

/** The accepted target forms, worded for configuration and tool errors. */
export const DELIVERY_TARGET_FORMS = 'a Discord channel id of 17 to 20 digits (optionally prefixed "discord:"), '
  + '"signal:group:<base64 group id>", or "signal:number:<E.164 number>"'

const SNOWFLAKE = /^\d{17,20}$/u
const E164 = /^\+[1-9]\d{6,14}$/u
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u
const SIGNAL_GROUP_ID_BYTES = 32

/**
 * Validate a Signal group id: canonical standard base64 of exactly 32 bytes.
 * @param value - candidate group id.
 * @returns the branded id, or undefined when the value is not one.
 */
export function parseSignalGroupId(value: string): SignalGroupId | undefined {
  if (value.length % 4 !== 0 || !BASE64.test(value)) return undefined
  const bytes = Buffer.from(value, 'base64')
  if (bytes.byteLength !== SIGNAL_GROUP_ID_BYTES || bytes.toString('base64') !== value) return undefined
  return brandString<SignalGroupId>(value)
}

/**
 * Validate an E.164 phone number: `+`, a non-zero leading digit, and 7 to 15 digits in total.
 * @param value - candidate number.
 * @returns the branded number, or undefined when the value is not one.
 */
export function parseSignalNumber(value: string): SignalNumber | undefined {
  return E164.test(value) ? brandString<SignalNumber>(value) : undefined
}

/**
 * Parse one target string.
 * @param value - configured or stored target.
 * @returns the parsed target, or undefined when the string matches no accepted form.
 */
export function parseDeliveryTarget(value: string): DeliveryTarget | undefined {
  const discord = value.startsWith('discord:') ? value.slice('discord:'.length) : value
  if (SNOWFLAKE.test(discord)) return { transport: 'discord', channelId: brandString<DiscordChannelId>(discord) }
  if (value.startsWith('signal:group:')) {
    const groupId = parseSignalGroupId(value.slice('signal:group:'.length))
    return groupId === undefined ? undefined : { transport: 'signal', kind: 'group', groupId }
  }
  if (value.startsWith('signal:number:')) {
    const number = parseSignalNumber(value.slice('signal:number:'.length))
    return number === undefined ? undefined : { transport: 'signal', kind: 'number', number }
  }
  return undefined
}

/**
 * Validate a configured target and name the offending field in the error.
 * @param value - configured target.
 * @param field - owner-qualified field name, such as `health: noticeChannelId`.
 * @returns the parsed target.
 * @throws Error naming the field and every accepted form.
 */
export function assertDeliveryTarget(value: string, field: string): DeliveryTarget {
  const target = parseDeliveryTarget(value)
  if (target === undefined) throw new Error(`${field} must be ${DELIVERY_TARGET_FORMS}`)
  return target
}

/**
 * The Discord channel a target names, for the Discord delivery owner.
 * @param value - stored target.
 * @returns the channel id, or undefined for a Signal or unparseable target.
 */
export function discordChannelOf(value: string): DiscordChannelId | undefined {
  const target = parseDeliveryTarget(value)
  return target?.transport === 'discord' ? target.channelId : undefined
}

/**
 * The Signal destination a target names, for the Signal delivery owner.
 * @param value - stored target.
 * @returns the destination, or undefined for a Discord or unparseable target.
 */
export function signalTargetOf(value: string): SignalDeliveryTarget | undefined {
  const target = parseDeliveryTarget(value)
  return target?.transport === 'signal' ? target : undefined
}

/**
 * Serialize a Signal destination back to its target string.
 * @param target - parsed destination.
 * @returns `signal:group:<id>` or `signal:number:<number>`.
 */
export function formatSignalTarget(target: SignalDeliveryTarget): string {
  return target.kind === 'group' ? `signal:group:${target.groupId}` : `signal:number:${target.number}`
}
