import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/types'
import { CONTROL_UNSUPPORTED_ERROR } from './control-unsupported'
import { SETTINGS_SET_UNSUPPORTED_MESSAGE, serverSettingsControl, type ServerSettingsControlDeps } from './settings-control'

const deps = (over: Partial<ServerSettingsControlDeps> = {}): ServerSettingsControlDeps => ({
  persistedCanvases: () => [
    { id: 'p1', nodes: [{ id: 'term-a' }] },
    { id: 'p2', nodes: [{ id: 'term-b' }] }
  ],
  capabilityProjectFor: (id) =>
    id === 'p1' ? { agentMessaging: true, capabilityAck: { agentMessaging: 'kept' } } : {},
  projectName: (id) => (id === 'p1' ? 'api' : 'web'),
  settings: () => DEFAULT_SETTINGS,
  ...over
})

describe('Server Edition settings: reads work, changes are refused by name', () => {
  it('--set is refused permanently — there is no human here to confirm it', () => {
    for (const args of [
      { set: 'agentMessaging', value: 'true' },
      { set: 'gridSize', value: '32' }
    ]) {
      const r = serverSettingsControl(deps(), 'term-a', args)
      expect(r).toEqual({ ok: false, error: CONTROL_UNSUPPORTED_ERROR, message: SETTINGS_SET_UNSUPPORTED_MESSAGE })
    }
    expect(SETTINGS_SET_UNSUPPORTED_MESSAGE).toContain('do not retry')
  })

  it('--get reads the GRANT from the same store view the delivery gate uses', () => {
    const r = serverSettingsControl(deps(), 'term-a', { get: 'agentMessaging' })
    expect(r).toMatchObject({ ok: true })
    expect(r.message).toContain('on (this project)')
    expect(r.message).toContain('project "api"')
    const off = serverSettingsControl(
      deps({ capabilityProjectFor: () => ({ agentMessaging: true }) }),
      'term-a',
      { get: 'agentMessaging' }
    )
    expect(off.message).toContain('has not confirmed')
  })

  it('a listing answers every allowlisted key', () => {
    const r = serverSettingsControl(deps(), 'term-a', {})
    for (const key of ['agentMessaging', 'snapToGrid', 'gridSize', 'defaultNodeWidth', 'defaultNodeHeight']) {
      expect(r.message).toContain(key)
    }
  })

  it('--project may only name the caller’s own project here', () => {
    expect(serverSettingsControl(deps(), 'term-a', { get: 'agentMessaging', project: 'p1' }).ok).toBe(true)
    expect(serverSettingsControl(deps(), 'term-a', { get: 'agentMessaging', project: 'p2' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('project-target-refused')
    })
  })
})
