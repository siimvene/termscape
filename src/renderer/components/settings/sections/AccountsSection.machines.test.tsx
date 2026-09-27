// @vitest-environment jsdom
//
// The machine-grouped Accounts settings: Claude and Codex accounts sit on the SAME machine panel,
// each provider with its own Add button, and a remote machine's buttons act ON that host — over a
// live connection only. The rules pinned here are the ones a regression would make silently wrong:
// a remote add/remove never runs locally, a disconnected host never reaches the remote leg, and a
// saved server with nothing on it and no connection stays out of the way.
//
// Fork shape (`.claude/rules/agents-accounts-usage.md`, "Account ROW membership (both lists) is the
// shell's"): `add()` registers the row in the shell and returns it (`account`), and `remove()` is
// ALWAYS the shell's verb, which branches on the ROW's host. A disconnected Codex host therefore
// still calls `remove(id)` with NO ctx (the shell only forgets a row carrying `host`, never a local
// teardown); a disconnected Claude host is REFUSED by the shell (teardown must be confirmed on the
// host) and the row stays.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AccountsSection } from './AccountsSection'
import { useSettings } from '../../../state/settings'
import { useProjects } from '../../../state/projects'
import { useSshConn } from '../../../state/sshConn'
import { useSshServers } from '../../../state/sshServers'
import { DEFAULT_SETTINGS, type ClaudeAccount } from '@shared/types'
import type { CodexAccount } from '@shared/codex-account'
import type { SshServer } from '@shared/ssh'

const prod: SshServer = { id: 's1', host: 'prod-box', user: 'deploy', label: 'Prod' } as SshServer
const idle: SshServer = { id: 's2', host: 'idle-box', user: 'me', label: 'Idle' } as SshServer
const PROD = 'deploy@prod-box'

let codexApi: Record<string, ReturnType<typeof vi.fn>>
let claudeApi: Record<string, ReturnType<typeof vi.fn>>
let events: { type: string; detail: unknown }[]
let root: Root
let host: HTMLElement
const onEvent = (e: Event): void => {
  events.push({ type: e.type, detail: (e as CustomEvent).detail })
}

function render(opts: {
  claude?: ClaudeAccount[]
  codex?: CodexAccount[]
  connected?: boolean
}): void {
  useSettings.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      claudeAccounts: opts.claude ?? [],
      codexAccounts: opts.codex ?? []
    },
    hydrated: true
  })
  useSshServers.setState({ servers: [prod, idle] })
  useProjects.setState({
    projects: [{ id: 'p1', name: 'prod', nodes: [], ssh: { server: prod, remoteCwd: '/srv' } } as never],
    activeProjectId: 'p1'
  })
  useSshConn.setState({ byProject: opts.connected === false ? {} : ({ p1: {} } as never) })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<AccountsSection isActive />))
}

const panel = (label: string): HTMLElement =>
  host.querySelector(`section[aria-label="Accounts on ${label}"]`) as HTMLElement
const buttonIn = (el: ParentNode, text: string): HTMLButtonElement | undefined =>
  [...el.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement | undefined
const byLabel = (label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label) as
    | HTMLButtonElement
    | undefined

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  events = []
  window.addEventListener('nodeterm:add-codex-account-login', onEvent)
  window.addEventListener('nodeterm:add-account-login', onEvent)
  codexApi = {
    // The shell's add returns the row it registered, pinned to the host it minted on.
    add: vi.fn(async () => ({
      id: 'cx-new',
      home: '/home/deploy/.nodeterm/cx/x',
      account: { id: 'cx-new', label: 'New account', pending: true, host: PROD } as CodexAccount
    })),
    waitLogin: vi.fn(async () => ({ email: 'ops@example.com' })),
    cancelWaitLogin: vi.fn(async () => {}),
    identity: vi.fn(async () => null),
    systemIdentity: vi.fn(async () => null),
    remove: vi.fn(async () => {})
  }
  claudeApi = {
    add: vi.fn(async () => ({
      id: 'cl-new',
      configDir: '~/x',
      versionSupported: true,
      account: { id: 'cl-new', label: 'New account', pending: true, host: PROD, createdAt: 0 } as ClaudeAccount
    })),
    waitLogin: vi.fn(async () => ({ email: 'ops@example.com' })),
    cancelWaitLogin: vi.fn(async () => {}),
    remove: vi.fn(async () => {})
  }
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    usage: { fetch: async () => null },
    ssh: { list: async () => [prod, idle] },
    settings: { save: async () => {} },
    codexAccounts: codexApi,
    claudeAccounts: claudeApi
  }
})

afterEach(async () => {
  act(() => root.unmount())
  host.remove()
  window.removeEventListener('nodeterm:add-codex-account-login', onEvent)
  window.removeEventListener('nodeterm:add-account-login', onEvent)
  await useSettings.getState().flush()
  useSettings.setState({ settings: DEFAULT_SETTINGS })
  useSshConn.setState({ byProject: {} })
  useSshServers.setState({ servers: [] })
  vi.unstubAllGlobals()
})

