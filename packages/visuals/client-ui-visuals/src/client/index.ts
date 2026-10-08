/**
 * Presented-visual browser plugin: renders each `deliverables/presented`
 * event whose files carry a `visual` snapshot as an inline Chat node at the
 * event's position, outside the turn's process folding. Images render from
 * the saved bytes; HTML mockups render in a sandboxed `srcdoc` frame whose
 * content policy blocks network access.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { Visuals } from './Visuals.tsx'
import { visualsDefinition } from './visuals.ts'
import { en, NS, zh, type VisualsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Inline visual delivery copy. */
    'visuals': VisualsKey
  }
}

/** Required services: slot registry, locale runtime, and the conversation node registry. */
export const inject = ['slots', 'locale', 'uiConversation']

/**
 * Register the dictionaries, the node definition, and its Chat node view.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'client-ui-visuals: dictionaries')
  ctx.uiConversation.events.register(visualsDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'presented-visual', locale: NS,
  }, Visuals))
}
