// @vitest-environment jsdom
// "Add Pi account" — the pi twin of AccountsSection.codex-add.test.tsx.
//
// Same registration-before-login-node property as Codex: `piAccounts.add()` registers the row
// inside the shell's own settings chain and resolves only once it is persisted, so the login event
// must fire only AFTER `add()` resolves, and never when it rejects. Pi additionally has no CLI
// login flag (the node runs bare `pi`, not `pi login`), so there is nothing else to gate on the
// command shape — but the capture flip (`healedPiAccount`) is pi's own thing to verify: the shell
// performs it on its OWN row and does not push to the renderer (`SettingsStore.mutate` doesn't),
// so this tab must mirror it once `waitLogin` resolves.
//
// MUTATIONS:
//  - dispatch the login event before awaiting `add()` ⇒ the first case reddens.
//  - swallow the rejection and dispatch anyway ⇒ the second case reddens.
//  - drop the `healedPiAccount` mirror after a successful waitLogin ⇒ the third case reddens.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { AccountsSection } from './AccountsSection'
import { useSettings } from '../../../state/settings'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import type { PiAccount } from '@shared/pi-account'

const NEW_ID = 'pi-new'
const NEW_ROW: PiAccount = { id: NEW_ID, label: 'New Pi account', pending: true, createdAt: 0 }

/** Ids the shell has registered so far — appended by the fake `add()` only when it RESOLVES. */
let registered: string[]
let dispatches: { accountId: string; registered: boolean }[]

const onPiLogin = (e: Event): void => {
  const accountId = (e as CustomEvent<{ accountId: string }>).detail.accountId
  dispatches.push({ accountId, registered: registered.includes(accountId) })
}

function render(rows: PiAccount[] = []): { host: HTMLElement; root: Root } {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, piAccounts: rows }, hydrated: true })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(<AccountsSection isActive />)
  })
  return { host, root }
}

const addPiButton = (host: HTMLElement): HTMLButtonElement | undefined =>
  Array.from(host.querySelectorAll('button')).find((b) =>
    /add pi account/i.test((b.textContent ?? '').trim())
  )

const until = async (pred: () => boolean, ms = 1500): Promise<void> => {
  const deadline = Date.now() + ms
  while (!pred() && Date.now() < deadline) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

/** Held so a test can resolve/reject the in-flight waitLogin at will. */
let waitLoginResolvers: Array<(v: { providers: string[] } | null) => void>

beforeEach(async () => {
  await useSettings.getState().flush?.()
  document.body.innerHTML = ''
  registered = []
  dispatches = []
  waitLoginResolvers = []
  window.addEventListener('nodeterm:add-pi-account-login', onPiLogin)
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    usage: { fetch: async () => null },
    ssh: { list: async () => [] },
    claudeAccounts: { waitLogin: () => new Promise(() => {}), cancelWaitLogin: async () => {} },
    codexAccounts: {
      systemIdentity: async () => null,
      identity: async () => null,
      add: () => new Promise(() => {}),
      waitLogin: () => new Promise(() => {}),
      cancelWaitLogin: async () => {}
    },
    piAccounts: {
      // The shell registers the row inside add(), after a short asynchronous gap standing in for
      // the mint + the persisted read-modify-write; the id counts as registered only once resolved.
      add: async () => {
        await new Promise((r) => setTimeout(r, 5))
        registered.push(NEW_ID)
        return { id: NEW_ID, agentDir: '/nowhere/pi-accounts/' + NEW_ID, account: NEW_ROW }
      },
      waitLogin: (id: string) =>
        new Promise<{ providers: string[] } | null>((resolve) => {
          waitLoginResolvers.push(resolve)
          void id
        }),
      cancelWaitLogin: async () => {},
      remove: async () => {}
    },
    settings: {
      load: async () => DEFAULT_SETTINGS,
      save: async (_s: Settings) => {}
    }
  }
})

afterEach(() => {
  window.removeEventListener('nodeterm:add-pi-account-login', onPiLogin)
  useSettings.setState({ settings: DEFAULT_SETTINGS })
})

