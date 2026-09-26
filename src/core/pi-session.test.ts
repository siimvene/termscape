import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import type { ContextWindowUsage } from '../shared/types'
import { createPiSessionTracker, linesFromPi, pickPiTitle, piContextUsage } from './pi-session'

// FIXTURE PROVENANCE — `__fixtures__/pi/session.jsonl` is REAL. Generated 2026-09-26 against the
// installed pi 0.84.1 binary (`--provider openai-codex --model gpt-5.6-sol --thinking off -p
// --session-dir <temp> --name "Fixture title" "List the files in the current directory using
// your bash tool, then reply with just the word done."`), copied in verbatim. Checked for
// secrets: none (cost/token numbers and a scratch cwd, no credentials).
const fixture = readFileSync(path.join(__dirname, '__fixtures__/pi/session.jsonl'), 'utf8')

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
    t.observe({ sessionId: 'a', sessionFile: '/ok/2026_a.jsonl' }, { trackPath: true })
    t.observe({ sessionId: 'b', sessionFile: '/etc/passwd' }, { trackPath: true })
    t.observe({ sessionId: 'c', sessionFile: '/ok/2026_c.jsonl' }, { trackPath: false })
    expect(t.pathFor('a')).toBe('/ok/2026_a.jsonl')
    expect(t.pathFor('b')).toBeUndefined()
    expect(t.pathFor('c')).toBeUndefined()
  })

  it('records a path only when its filename belongs to THAT session id (the locatePi rule)', () => {
    // A hook POST naming session A but pointing at session B's file (a legacy/unverified token,
    // or a buggy extension) must not make the title reader and context-link read B as A.
    const { t } = setup()
    t.observe({ sessionId: 'sid-a', sessionFile: '/ok/2026_sid-b.jsonl' }, { trackPath: true })
    t.observe({ sessionId: 'sid-b', sessionFile: '/ok/2026_sid-b.jsonl' }, { trackPath: true })
    expect(t.pathFor('sid-a')).toBeUndefined()
    expect(t.pathFor('sid-b')).toBe('/ok/2026_sid-b.jsonl')
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

describe('pickPiTitle', () => {
  it('reads the --name/`/name` session_info record from a real transcript', () => {
    expect(pickPiTitle(fixture)).toBe('Fixture title')
  })

  it('takes the LATEST session_info when a mid-session /name overwrites an earlier one', () => {
    const lines = [
      '{"type":"session_info","id":"a","parentId":null,"timestamp":"t","name":"First"}',
      '{"type":"message","id":"b","parentId":"a","timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
      '{"type":"session_info","id":"c","parentId":"b","timestamp":"t","name":"Renamed"}'
    ]
    expect(pickPiTitle(lines)).toBe('Renamed')
  })

  it('is null for a session that was never named', () => {
    expect(
      pickPiTitle(['{"type":"session","version":3,"id":"x","timestamp":"t","cwd":"/tmp"}'])
    ).toBeNull()
  })

  it('tolerates a torn last line and an unknown record type', () => {
    const lines = [
      '{"type":"session_info","id":"a","parentId":null,"timestamp":"t","name":"Kept"}',
      '{"type":"a_future_record_type","stuff":123}',
      '{"type":"session_info","id":"b","parentId":"a","timestamp":"t","na' // torn
    ]
    expect(pickPiTitle(lines)).toBe('Kept')
  })
})

describe('linesFromPi', () => {
  it('renders a real session (user turn, tool call, tool result, final assistant text)', () => {
    expect(linesFromPi(fixture)).toEqual([
      'user: List the files in the current directory using your bash tool, then reply with just the word done.',
      '  $ bash ls',
      '  = sessions ', // tool output ends `sessions\n`; the trailing empty line survives the join, matching claude/codex's renderer
      'assistant: done'
    ])
  })

  it('renders in the same `role: text` / `  $ tool arg` / `  = result` shape the other agents use', () => {
    const lines = [
      '{"type":"message","id":"1","parentId":null,"timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}',
      '{"type":"message","id":"2","parentId":"1","timestamp":"t","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"edit","arguments":{"file_path":"/a/b.ts"}}]}}',
      '{"type":"message","id":"3","parentId":"2","timestamp":"t","message":{"role":"toolResult","toolCallId":"c1","toolName":"edit","content":[{"type":"text","text":"ok"}],"isError":false}}',
      '{"type":"message","id":"4","parentId":"3","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}'
    ]
    expect(linesFromPi(lines)).toEqual(['user: hello', '  $ edit /a/b.ts', '  = ok', 'assistant: done'])
  })

  it('renders nothing for session/model_change/thinking_level_change/session_info records', () => {
    const lines = [
      '{"type":"session","version":3,"id":"x","timestamp":"t","cwd":"/tmp"}',
      '{"type":"session_info","id":"a","parentId":null,"timestamp":"t","name":"Fixture title"}',
      '{"type":"model_change","id":"b","parentId":"a","timestamp":"t","provider":"openai-codex","modelId":"gpt-5.6-sol"}',
      '{"type":"thinking_level_change","id":"c","parentId":"b","timestamp":"t","thinkingLevel":"off"}'
    ]
    expect(linesFromPi(lines)).toEqual([])
  })

  it('tolerates a torn last line and an unknown record type: costs only that line', () => {
    const lines = [
      '{"type":"message","id":"1","parentId":null,"timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
      '{"type":"a_future_record_type","stuff":123}',
      '{"type":"message","id":"2","parentId":"1","timestamp":"t","message":{"role":"ass' // torn
    ]
    expect(linesFromPi(lines)).toEqual(['user: hi'])
  })

  it('accepts a whole buffer (string) exactly like an array of lines', () => {
    expect(linesFromPi(fixture)).toEqual(linesFromPi(fixture.split('\n')))
  })
})
