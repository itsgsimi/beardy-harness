/**
 * The classification system prompt and instruction, and a reader for the model's answer: a fixed
 * JSON object with a description, labels, counts, and one yes-or-no answer with evidence frames per
 * asked question. The reader takes the first JSON object even inside fences or prose, checks each
 * field against its schema separately, and reports how complete the answer was.
 * @module @deepseek-ai/dsh-camera-watch/verdict
 */

import { z } from 'zod'
import { CAMERA_LABELS, CAMERA_QUESTIONS } from '@deepseek-ai/dsh-camera'
import type { CameraAnswer, CameraEventKind, CameraLabel, CameraQuestion, CameraVerdict } from '@deepseek-ai/dsh-camera'
import type { VerdictStatus } from './types.ts'

/** Longest stored verdict description. */
export const DESCRIPTION_MAX_CHARS = 200

/** Complete system prompt of every classification Session; it replaces the host's prompt sections. */
export const CLASSIFICATION_SYSTEM_PROMPT = [
  'You check still frames from a home security camera.',
  'The user message states the alert and shows the frames. Reply with exactly the one JSON object it asks for and nothing else.',
  'You have no tools. Describe people only by what is visible and never guess who anyone is.',
].join('\n')

/** One definition line per question, as the instruction states it. */
export const QUESTION_DEFINITIONS: Readonly<Record<CameraQuestion, string>> = Object.freeze({
  person_on_property: 'a person is on the porch, walkway, yard, or driveway. A person only on the sidewalk or street is false.',
  person_at_door: 'a person stands at the front door or within one step of it.',
  person_staying: 'a person on the property stays in view in two or more frames instead of walking past.',
  package_present: 'a package, box, or delivery bag lies on the property.',
  package_being_delivered: 'a person carries a package onto the property or sets one down.',
  vehicle_arriving: 'a vehicle pulls into the driveway, waits at its entrance with its lights on, '
    + 'or stands in it with a door open or a person getting out.',
  vehicle_leaving: 'a vehicle backs or drives out of the driveway toward the street.',
})

/** Closing tie-breaker, stated when a vehicle question is asked. */
export const VEHICLE_TIE_BREAKER = 'A vehicle that stays parked with its doors closed and nobody at it is neither arriving nor leaving; '
  + 'a vehicle driving along the street is neither.'

/** Everything the prompt states about one event. */
export interface PromptFacts {
  readonly kind: CameraEventKind
  readonly deviceLabel: string
  /** Local time already formatted in the configured zone. */
  readonly localTime: string
  /** Frame offsets after the alert, in milliseconds. */
  readonly offsetsMs: readonly number[]
  /** The one frame is the alert's first, classified before the rest are captured. */
  readonly firstFrame?: boolean
  /** The device's configured scene text, inserted verbatim. */
  readonly scene?: string | undefined
  /** Questions to ask, in canonical order. */
  readonly questions: readonly CameraQuestion[]
}

function framesSentence(facts: PromptFacts): string {
  const offsets = facts.offsetsMs.map(ms => `${String(Math.round(ms / 1_000))} s`).join(', ')
  const count = facts.offsetsMs.length
  if (facts.firstFrame === true) {
    return `The image is frame 0, only the first frame, taken ${offsets} after the alert; later frames are checked separately, so answer from this frame alone.`
  }
  if (count === 1) return `The image is frame 0, taken ${offsets} after the alert.`
  return `The ${String(count)} images are frames 0 to ${String(count - 1)} in capture order, taken ${offsets} after the alert.`
}

/**
 * Compose the model-facing classification instruction that precedes the frames: the alert, frame
 * numbering, the scene, the JSON object to fill in, and one definition line per asked question.
 * @param facts - event kind, device label and scene, local time, frame offsets, and questions.
 * @returns prompt text.
 */
export function classificationPrompt(facts: PromptFacts): string {
  const alert = facts.kind === 'ding' ? 'doorbell press' : 'motion alert'
  const template = JSON.stringify({
    description: '', labels: [], counts: {},
    ...Object.fromEntries(facts.questions.map(question => [question, { answer: false, frames: [] }])),
  })
  const lines = [`Check this ${alert} from the ${facts.deviceLabel} camera at ${facts.localTime}. ${framesSentence(facts)}`, '']
  if (facts.scene !== undefined) lines.push(`Scene: ${facts.scene}`, '')
  lines.push(
    'Reply with only this JSON object, filled in, and no other text:',
    template,
    '',
    '- description: one sentence of at most 25 words about what happens. Never guess who anyone is.',
    '- labels: each of "person", "vehicle", "package", "animal" visible in any frame.',
    '- counts: the most of each label visible at once, for example {"person":1}.',
  )
  if (facts.questions.length > 0) {
    lines.push('- Each question has "answer" (true or false) and "frames" (the frame numbers that show it). '
      + 'A true answer must list at least one frame. When no frame clearly shows it, answer false.')
    for (const question of facts.questions) lines.push(`- ${question}: ${QUESTION_DEFINITIONS[question]}`)
    if (facts.questions.some(question => question.startsWith('vehicle_'))) lines.push(`- ${VEHICLE_TIE_BREAKER}`)
  }
  return lines.join('\n')
}

/** A read verdict and how complete it was. */
export interface VerdictReading {
  readonly status: Exclude<VerdictStatus, 'failed' | 'skipped'>
  /** Present for `parsed` and `partial` readings. */
  readonly verdict?: CameraVerdict
  /** One-line account for an `unparsed` reading: the model's first line of text. */
  readonly text?: string
}

