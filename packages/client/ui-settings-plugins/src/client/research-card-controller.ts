/** Research worker selection over the active profile's configuration form. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'

/** Profile entry containing the research tool configuration. */
export const RESEARCH_NS = 'odysseus-research'

/** Fields needed to present and select an operator-configured worker. */
export interface ResearchSettings {
  model: string
  workerLabel?: string
  workers?: { id: string; label: string; model: string }[]
  selectedWorker?: string
}

/** Research picker snapshot. */
export interface ResearchCardState {
  status: 'loading' | 'ready' | 'unavailable'
  writable: boolean
  saving: boolean
  selected: string
  choices: readonly { id: string; label: string }[]
  error: boolean
}

/** Browser slot face for the research picker. */
export interface ResearchCardFace {
  hooks: { researchCard: SnapshotStore<ResearchCardState> }
  selectWorker(id: string): Promise<void>
}

/** Keeps the picker aligned with the current profile revision. */
export class ResearchCardController {
  private readonly store = createSnapshotStore<ResearchCardState>({
    status: 'loading', writable: false, saving: false, selected: 'default', choices: [], error: false,
  })

  /** @param form - shared Host configuration form for the research entry. */
  constructor(private readonly form: ConfigForm<ResearchSettings>) {
    form.subscribe(() => { this.derive() })
    this.derive()
  }

  private derive(): void {
    const form = this.form.getSnapshot()
    const value = form.value
    const choices = value === undefined ? [] : [
      { id: 'default', label: value.workerLabel ?? value.model },
      ...(value.workers ?? []).map(worker => ({ id: worker.id, label: worker.label })),
    ]
    this.store.set({
      ...this.store.getSnapshot(), status: form.status, writable: form.writable,
      selected: value?.selectedWorker ?? 'default', choices,
    })
  }

  /** Expose current profile choices and the one-field save action.
   * @returns the slot actions and observable picker state.
   */
  inject(): ResearchCardFace {
    return {
      hooks: { researchCard: this.store },
      selectWorker: async (id) => {
        this.store.set({ ...this.store.getSnapshot(), saving: true, error: false })
        try {
          if (!await this.form.set('selectedWorker', id)) this.store.set({ ...this.store.getSnapshot(), error: true })
        } catch {
          this.store.set({ ...this.store.getSnapshot(), error: true })
        } finally {
          this.store.set({ ...this.store.getSnapshot(), saving: false })
        }
      },
    }
  }
}
