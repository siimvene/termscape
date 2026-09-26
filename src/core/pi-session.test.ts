import { describe, expect, it } from 'vitest'
import type { ContextWindowUsage } from '../shared/types'
import { createPiSessionTracker, piContextUsage } from './pi-session'

const ctx = (tokens: unknown, contextWindow: unknown, percent: unknown) => ({ tokens, contextWindow, percent })

describe('piContextUsage', () => {
  it('uses pi’s OWN stated numbers, percent already 0–100 (measured: 1244/272000 → 0.457)', () => {
    expect(piContextUsage({ sessionId: 's', model: 'gpt-5.6-sol', context: ctx(1244, 272000, 0.457) }, 7)).toEqual({
      sessionId: 's', usedTokens: 1244, windowTokens: 272000, usedPercent: 0.457, model: 'gpt-5.6-sol', updatedAt: 7
    })
  })

  it('states nothing (null), never a guessed zero, when pi does not know yet or the shape is off', () => {
    expect(piContextUsage({ sessionId: 's', context: ctx(0, 272000, null) })).toBeNull()
    expect(piContextUsage({ sessionId: 's', context: ctx(10, 0, 1) })).toBeNull()
    expect(piContextUsage({ sessionId: 's', context: ctx('10', 100, 10) })).toBeNull()
    expect(piContextUsage({ sessionId: 's', context: ctx(-1, 100, 1) })).toBeNull()
    expect(piContextUsage({ sessionId: 's' })).toBeNull()
    expect(piContextUsage({ context: ctx(1, 100, 1) })).toBeNull()
  })

  it('clamps an over-full percent at 100', () => {
    expect(piContextUsage({ sessionId: 's', context: ctx(300, 272000, 140) })?.usedPercent).toBe(100)
  })
})

describe('createPiSessionTracker', () => {
  const setup = () => {
    const sent: ContextWindowUsage[] = []
    const t = createPiSessionTracker({
      send: (u) => sent.push(u),
      safePath: (p) => (p && p.startsWith('/ok/') ? p : undefined)
    })
    return { sent, t }
  }

  it('pushes only when the stated usage changes', () => {
    const { sent, t } = setup()
    t.observe({ sessionId: 's', context: ctx(10, 100, 10) }, { trackPath: true })
    t.observe({ sessionId: 's', context: ctx(10, 100, 10) }, { trackPath: true })
    t.observe({ sessionId: 's', context: ctx(20, 100, 20) }, { trackPath: true })
    expect(sent.map((u) => u.usedTokens)).toEqual([10, 20])
  })

  it('records only a jailed transcript path, and only when path tracking is allowed', () => {
    const { t } = setup()
    t.observe({ sessionId: 'a', sessionFile: '/ok/a.jsonl' }, { trackPath: true })
    t.observe({ sessionId: 'b', sessionFile: '/etc/passwd' }, { trackPath: true })
    t.observe({ sessionId: 'c', sessionFile: '/ok/c.jsonl' }, { trackPath: false })
    expect(t.pathFor('a')).toBe('/ok/a.jsonl')
    expect(t.pathFor('b')).toBeUndefined()
    expect(t.pathFor('c')).toBeUndefined()
  })

  it('a remote node (no path tracking) still gets its meter: the numbers are in the payload', () => {
    const { sent, t } = setup()
    t.observe({ sessionId: 'r', sessionFile: '/host/only.jsonl', context: ctx(5, 100, 5) }, { trackPath: false })
    expect(sent).toHaveLength(1)
  })

  it('session_shutdown forgets the session, so a relaunch with the same id meters again', () => {
    const { sent, t } = setup()
    t.observe({ sessionId: 's', sessionFile: '/ok/s.jsonl', context: ctx(10, 100, 10) }, { trackPath: true })
    expect(t.observe({ event: 'session_shutdown', sessionId: 's' }, { trackPath: true })).toBe('s')
    expect(t.pathFor('s')).toBeUndefined()
    t.observe({ sessionId: 's', context: ctx(10, 100, 10) }, { trackPath: true })
    expect(sent).toHaveLength(2)
  })
})
