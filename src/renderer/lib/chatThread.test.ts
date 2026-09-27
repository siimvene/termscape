import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/types'
import { assistantTurnEnds, chatRelativeTime } from './chatThread'

const NOW = Date.parse('2026-09-26T12:00:00Z')
const MIN = 60_000

describe('chatRelativeTime', () => {
  it('says "just now" under a minute, and for a stamp in the future (clock skew)', () => {
    expect(chatRelativeTime(NOW - 20_000, NOW)).toBe('just now')
    expect(chatRelativeTime(NOW + 5 * MIN, NOW)).toBe('just now')
  })

  it('counts minutes, hours and days in words', () => {
    expect(chatRelativeTime(NOW - 1 * MIN, NOW)).toBe('1 min ago')
    expect(chatRelativeTime(NOW - 2 * MIN, NOW)).toBe('2 min ago')
    expect(chatRelativeTime(NOW - 59 * MIN, NOW)).toBe('59 min ago')
    expect(chatRelativeTime(NOW - 60 * MIN, NOW)).toBe('1 hour ago')
    expect(chatRelativeTime(NOW - 5 * 60 * MIN, NOW)).toBe('5 hours ago')
    expect(chatRelativeTime(NOW - 24 * 60 * MIN, NOW)).toBe('1 day ago')
    expect(chatRelativeTime(NOW - 2 * 24 * 60 * MIN, NOW)).toBe('2 days ago')
    expect(chatRelativeTime(NOW - 29 * 24 * 60 * MIN, NOW)).toBe('29 days ago')
  })

  it('falls back to a short date past a month, where "43 days ago" stops meaning anything', () => {
    const label = chatRelativeTime(NOW - 45 * 24 * 60 * MIN, NOW)
    expect(label).not.toMatch(/ago/)
    expect(label).toMatch(/\d/)
  })
})

const say = (role: 'user' | 'assistant', text: string, at?: number): ChatMessage => ({
  role,
  parts: [{ kind: 'text', text }],
  ...(at !== undefined ? { at } : {})
})
const tool = (at?: number): ChatMessage => ({
  role: 'assistant',
  parts: [{ kind: 'tool', name: 'Bash', arg: 'ls' }],
  ...(at !== undefined ? { at } : {})
})

describe('assistantTurnEnds (one action row per assistant turn)', () => {
  it('puts the row on the LAST message of each run of assistant messages', () => {
    const msgs = [say('user', 'q'), say('assistant', 'a1', 1), tool(2), say('assistant', 'a2', 3), say('user', 'q2'), say('assistant', 'b', 4)]
    const ends = assistantTurnEnds(msgs)
    expect([...ends.keys()]).toEqual([3, 5])
  })

  it('copies the TEXT parts of the whole turn as markdown source, in order, and nothing else', () => {
    const msgs: ChatMessage[] = [
      say('assistant', 'First **para**.'),
      { role: 'assistant', parts: [{ kind: 'thinking', text: 'hidden' }, { kind: 'tool', name: 'Bash', arg: 'ls', result: 'x' }] },
      say('assistant', 'Second.')
    ]
    expect(assistantTurnEnds(msgs).get(2)?.copyText).toBe('First **para**.\n\nSecond.')
  })

  it('times the turn by its last stamped message', () => {
    const ends = assistantTurnEnds([say('assistant', 'a', 10), tool(20), tool()])
    expect(ends.get(2)?.at).toBe(20)
  })

  it('has no copy text for a turn of tool calls only, and no time when nothing is stamped', () => {
    const ends = assistantTurnEnds([tool()])
    expect(ends.get(0)).toEqual({ copyText: '', at: undefined })
  })

  it('a user message is never a turn end', () => {
    expect(assistantTurnEnds([say('user', 'q', 1)]).size).toBe(0)
  })
})
