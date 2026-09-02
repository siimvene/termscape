import { describe, it, expect } from 'vitest'
import { sanitizePendingLaunch } from './pending-launch'

describe('sanitizePendingLaunch — project.json / peer input is hostile', () => {
  it('keeps a well-formed launch, known fields only', () => {
    expect(sanitizePendingLaunch({ after: ['a', 'b'], command: 'claude --session-id x', extra: 1 })).toEqual({
      after: ['a', 'b'],
      command: 'claude --session-id x'
    })
    expect(sanitizePendingLaunch({ after: [], command: 'x', awaitSetupGroup: 'g1' })).toEqual({
      after: [],
      command: 'x',
      awaitSetupGroup: 'g1'
    })
  })
  it('drops an empty or missing command — the launch that could never fire but blocked resume', () => {
    expect(sanitizePendingLaunch({ after: [], command: '' })).toBeUndefined()
    expect(sanitizePendingLaunch({ after: [], command: '   ' })).toBeUndefined()
    expect(sanitizePendingLaunch({ after: [] })).toBeUndefined()
  })
  it('drops a malformed `after` — the shape that crashed `p.after.every`', () => {
    expect(sanitizePendingLaunch({ after: 'a', command: 'x' })).toBeUndefined()
    expect(sanitizePendingLaunch({ after: [1], command: 'x' })).toBeUndefined()
    expect(sanitizePendingLaunch({ after: [''], command: 'x' })).toBeUndefined()
    expect(sanitizePendingLaunch({ after: null, command: 'x' })).toBeUndefined()
  })
  it('non-objects are inert', () => {
    for (const v of [undefined, null, 'x', 1, true, []]) expect(sanitizePendingLaunch(v)).toBeUndefined()
  })
})
