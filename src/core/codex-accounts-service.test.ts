/**
 * The managed-Codex-account lifecycle lives in core, so BOTH shells serve it — the Server Edition
 * through `register()` on the platform seam (this file), the desktop through
 * `ipcMain.handle` over the same `codexAccountsHandlers()` (src/main/codex-accounts.test.ts, which
 * is unchanged by the split and is the desktop half of this proof).
 *
 * Every case here drives the SHIPPED registration through `fakePlatform().handlers[...]`, i.e.
 * exactly what the server's WS dispatch invokes for a browser tab. Registering with NO deps is the
 * Server Edition's own configuration: no `isSwitchReserved`, because it registers no switch.
 *
 * MUTATIONS:
 *  - point `registerCodexAccountsIpc` at the switch channels too ⇒ the "exactly five" case reddens.
 *  - drop the `deps.isSwitchReserved` guard in remove ⇒ the reservation case reddens.
 *  - switch the login gate's `fs.lstat` to `fs.stat` ⇒ the symlinked-credential case reddens.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

// The app-server client + the CLI lookup are runtime effects (a real `codex app-server daemon`);
// fake them. The filesystem under test is real, under mkdtemp.
const readAccount = vi.fn(async () => ({ email: 'me@example.com' }))
vi.mock('./codex-session-name', () => ({
  readCodexThreadAt: vi.fn(async () => null),
  readCodexAccountAt: (..._a: any[]) => readAccount()
}))
vi.mock('./pty-manager', () => ({ findInLoginPath: vi.fn(async () => null) }))

import { IPC } from '../shared/ipc'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { codexAccountHome } from './codex-accounts-core'
import { registerCodexAccountsIpc, type CodexAccountsDeps } from './codex-accounts-service'
import { SettingsStore } from './settings-store'
import { DEFAULT_SETTINGS, type Settings } from '../shared/types'

let fake: FakePlatform
let userDataDir = ''
let systemHome = ''
/** The REAL store over the temp userDataDir: the row ownership under test is its FIFO chain. */
let settings: SettingsStore

/** Register as the Server Edition does, always over the real store (a required dep). */
const register = (deps: Omit<CodexAccountsDeps, 'settings'> = {}): void =>
  registerCodexAccountsIpc({ settings, ...deps })

const call = (channel: string, ...args: unknown[]): Promise<any> =>
  Promise.resolve(fake.handlers[channel](...args))

/** What a browser tab must reach: the five parity VERBS — add, wait-login, cancel-wait, identity
 *  (two channels, "this managed account" and "this machine's system account") and remove — which is
 *  six channels. */
const PARITY_CHANNELS = [
  IPC.codexAccountsAdd,
  IPC.codexAccountsCancelWait,
  IPC.codexAccountsIdentity,
  IPC.codexAccountsRemove,
  IPC.codexAccountsSystemIdentity,
  IPC.codexAccountsWaitLogin
]

const DESKTOP_ONLY_CHANNELS = [
  IPC.codexAccountsSwitchThread,
  IPC.codexAccountsCommitSwitch,
  IPC.codexAccountsFinishSwitch,
  IPC.codexAccountsRollbackSwitch,
  IPC.codexAccountsTransferThreadToSsh
]

beforeEach(() => {
  readAccount.mockReset().mockResolvedValue({ email: 'me@example.com' })
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'nt-codex-svc-'))
  systemHome = mkdtempSync(path.join(os.tmpdir(), 'nt-codex-sys-'))
  // A system home with a shared, non-secret asset + directory to be symlinked into managed homes.
  writeFileSync(path.join(systemHome, 'config.toml'), 'model = "gpt"\n')
  mkdirSync(path.join(systemHome, 'skills'))
  process.env.CODEX_HOME = systemHome
  fake = fakePlatform({ userDataDir })
  initPlatform(fake)
  settings = new SettingsStore()
  settings.init()
})
afterEach(() => {
  resetPlatformForTests()
  delete process.env.CODEX_HOME
  rmSync(userDataDir, { recursive: true, force: true })
  rmSync(systemHome, { recursive: true, force: true })
})

