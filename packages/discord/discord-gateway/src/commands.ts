/**
 * The three slash commands the Discord listener owns. They are registered inside each
 * conversation Agent's scope, so they appear in that Session's command list and nowhere else;
 * every other command the mounted preset contributes (`/compact`, `/permission`, `/goal`) is
 * dispatched to by the router through the shared command registry.
 * @module @deepseek-ai/dsh-discord-gateway/commands
 */

import type { Context } from '@deepseek-ai/cordis'

/** Router operations one conversation's gateway commands invoke, closed over the channel. */
export interface GatewayCommandOps {
  /** Release the live Agent and delete the durable record so the next message starts a fresh Session. */
  startFresh(): Promise<string>
  /** Describe this conversation's session, preset, and activity as reply text. */
  status(): string
  /** Cancel the running turn, or report that nothing is running. */
  stopTurn(): string
}

/** Register `/new`, `/status`, and `/stop` in one conversation Agent's scope. */
export function registerGatewayCommands(agentCtx: Context, ops: GatewayCommandOps): void {
  agentCtx.commands.register({
    name: 'new',
    description: 'Start a fresh session with your next message',
    handler: async () => ({ kind: 'success', text: await ops.startFresh() }),
  })
  agentCtx.commands.register({
    name: 'status',
    description: 'Show this conversation\'s session, presets, and activity',
    handler: () => ({ kind: 'success' as const, text: ops.status() }),
  })
  agentCtx.commands.register({
    name: 'stop',
    description: 'Cancel the turn currently running in this conversation',
    handler: () => ({ kind: 'success' as const, text: ops.stopTurn() }),
  })
}
