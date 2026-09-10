/**
 * Discord command discovery and the three controls registered inside a live Agent. They are registered inside each
 * conversation Agent's scope, so they appear in that Session's command list and nowhere else;
 * every other command the mounted preset contributes (`/compact`, `/permission`, `/goal`) is
 * dispatched to by the router through the shared command registry.
 * @module @deepseek-ai/dsh-discord-gateway/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'

/** Commands available before a conversation has a live Agent. */
export const GATEWAY_COMMANDS = {
  new: { name: 'new', description: 'Start a fresh session with your next message' },
  status: { name: 'status', description: "Show this conversation's session, presets, and activity" },
  stop: { name: 'stop', description: 'Cancel the turn currently running in this conversation' },
  help: { name: 'help', description: 'Show the commands available in this Discord conversation' },
} as const satisfies Record<string, CommandDescriptor>

/**
 * Combine preset commands with the controls owned by the Discord conversation.
 * @param commands - Effective descriptors of the selected standing preset.
 * @param excluded - Preset commands whose execution belongs to another UI.
 * @returns sorted descriptors with gateway controls taking precedence in their own conversation.
 */
export function discordCommands(commands: readonly CommandDescriptor[], excluded: readonly string[] = []): readonly CommandDescriptor[] {
  const merged = new Map(commands.filter(command => !excluded.includes(command.name)).map(command => [command.name, command]))
  for (const command of Object.values(GATEWAY_COMMANDS)) merged.set(command.name, command)
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name))
}

/** Router operations one conversation's gateway commands invoke, closed over the channel. */
export interface GatewayCommandOps {
  /** Release the live Agent and delete the durable record so the next message starts a fresh Session. */
  startFresh(): Promise<string>
  /** Describe this conversation's session, preset, and activity as reply text. */
  status(): string
  /** Cancel the running turn, or report that nothing is running. */
  stopTurn(): string | Promise<string>
}

/**
 * Register `/new`, `/status`, and `/stop` through a command-injected child of the Agent's scope.
 * @param agentCtx - Agent setup context, which need not inject the command registry.
 * @param ops - Operations owned by this Agent's Discord conversation.
 */
export function registerGatewayCommands(agentCtx: Context, ops: GatewayCommandOps): void {
  agentCtx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      ...GATEWAY_COMMANDS.new,
      handler: async () => ({ kind: 'success', text: await ops.startFresh() }),
    })
    commandCtx.commands.register({
      ...GATEWAY_COMMANDS.status,
      handler: () => ({ kind: 'success' as const, text: ops.status() }),
    })
    commandCtx.commands.register({
      ...GATEWAY_COMMANDS.stop,
      handler: async () => ({ kind: 'success' as const, text: await ops.stopTurn() }),
    })
  })
}