describe('registerCodexAccountsIpc — the Server Edition surface', () => {
  it('registers exactly the parity channels on the platform seam, and nothing else', () => {
    register()
    expect(Object.keys(fake.handlers).sort()).toEqual([...PARITY_CHANNELS].sort())
  })

  // The other half of the split: the switch protocol and the SSH transfer leg are desktop-only,
  // because owner authorization is a live WebContents (id + `destroyed`) and the seam has neither.
  // An unregistered channel answers E_NO_HANDLER at ServerPlatform.dispatch, and the browser bridge
  // never gets that far — those members stay on the E_UNSUPPORTED stub.
  it('does NOT register the switch protocol or the SSH transfer leg', () => {
    register()
    for (const channel of DESKTOP_ONLY_CHANNELS) {
      expect(fake.handlers[channel], channel).toBeUndefined()
    }
  })

  it('add mints a 0700 home and symlinks the shared, non-secret runtime assets', async () => {
    register()
    const { id, home } = await call(IPC.codexAccountsAdd)
    expect(home).toBe(codexAccountHome(userDataDir, id))
    expect(lstatSync(home).mode & 0o777).toBe(0o700)
    expect(lstatSync(path.join(home, 'config.toml')).isSymbolicLink()).toBe(true)
    expect(lstatSync(path.join(home, 'skills')).isSymbolicLink()).toBe(true)
    // Credentials are NEVER shared in: only installation assets are.
    expect(() => lstatSync(path.join(home, 'auth.json'))).toThrow()
  })

  it('waitLogin returns the identity for a REAL non-symlink auth.json', async () => {
    register({ pollMs: 5 })
    const { id, home } = await call(IPC.codexAccountsAdd)
    writeFileSync(path.join(home, 'auth.json'), '{}')
    await expect(call(IPC.codexAccountsWaitLogin, id)).resolves.toEqual({
      email: 'me@example.com'
    })
    await expect(call(IPC.codexAccountsIdentity, id)).resolves.toEqual({
      email: 'me@example.com'
    })
  })

  // Property 10 / §2.1: a managed account acts only as its OWN login. A credential symlinked at the
  // system jar is "not logged in", so cancelWait ends the poll with null instead of a borrowed identity.
  it('the login gate REFUSES a symlinked auth.json', async () => {
    register({ pollMs: 5 })
    const { id, home } = await call(IPC.codexAccountsAdd)
    writeFileSync(path.join(systemHome, 'auth.json'), '{}')
    symlinkSync(path.join(systemHome, 'auth.json'), path.join(home, 'auth.json'))
    await expect(call(IPC.codexAccountsIdentity, id)).resolves.toBeNull()
    const pending = call(IPC.codexAccountsWaitLogin, id)
    await new Promise((r) => setTimeout(r, 20))
    await call(IPC.codexAccountsCancelWait, id)
    await expect(pending).resolves.toBeNull()
  })

  it('rejects an unsafe account id before it becomes a path (supply-chain guard)', async () => {
    register()
    await expect(call(IPC.codexAccountsRemove, '../../etc')).rejects.toThrow()
    await expect(call(IPC.codexAccountsWaitLogin, '../../etc')).rejects.toThrow()
  })

  // Two Server Edition tabs (or a tab and its reload) each start a wait for the SAME account. With
  // one waiter slot per id the second overwrote the first, so cancel reached only the newer poll
  // and the older one ran out its full five minutes with nothing left that could stop it. Both
  // must observe the cancel; a stranded poll shows up here as a promise that never settles.
  it('cancelWait ends EVERY concurrent wait for the id, not just the last one started', async () => {
    register({ pollMs: 5 })
    const { id } = await call(IPC.codexAccountsAdd)
    const first = call(IPC.codexAccountsWaitLogin, id)
    const second = call(IPC.codexAccountsWaitLogin, id)
    await new Promise((r) => setTimeout(r, 20))
    await call(IPC.codexAccountsCancelWait, id)
    const settled = (p: Promise<unknown>): Promise<'settled' | 'stranded'> =>
      Promise.race([
        p.then(() => 'settled' as const),
        new Promise<'stranded'>((r) => setTimeout(() => r('stranded'), 500))
      ])
    expect(await settled(first)).toBe('settled')
    expect(await settled(second)).toBe('settled')
    await expect(first).resolves.toBeNull()
    await expect(second).resolves.toBeNull()
  })

  // The `finally` of one wait must not take the other's cancel handle with it: after the first
  // wait ends, a cancel must still reach the second.
  it('a wait that finished does not strand a concurrent wait for the same id', async () => {
    register({ pollMs: 5 })
    const { id } = await call(IPC.codexAccountsAdd)
    const first = call(IPC.codexAccountsWaitLogin, id)
    const second = call(IPC.codexAccountsWaitLogin, id)
    await new Promise((r) => setTimeout(r, 20))
    await call(IPC.codexAccountsCancelWait, id)
    await first
    await second
    // Now a fresh wait must again be reachable by cancel (the map entry was not left dangling).
    const third = call(IPC.codexAccountsWaitLogin, id)
    await new Promise((r) => setTimeout(r, 20))
    await call(IPC.codexAccountsCancelWait, id)
    await expect(
      Promise.race([third, new Promise((_, rej) => setTimeout(() => rej(new Error('stranded')), 500))])
    ).resolves.toBeNull()
  })

  it('remove cancels every concurrent wait for the account', async () => {
    register({ pollMs: 5 })
    const { id } = await call(IPC.codexAccountsAdd)
    const first = call(IPC.codexAccountsWaitLogin, id)
    const second = call(IPC.codexAccountsWaitLogin, id)
    await new Promise((r) => setTimeout(r, 20))
    await call(IPC.codexAccountsRemove, id)
    await expect(
      Promise.race([
        Promise.all([first, second]),
        new Promise((_, rej) => setTimeout(() => rej(new Error('stranded')), 500))
      ])
    ).resolves.toEqual([null, null])
  })

  it('systemIdentity reads THIS machine by default but fails closed for a remote projectId', async () => {
    register()
    await expect(call(IPC.codexAccountsSystemIdentity)).resolves.toEqual({
      email: 'me@example.com'
    })
    // No SSH projects exist on the Server Edition; answering with THIS machine's login would
    // fabricate an identity for a machine we never asked (§5).
    await expect(call(IPC.codexAccountsSystemIdentity, { projectId: 'p1' })).resolves.toBeNull()
  })

  it('remove deletes the home, and refuses while a switch reservation pins the account', async () => {
    // The desktop passes this predicate from its WebContents-keyed reservation table; the Server
    // Edition passes none. Here it stands in for a live desktop reservation.
    const reserved = new Set<string>()
    register({ isSwitchReserved: (id) => reserved.has(id) })
    const { id, home } = await call(IPC.codexAccountsAdd)
    reserved.add(id)
    await expect(call(IPC.codexAccountsRemove, id)).rejects.toThrow(
      /reserved by an account switch/
    )
    expect(lstatSync(home).isDirectory()).toBe(true)
    reserved.delete(id)
    await call(IPC.codexAccountsRemove, id)
    expect(() => lstatSync(home)).toThrow()
  })

  it('refuses a concurrent removal of the same account (Property 10)', async () => {
    register()
    const { id } = await call(IPC.codexAccountsAdd)
    const first = call(IPC.codexAccountsRemove, id)
    await expect(call(IPC.codexAccountsRemove, id)).rejects.toThrow(/already in progress/)
    await first
  })
})

