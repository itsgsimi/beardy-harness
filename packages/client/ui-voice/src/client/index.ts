/** Native dictation contribution to the session composer. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { VoiceControl } from './VoiceControl.tsx'
import { en, zh, type VoiceKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { voice: VoiceKey }
}
export const inject = ['slots', 'locale', 'conversation', 'sessions']
/** Register the voice control and its locale for the lifetime of the composer slot. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('voice', { en, zh }))
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'voice', order: 0, locale: 'voice',
    inject: sessionId => ({
      append: (text: string): boolean => {
        const scope = ctx.sessions.scope(sessionId)
        return scope !== undefined && ctx.conversation.input.for(scope).appendDraft(text)
      },
    }),
  }, VoiceControl))
}
