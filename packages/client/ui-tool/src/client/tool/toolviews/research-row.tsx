/** Research report artifacts rendered from durable tool-result metadata. */
import { useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { IconBrowseOutline16, MarkdownText, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { toolRowModel } from '../models/tool-call-model.ts'
import { ToolRow } from '../components/ToolRow.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'
import css from './research-row.module.css'

interface Artifact {
  id: string
  markdown: string
  sources: { url: string; title?: string }[]
}

function artifactFromMeta(meta: unknown): Artifact | null {
  if (!meta || typeof meta !== 'object' || !('researchArtifact' in meta)) return null
  const value = meta.researchArtifact
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string'
    || !('markdown' in value) || typeof value.markdown !== 'string'
    || !('sources' in value) || !Array.isArray(value.sources)) return null
  const sources: Artifact['sources'] = []
  for (const item of value.sources as unknown[]) {
    if (!item || typeof item !== 'object' || !('url' in item) || typeof item.url !== 'string') return null
    if ('title' in item && item.title !== undefined && typeof item.title !== 'string') return null
    sources.push({ url: item.url, ...'title' in item && typeof item.title === 'string' ? { title: item.title } : {} })
  }
  return { id: value.id, markdown: value.markdown, sources }
}

function sourceHref(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined
  } catch {
    // A malformed saved source stays visible as text without a navigable link.
    return undefined
  }
}

type ResearchRowProps = ToolCallViewProps & PropsLocale<'conversation'>

/**
 * Open a complete saved report without expanding the model's JSON text page.
 * @param props - Durable call metadata, row state, and localized copy.
 * @returns Tool row and an accessible native report dialog.
 */
export function ResearchRow({ toolName, block, inspect, t }: ResearchRowProps) {
  const model = toolRowModel(toolName, block)
  const artifact = 'kind' in block && !block.isError ? artifactFromMeta(block.meta) : null
  const [open, setOpen] = useState(false)
  const [download, setDownload] = useState<string>()
  const markdown = artifact?.markdown
  const sources = artifact?.sources
  const sourceText = sources?.map((source, index) => `${index + 1}. ${source.title ?? source.url}\n   ${source.url}`).join('\n')
  const document = markdown === undefined ? undefined : `${markdown}\n\n${t('research.sources')}\n\n${sourceText ?? ''}\n`
  useEffect(() => {
    if (!open || document === undefined) return
    const url = URL.createObjectURL(new Blob([document], { type: 'text/markdown;charset=utf-8' }))
    setDownload(url)
    return () => { URL.revokeObjectURL(url) }
  }, [open, document])
  return (
    <>
      <ToolRow t={t} variant={model.variant} toolName={toolName} icon={<IconBrowseOutline16 size={14} />}
        title={t('research.title')} summary={artifact?.id ?? model.summary}
        output={artifact === null ? model.output : null} errorSummary={model.errorSummary}
        state={model.state} inspect={inspect} />
      {artifact !== null && (
        <div className={css.artifact}>
          <button type="button" className={css.open} onClick={() => { setOpen(true) }}>{t('research.open')}</button>
          <Modal open={open} onClose={() => { setOpen(false) }} title={t('research.report')}
            closeLabel={t('research.close')} className={css.dialog ?? ''} contentClassName={css.content ?? ''}
            footer={download && <a href={download} download={`${artifact.id}.md`}>{t('research.download')}</a>}>
            <p className={css.hint}>{t('research.evidence')}</p>
            <MarkdownText text={artifact.markdown} labels={{
              code: { copyLabel: t('research.copy'), copiedLabel: t('research.copied') }, footnotes: t('research.footnotes'),
            }} />
            <h3>{t('research.sources')}</h3>
            <ol>{artifact.sources.map((source, index) => <li key={`${index}:${source.url}`}>
              <a href={sourceHref(source.url)} target="_blank" rel="noopener noreferrer">{source.title ?? source.url}</a>
            </li>)}</ol>
          </Modal>
        </div>
      )}
    </>
  )
}

/** Registers the research artifact row in the conversation. */
export const researchToolview = {
  name: 'research-toolview',
  inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', () =>
      ctx.slots.register({ name: 'tool.call.toolview', key: 'odysseus_research', locale: NS }, ResearchRow))
  },
}