// Row MEMBERSHIP is this module's, written through the store's read-modify-write inside the same
// verb that mints / tears down the home. Before this the renderer appended the row to its OWN
// snapshot and full-saved it, so two browser tabs adding at once left the later save the winner:
// one authenticated home on disk with no row pointing at it.
//
// MUTATIONS:
//  - return from `add` before the `mutate` ⇒ the two-tabs case reddens (a home with no row).
//  - drop the rollback in `add`'s catch ⇒ the failed-persist case reddens (an orphan is left).
//  - delete the row from a snapshot in the renderer instead of here ⇒ the add-vs-remove case
//    reddens (the stale snapshot would carry the removed row back).
describe('codex-accounts — the shell owns row membership', () => {
  const rows = (): string[] => settings.get().codexAccounts.map((a) => a.id)
  const onDisk = (): string[] =>
    (JSON.parse(readFileSync(path.join(userDataDir, 'settings.json'), 'utf-8')) as Settings)
      .codexAccounts.map((a) => a.id)

  it('add registers a pending row in settings and returns it; the id is on disk before add resolves', async () => {
    register()
    const { id, home, account } = await call(IPC.codexAccountsAdd)
    expect(account).toEqual({ id, label: 'New Codex account', pending: true })
    expect(settings.get().codexAccounts).toEqual([account])
    expect(onDisk()).toEqual([id])
    expect(lstatSync(home).isDirectory()).toBe(true)
  })

  it('two concurrent adds (two browser tabs) both keep their rows AND their homes', async () => {
    register()
    const [a, b] = await Promise.all([call(IPC.codexAccountsAdd), call(IPC.codexAccountsAdd)])
    expect(rows().sort()).toEqual([a.id, b.id].sort())
    expect(onDisk().sort()).toEqual([a.id, b.id].sort())
    expect(lstatSync(a.home).isDirectory()).toBe(true)
    expect(lstatSync(b.home).isDirectory()).toBe(true)
  })

  it('an add racing a remove keeps the survivor and does not resurrect the removed one', async () => {
    register()
    const { id: gone, home: goneHome } = await call(IPC.codexAccountsAdd)
    // Tab B hydrated here: it knows `gone`, and will later full-save exactly this snapshot.
    const staleSnapshot = settings.get()
    const [, added] = await Promise.all([call(IPC.codexAccountsRemove, gone), call(IPC.codexAccountsAdd)])
    expect(rows()).toEqual([added.id])
    expect(() => lstatSync(goneHome)).toThrow()
    expect(lstatSync(added.home).isDirectory()).toBe(true)
    // Tab B saves its stale snapshot (label edit on the removed row, say): nothing comes back,
    // nothing is lost.
    await settings.save({
      ...staleSnapshot,
      codexAccounts: staleSnapshot.codexAccounts.map((a) => ({ ...a, label: 'renamed' }))
    })
    expect(rows()).toEqual([added.id])
    expect(onDisk()).toEqual([added.id])
  })

  it('a label edit from a snapshot taken before a concurrent add does not drop the added row', async () => {
    register()
    const { id: first } = await call(IPC.codexAccountsAdd)
    const staleSnapshot = settings.get()
    const { id: second } = await call(IPC.codexAccountsAdd)
    await settings.save({
      ...staleSnapshot,
      codexAccounts: staleSnapshot.codexAccounts.map((a) => ({ ...a, label: 'work' }))
    })
    expect(rows()).toEqual([first, second])
    expect(settings.get().codexAccounts[0].label).toBe('work')
  })

  it('add tears the minted home down again when the row cannot be persisted (no orphan, no row)', async () => {
    // A store whose write fails AFTER the verb has minted the home. `fn` is still run so the test
    // learns the id the verb chose — the only way to name the home it must have removed.
    let minted: string | undefined
    const failing = {
      get: () => settings.get(),
      mutate: async (fn: (s: Settings) => Settings) => {
        minted = fn(settings.get()).codexAccounts[0]?.id
        throw new Error('disk full')
      }
    }
    registerCodexAccountsIpc({ settings: failing })
    await expect(call(IPC.codexAccountsAdd)).rejects.toThrow(/disk full/)
    expect(minted).toBeTruthy()
    expect(rows()).toEqual([])
    expect(() => lstatSync(codexAccountHome(userDataDir, minted!))).toThrow()
  })

  it('remove deletes the row LAST: the row is gone only once the home is', async () => {
    register()
    const { id, home } = await call(IPC.codexAccountsAdd)
    await call(IPC.codexAccountsRemove, id)
    expect(() => lstatSync(home)).toThrow()
    expect(rows()).toEqual([])
    expect(onDisk()).toEqual([])
  })

  it('remove of a REMOTE row (host set) deletes only the row — it owns no local home', async () => {
    register()
    await settings.mutate((s) => ({
      ...s,
      codexAccounts: [{ id: 'remote-1', label: 'r', host: 'me@box', pending: false }]
    }))
    // A local directory that happens to share the digest must not be touched.
    const decoy = codexAccountHome(userDataDir, 'remote-1')
    mkdirSync(decoy, { recursive: true })
    await call(IPC.codexAccountsRemove, 'remote-1')
    expect(rows()).toEqual([])
    expect(lstatSync(decoy).isDirectory()).toBe(true)
    rmSync(decoy, { recursive: true, force: true })
  })

  it('remove of an id with no row still tears its local home down (cleans a pre-fix orphan)', async () => {
    register()
    const orphan = codexAccountHome(userDataDir, 'orphan-1')
    mkdirSync(orphan, { recursive: true })
    await call(IPC.codexAccountsRemove, 'orphan-1')
    expect(() => lstatSync(orphan)).toThrow()
  })
})
