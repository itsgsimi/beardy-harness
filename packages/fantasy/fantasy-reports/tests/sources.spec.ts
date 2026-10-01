import { describe, expect, it } from 'vitest'
import type { FantasyPlayer } from '@deepseek-ai/dsh-fantasy/types'
import { PlayerKey } from '@deepseek-ai/dsh-fantasy'
import { admitsPlayer, cleanSource, fetchable, isDefense, nameWords, playerExcerpt, playerPassages } from '../src/sources.ts'

function player(name: string, positions = ['RB']): FantasyPlayer {
  return { key: PlayerKey('470.p.1'), name, positions }
}

describe('roster-name admission', () => {
  it('admits pages that name the player and rejects unrelated pages and navigation shells', () => {
    expect(admitsPlayer(player('Breece Hall'), 'Breece Hall handled 18 carries.')).toBe(true)
    expect(admitsPlayer(player('Breece Hall'), 'Hall of Fame weekend | Scores | News')).toBe(false)
    expect(admitsPlayer(player('Breece Hall'), 'Breece Hallmark is a different person.')).toBe(false)
  })

  it('matches suffixes, initials, apostrophes, accents, defenses, and admits names too short to match', () => {
    expect(admitsPlayer(player('Travis Etienne Jr.'), 'Travis Etienne ran well.')).toBe(true)
    expect(admitsPlayer(player('J.K. Dobbins'), 'JK Dobbins is questionable.')).toBe(true)
    expect(admitsPlayer(player("Ja'Marr Chase", ['WR']), 'Ja’Marr Chase caught nine passes.')).toBe(true)
    expect(admitsPlayer(player('Chase Brown'), 'Chasé Brown returned.')).toBe(true)
    expect(admitsPlayer(player('Steelers', ['DEF']), 'The Pittsburgh Steelers defense had five sacks.')).toBe(true)
    expect(admitsPlayer(player('J. Ra'), 'Unrelated page')).toBe(true)
    expect(isDefense(player('Steelers', ['DEF']))).toBe(true)
    expect(isDefense(player('Breece Hall'))).toBe(false)
    expect(nameWords('  D.J. Moore, Jr. ')).toBe('dj moore jr')
  })
})

describe('source cleaning', () => {
  it('replaces inverse strength-of-schedule ordinals with plain difficulty words on any host', () => {
    expect(cleanSource('https://news.example/a', 'A 30th easiest opponent, the 15th easiest opponent, and the 1st easiest opponent.'))
      .toBe('A a hard matchup for this position, the an average matchup for this position, and the an easy matchup for this position.')
  })

  it('strips FantasyPros rank and projection headers and the repeated footer', () => {
    const page = 'Breece Hall Wk Rank (ECR) RB #17 Proj. 12 pts   View More News Start / Sit Availability Hall is the lead back.'
      + ' Footer Sections of the Site Breece Hall profile repeated'
    expect(cleanSource('https://www.fantasypros.com/nfl/players/breece-hall.php', page)).toBe('Breece Hall Hall is the lead back.')
    expect(cleanSource('https://fantasypros.com/x', 'Plain text.')).toBe('Plain text.')
  })
})

describe('model-visible passages', () => {
  it('keeps a page that fits and joins literal passages around roster surnames otherwise', () => {
    expect(playerPassages('short page', [player('Breece Hall')], 100)).toBe('short page')
    const filler = 'x'.repeat(3000)
    const text = `Headline. ${filler} Hall broke a long run. ${filler} Steelers allowed 10 points. ${filler}`
    const passages = playerPassages(text, [player('Breece Hall Jr.'), player('Steelers', ['DEF']), player('A B'), player('  ')], 5000)
    expect(passages.startsWith('Headline.')).toBe(true)
    expect(passages).toContain('Hall broke a long run.')
    expect(passages).toContain('Steelers allowed 10 points.')
    expect(passages).toContain('[... source passage omitted ...]')
    expect(passages.length).toBeLessThanOrEqual(5000)
    const crowded = Array.from({ length: 6 }, () => `Hall ${'y'.repeat(1700)}`).join(' ')
    expect(playerPassages(crowded, [player('Breece Hall')], 2000)).toHaveLength(2000)
  })

  it('cuts one verbatim excerpt from the first sentence naming the player', () => {
    const page = 'Week 3 injury report. J.K. Dobbins practiced fully on Wednesday. He is splitting carries. Other news follows here.'
    const dobbins = player('J.K. Dobbins')
    expect(playerExcerpt(page, dobbins, 80)).toBe('Dobbins practiced fully on Wednesday. He is splitting carries.')
    expect(page).toContain(playerExcerpt(page, dobbins, 80))
    expect(playerExcerpt(page, dobbins, 30)).toBe('Dobbins practiced fully on')
    expect(playerExcerpt('Practice notes. Nobody named here at all.', player('Al Ra'), 20)).toBe('Practice notes.')
    expect(playerExcerpt('Abcdefghijklmnopqrstuvwxyz', player('A B'), 10)).toBe('Abcdefghij')
    expect(playerExcerpt('The Steelers defense had five sacks.\nNext line.', player('Steelers', ['DEF']), 200))
      .toBe('The Steelers defense had five sacks.\nNext line.')
  })

  it('fetches only HTTPS pages outside excluded hosts', () => {
    expect(fetchable('https://news.example/a', ['reddit.com'])).toBe(true)
    expect(fetchable('https://old.reddit.com/r/nfl', ['reddit.com'])).toBe(false)
    expect(fetchable('https://reddit.com/', ['reddit.com'])).toBe(false)
    expect(fetchable('https://notreddit.com/', ['reddit.com'])).toBe(true)
    expect(fetchable('http://news.example/a', [])).toBe(false)
    expect(fetchable('not a url', [])).toBe(false)
  })
})