const SYNONYMS: Readonly<Record<string, CameraLabel>> = {
  person: 'person', people: 'person', human: 'person', man: 'person', woman: 'person', child: 'person',
  vehicle: 'vehicle', car: 'vehicle', truck: 'vehicle', van: 'vehicle', motorcycle: 'vehicle',
  package: 'package', parcel: 'package', box: 'package',
  animal: 'animal', dog: 'animal', cat: 'animal', bird: 'animal',
}

/** Which label a true answer to each question implies. */
const QUESTION_LABELS: Readonly<Record<CameraQuestion, CameraLabel>> = {
  person_on_property: 'person', person_at_door: 'person', person_staying: 'person',
  package_present: 'package', package_being_delivered: 'package',
  vehicle_arriving: 'vehicle', vehicle_leaving: 'vehicle',
}

/** One answer object; frame members are checked one by one so a bad index drops only itself. */
const answerSchema = z.object({ answer: z.boolean(), frames: z.array(z.unknown()) })
const listSchema = z.array(z.unknown())
const countsSchema = z.record(z.string(), z.unknown())

function labelOf(value: unknown): CameraLabel | undefined {
  if (typeof value !== 'string') return undefined
  const word = value.trim().toLowerCase()
  return SYNONYMS[word] ?? SYNONYMS[word.replace(/s$/u, '')] ?? SYNONYMS[word.replace(/es$/u, '')]
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/gu, ' ').trim()
  return line.length > DESCRIPTION_MAX_CHARS ? `${line.slice(0, DESCRIPTION_MAX_CHARS - 1)}…` : line
}

/** Find the first balanced JSON object in model text, skipping braces inside strings. */
function firstObject(text: string): Record<string, unknown> | undefined {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let quoted = false
    for (let index = start; index < text.length; index++) {
      const char = text[index]
      if (quoted) {
        if (char === '\\') index++
        else if (char === '"') quoted = false
      } else if (char === '"') quoted = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) {
        try {
          const value: unknown = JSON.parse(text.slice(start, index + 1))
          if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
        } catch {
          // Not JSON from this brace; the next opening brace may start the object.
        }
        break
      }
    }
  }
  return undefined
}

/** Completeness flag shared by the field readers of one answer. */
interface Completeness { complete: boolean }

function readAnswer(value: unknown, frameCount: number, state: Completeness): CameraAnswer | undefined {
  const parsed = answerSchema.safeParse(value)
  if (!parsed.success) {
    state.complete = false
    return undefined
  }
  const frames = new Set<number>()
  for (const frame of parsed.data.frames) {
    if (typeof frame === 'number' && Number.isInteger(frame) && frame >= 0 && frame < frameCount) frames.add(frame)
    else state.complete = false
  }
  // A true answer without an evidence frame reads as false.
  return parsed.data.answer && frames.size > 0
    ? { answer: true, frames: [...frames].sort((left, right) => left - right) }
    : { answer: false, frames: [] }
}

/**
 * Read the model's answer. Missing or invalid fields make the reading `partial`: labels and counts
 * keep their valid members, a missing description is replaced by the visible labels, an asked
 * question without a valid `{ answer, frames }` object is left out of `answers`, and evidence frames
 * outside the frame set are dropped. A true answer whose evidence frames are all missing or invalid
 * reads as false; fields for questions not asked are ignored. A true person, package, or vehicle
 * answer adds that label.
 * @param text - the classification turn's final assistant text.
 * @param frameCount - frames the model received.
 * @param questions - questions the instruction asked.
 * @returns the reading and its completeness.
 */
export function parseVerdict(text: string, frameCount: number, questions: readonly CameraQuestion[]): VerdictReading {
  const object = firstObject(text)
  if (object === undefined) return { status: 'unparsed', text: oneLine(text) }
  const state: Completeness = { complete: true }
  const labels = new Set<CameraLabel>()
  const rawLabels = listSchema.safeParse(object['labels'])
  if (rawLabels.success) {
    for (const value of rawLabels.data) {
      const label = labelOf(value)
      if (label === undefined) state.complete = false
      else labels.add(label)
    }
  } else state.complete = false
  const counts: Partial<Record<CameraLabel, number>> = {}
  const rawCounts = countsSchema.safeParse(object['counts'])
  if (rawCounts.success) {
    for (const [key, value] of Object.entries(rawCounts.data)) {
      const label = labelOf(key)
      const count = typeof value === 'number' && Number.isInteger(value) && value >= 0 ? Math.min(value, 99) : undefined
      if (label === undefined || count === undefined) {
        state.complete = false
        continue
      }
      counts[label] = Math.max(counts[label] ?? 0, count)
      if (count > 0) labels.add(label)
    }
  } else state.complete = false
  const answers: Partial<Record<CameraQuestion, CameraAnswer>> = {}
  for (const question of CAMERA_QUESTIONS) {
    if (!questions.includes(question)) continue
    const answer = readAnswer(object[question], frameCount, state)
    if (answer === undefined) continue
    answers[question] = answer
    if (answer.answer) labels.add(QUESTION_LABELS[question])
  }
  const ordered = CAMERA_LABELS.filter(label => labels.has(label))
  const rawDescription = object['description']
  let description = typeof rawDescription === 'string' ? oneLine(rawDescription) : ''
  if (description === '') {
    state.complete = false
    description = ordered.length === 0 ? 'Nothing identified.' : `Visible: ${ordered.join(', ')}.`
  }
  return { status: state.complete ? 'parsed' : 'partial', verdict: { labels: ordered, counts, description, answers } }
}
