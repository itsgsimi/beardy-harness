import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { askedQuestions } from '../src/policy.ts'
import { classificationRequest, renderClassificationRequest } from '../src/prompt.ts'
import { CLASSIFICATION_SYSTEM_PROMPT, classificationPrompt, needsRetry, parseVerdict, readingRank } from '../src/verdict.ts'
import { NIGHT } from './support.ts'

const TZ = 'America/Phoenix'

const FRONT_SCENE = 'Fisheye view. The front door is at the right edge, under a covered entry with a column. A paver walkway runs from the door '
  + 'to the driveway corner; a parked pickup is often visible past the column. The street and the houses across it are in the far background.'
const GARAGE_SCENE = 'Elevated view over the driveway. The concrete driveway fills the middle and bottom; the family pickup on the left and a sedan '
  + 'at the bottom right are usually parked there. The driveway meets the curb and street at the top middle. The sidewalk and street run across '
  + 'the top, with houses across the street. Pavers and shrubs are on the right.'

/** The deployment the questions are shaped for: people anywhere on both cameras, a front door, and a driveway with vehicles. */
const DEPLOYMENT: Config = {
  timezone: TZ,
  policy: { personDevices: ['front-door', 'garage'], doorDevices: ['front-door'], vehicleDevices: ['garage'] },
  devices: [{ id: 'front-door', scene: FRONT_SCENE }, { id: 'garage', scene: GARAGE_SCENE }],
}

const FRONT = { id: 'front-door', label: 'Front door' }
const GARAGE = { id: 'garage', label: 'Garage' }
const OFFSETS = [0, 10_400, 21_000]

const INSTRUCTIONS = [
  'Reply with only this JSON object, filled in, and no other text:',
]
const FIELD_LINES = [
  '- description: one sentence of at most 25 words about what happens. Never guess who anyone is.',
  '- labels: each of "person", "vehicle", "package", "animal" visible in any frame.',
  '- counts: the most of each label visible at once, for example {"person":1}.',
  '- Each question has "answer" (true or false) and "frames" (the frame numbers that show it). A true answer must list at least one frame. '
    + 'When no frame clearly shows it, answer false.',
]
const EMPTY = '{"answer":false,"frames":[]}'

