// @vitest-environment jsdom
// The SYSTEM account (~/.claude) was the one Claude login with no affordance in Settings →
// Accounts: managed rows had "Sign in again", the system row only a label and an email, and the
// only in-app path to `claude /login` for it was the usage popover's "⇄ Switch account…". So a
// user who read the row as "the account I can't manage here" went to a shell — and a stale
// identity file then had nothing in the app that could correct it. These pin that the row now
// carries the same login affordance, on the same event the popover already fires.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { AccountsSection } from './AccountsSection'
import { useSettings } from '../../../state/settings'
import { useSystemAccount } from '../../../state/systemAccount'
import { DEFAULT_SETTINGS } from '@shared/types'

let switches = 0
const onSwitch = (): void => {
  switches++
}
let refresh: ReturnType<typeof vi.fn>

function render(): { host: HTMLElement; root: Root } {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, claudeAccounts: [] } })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(<AccountsSection isActive />)
  })
  return { host, root }
}

const button = (host: HTMLElement, text: string): HTMLButtonElement | undefined =>
  Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === text)

beforeEach(() => {
  document.body.innerHTML = ''
  switches = 0
  window.addEventListener('nodeterm:switch-system-account', onSwitch)
  // Never resolves: the interesting window is "a switch is in flight".
  refresh = vi.fn(() => new Promise(() => {}))
  useSystemAccount.setState({ email: 'old@example.test', loaded: true })
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    usage: { fetch: async () => ({ email: 'old@example.test' }), refresh },
    ssh: { list: async () => [] },
    codexAccounts: { systemIdentity: async () => null, identity: async () => null },
    claudeAccounts: { waitLogin: async () => null, cancelWaitLogin: async () => {} },
    settings: { save: async () => {} }
  }
})

afterEach(() => {
  window.removeEventListener('nodeterm:switch-system-account', onSwitch)
  useSettings.setState({ settings: DEFAULT_SETTINGS })
  useSystemAccount.setState({ email: null, loaded: false, switching: false })
})

describe('AccountsSection — the system account is a normal row', () => {
  it('offers "Sign in / switch" on the system row when an identity is known', () => {
    const { host, root } = render()
    expect(button(host, 'Sign in / switch')).toBeTruthy()
    act(() => root.unmount())
  })

  it('offers plain "Sign in" when no identity is known', () => {
    useSystemAccount.setState({ email: null, loaded: true })
    const { host, root } = render()
    expect(button(host, 'Sign in')).toBeTruthy()
    act(() => root.unmount())
  })

  it('fires the same switch-system-account event the usage popover fires, then waits honestly', async () => {
    const { host, root } = render()
    await act(async () => {
      button(host, 'Sign in / switch')!.click()
    })
    expect(switches).toBe(1)
    expect(host.textContent).toContain('waiting for login…')
    expect(button(host, 'Sign in / switch')!.disabled).toBe(true)
    act(() => root.unmount())
  })

  // The wait is a process singleton in the store, not a component-local flag. A second attempt
  // while one is in flight must not spawn a second `claude /login` node + a second poll against
  // the same ~/.claude — it returns 'busy' and dispatches nothing.
  it('refuses a second switch while one is in flight: no second event', async () => {
    void useSystemAccount.getState().startSwitch()
    expect(switches).toBe(1)
    const second = await useSystemAccount.getState().startSwitch()
    expect(second).toBe('busy')
    expect(switches).toBe(1)
  })

  // The switch closes the Settings overlay, which unmounts this section. Because the flag lives in
  // the store, a reopened Settings still shows the disabled button and the waiting line for the
  // whole in-flight window — the reopened row cannot start a second login.
  it('survives the overlay closing: after unmount + remount mid-flight, still disabled and waiting', async () => {
    const first = render()
    await act(async () => {
      button(first.host, 'Sign in / switch')!.click()
    })
    expect(switches).toBe(1)
    // Overlay closes → section unmounts while the switch is still in flight.
    act(() => first.root.unmount())
    // Reopen Settings → a fresh AccountsSection reads the same store.
    const again = render()
    expect(again.host.textContent).toContain('waiting for login…')
    expect(button(again.host, 'Sign in / switch')!.disabled).toBe(true)
    expect(switches).toBe(1)
    act(() => again.root.unmount())
  })
})
