// @vitest-environment jsdom
// "Add Codex account" must not open its `codex login` terminal until the SHELL knows the new id.
//
// The login node's pty gets the managed `CODEX_HOME` only when PtyManager finds the account id in
// the shell's settings (`isCodexAccount` reads them live). The renderer store persists on a 300 ms
// coalesce, so dispatching the login event in the same tick as the store update raced pty
// creation against the save. When the pty won, `codex login` ran under the SYSTEM `~/.codex` and
// overwrote the user's default credential, while `waitLogin` polled a managed home nothing was
// writing to. Tight on desktop; wide open over the Server Edition's WebSocket, which is what made
// the path reachable from a browser.
//
// The property: at the moment the login event is dispatched, the shell has already ACKNOWLEDGED a
// settings save that contains the new id. Not "a save was sent" — resolved.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { AccountsSection } from './AccountsSection'
import { useSettings } from '../../../state/settings'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'

const NEW_ID = 'c0dex-new'

let acknowledgedIds: string[][]
let dispatches: { accountId: string; acknowledged: boolean }[]

const onCodexLogin = (e: Event): void => {
  const accountId = (e as CustomEvent<{ accountId: string }>).detail.accountId
  dispatches.push({
    accountId,
    acknowledged: acknowledgedIds.some((ids) => ids.includes(accountId))
  })
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
  acknowledgedIds = []
  dispatches = []
  window.addEventListener('nodeterm:add-codex-account-login', onCodexLogin)
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    usage: { fetch: async () => null },
    ssh: { list: async () => [] },
    claudeAccounts: { waitLogin: () => new Promise(() => {}), cancelWaitLogin: async () => {} },
    codexAccounts: {
      systemIdentity: async () => null,
      identity: async () => null,
      add: async () => ({ id: NEW_ID, home: '/nowhere/codex-accounts/' + NEW_ID }),
      // Never resolves: the interesting window is "the login node has been asked for".
      waitLogin: () => new Promise(() => {}),
      cancelWaitLogin: async () => {}
    },
    settings: {
      load: async () => DEFAULT_SETTINGS,
      // The shell's acknowledgement is what the barrier waits on; it is recorded only when the
      // save RESOLVES, after a short asynchronous gap standing in for the write + rename.
      save: async (s: Settings) => {
        await new Promise((r) => setTimeout(r, 5))
        acknowledgedIds.push(s.codexAccounts.map((a) => a.id))
      }
    }
  }
})

afterEach(() => {
  window.removeEventListener('nodeterm:add-codex-account-login', onCodexLogin)
  useSettings.setState({ settings: DEFAULT_SETTINGS })
})

describe('AccountsSection — adding a Codex account', () => {
  it('opens the login terminal only after the shell has acknowledged a save carrying the new id', async () => {
    const { host, root } = render()
    const add = addCodexButton(host)
    expect(add).toBeTruthy()
    await act(async () => {
      add!.click()
    })
    await until(() => dispatches.length > 0)
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0].accountId).toBe(NEW_ID)
    // The invariant: registered BEFORE the pty can be asked for, not merely scheduled.
    expect(dispatches[0].acknowledged).toBe(true)
    root.unmount()
  })

  it('opens no terminal when the shell rejects the save (the id is not known to be registered)', async () => {
    ;(window as unknown as { nodeTerminal: { settings: { save: unknown } } }).nodeTerminal.settings.save =
      async () => {
        throw new Error('disk full')
      }
    const { host, root } = render()
    await act(async () => {
      addCodexButton(host)!.click()
    })
    await until(() => host.textContent?.includes('Could not set up the Codex account') ?? false)
    expect(dispatches).toEqual([])
    expect(host.textContent).toContain('Could not set up the Codex account')
    root.unmount()
  })
})
