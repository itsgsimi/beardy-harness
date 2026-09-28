import { describe, expect, it } from 'vitest'
import { splitText, styleText } from '../src/text.ts'

describe('splitText', () => {
  it('keeps short text whole and drops whitespace-only text', () => {
    expect(splitText('  hello  ', 10)).toEqual(['hello'])
    expect(splitText(' \n ', 10)).toEqual([])
  })

  it('prefers paragraph, then line, then word breaks in the second half of a part', () => {
    expect(splitText('aaaaaa\n\nbbbb cccc', 10)).toEqual(['aaaaaa', 'bbbb cccc'])
    expect(splitText('aaaaaa\nbbbb cccc', 10)).toEqual(['aaaaaa', 'bbbb cccc'])
    expect(splitText('aaaaaa bbbbbbbbb', 10)).toEqual(['aaaaaa', 'bbbbbbbbb'])
    expect(splitText('a\n\nbbbbbbbbbbbbbb', 10)).toEqual(['a\n\nbbbbbbb', 'bbbbbbb'])
  })

  it('never cuts a surrogate pair', () => {
    const text = `${'a'.repeat(9)}😀${'b'.repeat(5)}`
    const parts = splitText(text, 10)
    expect(parts).toEqual(['a'.repeat(9), `😀${'b'.repeat(5)}`])
    expect(parts.every(part => part.length <= 10)).toBe(true)
  })
})

describe('styleText', () => {
  it('turns paired bold markers into ranges measured in the visible text', () => {
    expect(styleText('**Front door** · 07:15: Doorbell rang\n**x**y')).toEqual({
      message: 'Front door · 07:15: Doorbell rang\nxy',
      textStyle: ['0:10:BOLD', '34:1:BOLD'],
    })
  })

  it('measures ranges in UTF-16 units and leaves unpaired or empty markers literal', () => {
    expect(styleText('😀 **ab**')).toEqual({ message: '😀 ab', textStyle: ['3:2:BOLD'] })
    expect(styleText('a ** b **** c **\nd**')).toEqual({ message: 'a ** b **** c **\nd**', textStyle: [] })
    expect(styleText('plain')).toEqual({ message: 'plain', textStyle: [] })
  })
})