describe('classification prompts', () => {
  it('asks the front door about people on the property, at the door, and staying, and about packages', () => {
    const request = renderClassificationRequest(DEPLOYMENT, { device: FRONT, kind: 'motion', occurredAt: NIGHT, offsetsMs: OFFSETS })
    expect(request.systemPrompt).toBe(CLASSIFICATION_SYSTEM_PROMPT)
    expect(request.questions).toEqual(['person_on_property', 'person_at_door', 'person_staying', 'package_present', 'package_being_delivered'])
    expect(request.prompt).toBe([
      'Check this motion alert from the Front door camera at 2026-09-27 23:30:00. The 3 images are frames 0 to 2 in capture order, taken 0 s, 10 s, 21 s after the alert.',
      '',
      `Scene: ${FRONT_SCENE}`,
      '',
      ...INSTRUCTIONS,
      `{"description":"","labels":[],"counts":{},"person_on_property":${EMPTY},"person_at_door":${EMPTY},"person_staying":${EMPTY},`
        + `"package_present":${EMPTY},"package_being_delivered":${EMPTY}}`,
      '',
      ...FIELD_LINES,
      '- person_on_property: a person is on the porch, walkway, yard, or driveway. A person only on the sidewalk or street is false.',
      '- person_at_door: a person stands at the front door or within one step of it.',
      '- person_staying: a person on the property stays in view in two or more frames instead of walking past.',
      '- package_present: a package, box, or delivery bag lies on the property.',
      '- package_being_delivered: a person carries a package onto the property or sets one down.',
    ].join('\n'))
  })

  it('asks the garage about people and packages on the property and vehicles arriving or leaving, with the vehicle tie-breaker', () => {
    const request = renderClassificationRequest(DEPLOYMENT, { device: GARAGE, kind: 'motion', occurredAt: NIGHT, offsetsMs: OFFSETS })
    expect(request.questions).toEqual(['person_on_property', 'person_staying', 'package_present', 'package_being_delivered', 'vehicle_arriving', 'vehicle_leaving'])
    expect(request.prompt).toBe([
      'Check this motion alert from the Garage camera at 2026-09-27 23:30:00. The 3 images are frames 0 to 2 in capture order, taken 0 s, 10 s, 21 s after the alert.',
      '',
      `Scene: ${GARAGE_SCENE}`,
      '',
      ...INSTRUCTIONS,
      `{"description":"","labels":[],"counts":{},"person_on_property":${EMPTY},"person_staying":${EMPTY},"package_present":${EMPTY},`
        + `"package_being_delivered":${EMPTY},"vehicle_arriving":${EMPTY},"vehicle_leaving":${EMPTY}}`,
      '',
      ...FIELD_LINES,
      '- person_on_property: a person is on the porch, walkway, yard, or driveway. A person only on the sidewalk or street is false.',
      '- person_staying: a person on the property stays in view in two or more frames instead of walking past.',
      '- package_present: a package, box, or delivery bag lies on the property.',
      '- package_being_delivered: a person carries a package onto the property or sets one down.',
      '- vehicle_arriving: a vehicle pulls into the driveway, waits at its entrance with its lights on, or stands in it with a door open or a person getting out.',
      '- vehicle_leaving: a vehicle backs or drives out of the driveway toward the street.',
      '- A vehicle that stays parked with its doors closed and nobody at it is neither arriving nor leaving; a vehicle driving along the street is neither.',
    ].join('\n'))
  })

  it('asks a first-frame check from that frame alone, without staying, package-present, or leaving questions', () => {
    const garage = renderClassificationRequest(DEPLOYMENT, { device: GARAGE, kind: 'motion', occurredAt: NIGHT, offsetsMs: [300], firstFrame: true })
    expect(garage.questions).toEqual(['person_on_property', 'package_being_delivered', 'vehicle_arriving'])
    expect(garage.prompt.split('\n')[0]).toBe('Check this motion alert from the Garage camera at 2026-09-27 23:30:00. The image is frame 0, only the first frame, '
      + 'taken 0 s after the alert; later frames are checked separately, so answer from this frame alone.')
    const front = renderClassificationRequest(DEPLOYMENT, { device: FRONT, kind: 'motion', occurredAt: NIGHT, offsetsMs: [0], firstFrame: true })
    expect(front.questions).toEqual(['person_on_property', 'person_at_door', 'package_being_delivered'])
  })

  it('names a doorbell press, a single frame, and leaves out the scene a device does not configure', () => {
    const request = renderClassificationRequest({ timezone: TZ }, { device: { id: 'porch', label: 'Porch' }, kind: 'ding', occurredAt: NIGHT, offsetsMs: [0] })
    expect(request.questions).toEqual(['person_on_property', 'person_at_door', 'package_present', 'package_being_delivered'])
    expect(request.prompt.split('\n').slice(0, 3)).toEqual([
      'Check this doorbell press from the Porch camera at 2026-09-27 23:30:00. The image is frame 0, taken 0 s after the alert.',
      '',
      'Reply with only this JSON object, filled in, and no other text:',
    ])
    expect(request.prompt).not.toContain('Scene:')
    expect(request.prompt).not.toContain('neither arriving nor leaving')
  })

  it('renders the same request from resolved settings as from the written configuration', () => {
    const event = { device: GARAGE, kind: 'motion' as const, occurredAt: NIGHT, offsetsMs: OFFSETS }
    expect(classificationRequest(resolveConfig(DEPLOYMENT), event)).toEqual(renderClassificationRequest(DEPLOYMENT, event))
    expect(() => renderClassificationRequest({ timezone: 'Mars/Olympus' }, event)).toThrow(/not a known IANA time zone/)
  })

  it('omits the question lines when no rule needs a question', () => {
    const prompt = classificationPrompt({ kind: 'motion', deviceLabel: 'Side', localTime: 't', offsetsMs: [0], questions: [] })
    expect(prompt).toContain('{"description":"","labels":[],"counts":{}}')
    expect(prompt).not.toContain('Each question has')
  })

  it('pairs with a short check-only system prompt', () => {
    expect(CLASSIFICATION_SYSTEM_PROMPT).toBe([
      'You check still frames from a home security camera.',
      'The user message states the alert and shows the frames. Reply with exactly the one JSON object it asks for and nothing else.',
      'You have no tools. Describe people only by what is visible and never guess who anyone is.',
    ].join('\n'))
  })
})

