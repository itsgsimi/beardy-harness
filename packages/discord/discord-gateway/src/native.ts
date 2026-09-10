/** Authorized, bounded native Discord command and component execution. @module @deepseek-ai/dsh-discord-gateway/native */

import type { CommandDescriptor, CommandResult } from '@deepseek-ai/dsh-commands'
import { chunkContent, defangBroadcastMentions } from '@deepseek-ai/dsh-tool-discord'
import type { DiscordMessageBody } from '@deepseek-ai/dsh-tool-discord'
import type { RoutingPolicy } from './conversation.ts'
import { createDiscordInteractionTransport } from './interactions.ts'
import type { DiscordInteraction, DiscordInteractionId, DiscordInteractionTransport } from './interactions.ts'
import { CONVERSATION_CONTROLS, renderCards } from './presentation.ts'
import type { GatewaySettings } from './types.ts'

/** Services and cancellation owned by the gateway listener. */
export interface NativeInteractionDeps {
  readonly signal: AbortSignal
  readonly policy: RoutingPolicy
  readonly settings: GatewaySettings
  readonly applicationId: () => string
  readonly commands: () => readonly CommandDescriptor[]
  /** Execute the same command path used by channel messages, observing cancellation. */
  readonly execute: (channelId: string, line: string, signal: AbortSignal) => Promise<CommandResult>
  /** Atomically resolve a pending prompt after its component has been acknowledged. */
  readonly component: (interaction: Extract<DiscordInteraction, { kind: 'component' }>, signal: AbortSignal) => Promise<string>
  readonly transport?: DiscordInteractionTransport
  /** Receives operation diagnostics without interaction tokens or exception messages. */
  readonly warn: (message: string) => void
}

/** Transient interaction owner; its receipt cache stores identities without response tokens. */
export interface NativeInteractions {
  /**
   * Admit an interaction and start its acknowledgement without delaying gateway dispatch.
   * @param interaction - Validated Discord gateway invocation.
   */
  handle(interaction: DiscordInteraction): void
  /** @returns after admitted callbacks and command handlers observe cancellation and settle. */
  dispose(): Promise<void>
}

/**
 * Create a listener-owned interaction dispatcher with private responses and bounded replay memory.
 * @param deps - Access policy, command execution, presentation, and response transport.
 * @returns a dispatcher whose disposal cancels and joins its outstanding work.
 */
export function createNativeInteractions(deps: NativeInteractionDeps): NativeInteractions {
  const controller = new AbortController()
  const signal = AbortSignal.any([deps.signal, controller.signal])
  const transport = deps.transport ?? createDiscordInteractionTransport({ requestTimeoutMs: deps.settings.replyRequestTimeoutMs })
  const pending = new Map<DiscordInteractionId, Promise<void>>()
  const receipts = new Set<DiscordInteractionId>()
  let busyReply: Promise<void> | undefined

  const remember = (id: DiscordInteractionId): void => {
    receipts.add(id)
    // oxlint-disable-next-line typescript/no-non-null-assertion -- an over-limit set contains its oldest receipt.
    while (receipts.size > deps.settings.interactionReceiptLimit) receipts.delete(receipts.values().next().value!)
  }
  const privateReply = async (interaction: DiscordInteraction, text: string): Promise<void> => {
    await transport.reply(interaction, 4, { content: text, flags: 64 }, signal)
  }
  const admitted = (interaction: DiscordInteraction): boolean =>
    deps.policy.allowedUserIds.has(interaction.userId)
    && (interaction.guildId === '' || deps.policy.allowedChannelIds.has(interaction.channelId))

  const deliver = async (interaction: DiscordInteraction, text: string, title: string, controls: boolean): Promise<void> => {
    const bodies: DiscordMessageBody[] = deps.settings.richMessages
      ? renderCards(text, { title, color: deps.settings.accentColor, ...(controls ? { controls: CONVERSATION_CONTROLS } : {}) })
      : chunkContent(defangBroadcastMentions(text).content).map(content => ({ content }))
    if (bodies.length > deps.settings.replyMaxChunksPerCall) {
      await transport.edit(interaction, { content: 'This result is too long to send through Discord.' }, signal)
      return
    }
    for (const [index, body] of bodies.entries()) {
      signal.throwIfAborted()
      if (index === 0) await transport.edit(interaction, body, signal)
      else await transport.followup(interaction, body, signal)
    }
  }
  const run = async (interaction: DiscordInteraction): Promise<void> => {
    if (interaction.kind === 'autocomplete') {
      await transport.reply(interaction, 8, { choices: [] }, signal)
      return
    }
    if (!admitted(interaction)) {
      await privateReply(interaction, 'You do not have access to this bot in this channel.')
      return
    }
    await transport.reply(interaction, 5, { flags: 64 }, signal)
    signal.throwIfAborted()
    let text: string
    let title: string
    let controls = false
    try {
      if (interaction.kind === 'component' && !interaction.customId.startsWith('dsh:command:')) {
        text = await deps.component(interaction, signal)
        title = 'Request'
      } else {
        const command = interaction.kind === 'command' ? interaction.name : interaction.customId.slice('dsh:command:'.length)
        if (!deps.commands().some(descriptor => descriptor.name === command)) {
          text = 'This command is no longer available. Refresh the Discord command menu.'
          title = 'Command unavailable'
        } else {
          const args = interaction.kind === 'command' && interaction.arguments !== '' ? ` ${interaction.arguments}` : ''
          const result = await deps.execute(interaction.channelId, `/${command}${args}`, signal)
          text = result.text?.trim() ? result.text : 'Done.'
          title = result.kind === 'error' ? `/${command} failed` : `/${command}`
          controls = true
        }
      }
    } catch {
      // Handlers may throw messages containing private request data; expose only this fixed diagnostic.
      if (signal.aborted) return
      deps.warn(`discord-gateway: native interaction ${interaction.id} execution failed`)
      text = 'The request could not be completed. Please try again.'
      title = 'Request failed'
    }
    try {
      await deliver(interaction, text.trim() === '' ? 'Done.' : text, title, controls)
    } catch {
      // Discord may accept only part of a response; replace its first message without repeating the action.
      if (signal.aborted) return
      deps.warn(`discord-gateway: native interaction ${interaction.id} response delivery failed`)
      await transport.edit(interaction, { content: 'The result could not be delivered. Please try again.' }, signal)
    }
  }

  return {
    handle(interaction) {
      if (signal.aborted || interaction.applicationId !== deps.applicationId()
        || pending.has(interaction.id) || receipts.has(interaction.id)) return
      if (pending.size >= deps.settings.interactionMaxPending) {
        remember(interaction.id)
        // One overload callback remains joinable while the configured execution slots are occupied.
        if (busyReply !== undefined) return
        busyReply = (interaction.kind === 'autocomplete'
          ? transport.reply(interaction, 8, { choices: [] }, signal)
          : privateReply(interaction, 'Too many requests are running. Please try again shortly.'))
          .catch(() => {
            if (!signal.aborted) deps.warn('discord-gateway: native overload acknowledgement failed')
          }).finally(() => { busyReply = undefined })
        return
      }
      const task = run(interaction).catch(() => {
        if (!signal.aborted) deps.warn(`discord-gateway: native interaction ${interaction.id} response failed`)
      }).finally(() => { pending.delete(interaction.id); remember(interaction.id) })
      pending.set(interaction.id, task)
    },
    async dispose() {
      controller.abort(new Error('discord-gateway: native interactions disposed'))
      await Promise.all([...pending.values(), ...(busyReply === undefined ? [] : [busyReply])])
      receipts.clear()
    },
  }
}
