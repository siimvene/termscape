import { describe, expect, it, vi } from 'vitest'
import type { ClaudeAccount } from '@shared/types'
import {
  planAccountSwitch,
  executeAccountSwitch,
  type AccountSwitchState,
  type AccountSwitchEffects,
  type CopyOutcome
} from './accountSwitch'

const base: AccountSwitchState = {
  agentId: 'claude',
  source: 'local',
  ssh: false,
  sessionId: 'sess-1',
  accountId: undefined, // currently on the system account
  state: 'done',
  cwd: '/repo'
}

const work: ClaudeAccount = { id: 'work', label: 'Work', createdAt: 0 }
const home: ClaudeAccount = { id: 'home', label: 'Home', createdAt: 0 }
const pending: ClaudeAccount = { id: 'new', label: 'new', createdAt: 0, pending: true }
const remote: ClaudeAccount = { id: 'box', label: 'Box', host: 'u@box', createdAt: 0 }
const accounts = [work, home, pending, remote]

describe('planAccountSwitch — refusal matrix', () => {
  it('accepts a system → managed local switch on an idle claude node', () => {
    expect(planAccountSwitch(base, 'work', accounts)).toEqual({
      ok: true,
      plan: { sourceAccountId: undefined, targetAccountId: 'work', sessionId: 'sess-1', cwd: '/repo' }
    })
  })

  it('accepts a managed → system switch (target undefined/empty)', () => {
    const node = { ...base, accountId: 'work' }
    expect(planAccountSwitch(node, undefined, accounts)).toMatchObject({
      ok: true,
      plan: { sourceAccountId: 'work', targetAccountId: undefined }
    })
    expect(planAccountSwitch(node, '', accounts)).toMatchObject({ ok: true })
  })

  it('accepts a claude-base custom agent (capabilityAgentId resolves to claude)', () => {
    // capabilityAgentId of an unknown id is itself; an unknown id is NOT claude, so this pins that
    // only a claude-capability node is accepted. A builtin 'claude' passes above.
    expect(planAccountSwitch({ ...base, agentId: 'codex' }, 'work', accounts)).toEqual({
      ok: false,
      reason: 'not-claude'
    })
  })

  it('refuses a non-claude node', () => {
    expect(planAccountSwitch({ ...base, agentId: 'gemini' }, 'work', accounts)).toEqual({
      ok: false,
      reason: 'not-claude'
    })
    expect(planAccountSwitch({ ...base, agentId: undefined }, 'work', accounts)).toEqual({
      ok: false,
      reason: 'not-claude'
    })
  })

  it('refuses a relay tab and an SSH-project node (other machines dirs)', () => {
    expect(planAccountSwitch({ ...base, source: 'relay' }, 'work', accounts)).toEqual({
      ok: false,
      reason: 'not-local'
    })
    expect(planAccountSwitch({ ...base, source: 'server' }, 'work', accounts)).toEqual({
      ok: false,
      reason: 'not-local'
    })
    expect(planAccountSwitch({ ...base, ssh: true }, 'work', accounts)).toEqual({
      ok: false,
      reason: 'not-local'
    })
  })

  it.each(['working', 'blocked'])('refuses a busy session (%s)', (state) => {
    expect(planAccountSwitch({ ...base, state }, 'work', accounts)).toEqual({
      ok: false,
      reason: 'busy'
    })
  })

  it('refuses when no resumable session id / cwd is known', () => {
    expect(planAccountSwitch({ ...base, sessionId: undefined }, 'work', accounts)).toEqual({
      ok: false,
      reason: 'no-session'
    })
    expect(planAccountSwitch({ ...base, sessionId: '   ' }, 'work', accounts)).toEqual({
      ok: false,
      reason: 'no-session'
    })
    // cwd is deliberately NOT required (the copy's scan leg resolves strictly by sessionId):
    // a cwd-less inline-canvas node must plan fine, with '' handed to the copy.
    const d = planAccountSwitch({ ...base, cwd: undefined }, 'work', accounts)
    expect(d.ok && d.plan.cwd === '').toBe(true)
  })

  it('refuses a HIBERNATED (Eco-slept) node — the pane holds a bare shell, terminate can never pass', () => {
    expect(planAccountSwitch({ ...base, hibernated: true }, 'work', accounts)).toEqual({
      ok: false,
      reason: 'hibernated'
    })
  })

  it('refuses a forged SOURCE account id (rides the git-shared project.json)', () => {
    expect(planAccountSwitch({ ...base, accountId: '../evil' }, 'work', accounts)).toEqual({
      ok: false,
      reason: 'account-unavailable'
    })
  })

  it('refuses a no-op switch to the current account (system and managed)', () => {
    expect(planAccountSwitch(base, undefined, accounts)).toEqual({
      ok: false,
      reason: 'same-account'
    })
    expect(planAccountSwitch({ ...base, accountId: 'work' }, 'work', accounts)).toEqual({
      ok: false,
      reason: 'same-account'
    })
  })

  it('refuses a missing, remote, or forged target id — never falls back', () => {
    expect(planAccountSwitch(base, 'gone', accounts)).toEqual({
      ok: false,
      reason: 'account-unavailable'
    })
    expect(planAccountSwitch(base, 'box', accounts)).toEqual({
      ok: false,
      reason: 'account-unavailable'
    })
    // A path-traversal / hostile id is refused before it can be interpolated handler-side.
    expect(planAccountSwitch(base, '../../etc', accounts)).toEqual({
      ok: false,
      reason: 'account-unavailable'
    })
    expect(planAccountSwitch(base, 'a/b', accounts)).toEqual({
      ok: false,
      reason: 'account-unavailable'
    })
  })

  it('refuses a target account still pending login', () => {
    expect(planAccountSwitch(base, 'new', accounts)).toEqual({
      ok: false,
      reason: 'account-pending'
    })
  })
})

