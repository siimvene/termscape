// @vitest-environment jsdom
// "Add Codex account" is DESKTOP-ONLY, and a browser tab (Server Edition) says why.
//
// The codex-login intent (`PtyCreateOptions.codexLogin`) closed the credential-OVERWRITE race: a
// login node whose settings save lost to the pty spawn now refuses rather than writing the host's
// system `~/.codex`. It did NOT close the account-ROW-LOSS race: every Server Edition tab flushes a
// FULL settings snapshot (`settings-store.ts` `save` replaces, it does not merge), so two tabs
// adding concurrently leave one of them with a managed home minted on disk and NO settings row
// pointing at it — a credential-bearing directory nothing can list, switch to, or remove. Until
// the store merges per account, the browser must not offer the button at all.
//
// MUTATION: drop the `isBrowserRuntime()` branch around the button in AccountsSection.tsx → the
// first test finds a button and reddens.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useSettings } from '../../../state/settings'
import { DEFAULT_SETTINGS } from '@shared/types'

let browser = false
vi.mock('../../../bridge/runtime', () => ({
  isBrowserRuntime: () => browser,
  markBrowserRuntime: () => {}
}))

const { AccountsSection } = await import('./AccountsSection')

function render(): { host: HTMLElement; root: Root } {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, codexAccounts: [] }, hydrated: true })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(<AccountsSection isActive />)
  })
  return { host, root }
}

const addCodexButton = (host: HTMLElement): HTMLButtonElement | undefined =>
  Array.from(host.querySelectorAll('button')).find((b) =>
    /add codex account/i.test((b.textContent ?? '').trim())
  )

beforeEach(() => {
  document.body.innerHTML = ''
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    usage: { fetch: async () => null },
    ssh: { list: async () => [] },
    claudeAccounts: { waitLogin: () => new Promise(() => {}), cancelWaitLogin: async () => {} },
    codexAccounts: {
      systemIdentity: async () => null,
      identity: async () => null,
      add: async () => ({ id: 'never', home: '/nowhere' }),
      waitLogin: () => new Promise(() => {}),
      cancelWaitLogin: async () => {}
    },
    settings: { load: async () => DEFAULT_SETTINGS, save: async () => {} }
  }
})

afterEach(() => {
  useSettings.setState({ settings: DEFAULT_SETTINGS })
})

describe('AccountsSection — Add Codex account in a browser tab', () => {
  it('hides the button and says to add the account from the desktop app', () => {
    browser = true
    const { host, root } = render()
    expect(addCodexButton(host)).toBeUndefined()
    expect(host.textContent).toContain('Adding a Codex account from the browser is temporarily unavailable')
    expect(host.textContent).toContain('desktop app')
    root.unmount()
  })

  it('still offers the button on the desktop', () => {
    browser = false
    const { host, root } = render()
    expect(addCodexButton(host)).toBeTruthy()
    root.unmount()
  })
})
