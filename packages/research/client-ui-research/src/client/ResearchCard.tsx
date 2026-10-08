/** Research worker picker on the Settings → Plugins page. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ResearchCardFace } from './research-card-controller.ts'
import type { NS } from './locales.ts'
import css from './ResearchCard.module.css'

/** Bound picker props. */
export type ResearchCardProps = PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<typeof NS> & InjectFace<ResearchCardFace>

/** @param props - profile form state and worker selection action. @returns the research tab. */
export function ResearchCard({ useResearchCard, selectWorker, t }: ResearchCardProps) {
  const state = useResearchCard(snapshot => snapshot)
  if (state.status === 'unavailable') return <p>{t('settings.unavailable')}</p>
  if (state.status === 'loading') return <p>{t('settings.loading')}</p>
  return <section>
    <h2>{t('settings.title')}</h2>
    <p>{t('settings.description')}</p>
    <div className={css.field}>
      <label className={css.label} htmlFor="research-model">{t('settings.model')}</label>
      <select id="research-model" className={css.input} value={state.selected}
        disabled={!state.writable || state.saving}
        onChange={(event) => { void selectWorker(event.target.value) }}>
        {state.choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
      </select>
      <p className={css.hint}>{t('settings.hint')}</p>
      {state.error ? <p role="alert">{t('settings.saveFailed')}</p> : null}
    </div>
  </section>
}
