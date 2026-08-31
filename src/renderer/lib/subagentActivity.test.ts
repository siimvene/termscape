import { describe, it, expect } from 'vitest'
import { parseActivitySegments } from './subagentActivity'

describe('parseActivitySegments', () => {
  it('types lines by the formatLine prefixes and merges consecutive prose', () => {
    const stream = [
      '✻ weigh the two options',
      'I will check the license module.',
      '',
      '- option A',
      '- option B',
      '$ Read src/core/license.ts',
      '  ↳ 1→import … (+120 lines)',
      'Done — A is correct.'
    ].join('\n')
    expect(parseActivitySegments(stream)).toEqual([
      { kind: 'thinking', text: 'weigh the two options' },
      // one merged block, interior blank kept (markdown paragraph break)
      { kind: 'prose', text: 'I will check the license module.\n\n- option A\n- option B' },
      { kind: 'tool', text: '$ Read src/core/license.ts\n↳ 1→import … (+120 lines)' },
      { kind: 'prose', text: 'Done — A is correct.' }
    ])
  })

  it('keeps an orphan result (its tool line scrolled off the bounded tail)', () => {
    expect(parseActivitySegments('  ↳ ok (+3 lines)')).toEqual([
      { kind: 'tool', text: '↳ ok (+3 lines)' }
    ])
  })

  it('yields nothing for empty/blank input', () => {
    expect(parseActivitySegments('')).toEqual([])
    expect(parseActivitySegments('\n \n')).toEqual([])
  })

  it('tolerates a torn head line as prose', () => {
    // slice(-CAP) can cut mid-line: the torn tail of a thinking line has no prefix.
    const segs = parseActivitySegments('gh the options\n$ Bash ls')
    expect(segs[0]).toEqual({ kind: 'prose', text: 'gh the options' })
    expect(segs[1].kind).toBe('tool')
  })
})