describe('askedQuestions', () => {
  const policy = resolveConfig({ timezone: TZ }).policy
  const scope = { kind: 'motion' as const, deviceId: 'side', frameCount: 3 }

  it('asks only what the enabled rules read', () => {
    expect(askedQuestions(policy, scope)).toEqual(['person_on_property', 'person_staying', 'package_present', 'package_being_delivered'])
    const quiet = { ...policy, nightPerson: false, packageDelivered: false }
    expect(askedQuestions(quiet, { ...scope, frameCount: 1 })).toEqual([])
    expect(askedQuestions(quiet, scope)).toEqual(['person_on_property', 'person_staying'])
    expect(askedQuestions(quiet, { ...scope, kind: 'ding', frameCount: 1 })).toEqual([])
    expect(askedQuestions({ ...quiet, personDevices: ['side'] }, { ...scope, frameCount: 1 })).toEqual(['person_on_property'])
    expect(askedQuestions({ ...policy, arrivalBaselineMs: 0 }, scope)).toEqual(['person_on_property', 'person_staying', 'package_being_delivered'])
  })

  it('asks the vehicle questions a vehicle device lists', () => {
    const vehicles = { ...policy, nightPerson: false, packageDelivered: false, vehicleDevices: ['side'] }
    expect(askedQuestions(vehicles, { ...scope, frameCount: 1 })).toEqual(['vehicle_arriving', 'vehicle_leaving'])
    expect(askedQuestions({ ...vehicles, vehicleActivities: ['leaving'] }, { ...scope, frameCount: 1 })).toEqual(['vehicle_leaving'])
    expect(askedQuestions({ ...vehicles, vehicleActivities: ['leaving'] }, { ...scope, frameCount: 1, firstFrame: true })).toEqual([])
  })
})

describe('parseVerdict', () => {
  const QUESTIONS = ['person_on_property', 'person_staying', 'vehicle_arriving'] as const

  it('reads a complete answer and adds the labels its true answers imply', () => {
    expect(parseVerdict(JSON.stringify({
      description: 'A person steps out of a dark SUV that just pulled into the driveway.', labels: ['vehicle'], counts: { vehicle: 2 },
      person_on_property: { answer: true, frames: [2, 1, 1] }, person_staying: { answer: false, frames: [] },
      vehicle_arriving: { answer: true, frames: [0] },
    }), 3, QUESTIONS)).toEqual({
      status: 'parsed',
      verdict: {
        labels: ['person', 'vehicle'], counts: { vehicle: 2 }, description: 'A person steps out of a dark SUV that just pulled into the driveway.',
        answers: {
          person_on_property: { answer: true, frames: [1, 2] }, person_staying: { answer: false, frames: [] },
          vehicle_arriving: { answer: true, frames: [0] },
        },
      },
    })
  })

  it('reads a true answer without evidence frames as false, and drops frames outside the frame set', () => {
    const reading = parseVerdict(JSON.stringify({
      description: 'x', labels: [], counts: {},
      person_on_property: { answer: true, frames: [] }, person_staying: { answer: true, frames: [5, -1, 'x', 1.5] }, vehicle_arriving: { answer: false, frames: [0] },
    }), 3, QUESTIONS)
    expect(reading).toEqual({
      status: 'partial',
      verdict: { labels: [], counts: {}, description: 'x', answers: {
        person_on_property: { answer: false, frames: [] }, person_staying: { answer: false, frames: [] },
        vehicle_arriving: { answer: false, frames: [] },
      } },
    })
  })

  it('keeps the answers it can read from a partial object and ignores questions not asked', () => {
    const reading = parseVerdict('{"description":"A person on the sidewalk.","labels":["people"],"counts":{"person":1},'
      + '"person_on_property":"no","person_staying":{"answer":"false","frames":[]},"vehicle_arriving":{"answer":false,"frames":[]},'
      + '"vehicle_leaving":{"answer":true,"frames":[0]}}', 1, QUESTIONS)
    expect(reading).toEqual({
      status: 'partial',
      verdict: { labels: ['person'], counts: { person: 1 }, description: 'A person on the sidewalk.', answers: { vehicle_arriving: { answer: false, frames: [] } } },
    })
    expect(parseVerdict('{"description":"x","labels":[],"counts":{}}', 1, QUESTIONS).status).toBe('partial')
    expect(parseVerdict('{"description":"x","labels":[],"counts":{},"package_present":{"answer":true,"frames":[0]}}', 1, []))
      .toEqual({ status: 'parsed', verdict: { labels: [], counts: {}, description: 'x', answers: {} } })
  })

  it('finds the object inside fences and prose, skipping braces in strings and invalid candidates', () => {
    const text = 'Sure! {not json} Here it is:\n```json\n{"description":"Two people {walk} past\\n a \\"car\\".","labels":["People","cars","boxes","Dogs"],'
      + '"counts":{"people":2,"car":1,"truck":2}}\n```'
    expect(parseVerdict(text, 3, [])).toEqual({
      status: 'parsed',
      verdict: { labels: ['person', 'vehicle', 'package', 'animal'], counts: { person: 2, vehicle: 2 }, description: 'Two people {walk} past a "car".', answers: {} },
    })
  })

  it('keeps valid labels and counts and fills a missing description from them', () => {
    expect(parseVerdict('{"labels":["person","ghost",3],"counts":{"person":-1,"alien":1,"package":0,"animal":150}}', 2, [])).toEqual({
      status: 'partial',
      verdict: { labels: ['person', 'animal'], counts: { package: 0, animal: 99 }, description: 'Visible: person, animal.', answers: {} },
    })
    expect(parseVerdict('{"labels":"person","counts":[],"description":"   "}', 1, [])).toEqual({
      status: 'partial', verdict: { labels: [], counts: {}, description: 'Nothing identified.', answers: {} },
    })
    expect(parseVerdict('{"labels":[],"counts":null,"description":"x"}', 1, []).status).toBe('partial')
    expect(parseVerdict('{"labels":[],"counts":{},"description":7}', 1, []).verdict?.description).toBe('Nothing identified.')
  })

  it('reads an object that states nothing, such as the echoed template, as empty', () => {
    const prompt = classificationPrompt({ kind: 'motion', deviceLabel: 'Porch', localTime: '12:00', offsetsMs: [0, 10_000, 20_000], questions: QUESTIONS })
    const template = prompt.split('\n').find(line => line.startsWith('{'))!
    expect(parseVerdict(template, 3, QUESTIONS)).toEqual({ status: 'empty' })
    expect(parseVerdict('```json\n{"description":"  ","labels":[],"counts":{},"person_staying":{"answer":false,"frames":[1]}}\n```', 3, QUESTIONS))
      .toEqual({ status: 'empty' })
    expect(parseVerdict('{}', 1, QUESTIONS)).toEqual({ status: 'empty' })
    for (const text of [
      '{"description":"Quiet street.","labels":[],"counts":{}}',
      '{"description":"","labels":["car"],"counts":{}}',
      '{"description":"","labels":[],"counts":{"person":0}}',
      '{"description":"","labels":[],"counts":{},"person_staying":{"answer":true,"frames":[]}}',
      '{"labels":[],"counts":null}',
      '{"labels":{},"counts":{}}',
      '{"description":7}',
    ]) expect(parseVerdict(text, 1, QUESTIONS).status).toBe('partial')
  })

  it('reports malformed output as unparsed with a bounded one-line account', () => {
    expect(parseVerdict('I see a person\nat the door.', 3, QUESTIONS)).toEqual({ status: 'unparsed', text: 'I see a person at the door.' })
    expect(parseVerdict('[1, 2] {"unterminated": ', 3, QUESTIONS)).toEqual({ status: 'unparsed', text: '[1, 2] {"unterminated":' })
    expect(parseVerdict('["an array"]', 1, QUESTIONS).status).toBe('unparsed')
    const long = parseVerdict(`{"labels":[],"counts":{},"description":"${'a'.repeat(300)}"}`, 1, [])
    expect(long.verdict?.description).toHaveLength(200)
    expect(parseVerdict('x'.repeat(500), 1, QUESTIONS).text).toHaveLength(200)
  })
})

