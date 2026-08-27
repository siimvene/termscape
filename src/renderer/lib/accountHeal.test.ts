import { describe, it, expect, vi } from 'vitest'
import type { ClaudeAccount } from '@shared/types'
import {
  healedAccount,
  healPendingAccounts,
  raceLoginCapture,
  healPendingAccountsOnLaunch,
  RETRY_GRACE_MS
} from './accountHeal'

const acc = (over: Partial<ClaudeAccount> = {}): ClaudeAccount => ({
  id: 'a1',
  label: 'New account',
  pending: true,
  createdAt: 0,
  ...over
})

describe('healedAccount (label adoption)', () => {
  it('adopts the email when the label is the placeholder', () => {
    expect(healedAccount(acc({ label: 'New account' }), 'me@x.io')).toMatchObject({
      email: 'me@x.io',
      label: 'me@x.io',
      pending: false
    })
  })
  it('adopts the email when the label is empty', () => {
    expect(healedAccount(acc({ label: '' }), 'me@x.io').label).toBe('me@x.io')
  })
  it('keeps a user-chosen label', () => {
    expect(healedAccount(acc({ label: 'work' }), 'me@x.io')).toMatchObject({
      email: 'me@x.io',
      label: 'work',
      pending: false
    })
  })
})

describe('healPendingAccounts', () => {
  it('flips only captured local pending accounts', async () => {
    const accounts = [acc({ id: 'a1' }), acc({ id: 'a2' })]
    const waitLogin = vi
      .fn()
      .mockImplementation(async (id: string) => (id === 'a1' ? { email: 'a1@x.io' } : null))
    let current = accounts
    const applyAccounts = (fn: (a: ClaudeAccount[]) => ClaudeAccount[]): void => {
      current = fn(current)
    }
    await healPendingAccounts(accounts, waitLogin, applyAccounts)
    expect(current.find((a) => a.id === 'a1')).toMatchObject({ pending: false, email: 'a1@x.io' })
    // a2 timed out: untouched.
    expect(current.find((a) => a.id === 'a2')).toMatchObject({ pending: true })
  })

  it('never touches remote accounts (host set) — waitLogin is not even called for them', async () => {
    const accounts = [acc({ id: 'r1', host: 'me@host' })]
    const waitLogin = vi.fn().mockResolvedValue({ email: 'x@x.io' })
    const apply = vi.fn()
    await healPendingAccounts(accounts, waitLogin, apply)
    expect(waitLogin).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })

  it('refreshes a STALE email on a non-pending local record (label untouched)', async () => {
    // The user re-logged the dir under another identity; the record must catch up.
    const accounts = [acc({ id: 'plg', pending: false, label: 'PLG', email: 'old@piletilevi.ee' })]
    const waitLogin = vi.fn().mockResolvedValue({ email: 'new@plgmoments.com' })
    const apply = vi.fn()
    await healPendingAccounts(accounts, waitLogin, apply)
    const out = apply.mock.calls[0][0](accounts)
    expect(out[0]).toMatchObject({ email: 'new@plgmoments.com', label: 'PLG', pending: false })
  })

  it('non-pending record whose email already matches is left alone', async () => {
    const accounts = [acc({ id: 'ok', pending: false, label: 'X', email: 'same@x.io' })]
    const apply = vi.fn()
    await healPendingAccounts(accounts, vi.fn().mockResolvedValue({ email: 'same@x.io' }), apply)
    expect(apply).not.toHaveBeenCalled()
  })

  it('a REJECTED waitLogin is treated as null — one bad account never kills the heal', async () => {
    const accounts = [acc({ id: 'boom' }), acc({ id: 'good' })]
    const waitLogin = vi.fn(async (id: string) => {
      if (id === 'boom') throw new Error('stubbed away')
      return { email: 'good@x.io' }
    })
    const apply = vi.fn()
    await healPendingAccounts(accounts, waitLogin, apply)
    expect(apply).toHaveBeenCalledTimes(1)
    const out = apply.mock.calls[0][0](accounts)
    expect(out.find((a: { id: string }) => a.id === 'good')).toMatchObject({ pending: false })
  })

  it('leaves a pending-without-login account alone', async () => {
    const accounts = [acc({ id: 'a1' })]
    const apply = vi.fn()
    await healPendingAccounts(accounts, vi.fn().mockResolvedValue(null), apply)
    expect(apply).not.toHaveBeenCalled()
  })
})

// A hand-driven clock: setTimer records the callback, the test fires it explicitly.
function fakeClock() {
  let stored: (() => void) | null = null
  let cleared = false
  return {
    setTimer: (fn: () => void) => {
      stored = fn
      return 1
    },
    clearTimer: () => {
      cleared = true
    },
    fire: () => stored?.(),
    get cleared() {
      return cleared
    }
  }
}

describe('raceLoginCapture', () => {
  it('capture BEFORE grace ⇒ no login node dispatched, timer cleared', async () => {
    const clock = fakeClock()
    const dispatchLoginNode = vi.fn()
    const result = await raceLoginCapture({
      waitLogin: () => Promise.resolve({ email: 'me@x.io' }),
      dispatchLoginNode,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })
    expect(result).toEqual({ email: 'me@x.io' })
    expect(dispatchLoginNode).not.toHaveBeenCalled()
    expect(clock.cleared).toBe(true)
  })

  it('capture AFTER grace ⇒ exactly one login node dispatched', async () => {
    const clock = fakeClock()
    const dispatchLoginNode = vi.fn()
    let resolveWait!: (v: { email: string } | null) => void
    const promise = raceLoginCapture({
      waitLogin: () => new Promise((r) => (resolveWait = r)),
      dispatchLoginNode,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })
    clock.fire() // grace elapsed before capture
    resolveWait({ email: 'late@x.io' })
    const result = await promise
    expect(result).toEqual({ email: 'late@x.io' })
    expect(dispatchLoginNode).toHaveBeenCalledTimes(1)
  })

  it('timeout ⇒ login node dispatched and result is null (row: not captured)', async () => {
    const clock = fakeClock()
    const dispatchLoginNode = vi.fn()
    let resolveWait!: (v: { email: string } | null) => void
    const promise = raceLoginCapture({
      waitLogin: () => new Promise((r) => (resolveWait = r)),
      dispatchLoginNode,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })
    clock.fire()
    resolveWait(null)
    expect(await promise).toBeNull()
    expect(dispatchLoginNode).toHaveBeenCalledTimes(1)
  })

  it('defaults the grace window to RETRY_GRACE_MS', async () => {
    const setTimer = vi.fn().mockReturnValue(1)
    await raceLoginCapture({
      waitLogin: () => Promise.resolve(null),
      dispatchLoginNode: vi.fn(),
      setTimer,
      clearTimer: vi.fn()
    })
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), RETRY_GRACE_MS)
  })
})

describe('healPendingAccountsOnLaunch (double-run latch)', () => {
  it('runs once; a second call is a no-op (dev HMR remount)', async () => {
    const whenReady = vi.fn().mockResolvedValue(undefined)
    const getAccounts = vi.fn().mockReturnValue([])
    const deps = { whenReady, getAccounts, waitLogin: vi.fn(), applyAccounts: vi.fn() }
    healPendingAccountsOnLaunch(deps)
    healPendingAccountsOnLaunch(deps)
    await Promise.resolve()
    expect(whenReady).toHaveBeenCalledTimes(1)
    expect(getAccounts).toHaveBeenCalledTimes(1)
  })
})
