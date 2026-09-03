// @vitest-environment jsdom
// Defect: an account that LOSES its credential had no way back. Every login affordance in this
// section — the login-node dispatch, the "waiting for login…" line and the Retry button — was
// gated on `account.pending`, and a settled row printed only its email. So when an OAuth
// credential expired (observed on a real managed account), remove-and-re-add was the only path,
// which throws away the config dir, the transcripts and the colour with it.
//
// These pin the affordance itself and the one subtlety that makes it work: capture is
// "`.claude.json` has an oauthAccount", which an expired-but-previously-logged-in dir already
// satisfies — so the settled path must open the login terminal with NO grace, or the race
// resolves off the stale identity file and the button visibly does nothing.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { AccountsSection } from './AccountsSection'
import { useSettings } from '../../../state/settings'
import { DEFAULT_SETTINGS, type ClaudeAccount } from '@shared/types'

const settled: ClaudeAccount = { id: 'a1', label: 'PLG', email: 'someone@example.test', createdAt: 0 }
const pending: ClaudeAccount = { id: 'a2', label: 'New account', pending: true, createdAt: 0 }

let waitLogin: ReturnType<typeof vi.fn>
let loginNodes: string[]
// Kept as a named handler so it can be removed again: left attached, each test's listener would
// also record the next test's dispatch and the counts would read as duplicate login nodes.
const onLoginNode = (e: Event): void => {
  loginNodes.push((e as CustomEvent<{ accountId: string }>).detail.accountId)
}

function render(accounts: ClaudeAccount[]): { host: HTMLElement; root: Root } {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, claudeAccounts: accounts } })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(<AccountsSection isActive />)
  })
  return { host, root }
}

const buttons = (host: HTMLElement): HTMLButtonElement[] =>
  Array.from(host.querySelectorAll('button'))

const button = (host: HTMLElement, text: string): HTMLButtonElement | undefined =>
  buttons(host).find((b) => (b.textContent ?? '').trim() === text)

/** Let the 0 ms grace timer and the awaited login race turn over. */
const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20))
  })
}

beforeEach(() => {
  document.body.innerHTML = ''
  loginNodes = []
  // Never resolves by default: the interesting window is "a login is in flight", and a resolved
  // capture would end it before the assertions run.
  waitLogin = vi.fn(() => new Promise(() => {}))
  window.addEventListener('nodeterm:add-account-login', onLoginNode)
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    usage: { fetch: async () => null },
    ssh: { list: async () => [] },
    codexAccounts: { systemIdentity: async () => null, identity: async () => null },
    claudeAccounts: { waitLogin, cancelWaitLogin: async () => {} },
    // A settings write schedules a real coalesced save; an absent `save` throws inside that timer
    // and poisons whatever run shares the worker (see AccountsSection.color.test.tsx).
    settings: { save: async () => {} }
  }
})

afterEach(() => {
  window.removeEventListener('nodeterm:add-account-login', onLoginNode)
  useSettings.setState({ settings: DEFAULT_SETTINGS })
})

describe('AccountsSection — signing a settled account back in', () => {
  it('offers "Sign in again" on a settled account', () => {
    const { host, root } = render([settled])
    expect(button(host, 'Sign in again')).toBeTruthy()
    expect(button(host, 'Retry login')).toBeUndefined()
    root.unmount()
  })

  // The pending row keeps its own wording and its own timing (the capture-first grace); the new
  // affordance must not swallow it.
  it('keeps "Retry login" on a pending account, and does not offer the settled wording', () => {
    const { host, root } = render([pending])
    expect(button(host, 'Retry login')).toBeTruthy()
    expect(button(host, 'Sign in again')).toBeUndefined()
    root.unmount()
  })

  it('gives each row the affordance its own state earns', () => {
    const { host, root } = render([settled, pending])
    expect(button(host, 'Sign in again')).toBeTruthy()
    expect(button(host, 'Retry login')).toBeTruthy()
    root.unmount()
  })

  // The heart of it: the terminal must actually open. With the Retry grace this row would sit
  // there while the race resolved off its stale `.claude.json`, and nothing would ever appear.
  it('opens the login terminal for the settled account with no grace', async () => {
    const { host, root } = render([settled])
    await act(async () => {
      button(host, 'Sign in again')!.click()
    })
    await settle()
    expect(waitLogin).toHaveBeenCalledWith('a1', undefined)
    expect(loginNodes).toEqual(['a1'])
    root.unmount()
  })

  it('does NOT open a terminal for a pending Retry inside its grace window', async () => {
    const { host, root } = render([pending])
    await act(async () => {
      button(host, 'Retry login')!.click()
    })
    await settle()
    expect(waitLogin).toHaveBeenCalled()
    expect(loginNodes).toEqual([]) // 5 s grace has not elapsed
    root.unmount()
  })

  // Not stranding the row: while the login is in flight the settled row says so and cannot be
  // double-fired, and it leaves that state on the honest outcome rather than latching.
  it('shows the in-flight state on a settled row and disables the button', async () => {
    const { host, root } = render([settled])
    await act(async () => {
      button(host, 'Sign in again')!.click()
    })
    await settle()
    expect(host.textContent).toContain('waiting for login…')
    expect(button(host, 'Sign in again')!.disabled).toBe(true)
    root.unmount()
  })

  it('reports a failed capture on a settled row and re-enables the button', async () => {
    waitLogin = vi.fn(async () => null)
    ;(window as unknown as { nodeTerminal: { claudeAccounts: unknown } }).nodeTerminal.claudeAccounts =
      { waitLogin, cancelWaitLogin: async () => {} }
    const { host, root } = render([settled])
    await act(async () => {
      button(host, 'Sign in again')!.click()
    })
    await settle()
    expect(host.textContent).toContain('login not captured')
    expect(button(host, 'Sign in again')!.disabled).toBe(false)
    root.unmount()
  })
})
