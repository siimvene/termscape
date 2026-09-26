import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { useAgentStatus } from '../state/agentStatus'

// Codex reports SessionStart as `kind:'state'`, `state:'working'`, `sessionPhase:'start'`
// (normalizeCodex), not as a `kind:'session'` event. The agent-status mirror honours the marker
// (agent-status-mirror.ts reduceEffectiveEntry); the canvas listener must too, or a relaunch within
// DONE_HOLDOFF_MS of `done` is dropped here while the phone, reading the mirror, shows it working.
//
// Canvas is impractical to mount in jsdom, so this follows status-lifecycle.test.ts: the store
// CONTRACT the fix relies on is exercised directly, and a source guard pins the wiring.

describe('a session start gets past the done-holdoff (store contract)', () => {
  afterEach(() => {
    for (const id of Object.keys(useAgentStatus.getState().byId)) useAgentStatus.getState().remove(id)
  })

  it('a bare `working` right after `done` is held off (the behaviour the start marker must bypass)', () => {
    const s = useAgentStatus.getState()
    s.setState('node-c', 'done', 'codex')
    s.setState('node-c', 'working', 'codex')
    expect(useAgentStatus.getState().byId['node-c']?.state).toBe('done')
  })

  it('the session-start reset, then `working`, lands `working` inside the holdoff window', () => {
    const s = useAgentStatus.getState()
    s.setState('node-c', 'done', 'codex')
    // What applySessionStart does first: clear the live state, exactly as a `session` start does.
    s.setState('node-c', undefined, 'codex')
    s.setState('node-c', 'working', 'codex')
    expect(useAgentStatus.getState().byId['node-c']?.state).toBe('working')
  })
})

describe('Canvas status listener wiring (source guard)', () => {
  const src = readFileSync(join(__dirname, 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')
  // Each end marker is searched from its own start: both strings also occur earlier in the file.
  const between = (start: string, end: string): string => {
    const from = src.indexOf(start)
    expect(from, start).toBeGreaterThan(-1)
    const to = src.indexOf(end, from)
    expect(to, end).toBeGreaterThan(from)
    return src.slice(from, to)
  }
  const stateCase = between("case 'state': {", "case 'subagent-start':")
  const sessionCase = between("case 'session':", '// `--auto-close yes`')

  it('the `state` case runs the session-start reset for a start-phase event, before setState', () => {
    const reset = stateCase.indexOf("if (e.sessionPhase === 'start') applySessionStart()")
    expect(reset).toBeGreaterThan(-1)
    expect(reset).toBeLessThan(stateCase.indexOf('cs.setState('))
  })

  it('both cases share ONE reset definition (no second copy of the start rule)', () => {
    expect(sessionCase).toContain('applySessionStart()')
    expect(src.match(/cs\.setHibernated\(e\.nodeId, false\)/g) ?? []).toHaveLength(1)
    expect(src.match(/cs\.setPaused\(e\.nodeId, false\)/g) ?? []).toHaveLength(1)
  })
})
