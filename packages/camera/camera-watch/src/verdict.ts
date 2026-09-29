/**
 * The classification system prompt and instruction, and a tolerant reader for the model's verdict:
 * it accepts fenced or surrounded JSON, common synonyms, and percentages, and reports how complete
 * the answer was.
 * @module @deepseek-ai/dsh-camera-watch/verdict
 */

import { CAMERA_ACTIVITIES, CAMERA_LABELS, CAMERA_VEHICLE_ACTIVITIES } from '@deepseek-ai/dsh-camera'
import type { CameraActivity, CameraEventKind, CameraLabel, CameraVehicleActivity, CameraVerdict } from '@deepseek-ai/dsh-camera'
import type { VerdictStatus } from './types.ts'

/** Longest stored verdict description. */
export const DESCRIPTION_MAX_CHARS = 200

/** Complete system prompt of every classification Session; it replaces the host's prompt sections. */
export const CLASSIFICATION_SYSTEM_PROMPT = [
  'You classify still frames from a home security camera.',
  'The user message states the alert and shows the frames. Reply with exactly the one JSON object it asks for and nothing else.',
  'You have no tools. Describe people only by what is visible and never guess who anyone is.',
].join('\n')

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
}

/**
 * Compose the model-facing classification instruction that precedes the frames.
 * @param facts - event kind, device label, local time, and frame offsets.
 * @returns prompt text.
 */
export function classificationPrompt(facts: PromptFacts): string {
  const alert = facts.kind === 'ding' ? 'doorbell press' : 'motion alert'
  const offsets = facts.offsetsMs.map(ms => `${String(Math.round(ms / 1_000))} s`).join(', ')
  const count = facts.offsetsMs.length
  const scope = facts.firstFrame === true
    ? `The image is only the first frame, taken ${offsets} after the alert; later frames are checked separately, so describe only what this frame shows.`
    : `The ${String(count)} image${count === 1 ? ' is a frame' : 's are frames'} in capture order, taken ${offsets} after the alert.`
  return [
    `Classify this ${alert} from the ${facts.deviceLabel} camera at ${facts.localTime}. ${scope}`,
    '',
    'Reply with only one JSON object and no other text:',
    '{"labels":[],"counts":{},"activity":"none","vehicleActivity":"none","confidence":0,"description":"","personFrames":[]}',
    '',
    '- labels: each of "person", "vehicle", "package", "animal" visible in any frame.',
    '- counts: the most of each label visible at once, for example {"person":1}.',
    '- activity: one of "delivering", "lingering", "passing", "ringing", "none".',
    '- vehicleActivity: "arriving" when a vehicle drives into the driveway or a parking spot, or is stopped there with a door open, '
      + 'its lights on, or a person getting in or out, or is present in later frames but not in earlier ones; '
      + '"leaving" when a vehicle pulls out or is gone from later frames; "passing" when one drives by without stopping; '
      + '"parked" only when every vehicle stays still with its doors closed, its lights off, and nobody getting in or out; '
      + '"none" when no vehicle is visible.',
    '- confidence: how sure you are, from 0 to 1.',
    '- description: one sentence of at most 25 words about what is happening. Do not guess who anyone is.',
    '- personFrames: zero-based indices of the frames that show a person.',
  ].join('\n')
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

/** Read one enumerated field case-insensitively; a value outside the choices, or `unknown` itself, reads as `unknown`. */
function choiceOf<T extends string>(choices: readonly (T | 'unknown')[], value: unknown): T | 'unknown' {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return choices.find(choice => choice === raw && choice !== 'unknown') ?? 'unknown'
}

function confidenceOf(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value.trim().replace(/%$/u, '')) : Number.NaN
  if (!Number.isFinite(number) || number < 0) return undefined
  if (number <= 1) return number
  return number <= 100 ? number / 100 : undefined
}

/**
 * Read the model's verdict. Missing or invalid fields make the reading `partial`: labels and counts
 * keep their valid members, activity and vehicle activity become `unknown`, confidence becomes 0, an
 * empty description is replaced by the visible labels, and person frames outside the frame set are
 * dropped. A person frame adds the `person` label and a vehicle activity other than `none` adds the
 * `vehicle` label.
 * @param text - the classification turn's final assistant text.
 * @param frameCount - frames the model received.
 * @returns the reading and its completeness.
 */
export function parseVerdict(text: string, frameCount: number): VerdictReading {
  const object = firstObject(text)
  if (object === undefined) return { status: 'unparsed', text: oneLine(text) }
  let complete = true
  const labels = new Set<CameraLabel>()
  if (Array.isArray(object['labels'])) {
    for (const value of object['labels']) {
      const label = labelOf(value)
      if (label === undefined) complete = false
      else labels.add(label)
    }
  } else complete = false
  const counts: Partial<Record<CameraLabel, number>> = {}
  const rawCounts = object['counts']
  if (typeof rawCounts === 'object' && rawCounts !== null && !Array.isArray(rawCounts)) {
    for (const [key, value] of Object.entries(rawCounts)) {
      const label = labelOf(key)
      const count = typeof value === 'number' && Number.isInteger(value) && value >= 0 ? Math.min(value, 99) : undefined
      if (label === undefined || count === undefined) {
        complete = false
        continue
      }
      counts[label] = Math.max(counts[label] ?? 0, count)
      if (count > 0) labels.add(label)
    }
  } else complete = false
  const activity: CameraActivity = choiceOf(CAMERA_ACTIVITIES, object['activity'])
  const vehicleActivity: CameraVehicleActivity = choiceOf(CAMERA_VEHICLE_ACTIVITIES, object['vehicleActivity'])
  if (activity === 'unknown' || vehicleActivity === 'unknown') complete = false
  if (vehicleActivity !== 'unknown' && vehicleActivity !== 'none') labels.add('vehicle')
  const confidence = confidenceOf(object['confidence'])
  if (confidence === undefined) complete = false
  const personFrames = new Set<number>()
  if (Array.isArray(object['personFrames'])) {
    for (const value of object['personFrames']) {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < frameCount) personFrames.add(value)
      else complete = false
    }
  } else complete = false
  if (personFrames.size > 0) labels.add('person')
  const ordered = CAMERA_LABELS.filter(label => labels.has(label))
  let description = typeof object['description'] === 'string' ? oneLine(object['description']) : ''
  if (description === '') {
    complete = false
    description = ordered.length === 0 ? 'Nothing identified.' : `Visible: ${ordered.join(', ')}.`
  }
  return {
    status: complete ? 'parsed' : 'partial',
    verdict: {
      labels: ordered,
      counts,
      activity,
      vehicleActivity,
      confidence: confidence ?? 0,
      description,
      personFrames: [...personFrames].sort((left, right) => left - right),
    },
  }
}