// A recording effects harness: notes call order and lets each effect's result be scripted.
function harness(over: Partial<{ copy: CopyOutcome; killed: boolean }> = {}): {
  order: string[]
  effects: AccountSwitchEffects
} {
  const order: string[] = []
  const copy = over.copy ?? { ok: true, copied: 7 }
  const killed = over.killed ?? true
  return {
    order,
    effects: {
      copyTranscript: vi.fn(async () => {
        order.push('copy')
        return copy
      }),
      terminateForeground: vi.fn(async () => {
        order.push('terminate')
        return killed
      }),
      recycle: vi.fn(() => order.push('recycle')),
      commit: vi.fn(() => order.push('commit'))
    }
  }
}

describe('executeAccountSwitch — ordered action plan', () => {
  it('copies BEFORE any destructive step, then terminate → recycle → commit', async () => {
    const { order, effects } = harness()
    const out = await executeAccountSwitch(effects)
    expect(out).toEqual({ ok: true, copied: 7 })
    // The SECOND copy is the post-terminate flush pickup (consort finding): best-effort, after
    // the SIGTERM so the CLI's shutdown tail is included, before anything is recycled.
    expect(order).toEqual(['copy', 'terminate', 'copy', 'recycle', 'commit'])
  })

  it('mutates NOTHING when the copy fails (no terminate, no recycle, no commit)', async () => {
    const { order, effects } = harness({ copy: { ok: false, reason: 'not-found' } })
    const out = await executeAccountSwitch(effects)
    expect(out).toEqual({ ok: false, reason: 'copy-failed', copy: 'not-found' })
    expect(order).toEqual(['copy'])
    expect(effects.terminateForeground).not.toHaveBeenCalled()
    expect(effects.recycle).not.toHaveBeenCalled()
    expect(effects.commit).not.toHaveBeenCalled()
  })

  it('aborts after a refused SIGTERM — copy ran, but nothing is killed or committed', async () => {
    const { order, effects } = harness({ killed: false })
    const out = await executeAccountSwitch(effects)
    expect(out).toEqual({ ok: false, reason: 'terminate-failed' })
    expect(order).toEqual(['copy', 'terminate'])
    expect(effects.recycle).not.toHaveBeenCalled()
    expect(effects.commit).not.toHaveBeenCalled()
  })
})
