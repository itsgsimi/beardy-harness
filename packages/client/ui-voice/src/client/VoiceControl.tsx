/** Composer microphone using the same toolbar controls as the surrounding input. */
import { useEffect, useRef, useState } from 'react'
import { Button, IconCloseOutline16, IconStopFill16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { recordAudio, transcribeAudio, type RecordingLimits } from './recording.ts'
import css from './VoiceControl.module.css'

export interface VoiceInjected {
  append: (text: string) => boolean
}
type Props = PropsRuntime<'conversation.input.right'> & PropsLocale<'voice'> & VoiceInjected
type Phase = 'idle' | 'requesting' | 'recording' | 'transcribing'

function Microphone() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" />
  </svg>
}

export function VoiceControl({ append, useInput, t }: Props) {
  const locked = useInput(state => state.phase !== 'plain')
  const [limits, setLimits] = useState<RecordingLimits | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<'failed' | 'empty' | 'unsupported' | null>(null)
  const [pendingText, setPendingText] = useState('')
  const active = useRef<AbortController | null>(null)
  const stop = useRef<(() => void) | null>(null)
  useEffect(() => {
    const load = new AbortController()
    void fetch('/api/speech/config', { signal: load.signal }).then(async (response) => {
      if (!response.ok) return
      const value: unknown = await response.json()
      if (typeof value !== 'object' || value === null || !('maxAudioBytes' in value) || !('maxDurationSeconds' in value)
        || typeof value.maxAudioBytes !== 'number' || typeof value.maxDurationSeconds !== 'number'
        || value.maxAudioBytes <= 0 || value.maxDurationSeconds <= 0) return
      if (!load.signal.aborted) setLimits({ maxAudioBytes: value.maxAudioBytes, maxDurationSeconds: value.maxDurationSeconds })
    }).catch(() => { /* An unconfigured or disconnected speech provider contributes no microphone. */ })
    return () => { load.abort(); active.current?.abort() }
  }, [])
  if (limits === null) return null
  const cancel = (): void => {
    active.current?.abort()
    active.current = null
    stop.current = null
    setPhase('idle')
  }
  const start = async (): Promise<void> => {
    // An insecure context leaves `navigator.mediaDevices` absent at runtime, which the DOM types do not admit.
    const mediaDevices = navigator.mediaDevices as MediaDevices | undefined
    if (!globalThis.isSecureContext || mediaDevices?.getUserMedia === undefined || typeof MediaRecorder === 'undefined') {
      setError('unsupported'); return
    }
    const operation = new AbortController()
    active.current = operation
    setError(null); setPhase('requesting')
    try {
      const audio = await recordAudio(operation.signal, limits, (finish) => {
        stop.current = finish; setPhase('recording')
      })
      operation.signal.throwIfAborted()
      stop.current = null; setPhase('transcribing')
      const text = await transcribeAudio(audio, operation.signal)
      operation.signal.throwIfAborted()
      if (text === '') setError('empty')
      else if (!append(text)) setPendingText(text)
    } catch {
      if (!operation.signal.aborted) setError('failed')
    } finally {
      if (active.current === operation && !operation.signal.aborted) {
        active.current = null; stop.current = null; setPhase('idle')
      }
    }
  }
  return <span className={css.wrap}>
    {phase === 'idle'
      ? <Button variant="toolbar" size="sm" aria-label={t('start')} title={t('start')} disabled={locked || pendingText !== ''} onClick={() => { void start() }}><Microphone /></Button>
      : <>
        <span className={css.status} role="status"><span className={phase === 'recording' ? css.dot : undefined} />{t(phase)}</span>
        {phase === 'recording' && <Button variant="toolbar" size="sm" aria-label={t('stop')} title={t('stop')} onClick={() => stop.current?.()}><IconStopFill16 /></Button>}
        <Button variant="toolbar" size="sm" aria-label={t('cancel')} title={t('cancel')} onClick={cancel}><IconCloseOutline16 /></Button>
      </>}
    {pendingText !== '' && <Button variant="toolbar" size="sm" disabled={locked} title={pendingText} onClick={() => { if (append(pendingText)) setPendingText('') }}>{t('insert')}</Button>}
    {error !== null && <span className={css.error} role="status">{t(error)}</span>}
  </span>
}
