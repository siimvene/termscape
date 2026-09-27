/**
 * The SSH leg of the Codex account verbs (Settings → Accounts, a remote machine's panel). With a
 * `{ projectId }` ctx every verb acts ON that host through the SSH manager — and a ctx it cannot
 * resolve is an error, never a quiet fall-back to THIS machine's managed homes.
 *
 * MUTATION: drop `remoteFor(ctx)` from `add` (mint locally regardless) ⇒ the add test finds a new
 * LOCAL home and no remote call ⇒ red. Let the remote waitLogin accept any truthy answer from the
 * auth probe as "logged in" before it is `true` ⇒ the null-probe test resolves early ⇒ red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'

const h: { handlers: Record<string, (...a: any[]) => unknown> } = { handlers: {} }
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => unknown) => (h.handlers[ch] = fn) }
}))
vi.mock('../core/codex-session-name', () => ({
  readCodexThreadAt: vi.fn(),
  readCodexAccountAt: vi.fn(async () => ({ email: 'local@example.com' }))
}))
vi.mock('../core/pty-manager', () => ({ findInLoginPath: vi.fn(async () => null) }))
vi.mock('./codex-relay-daemon', () => ({ ensureCodexRelayRoot: vi.fn() }))

import { IPC } from '../shared/ipc'
import { fakePlatform } from '../core/platform-fake'

let userDataDir = ''
let settings: import('../core/settings-store').SettingsStore
const mgr = {
  remoteCodexAccountAdd: vi.fn(async (_p: string, id: string) => ({ home: `/home/u/.nodeterm/cx/${id}` })),
  remoteCodexAuthPresent: vi.fn(async (): Promise<boolean | null> => true),
  remoteCodexAccountIdentity: vi.fn(async (): Promise<{ email: string | null } | null> => ({
    email: 'ops@example.com'
  })),
  remoteCodexAccountRemove: vi.fn(async () => true),
  remoteCodexSwitchThread: vi.fn(async () => {}),
  // The row's `host` comes from the SSH manager (shell-owned provenance), never the renderer ctx.
  hostKeyFor: vi.fn((_p: string): string | undefined => 'ops@build-box')
}
const sender = { id: 1, isDestroyed: () => false, once: () => {}, removeListener: () => {} }
const call = (channel: string, ...args: any[]) => h.handlers[channel]({ sender }, ...args)
const CTX = { projectId: 'p1' }

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  h.handlers = {}
  for (const f of Object.values(mgr)) f.mockClear()
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-codex-remote-'))
  vi.resetModules()
  const { initPlatform } = await import('../core/platform')
  initPlatform(fakePlatform({ userDataDir }))
  const { SettingsStore } = await import('../core/settings-store')
  settings = new SettingsStore()
  settings.init()
  const { initCodexAccounts } = await import('./codex-accounts')
  // Fork shape: the shell owns account ROW membership, so the store is a required first argument.
  initCodexAccounts(settings, () => mgr as any)
})
afterEach(async () => {
  vi.useRealTimers()
  const { resetPlatformForTests } = await import('../core/platform')
  resetPlatformForTests()
  rmSync(userDataDir, { recursive: true, force: true })
})

const localHomes = (): string[] => {
  const root = path.join(userDataDir, 'codex-accounts')
  return existsSync(root) ? readdirSync(root) : []
}

describe('Codex account verbs over SSH', () => {
  it('add mints the home ON the host and creates nothing locally', async () => {
    const res = (await call(IPC.codexAccountsAdd, CTX)) as { id: string; home: string }
    expect(mgr.remoteCodexAccountAdd).toHaveBeenCalledWith('p1', res.id)
    expect(res.home).toBe(`/home/u/.nodeterm/cx/${res.id}`)
    expect(localHomes()).toEqual([])
    // The shell registered the row, pinned to the host the SSH manager names.
    expect(mgr.hostKeyFor).toHaveBeenCalledWith('p1')
    const row = (await settings.readAccountsFromDisk()).codexAccounts.find((a) => a.id === res.id)
    expect(row).toMatchObject({ id: res.id, pending: true, host: 'ops@build-box' })
  })

  it('add refuses when the host is not connected', async () => {
    mgr.remoteCodexAccountAdd.mockResolvedValueOnce(null as never)
    await expect(call(IPC.codexAccountsAdd, CTX)).rejects.toThrow(/not connected/)
    expect((await settings.readAccountsFromDisk()).codexAccounts).toEqual([])
  })

  it('waitLogin polls the host and reads the email there', async () => {
    expect(await call(IPC.codexAccountsWaitLogin, 'acct1', CTX)).toEqual({ email: 'ops@example.com' })
    expect(mgr.remoteCodexAuthPresent).toHaveBeenCalledWith('p1', 'acct1')
  })

  it('waitLogin keeps waiting while the host cannot be asked, and completes without an email', async () => {
    mgr.remoteCodexAuthPresent.mockResolvedValueOnce(null).mockResolvedValueOnce(false)
    mgr.remoteCodexAccountIdentity.mockResolvedValueOnce(null)
    const done = call(IPC.codexAccountsWaitLogin, 'acct1', CTX) as Promise<unknown>
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await done).toEqual({ email: null })
    expect(mgr.remoteCodexAuthPresent).toHaveBeenCalledTimes(3)
  })

  it('systemIdentity and identity ask the host', async () => {
    await call(IPC.codexAccountsSystemIdentity, CTX)
    expect(mgr.remoteCodexAccountIdentity).toHaveBeenLastCalledWith('p1', undefined)
    await call(IPC.codexAccountsIdentity, 'acct1', CTX)
    expect(mgr.remoteCodexAccountIdentity).toHaveBeenLastCalledWith('p1', 'acct1')
  })

  it('remove deletes the home ON the host, and throws when it could not', async () => {
    const { id } = (await call(IPC.codexAccountsAdd, CTX)) as { id: string }
    mgr.remoteCodexAccountRemove.mockResolvedValueOnce(false)
    await expect(call(IPC.codexAccountsRemove, id, CTX)).rejects.toThrow(/SSH host/)
    // Home-then-row: a failed teardown keeps the row visible and retryable.
    expect((await settings.readAccountsFromDisk()).codexAccounts.map((a) => a.id)).toEqual([id])
    await call(IPC.codexAccountsRemove, id, CTX)
    expect(mgr.remoteCodexAccountRemove).toHaveBeenLastCalledWith('p1', id)
    expect((await settings.readAccountsFromDisk()).codexAccounts).toEqual([])
  })
})

describe('Codex running-node switch over SSH', () => {
  it('exposes the thread to the target on the host behind the project', async () => {
    await call(IPC.codexAccountsSwitchThreadRemote, 'thread-1', 'acc2', ['acc1', 'acc2'], CTX)
    expect(mgr.remoteCodexSwitchThread).toHaveBeenCalledWith('p1', 'thread-1', 'acc2', ['acc1', 'acc2'])
    // To the host's system account (no id) too.
    await call(IPC.codexAccountsSwitchThreadRemote, 'thread-1', undefined, ['acc1'], CTX)
    expect(mgr.remoteCodexSwitchThread).toHaveBeenLastCalledWith('p1', 'thread-1', undefined, ['acc1'])
  })

  it('refuses a target that is not one of the host accounts, a bad id, and a missing ctx', async () => {
    await expect(
      call(IPC.codexAccountsSwitchThreadRemote, 'thread-1', 'elsewhere', ['acc1'], CTX)
    ).rejects.toThrow(/not on this host/)
    await expect(
      call(IPC.codexAccountsSwitchThreadRemote, '../x', 'acc1', ['acc1'], CTX)
    ).rejects.toThrow(/Invalid/)
    await expect(
      call(IPC.codexAccountsSwitchThreadRemote, 'thread-1', 'acc1', ['acc1'])
    ).rejects.toThrow(/SSH project is required/)
    expect(mgr.remoteCodexSwitchThread).not.toHaveBeenCalled()
  })
})
