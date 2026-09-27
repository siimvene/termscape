/**
 * The desktop binds core's pi-account table through `ipcMain` — never `platform().handle`, which
 * is the peer-reachable table (INVARIANT 4c): a paired relay GUEST must not be able to mint or
 * delete managed pi accounts on the HOST.
 *
 * MUTATION: switch `initPiAccounts` to `registerPiAccountsIpc` (the platform seam) ⇒ the ipcMain
 * table is empty and the platform table fills, and both assertions redden.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { fakePlatform, type FakePlatform } from '../core/platform-fake'
import { SettingsStore } from '../core/settings-store'
import { IPC } from '../shared/ipc'

const h: { handlers: Record<string, (...a: any[]) => unknown> } = { handlers: {} }
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => unknown) => (h.handlers[ch] = fn) }
}))

let userDataDir = ''
let fake: FakePlatform

beforeEach(() => {
  h.handlers = {}
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'nt-main-pi-'))
  fake = fakePlatform({ userDataDir })
  initPlatform(fake)
})
afterEach(() => {
  resetPlatformForTests()
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('initPiAccounts (desktop)', () => {
  it('registers the four pi-accounts channels on ipcMain, none on the peer-reachable platform table', async () => {
    const { initPiAccounts } = await import('./pi-accounts')
    const settings = new SettingsStore()
    settings.init()
    initPiAccounts(settings)
    expect(Object.keys(h.handlers).sort()).toEqual(
      [IPC.piAccountsAdd, IPC.piAccountsCancelWait, IPC.piAccountsRemove, IPC.piAccountsWaitLogin].sort()
    )
    expect(Object.keys(fake.handlers).filter((c) => c.startsWith('pi-accounts:'))).toEqual([])
  })

  it('strips the IPC event and serves the real core handler (add mints + registers the row)', async () => {
    const { initPiAccounts } = await import('./pi-accounts')
    const settings = new SettingsStore()
    settings.init()
    const skilled: string[] = []
    initPiAccounts(settings, (d) => skilled.push(d))
    const res = (await h.handlers[IPC.piAccountsAdd]({ sender: {} })) as {
      id: string
      agentDir: string
    }
    expect(existsSync(res.agentDir)).toBe(true)
    expect(skilled).toEqual([res.agentDir])
    expect(settings.get().piAccounts.map((a) => a.id)).toEqual([res.id])
    await h.handlers[IPC.piAccountsRemove]({ sender: {} }, res.id)
    expect(existsSync(res.agentDir)).toBe(false)
    expect(settings.get().piAccounts).toEqual([])
  })
})
