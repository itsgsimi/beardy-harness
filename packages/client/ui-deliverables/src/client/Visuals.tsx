/** Inline visual findings with an isolated mockup frame and original-file download. */
import { useMemo, useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PresentedVisual } from '@deepseek-ai/dsh-tool-present/types'
import { basename } from '../presented.ts'
import { mockupDocument } from './visuals.ts'
import type { NS } from './locales.ts'
import css from './Visuals.module.css'

type VisualsProps = PropsRuntime<'conversation.chat.node', 'presented-visual'> & PropsLocale<typeof NS>

function VisualBody({ visual, t }: { visual: PresentedVisual; t: VisualsProps['t'] }) {
  const [failed, setFailed] = useState(false)
  const document = useMemo(() => visual.mediaType === 'text/html' ? mockupDocument(visual.data) : null, [visual])
  if (failed) return <p role="alert">{t('visual.failed')}</p>
  if (visual.mediaType === 'text/html') return document === null
    ? <p role="alert">{t('visual.failed')}</p>
    : <iframe className={css.frame} title={visual.title} srcDoc={document} sandbox="allow-scripts" referrerPolicy="no-referrer" />
  return <img className={css.image} src={`data:${visual.mediaType};base64,${visual.data}`} alt={visual.title} onError={() => { setFailed(true) }} />
}

/**
 * Render snapshots in their original conversation position during work and replay.
 * @param props - committed visual node and localized controls.
 * @returns inline visual cards with captions and an expanded view.
 */
export function Visuals({ node, t }: VisualsProps) {
  const [expanded, setExpanded] = useState<number>()
  return <div className={css.visuals} data-presented-visual>
    {node.data.files.map((file, index) => <figure className={css.card} key={`${index}:${file.path}`}>
      <figcaption className={css.caption}>
        <strong>{file.visual.title}</strong>
        {file.description && <p>{file.description}</p>}
      </figcaption>
      <VisualBody visual={file.visual} t={t} />
      <div className={css.actions}>
        <button type="button" onClick={() => { setExpanded(index) }}>{t('visual.expand')}</button>
        <a href={`data:${file.visual.mediaType};base64,${file.visual.data}`} download={basename(file.path)}>{t('visual.download')}</a>
        {file.visual.mediaType === 'text/html' && <span>{t('visual.isolated')}</span>}
      </div>
      <Modal open={expanded === index} onClose={() => { setExpanded(undefined) }} title={file.visual.title}
        closeLabel={t('visual.close')} className={css.dialog as string} contentClassName={css.expanded as string}>
        <VisualBody visual={file.visual} t={t} />
      </Modal>
    </figure>)}
  </div>
}
