/**
 * Research browser plugin: the keyed tool views for `deep_research` and
 * `odysseus_research` calls, which open a settled call's saved report, and
 * the research worker picker on the Settings → Plugins page, bound to the
 * active profile's `odysseus-research` configuration entry.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { ResearchCard } from './ResearchCard.tsx'
import { RESEARCH_NS, ResearchCardController, type ResearchSettings } from './research-card-controller.ts'
import { ResearchRow } from './ResearchRow.tsx'
import { en, NS, zh, type ResearchKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Research report row and research settings copy. */
    'research': ResearchKey
  }
}

/** Wire tool names whose calls render the research row. */
export const RESEARCH_TOOL_NAMES = ['deep_research', 'odysseus_research'] as const

/** Required services: slot registry, locale runtime, and the profile configuration forms. */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Register the dictionaries, the research tool views, and the Settings tab.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'client-ui-research: dictionaries')
  for (const key of RESEARCH_TOOL_NAMES) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key, locale: NS }, ResearchRow))
  }
  const research = new ResearchCardController(ctx.configForms.get<ResearchSettings>(RESEARCH_NS))
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab', id: 'research', order: 20,
    label: () => t('settings.title'), locale: NS, inject: () => research.inject(),
  }, ResearchCard))
}
