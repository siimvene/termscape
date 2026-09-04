// @vitest-environment jsdom
// "Add Codex account" is offered in a browser tab (Server Edition) exactly as on the desktop.
//
// It was gated off there once: every Server Edition tab flushed a FULL settings snapshot
// (`settings-store.ts` `save` replaced, it did not merge), so two tabs adding concurrently left one
// of them with a managed home minted on disk and NO settings row pointing at it — a
// credential-bearing directory nothing could list, switch to, or remove. Row MEMBERSHIP is now the
// shell's (`codexAccounts.add()` / `remove()` write it through the store's read-modify-write, and a
// snapshot save can only edit rows the shell already has — src/core/settings-store.test.ts and
// src/core/codex-accounts-service.test.ts prove the races), so the gate has nothing left to guard.
//
// MUTATION: reintroduce an `isBrowserRuntime()` branch around the button in AccountsSection.tsx ⇒
// the browser case finds no button and reddens.
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
      add: async () => ({
        id: 'never',
        home: '/nowhere',
        account: { id: 'never', label: 'New Codex account', pending: true }
      }),
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
  it('offers the button in the browser, with no desktop-only notice', () => {
    browser = true
    const { host, root } = render()
    expect(addCodexButton(host)).toBeTruthy()
    expect(host.textContent).not.toContain('temporarily unavailable')
    root.unmount()
  })

  it('offers the button on the desktop', () => {
    browser = false
    const { host, root } = render()
    expect(addCodexButton(host)).toBeTruthy()
    root.unmount()
  })
})
