import { describe, expect, it } from 'vitest'
import { applyGrokHookSession, planGrokHookSession } from './grok-hook-session'

describe('planGrokHookSession', () => {
  it.each([
    ['PermissionDenied', 'permission_denied', 'permissiondenied', 'gs-before', undefined],
    ['StopCancelled', 'stop_cancelled', 'stopcancelled', 'gs-before', undefined],
    ['SubagentStart', 'subagent_start', 'subagentstart', 'gs-before', undefined],
    ['SubagentStop', 'subagent_stop', 'subagentstop', 'gs-before', undefined],
    ['PreCompact', 'pre_compact', 'precompact', 'gs-before', undefined],
    ['PostCompact', 'post_compact', 'postcompact', 'gs-after', undefined]
  ])(
    '%s produces the shell-independent session transition',
    (_name, hookEventName, event, sessionId, forgetSessionId) => {
      expect(
        planGrokHookSession({ hookEventName, sessionId, cwd: '/w/project' }, 'gs-before')
      ).toEqual({
        event,
        sessionId,
        cwd: '/w/project',
        forgetSessionId
      })
    }
  )

  it('NEVER retires a session on PostCompact, not even when the id differs', () => {
    // There used to be a branch here retiring the previous id, written on the belief that grok mints
    // a new one when it compacts. Measured on 1.0.13: it does not — the captured `pre_compact` and
    // `post_compact` carry the same `sessionId`. So the branch could not fire, and the belief came
    // from a comment rather than from data.
    //
    // This asserts the case that branch existed for — a DIFFERENT id — precisely because that is the
    // input under which the old code did something. Restoring it turns this red.
    expect(
      planGrokHookSession(
        { hook_event_name: 'post_compact', session_id: 'gs-after', cwd: '/w/project' },
        'gs-before'
      ).forgetSessionId
    ).toBeUndefined()
    // And the ordinary case, where the id repeats, is unchanged.
    expect(
      planGrokHookSession(
        { hook_event_name: 'post_compact', session_id: 'gs-current', cwd: '/w/project' },
        'gs-current'
      ).forgetSessionId
    ).toBeUndefined()
  })

  it('SessionEnd is the only event that retires an id', () => {
    expect(
      planGrokHookSession(
        { hook_event_name: 'session_end', session_id: 'gs-1', cwd: '/w/project' },
        'gs-1'
      ).forgetSessionId
    ).toBe('gs-1')
  })

  it.each(['desktop', 'server'])('%s applies all six new events through the same behavioral seam', (_shell) => {
    const cases = [
      ['permission_denied', 'gs-before', undefined],
      ['stop_cancelled', 'gs-before', undefined],
      ['subagent_start', 'gs-before', undefined],
      ['subagent_stop', 'gs-before', undefined],
      ['pre_compact', 'gs-before', undefined],
      ['post_compact', 'gs-after', undefined]
    ] as const

    for (const [hookEventName, sessionId, forgotten] of cases) {
      const sessions = new Map([['node-1', 'gs-before']])
      const remembered: [string, string][] = []
      const forgot: string[] = []

      applyGrokHookSession(
        'node-1',
        { hookEventName, sessionId, cwd: '/w/project' },
        sessions,
        {
          sessionsDir: '/grok/sessions',
          rememberSessionDir: (id, dir) => remembered.push([id, dir]),
          forgetSession: (id) => {
            if (id) forgot.push(id)
          }
        }
      )

      expect(sessions.get('node-1'), hookEventName).toBe(sessionId)
      expect(remembered, hookEventName).toEqual([
        [sessionId, `/grok/sessions/${encodeURIComponent('/w/project')}/${sessionId}`]
      ])
      expect(forgot, hookEventName).toEqual(forgotten ? [forgotten] : [])
    }
  })
})
