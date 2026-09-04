/**
 * The managed-Codex-account lifecycle lives in core, so BOTH shells serve it — the Server Edition
 * through `registerCodexAccountsIpc()` on the platform seam (this file), the desktop through
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
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
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
import { registerCodexAccountsIpc } from './codex-accounts-service'

let fake: FakePlatform
let userDataDir = ''
let systemHome = ''

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
})
afterEach(() => {
  resetPlatformForTests()
  delete process.env.CODEX_HOME
  rmSync(userDataDir, { recursive: true, force: true })
  rmSync(systemHome, { recursive: true, force: true })
})

describe('registerCodexAccountsIpc — the Server Edition surface', () => {
  it('registers exactly the parity channels on the platform seam, and nothing else', () => {
    registerCodexAccountsIpc()
    expect(Object.keys(fake.handlers).sort()).toEqual([...PARITY_CHANNELS].sort())
  })

  // The other half of the split: the switch protocol and the SSH transfer leg are desktop-only,
  // because owner authorization is a live WebContents (id + `destroyed`) and the seam has neither.
  // An unregistered channel answers E_NO_HANDLER at ServerPlatform.dispatch, and the browser bridge
  // never gets that far — those members stay on the E_UNSUPPORTED stub.
  it('does NOT register the switch protocol or the SSH transfer leg', () => {
    registerCodexAccountsIpc()
    for (const channel of DESKTOP_ONLY_CHANNELS) {
      expect(fake.handlers[channel], channel).toBeUndefined()
    }
  })

  it('add mints a 0700 home and symlinks the shared, non-secret runtime assets', async () => {
    registerCodexAccountsIpc()
    const { id, home } = await call(IPC.codexAccountsAdd)
    expect(home).toBe(codexAccountHome(userDataDir, id))
    expect(lstatSync(home).mode & 0o777).toBe(0o700)
    expect(lstatSync(path.join(home, 'config.toml')).isSymbolicLink()).toBe(true)
    expect(lstatSync(path.join(home, 'skills')).isSymbolicLink()).toBe(true)
    // Credentials are NEVER shared in: only installation assets are.
    expect(() => lstatSync(path.join(home, 'auth.json'))).toThrow()
  })

  it('waitLogin returns the identity for a REAL non-symlink auth.json', async () => {
    registerCodexAccountsIpc({ pollMs: 5 })
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
    registerCodexAccountsIpc({ pollMs: 5 })
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
    registerCodexAccountsIpc()
    await expect(call(IPC.codexAccountsRemove, '../../etc')).rejects.toThrow()
    await expect(call(IPC.codexAccountsWaitLogin, '../../etc')).rejects.toThrow()
  })

  // Two Server Edition tabs (or a tab and its reload) each start a wait for the SAME account. With
  // one waiter slot per id the second overwrote the first, so cancel reached only the newer poll
  // and the older one ran out its full five minutes with nothing left that could stop it. Both
  // must observe the cancel; a stranded poll shows up here as a promise that never settles.
  it('cancelWait ends EVERY concurrent wait for the id, not just the last one started', async () => {
    registerCodexAccountsIpc({ pollMs: 5 })
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
    registerCodexAccountsIpc({ pollMs: 5 })
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
    registerCodexAccountsIpc({ pollMs: 5 })
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
    registerCodexAccountsIpc()
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
    registerCodexAccountsIpc({ isSwitchReserved: (id) => reserved.has(id) })
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
    registerCodexAccountsIpc()
    const { id } = await call(IPC.codexAccountsAdd)
    const first = call(IPC.codexAccountsRemove, id)
    await expect(call(IPC.codexAccountsRemove, id)).rejects.toThrow(/already in progress/)
    await first
  })
})
