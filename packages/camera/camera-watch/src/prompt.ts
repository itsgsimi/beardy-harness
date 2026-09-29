/**
 * The exact classification request text for one event: the system prompt, the instruction that
 * precedes the frames, and the questions it asks. The watch builds every classification from it, and
 * a replay script renders the same text for stored events from a configuration.
 * @module @deepseek-ai/dsh-camera-watch/prompt
 */

import type { CameraEventKind, CameraQuestion } from '@deepseek-ai/dsh-camera'
import { resolveConfig } from './config.ts'
import type { Config, ResolvedConfig } from './config.ts'
import { localDateTime } from './notice.ts'
import { askedQuestions } from './policy.ts'
import { CLASSIFICATION_SYSTEM_PROMPT, classificationPrompt } from './verdict.ts'

/** The event a request is rendered for. */
export interface RequestEvent {
  /** Provider device id and label, as `ctx.camera.devices()` lists them. */
  readonly device: { readonly id: string; readonly label: string }
  readonly kind: CameraEventKind
  /** Epoch milliseconds of the event. */
  readonly occurredAt: number
  /** Frame offsets after the event in capture order, in milliseconds. */
  readonly offsetsMs: readonly number[]
  /** Render the first-frame check, which sees only the first frame. */
  readonly firstFrame?: boolean
}

/** One rendered classification request. */
export interface ClassificationRequestText {
  /** Complete system prompt. */
  readonly systemPrompt: string
  /** Instruction text of the user message; the frames follow it as images. */
  readonly prompt: string
  /** Questions the instruction asks, in canonical order; pass them to `parseVerdict`. */
  readonly questions: readonly CameraQuestion[]
}

/**
 * Render the request for one event from resolved settings.
 * @param config - resolved watch settings.
 * @param event - device, kind, time, frame offsets, and whether it is a first-frame check.
 * @returns system prompt, instruction, and asked questions.
 */
export function classificationRequest(config: ResolvedConfig, event: RequestEvent): ClassificationRequestText {
  const questions = askedQuestions(config.policy, {
    kind: event.kind, deviceId: event.device.id, frameCount: event.offsetsMs.length, firstFrame: event.firstFrame === true,
  })
  const prompt = classificationPrompt({
    kind: event.kind,
    deviceLabel: event.device.label,
    localTime: localDateTime(event.occurredAt, config.timezone),
    offsetsMs: event.offsetsMs,
    firstFrame: event.firstFrame === true,
    scene: config.scenes.get(event.device.id),
    questions,
  })
  return { systemPrompt: CLASSIFICATION_SYSTEM_PROMPT, prompt, questions }
}

/**
 * Render the exact request the watch sends for one event under a configuration, without a running
 * host: for replaying stored events against a new prompt. The configuration is validated as at load,
 * except that device ids are not checked against a provider.
 * @param config - camera watch configuration as written in `cordis.yml`.
 * @param event - device, kind, time, frame offsets, and whether it is a first-frame check.
 * @returns system prompt, instruction, and asked questions.
 */
export function renderClassificationRequest(config: Config, event: RequestEvent): ClassificationRequestText {
  return classificationRequest(resolveConfig(config), event)
}
