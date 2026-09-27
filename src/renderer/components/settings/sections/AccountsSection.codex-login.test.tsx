// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AccountsSection } from './AccountsSection'
import { useSettings } from '../../../state/settings'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import type { CodexAccount } from '@shared/codex-account'

// Upstream #683 (9532134f) closed a real race: the login pty resolves the account's CODEX_HOME from
// MAIN's settings, so opening the login node before main knew the new id launched it on the
// SYSTEM account. Upstream fixed it with a renderer save barrier. In this fork the SHELL owns row
// membership (`.claude/rules/agents-accounts-usage.md`, "Account ROW membership (both lists) is the
// shell's"): `codexAccounts.add()` appends the row through `SettingsStore.mutate` and resolves only
// once it is on disk. So the barrier IS `add()`: nothing may launch or poll before it resolves, and
// a failed add (the shell's persist failed, and it rolled the home back) must launch nothing.
//
// MUTATION: dispatch the login event before awaiting `add()` => the listener sees an id main does
// not know yet => 'SYSTEM' => red.
const ROW: CodexAccount = { id: 'fixture-codex', label: 'New account', pending: true }

let root: Root
let host: HTMLDivElement
let acknowledge: () => void
let rejectAdd: (error: Error) => void
let published: Settings
let launched: string[]
let listener: EventListener
const waitLogin = vi.fn()
const save = vi.fn()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  published = { ...DEFAULT_SETTINGS }
  launched = []
  waitLogin.mockReset().mockResolvedValue({ email: 'fixture@example.test' })
  // The renderer's mirror save is display state only; it never gates the launch.
  save.mockReset().mockResolvedValue(undefined)
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS }, hydrated: true })
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    usage: { fetch: async () => null },
    ssh: { list: async () => [] },
    settings: { save },
    codexAccounts: {
      // The shell's add: the row lands in MAIN's settings (`published`) before add() resolves.
      add: () =>
        new Promise((resolve, reject) => {
          acknowledge = () => {
            published = { ...published, codexAccounts: [...published.codexAccounts, ROW] }
            resolve({ id: ROW.id, home: '/fixture/managed', account: ROW })
          }
          rejectAdd = reject
        }),
      systemIdentity: async () => null,
      identity: async () => null,
      waitLogin
    }
  }
  listener = ((event: CustomEvent<{ accountId: string }>) => {
    // The agent-less PTY resolves its provider from MAIN's list, not the renderer's store.
    const id = event.detail.accountId
    launched.push(published.codexAccounts.some((a) => a.id === id) ? id : 'SYSTEM')
  }) as EventListener
  window.addEventListener('nodeterm:add-codex-account-login', listener)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<AccountsSection isActive />))
})

afterEach(async () => {
  act(() => root.unmount())
  window.removeEventListener('nodeterm:add-codex-account-login', listener)
  host.remove()
  // Drain the pending identity update's ordinary coalesced save before leaving jsdom.
  save.mockResolvedValue(undefined)
  await useSettings.getState().flush()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function add(): Promise<void> {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Add Codex account')!
  expect(button).toBeTruthy()
  await act(async () => button.click())
}

describe('managed Codex login settings barrier (#683, shell-owned row)', () => {
  it('waits for main to know the account before launching, then clears pending after identity capture', async () => {
    await add()
    expect(launched).toEqual([])
    expect(waitLogin).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    // Still unregistered in main: nothing launched, nothing polled, and no renderer-built row.
    expect(launched).toEqual([])
    expect(waitLogin).not.toHaveBeenCalled()
    expect(useSettings.getState().settings.codexAccounts).toEqual([])
    await act(async () => { acknowledge() })
    expect(launched).toEqual(['fixture-codex'])
    expect(waitLogin).toHaveBeenCalledWith('fixture-codex')
    expect(useSettings.getState().settings.codexAccounts[0]).toMatchObject({
      id: 'fixture-codex', email: 'fixture@example.test', pending: false
    })
  })

  it('does not launch or poll when publishing the account fails', async () => {
    await add()
    await act(async () => rejectAdd(new Error('fixture write failure')))
    expect(launched).toEqual([])
    expect(waitLogin).not.toHaveBeenCalled()
    expect(useSettings.getState().settings.codexAccounts).toEqual([])
    expect(host.textContent).toContain('Could not set up the Codex account.')
  })
})
