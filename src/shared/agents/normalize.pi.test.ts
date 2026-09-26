import { describe, expect, it } from 'vitest'
import { normalizeFor, normalizePi } from './normalize'

// The payloads below are the envelope nodeterm's OWN pi extension posts (core/agents/hooks/pi.ts):
// pi has no hook-file mechanism, so the event names are pi's extension-API names, measured on pi
// 0.84.1 with a probe extension (session_start → agent_start → turn_start → … → agent_settled →
// session_shutdown, one run with a bash tool call; docs/pi-agent.md).
const env = (payload: Record<string, unknown>) => ({ nodeId: 'n1', agentId: 'pi', payload })
const sid = '01a0dd59-8ab6-75f1-8f94-4a33a3d4775d'

describe('normalizePi', () => {
  it('session_start is a session-start lifecycle event carrying the session id', () => {
    expect(normalizePi(env({ event: 'session_start', sessionId: sid, reason: 'startup' }))).toEqual({
      nodeId: 'n1', agentId: 'pi', sessionId: sid, kind: 'session', sessionPhase: 'start'
    })
  })

  it('agent_start opens a turn (working + newTurn); tool_execution_start keeps it working', () => {
    expect(normalizePi(env({ event: 'agent_start', sessionId: sid }))).toMatchObject({
      kind: 'state', state: 'working', newTurn: true
    })
    const tool = normalizePi(env({ event: 'tool_execution_start', sessionId: sid, toolName: 'bash' }))
    expect(tool).toMatchObject({ kind: 'state', state: 'working' })
    expect(tool?.newTurn).toBeUndefined()
  })

  it('agent_settled ends the turn; the final stopReason picks clean / errored / interrupted', () => {
    expect(normalizePi(env({ event: 'agent_settled', sessionId: sid, stopReason: 'stop', lastMessage: 'DONE' })))
      .toEqual({ nodeId: 'n1', agentId: 'pi', sessionId: sid, kind: 'state', state: 'done', lastMessage: 'DONE' })
    expect(normalizePi(env({ event: 'agent_settled', sessionId: sid, stopReason: 'error' })))
      .toMatchObject({ state: 'done', errored: true })
    expect(normalizePi(env({ event: 'agent_settled', sessionId: sid, stopReason: 'aborted' })))
      .toMatchObject({ state: 'done', interrupted: true })
  })

  it('an unknown stopReason is still a clean done (closed set, never a guessed error)', () => {
    const ev = normalizePi(env({ event: 'agent_settled', sessionId: sid, stopReason: 'something-new' }))
    expect(ev).toMatchObject({ state: 'done' })
    expect(ev?.errored).toBeUndefined()
    expect(ev?.interrupted).toBeUndefined()
  })

  it('session_shutdown ends the session; session_info_changed carries the title', () => {
    expect(normalizePi(env({ event: 'session_shutdown', sessionId: sid }))).toMatchObject({
      kind: 'session', sessionPhase: 'end'
    })
    expect(normalizePi(env({ event: 'session_info_changed', sessionId: sid, name: 'Refactor billing' })))
      .toEqual({ nodeId: 'n1', agentId: 'pi', sessionId: sid, kind: 'session', sessionTitle: 'Refactor billing' })
  })

  it('ignores an empty title, unknown events and a non-string session id', () => {
    expect(normalizePi(env({ event: 'session_info_changed', sessionId: sid, name: '  ' }))).toBeNull()
    expect(normalizePi(env({ event: 'message_update', sessionId: sid }))).toBeNull()
    expect(normalizePi(env({ event: 'agent_start', sessionId: 42 }))?.sessionId).toBeUndefined()
  })

  it('is what normalizeFor dispatches to for agentId pi', () => {
    expect(normalizeFor('pi', env({ event: 'agent_start', sessionId: sid }))).toMatchObject({
      agentId: 'pi', state: 'working'
    })
  })
})
