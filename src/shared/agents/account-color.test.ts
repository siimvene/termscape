import { describe, it, expect } from 'vitest'
import { agentAccountColor } from './account-color'

// The three lists are keyed INDEPENDENTLY: the same id appears in all of them here on purpose, so a
// node colored from the wrong provider's list shows up as the wrong color, not as a silent pass.
const claude = [{ id: 'a1', label: 'c', createdAt: 1, color: '#0a84ff' }]
const codex = [{ id: 'a1', label: 'x', color: '#32d74b' }]
const pi = [{ id: 'a1', label: 'openai-codex', createdAt: 1, color: '#ff375f' }]

describe('agentAccountColor — pi reads piAccounts, and only pi does', () => {
  it('a pi node takes its PI account color, never a same-id Claude/Codex one', () => {
    expect(agentAccountColor('pi', 'a1', { claude, codex, pi })).toBe('#ff375f')
  })

  it('claude and codex still read their own lists, never the pi one', () => {
    expect(agentAccountColor('claude', 'a1', { claude, codex, pi })).toBe('#0a84ff')
    expect(agentAccountColor('codex', 'a1', { claude, codex, pi })).toBe('#32d74b')
  })

  it('a caller that passes no pi list (predates pi accounts) gets no pi color, and no throw', () => {
    expect(agentAccountColor('pi', 'a1', { claude, codex })).toBeUndefined()
  })

  it('an unknown / stale id, or a non-string hand-edited color, is no color', () => {
    expect(agentAccountColor('pi', 'gone', { claude, codex, pi })).toBeUndefined()
    const bad = [{ id: 'a1', label: 'x', createdAt: 1, color: 123 as unknown as string }]
    expect(agentAccountColor('pi', 'a1', { claude, codex, pi: bad })).toBeUndefined()
  })
})