describe('AccountsSection — one panel per machine, both providers', () => {
  it('puts a host’s Claude and Codex accounts on that host’s panel, and hides an idle saved server', () => {
    render({
      claude: [{ id: 'a1', label: 'Server login', host: PROD, createdAt: 0 }],
      codex: [{ id: 'c1', label: 'Prod codex', host: PROD }]
    })
    const p = panel(PROD)
    expect(p).toBeTruthy()
    expect((p.querySelector('input[value="Server login"]') as HTMLInputElement | null)).toBeTruthy()
    expect((p.querySelector('input[value="Prod codex"]') as HTMLInputElement | null)).toBeTruthy()
    expect(buttonIn(p, 'Add Claude account')?.disabled).toBe(false)
    expect(buttonIn(p, 'Add Codex account')?.disabled).toBe(false)
    // idle-box: saved, nothing on it, not connected → no panel, but the footnote counts it.
    expect(panel('me@idle-box')).toBeNull()
    expect(host.textContent).toContain('1 saved SSH server has no accounts yet')
  })

  it('disables a disconnected host’s Add buttons instead of running them locally', () => {
    render({ claude: [{ id: 'a1', label: 'Server login', host: PROD, createdAt: 0 }], connected: false })
    const p = panel(PROD)
    expect(buttonIn(p, 'Add Claude account')?.disabled).toBe(true)
    expect(buttonIn(p, 'Add Codex account')?.disabled).toBe(true)
    expect(p.textContent).toContain('not connected')
  })
})

describe('AccountsSection — Codex on an SSH host', () => {
  it('creates the home ON the host, opens the login there, and waits over the host', async () => {
    render({})
    await act(async () => buttonIn(panel(PROD), 'Add Codex account')!.click())
    expect(codexApi.add).toHaveBeenCalledWith({ projectId: 'p1' })
    expect(events).toContainEqual({
      type: 'nodeterm:add-codex-account-login',
      detail: { accountId: 'cx-new', remote: true, host: PROD }
    })
    expect(codexApi.waitLogin).toHaveBeenCalledWith('cx-new', { projectId: 'p1' })
    expect(useSettings.getState().settings.codexAccounts[0]).toMatchObject({
      id: 'cx-new',
      host: PROD,
      email: 'ops@example.com',
      pending: false
    })
  })

  it('removes a remote account ON its host when connected', async () => {
    render({ codex: [{ id: 'c1', label: 'Prod codex', host: PROD }] })
    act(() => byLabel('Remove Codex account')!.click())
    expect(document.body.textContent).toContain('Codex home on deploy@prod-box will be deleted')
    await act(async () => buttonIn(document.body, 'Remove')!.click())
    expect(codexApi.remove).toHaveBeenCalledWith('c1', { projectId: 'p1' })
    expect(useSettings.getState().settings.codexAccounts).toEqual([])
  })

  it('only forgets a remote account whose host is not connected — never a remote-leg remove', async () => {
    render({ codex: [{ id: 'c1', label: 'Prod codex', host: PROD }], connected: false })
    act(() => byLabel('Remove Codex account')!.click())
    expect(document.body.textContent).toContain('not connected, so nodeterm only forgets it')
    await act(async () => buttonIn(document.body, 'Remove')!.click())
    // The shell drops the row; with no ctx it never reaches the SSH leg, and its local verb reads
    // the row's `host` from disk and skips every local teardown for it.
    expect(codexApi.remove).toHaveBeenCalledTimes(1)
    expect(codexApi.remove).toHaveBeenCalledWith('c1')
    expect(codexApi.remove).not.toHaveBeenCalledWith('c1', expect.anything())
    expect(useSettings.getState().settings.codexAccounts).toEqual([])
  })

  it('keeps the row and says why when the removal is refused', async () => {
    codexApi.remove.mockRejectedValueOnce(new Error('Codex account is reserved by an account switch'))
    render({ codex: [{ id: 'c1', label: 'Mine' }] })
    act(() => byLabel('Remove Codex account')!.click())
    await act(async () => buttonIn(document.body, 'Remove')!.click())
    expect(useSettings.getState().settings.codexAccounts).toHaveLength(1)
    expect(host.textContent).toContain('reserved by an account switch')
  })

  it('offers Retry login on a pending Codex row, like Claude', async () => {
    render({ codex: [{ id: 'c2', label: 'New Codex account', pending: true }] })
    await act(async () => buttonIn(host, 'Retry login')!.click())
    expect(codexApi.waitLogin).toHaveBeenCalledWith('c2')
  })
})

describe('AccountsSection — Claude on an SSH host', () => {
  it('refuses to remove a remote Claude account whose host is not connected, and keeps the row', async () => {
    // The shell drops a remote Claude row only after CONFIRMED teardown on its host; the SSH remove
    // primitive reports false for a disconnected project, so the verb rejects.
    claudeApi.remove.mockRejectedValueOnce(new Error('Could not remove the Claude account on the SSH host'))
    render({ claude: [{ id: 'a1', label: 'Server login', host: PROD, createdAt: 0 }], connected: false })
    act(() => byLabel('Remove account')!.click())
    expect(document.body.textContent).toContain('is not connected, so the account cannot be removed yet')
    await act(async () => buttonIn(document.body, 'Remove')!.click())
    // Routed at the host's (saved, disconnected) project, never a local remove.
    expect(claudeApi.remove).toHaveBeenCalledWith('a1', { projectId: 'p1' })
    expect(useSettings.getState().settings.claudeAccounts).toEqual([
      { id: 'a1', label: 'Server login', host: PROD, createdAt: 0 }
    ])
    expect(host.textContent).toContain('Reconnect the project and try again')
  })

  it('removes it ON the host when connected', async () => {
    render({ claude: [{ id: 'a1', label: 'Server login', host: PROD, createdAt: 0 }] })
    act(() => byLabel('Remove account')!.click())
    await act(async () => buttonIn(document.body, 'Remove')!.click())
    expect(claudeApi.remove).toHaveBeenCalledWith('a1', { projectId: 'p1' })
  })
})
