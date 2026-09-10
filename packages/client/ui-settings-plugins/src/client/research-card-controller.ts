/** Staged research-model choice over the Host-owned worker catalog. */
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { CardForm, textField, type CardActions, type CardFieldState, type CardShell } from './card-form.ts'

/** Settings namespace of the Odysseus bridge. */
export const RESEARCH_NS = 'odysseus-research'

/** User-selected worker and operator-owned picker entries. */
export interface ResearchSettings {
  /** Worker used for the next research job. */
  worker: string
  /** Configured choices; the Host rejects catalog edits. */
  choices: { id: string; label: string; model: string }[]
}

/** Research card state. */
export interface ResearchCardState extends CardShell {
  /** Staged worker choice. */
  worker: CardFieldState
  /** Current configured models. */
  choices: ResearchSettings['choices']
}

/** Reactive card and staged write actions. */
export interface ResearchCardFace extends CardActions {
  hooks: {
    /** Model picker state. */
    researchCard: SnapshotStore<ResearchCardState>
  }
}

/** Edits only the selected worker; existing jobs keep their original model. */
export class ResearchCardController {
  private readonly form: CardForm<ResearchSettings>
  private readonly store: SnapshotStore<ResearchCardState>

  /** @param scope - Research settings synchronized with the Host. */
  constructor(scope: SettingsScope<ResearchSettings>) {
    this.form = new CardForm(scope, [textField('worker')])
    this.store = this.form.bind(() => ({
      ...this.form.shell(), worker: this.form.field('worker'), choices: scope.getSnapshot().value?.choices ?? [],
    }))
  }

  /** @returns Model picker state and revision-fenced form actions. */
  inject(): ResearchCardFace {
    return { hooks: { researchCard: this.store }, ...this.form.actions() }
  }
}