describe('corrective retry readings', () => {
  const QUESTIONS = ['person_on_property', 'person_staying', 'vehicle_arriving'] as const
  const answer = { answer: false, frames: [] }
  const complete = JSON.stringify({ description: 'Quiet.', labels: [], counts: {}, person_on_property: answer, person_staying: answer, vehicle_arriving: answer })
  const twoAnswered = JSON.stringify({ description: 'Quiet.', labels: ['ghost'], counts: {}, person_on_property: answer, person_staying: answer })
  const oneAnswered = JSON.stringify({ description: 'Quiet.', labels: [], counts: {}, person_on_property: answer })
  const allAnsweredGap = JSON.stringify({ description: 'Quiet.', labels: ['ghost'], counts: {}, person_on_property: answer, person_staying: answer, vehicle_arriving: answer })
  const read = (text: string): ReturnType<typeof parseVerdict> => parseVerdict(text, 1, QUESTIONS)

  it('asks again for no JSON object, an empty object, or a missing question, and never for a parsed answer or a gap outside the questions', () => {
    expect(['prose', '{}', oneAnswered, complete, allAnsweredGap].map(text => needsRetry(read(text), QUESTIONS))).toEqual([true, true, true, false, false])
  })

  it('ranks parsed over partial over unparsed over empty, and a partial answering more questions higher', () => {
    const ranks = [complete, allAnsweredGap, twoAnswered, oneAnswered, 'prose', '{}'].map(text => readingRank(read(text), QUESTIONS))
    expect(ranks).toEqual([...ranks].sort((left, right) => right - left))
    expect(new Set(ranks).size).toBe(ranks.length)
  })
})
