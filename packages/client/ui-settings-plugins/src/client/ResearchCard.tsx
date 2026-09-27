/** Research worker picker in the built-in plugins Settings page. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ResearchCardFace } from './research-card-controller.ts'
import css from './fields.module.css'

/** Bound picker props. */
export type ResearchCardProps = PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.plugins'> & InjectFace<ResearchCardFace>

/** @param props - profile form state and worker selection action. @returns the research tab. */
export function ResearchCard({ useResearchCard, selectWorker, t }: ResearchCardProps) {
  const state = useResearchCard(snapshot => snapshot)
  if (state.status === 'unavailable') return <p>{t('researchUnavailable')}</p>
  if (state.status === 'loading') return <p>{t('researchLoading')}</p>
  return <section>
    <h2>{t('researchTitle')}</h2>
    <p>{t('researchDescription')}</p>
    <div className={css.field}>
      <label className={css.label} htmlFor="research-model">{t('researchModel')}</label>
      <select id="research-model" className={css.input} value={state.selected}
        disabled={!state.writable || state.saving}
        onChange={(event) => { void selectWorker(event.target.value) }}>
        {state.choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
      </select>
      <p className={css.hint}>{t('researchHint')}</p>
      {state.error ? <p role="alert">{t('researchSaveFailed')}</p> : null}
    </div>
  </section>
}
