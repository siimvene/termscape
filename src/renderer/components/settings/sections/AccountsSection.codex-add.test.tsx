// @vitest-environment jsdom
// "Add Codex account" must not open its `codex login` terminal until the SHELL knows the new id.
//
// The login node's pty gets the managed `CODEX_HOME` only when PtyManager finds the account id in
// the shell's settings (`isCodexAccount` reads them live). The row used to be the RENDERER's to
// write: it appended the minted id to its own snapshot and a save barrier waited for the shell to
// acknowledge that save before the login event fired. Now `codexAccounts.add()` itself registers
// the row (a read-modify-write on the settings store) and resolves only once it is persisted — so
// the property is that the login event is dispatched only AFTER `add()` has resolved, and never at
// all when `add()` rejects. The renderer's own snapshot save is no longer what registers the id;
// it is a mirror the shell reconciles against its own membership.
//
// MUTATIONS:
//  - dispatch the login event before awaiting `add()` ⇒ the first case reddens.
//  - swallow the rejection and dispatch anyway ⇒ the second case reddens.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { AccountsSection } from './AccountsSection'
import { useSettings } from '../../../state/settings'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import type { CodexAccount } from '@shared/codex-account'

const NEW_ID = 'c0dex-new'
const NEW_ROW: CodexAccount = { id: NEW_ID, label: 'New Codex account', pending: true }

/** Ids the shell has registered so far — appended by the fake `add()` only when it RESOLVES. */
let registered: string[]
let dispatches: { accountId: string; registered: boolean }[]
let snapshotsSaved: string[][]

const onCodexLogin = (e: Event): void => {
  const accountId = (e as CustomEvent<{ accountId: string }>).detail.accountId
  dispatches.push({ accountId, registered: registered.includes(accountId) })
}

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

const until = async (pred: () => boolean, ms = 1500): Promise<void> => {
  const deadline = Date.now() + ms
  while (!pred() && Date.now() < deadline) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

beforeEach(async () => {
  await useSettings.getState().flush?.()
  document.body.innerHTML = ''
  registered = []
  dispatches = []
  snapshotsSaved = []
  window.addEventListener('nodeterm:add-codex-account-login', onCodexLogin)
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    usage: { fetch: async () => null },
    ssh: { list: async () => [] },
    claudeAccounts: { waitLogin: () => new Promise(() => {}), cancelWaitLogin: async () => {} },
    codexAccounts: {
      systemIdentity: async () => null,
      identity: async () => null,
      // The shell registers the row inside add(), after a short asynchronous gap standing in for
      // the mint + the persisted read-modify-write; the id counts as registered only once resolved.
      add: async () => {
        await new Promise((r) => setTimeout(r, 5))
        registered.push(NEW_ID)
        return { id: NEW_ID, home: '/nowhere/cx/' + NEW_ID, account: NEW_ROW }
      },
      // Never resolves: the interesting window is "the login node has been asked for".
      waitLogin: () => new Promise(() => {}),
      cancelWaitLogin: async () => {}
    },
    settings: {
      load: async () => DEFAULT_SETTINGS,
      save: async (s: Settings) => {
        snapshotsSaved.push(s.codexAccounts.map((a) => a.id))
      }
    }
  }
})

afterEach(() => {
  window.removeEventListener('nodeterm:add-codex-account-login', onCodexLogin)
  useSettings.setState({ settings: DEFAULT_SETTINGS })
})

describe('AccountsSection — adding a Codex account', () => {
  it('opens the login terminal only after the shell has registered the row inside add()', async () => {
    const { host, root } = render()
    const add = addCodexButton(host)
    expect(add).toBeTruthy()
    await act(async () => {
      add!.click()
    })
    await until(() => dispatches.length > 0)
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0].accountId).toBe(NEW_ID)
    // The invariant: registered by the shell BEFORE the pty can be asked for.
    expect(dispatches[0].registered).toBe(true)
    // The row the shell returned is mirrored for this tab's display.
    expect(useSettings.getState().settings.codexAccounts).toEqual([NEW_ROW])
    root.unmount()
  })

  it('opens no terminal when add() rejects (the shell registered nothing)', async () => {
    ;(window as unknown as { nodeTerminal: { codexAccounts: { add: unknown } } }).nodeTerminal.codexAccounts.add =
      async () => {
        throw new Error('disk full')
      }
    const { host, root } = render()
    await act(async () => {
      addCodexButton(host)!.click()
    })
    await until(() => host.textContent?.includes('Could not set up the Codex account') ?? false)
    expect(dispatches).toEqual([])
    expect(useSettings.getState().settings.codexAccounts).toEqual([])
    expect(host.textContent).toContain('Could not set up the Codex account')
    root.unmount()
  })

  it('does not wait on its own snapshot save to open the login node — a stuck save cannot latch the spinner', async () => {
    // The shell's snapshot save never acknowledges. Before, the registration barrier waited on it
    // (bounded by a timeout, then refused to open anything); now registration is add()'s own.
    ;(window as unknown as { nodeTerminal: { settings: { save: unknown } } }).nodeTerminal.settings.save =
      () => new Promise(() => {})
    const { host, root } = render()
    await act(async () => {
      addCodexButton(host)!.click()
    })
    await until(() => dispatches.length > 0)
    expect(dispatches).toEqual([{ accountId: NEW_ID, registered: true }])
    root.unmount()
  })
})