describe('AccountsSection — adding a Pi account', () => {
  // agents-pi rule: an Anthropic Pro/Max login through a third-party harness is billed as extra
  // usage, not plan limits, and the user must be told BEFORE picking a provider in /login.
  it('states the Anthropic billing difference before any login starts', () => {
    const { host, root } = render()
    const note = host.querySelector('[data-testid="pi-billing-note"]')
    expect(note?.textContent).toMatch(/Claude Pro\/Max login in Pi is billed by Anthropic as third-party extra usage/)
    expect(note?.textContent).toMatch(/not against your plan limits/)
    root.unmount()
  })

  it('opens the login terminal only after the shell has registered the row inside add()', async () => {
    const { host, root } = render()
    const add = addPiButton(host)
    expect(add).toBeTruthy()
    await act(async () => {
      add!.click()
    })
    await until(() => dispatches.length > 0)
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0].accountId).toBe(NEW_ID)
    expect(dispatches[0].registered).toBe(true)
    expect(useSettings.getState().settings.piAccounts).toEqual([NEW_ROW])
    root.unmount()
  })

  it('opens no terminal when add() rejects (the shell registered nothing)', async () => {
    ;(window as unknown as { nodeTerminal: { piAccounts: { add: unknown } } }).nodeTerminal.piAccounts.add =
      async () => {
        throw new Error('disk full')
      }
    const { host, root } = render()
    await act(async () => {
      addPiButton(host)!.click()
    })
    await until(() => host.textContent?.includes('Could not set up the Pi account') ?? false)
    expect(dispatches).toEqual([])
    expect(useSettings.getState().settings.piAccounts).toEqual([])
    expect(host.textContent).toContain('Could not set up the Pi account')
    root.unmount()
  })

  it('mirrors the shell-side capture flip (healedPiAccount) once waitLogin resolves', async () => {
    const { host, root } = render()
    await act(async () => {
      addPiButton(host)!.click()
    })
    await until(() => dispatches.length > 0)
    await until(() => waitLoginResolvers.length > 0)
    await act(async () => {
      waitLoginResolvers[0]({ providers: ['openai-codex'] })
    })
    await until(
      () =>
        useSettings.getState().settings.piAccounts[0]?.pending === false &&
        useSettings.getState().settings.piAccounts[0]?.label === 'openai-codex'
    )
    expect(useSettings.getState().settings.piAccounts).toEqual([
      { id: NEW_ID, label: 'openai-codex', pending: false, createdAt: 0 }
    ])
    root.unmount()
  })
})

// A row left `pending` — the 5-minute waitLogin timed out, or the app restarted before the
// capture — used to be stuck: nothing ever called waitLogin again, the add menu filters pending
// rows out, and the only action on the row was Remove. Same shape as the Codex reconcile effect.
describe('AccountsSection — a pending Pi row left behind', () => {
  it('is reconciled while the section is active: waitLogin runs again and the row resolves', async () => {
    const { root } = render([NEW_ROW])
    await until(() => waitLoginResolvers.length > 0)
    expect(dispatches).toEqual([]) // reconcile does not reopen a login terminal by itself
    await act(async () => {
      waitLoginResolvers[0]({ providers: ['anthropic'] })
    })
    await until(() => useSettings.getState().settings.piAccounts[0]?.pending === false)
    expect(useSettings.getState().settings.piAccounts).toEqual([
      { id: NEW_ID, label: 'anthropic', pending: false, createdAt: 0 }
    ])
    root.unmount()
  })

  it('offers Retry login, which reopens the login terminal for that row', async () => {
    const { host, root } = render([NEW_ROW])
    const retry = Array.from(host.querySelectorAll('button')).find((b) =>
      /retry login/i.test((b.textContent ?? '').trim())
    )
    expect(retry).toBeTruthy()
    await act(async () => {
      retry!.click()
    })
    await until(() => dispatches.length > 0)
    expect(dispatches[0].accountId).toBe(NEW_ID)
    root.unmount()
  })
})
