/** Research call row with the saved report opened in a dialog. */
import { useEffect, useState } from 'react'
import { DisclosureRow, IconBrowseOutlineRegular, MarkdownText, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { callSummary, reportDocument, researchArtifact, sourceHref, type ResearchArtifact } from './report.ts'
import type { NS } from './locales.ts'
import css from './ResearchRow.module.css'

type ResearchRowProps = ToolCallViewProps & PropsLocale<typeof NS>
type Translate = ResearchRowProps['t']

/* v8 ignore next -- A preparing row is not expandable, so DisclosureRow never calls its toggle. */
const ignoreToggle = (): void => undefined

/**
 * Render a research call; a settled call with a saved report adds a report dialog.
 * @param props - tool call phase, inspect callback, and localized copy.
 * @returns the call row and, for a saved report, its dialog trigger.
 */
export function ResearchRow(props: ResearchRowProps) {
  if (props.phase === 'preparing') {
    return <div data-tool={props.toolName} data-state="preparing">
      <DisclosureRow title={props.t('row.title')} icon={<IconBrowseOutlineRegular size={14} />}
        open={false} expandable={false} onToggle={ignoreToggle} running />
    </div>
  }
  const { toolName, block, inspect, t } = props
  const settled = 'kind' in block
  const state = !settled ? 'running' : block.error?.code === 'interrupted' ? 'stopped' : block.isError ? 'error' : 'ok'
  const artifact = settled && !block.isError ? researchArtifact(block.meta) : null
  const text = settled ? block.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n') : ''
  const summary = artifact?.id ?? callSummary((settled ? block.call?.argsRaw : block.argsRaw) ?? '')
  return <div data-tool={toolName} data-state={state}>
    <CallDisclosure t={t} state={state} summary={summary} running={!settled}
      details={artifact === null ? text : ''} inspect={inspect} />
    {artifact !== null && <ReportDialog artifact={artifact} t={t} />}
  </div>
}

interface CallDisclosureProps {
  readonly t: Translate
  readonly state: 'running' | 'ok' | 'error' | 'stopped'
  readonly summary: string
  readonly running: boolean
  readonly details: string
  readonly inspect: (() => void) | undefined
}

function CallDisclosure({ t, state, summary, running, details, inspect }: CallDisclosureProps) {
  const [expanded, setExpanded] = useState(false)
  return <DisclosureRow title={t('row.title')} icon={<IconBrowseOutlineRegular size={14} />}
    running={running} open={expanded && details !== ''} expandable={details !== ''}
    expandOnRowClick keepContentWhenOpen onToggle={() => { setExpanded(value => !value) }}
    collapsedContent={<span className={css.status}>
      <span>{t(`row.${state}`)}</span>
      <span className={css.subject}>{summary}</span>
    </span>}>
    <pre className={css.details}>{details}</pre>
    {inspect && <button type="button" className={css.inspect} onClick={inspect}>{t('row.inspect')}</button>}
  </DisclosureRow>
}

function ReportDialog({ artifact, t }: { readonly artifact: ResearchArtifact; readonly t: Translate }) {
  const [open, setOpen] = useState(false)
  const [download, setDownload] = useState<string>()
  const sourcesHeading = t('report.sources')
  useEffect(() => {
    if (!open) return
    const url = URL.createObjectURL(new Blob([reportDocument(artifact, sourcesHeading)], { type: 'text/markdown;charset=utf-8' }))
    setDownload(url)
    return () => { URL.revokeObjectURL(url) }
  }, [open, artifact, sourcesHeading])
  return <div className={css.artifact}>
    <button type="button" className={css.open} onClick={() => { setOpen(true) }}>{t('report.open')}</button>
    <Modal open={open} onClose={() => { setOpen(false) }} title={t('report.title')}
      closeLabel={t('report.close')} className={css.dialog as string} contentClassName={css.content as string}
      footer={download && <a href={download} download={`${artifact.id}.md`}>{t('report.download')}</a>}>
      <p className={css.hint}>{t('report.evidence')}</p>
      <MarkdownText text={artifact.markdown} labels={{
        code: { copyLabel: t('report.copy'), copiedLabel: t('report.copied') }, footnotes: t('report.footnotes'),
      }} />
      <h3>{sourcesHeading}</h3>
      <ol>{artifact.sources.map((source, index) => <li key={`${index}:${source.url}`}>
        <a href={sourceHref(source.url)} target="_blank" rel="noopener noreferrer">{source.title ?? source.url}</a>
      </li>)}</ol>
    </Modal>
  </div>
}
