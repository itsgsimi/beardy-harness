/** Research model picker for jobs started through Odysseus. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ResearchCardFace } from './research-card-controller.ts'
import { PluginCard } from './PluginCard.tsx'
import type {} from './slot-contract.ts'
import css from './fields.module.css'

/** Bound picker props. */
export type ResearchCardProps = PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'> & InjectFace<ResearchCardFace>

/**
 * Render a staged research model selection.
 * @param props - Synchronized settings, copy, and save actions.
 * @returns Research settings card, hidden when the bridge is absent.
 */
export function ResearchCard(props: ResearchCardProps) {
  const state = props.useResearchCard(snapshot => snapshot)
  const { t } = props
  return (
    <PluginCard t={t} titleKey="researchTitle" descriptionKey="researchDescription"
      state={state} onSave={props.save} onDiscard={props.discard}>
      <div className={css.field}>
        <label className={css.label} htmlFor="research-model">{t('researchModel')}</label>
        <select id="research-model" className={css.input} value={state.worker.text}
          disabled={!state.writable || state.saving}
          onChange={(event) => { props.edit('worker', event.target.value) }}>
          {state.choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
        </select>
        <p className={css.hint}>{t('researchHint')}</p>
      </div>
    </PluginCard>
  )
}
