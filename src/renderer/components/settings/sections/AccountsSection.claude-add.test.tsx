// @vitest-environment jsdom
// "Add account" (Claude) mirrors the row the SHELL registered, and opens its `claude /login` node
// only once `add()` has resolved — the same shape as AccountsSection.codex-add.test.tsx.
//
// The row used to be the RENDERER's to write: it built `{id, label:'New account', pending, host}`
// itself after `add()` returned and full-saved it, so two Server Edition tabs adding at once left
// the later snapshot the winner (one logged-in config dir with no row). Now `claudeAccounts.add()`
// registers the row (a read-modify-write on the settings store) and returns it; the renderer's
// snapshot save is a mirror the store reconciles against its own membership.
//
// MUTATIONS:
//  - build the row in the renderer again (ignore `added.account`) ⇒ the host case reddens: the
//    shell's row is what carries the host it actually minted on.
//  - dispatch the login event before awaiting `add()` ⇒ the ordering case reddens.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { AccountsSection } from './AccountsSection'
import { useSettings } from '../../../state/settings'
import { DEFAULT_SETTINGS, type ClaudeAccount } from '@shared/types'

const NEW_ROW: ClaudeAccount = { id: 'k-new', label: 'New account', pending: true, createdAt: 7 }

let registered: string[]
let dispatches: { accountId: string; registered: boolean }[]
let addCalls: unknown[]

const onLogin = (e: Event): void => {
  const accountId = (e as CustomEvent<{ accountId: string }>).detail.accountId
  dispatches.push({ accountId, registered: registered.includes(accountId) })
}

function render(): { host: HTMLElement; root: Root } {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, claudeAccounts: [] }, hydrated: true })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(<AccountsSection isActive />)
  })
  return { host, root }
}

const addButton = (host: HTMLElement): HTMLButtonElement | undefined =>
  Array.from(host.querySelectorAll('button')).find((b) =>
    /^add account$/i.test((b.textContent ?? '').trim())
  )

const until = async (pred: () => boolean, ms = 1500): Promise<void> => {
  const deadline = Date.now() + ms
  while (!pred() && Date.now() < deadline) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

beforeEach(() => {
  document.body.innerHTML = ''
  registered = []
  dispatches = []
  addCalls = []
  window.addEventListener('nodeterm:add-account-login', onLogin)
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    usage: { fetch: async () => null },
    ssh: { list: async () => [] },
    codexAccounts: { systemIdentity: async () => null, identity: async () => null },
    claudeAccounts: {
      add: async (ctx: unknown) => {
        addCalls.push(ctx)
        await new Promise((r) => setTimeout(r, 15))
        registered.push(NEW_ROW.id)
        return { id: NEW_ROW.id, configDir: '/x', versionSupported: true, account: NEW_ROW }
      },
      waitLogin: () => new Promise(() => {}),
      cancelWaitLogin: async () => {}
    },
    settings: { save: async () => {} }
  }
})

afterEach(() => {
  window.removeEventListener('nodeterm:add-account-login', onLogin)
})

describe('Add account (Claude) — the shell owns the row', () => {
  it('mirrors the row the shell returned and dispatches the login node only after add() resolved', async () => {
    const { host, root } = render()
    await act(async () => {
      addButton(host)!.click()
    })
    await until(() => dispatches.length > 0)
    expect(addCalls).toEqual([undefined]) // a local add carries no ctx
    expect(dispatches).toEqual([{ accountId: NEW_ROW.id, registered: true }])
    // The mirrored row is the shell's, byte for byte — not one the renderer built itself.
    expect(useSettings.getState().settings.claudeAccounts).toEqual([NEW_ROW])
    root.unmount()
  })

  it('does not duplicate a row the store already holds (another listener mirrored it first)', async () => {
    const { host, root } = render()
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, claudeAccounts: [NEW_ROW] },
      hydrated: true
    })
    await act(async () => {
      addButton(host)!.click()
    })
    await until(() => dispatches.length > 0)
    expect(useSettings.getState().settings.claudeAccounts).toEqual([NEW_ROW])
    root.unmount()
  })
})
