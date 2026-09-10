/** Picker placement preferences, saved independently of session composition. */

import { useEffect, useRef } from 'react'
import type { PresetPickerPlacement } from '@deepseek-ai/dsh-agent-presets/types'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentPresetSeatProps } from './AgentPresetSeat.tsx'
import type { AgentPresetSeatState } from './seat-store.ts'
import { presetDisplayText } from './locales.ts'
import css from './AgentPresetPickerSettings.module.css'

/**
 * Render the placement editor over the complete healthy roster, including hidden modes.
 * @param props - roster, save callback, and localized dialog controls.
 * @returns the management dialog when open.
 */
export function AgentPresetPickerSettings({ open, onClose, state, setPickerPlacement, t }: {
  open: boolean
  onClose: () => void
  state: AgentPresetSeatState
  setPickerPlacement: AgentPresetSeatProps['setPickerPlacement']
  t: AgentPresetSeatProps['t']
}) {
  const focusAfterSave = useRef<HTMLSelectElement | null>(null)
  useEffect(() => {
    if (state.pickerSaving) return
    const field = focusAfterSave.current
    focusAfterSave.current = null
    if (field?.isConnected && document.activeElement === document.body) field.focus()
  }, [state.pickerSaving])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('manageModes')}
      closeLabel={t('close')}
      description={t('pickerIntro')}
      className={css.dialog as string}
      contentClassName={css.content as string}
      footer={<Button variant="outline" onClick={onClose}>{t('done')}</Button>}
    >
      <div className={css.rows} aria-busy={state.pickerSaving}>
        {state.options.map((option, index) => {
          const { name } = presetDisplayText(option, t)
          return (
            <label key={option.id} className={css.row}>
              <span className={css.name}>{name}</span>
              <select
                className={css.select}
                aria-label={t('pickerPlacement', { name })}
                value={option.picker ?? 'main'}
                disabled={state.pickerSaving}
                autoFocus={index === 0}
                onChange={(event) => {
                  focusAfterSave.current = event.currentTarget
                  void setPickerPlacement(option.id, event.target.value as PresetPickerPlacement)
                }}
              >
                <option value="main">{t('pickerMain')}</option>
                <option value="more">{t('pickerMore')}</option>
                <option value="hidden">{t('pickerHidden')}</option>
              </select>
            </label>
          )
        })}
      </div>
      {state.pickerError === null ? null : <p className={css.error} role="alert">{state.pickerError}</p>}
    </Modal>
  )
}
