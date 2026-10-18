/**
 * Managed pi accounts: the lifecycle is core, so both shells serve it. Every case drives the
 * shipped registration through the platform seam (`fakePlatform().handlers[...]`), exactly what
 * `ipcMain.handle` / the server's WS dispatch invoke. The status extension is the REAL installer
 * writing into the temp dir, so "the dir carries the extension" is observed, not assumed.
 *
 * MUTATION: register the row before minting the dir, drop the rollback `rm`, delete the row before
 * the dir, or let `wait-login` accept an empty `{}` auth.json → the matching case reddens.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import { registerPiAccountsIpc as registerWithDeps, type PiAccountsDeps } from './pi-accounts-service'
import { piAccountDirFor } from './pi-config-dir'
import { piExtensionPath, PI_EXTENSION_MARKER } from './agents/hooks/pi'
import { createIntegrationLifecycle, registerIntegrationLifecycle } from './agent-integrations'
import { SettingsStore } from './settings-store'
import { NEW_PI_ACCOUNT_LABEL, type PiAccount } from '../shared/pi-account'
import type { Settings } from '../shared/types'

let fake: FakePlatform
let userDataDir: string
let settings: SettingsStore
const register = (deps: Omit<PiAccountsDeps, 'settings'> = {}): void =>
  registerWithDeps({ settings, ...deps })
const call = (channel: string, ...args: unknown[]): Promise<any> =>
  Promise.resolve(fake.handlers[channel](...args))
const rows = (): string[] => settings.get().piAccounts.map((a) => a.id)
const onDisk = (): PiAccount[] =>
  (JSON.parse(readFileSync(path.join(userDataDir, 'settings.json'), 'utf-8')) as Settings).piAccounts
const writeAuth = (dir: string, body: unknown): void =>
  writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(body))

beforeEach(() => {
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'nt-pi-accounts-'))
  fake = fakePlatform({ userDataDir })
  initPlatform(fake)
  settings = new SettingsStore()
  settings.init()
})
afterEach(() => {
  registerIntegrationLifecycle(null)
  resetPlatformForTests()
  rmSync(userDataDir, { recursive: true, force: true })
})

/** Register the consent lifecycle the shells boot, with pi's choice (and the Server Edition's
 *  `installHooks: false` veto) as given. `add` asks it, exactly like a Claude account's add. */
function consent(pi: 'enabled' | 'declined' | undefined, opts: { veto?: boolean; canvas?: boolean } = {}): void {
  registerIntegrationLifecycle(
    createIntegrationLifecycle({
      settings: () => ({
        ...settings.get(),
        agentIntegrations: { agents: pi ? { pi } : {}, origin: 'asked' }
      }),
      userDataDir: () => userDataDir,
      shims: () => ({
        canvas: opts.canvas === false ? undefined : path.join(userDataDir, 'canvas-control', 'nodeterm.sh'),
        context: path.join(userDataDir, 'context-links', 'context.sh')
      }),
      veto: opts.veto
    })
  )
}
const skillFile = (dir: string, name: string): string => path.join(dir, 'skills', name, 'SKILL.md')

describe('registerPiAccountsIpc — the four channels', () => {
  it('registers exactly the four pi-accounts channels', () => {
    register()
    expect(Object.keys(fake.handlers).sort()).toEqual(
      [
        IPC.piAccountsAdd,
        IPC.piAccountsCancelWait,
        IPC.piAccountsRemove,
        IPC.piAccountsWaitLogin
      ].sort()
    )
  })

  it('add() mints <userData>/pi-accounts/<id> (0700); with pi ENABLED it carries the extension + both skills', async () => {
    consent('enabled')
    register()
    const res = await call(IPC.piAccountsAdd)
    expect(res.id).toMatch(/^[A-Za-z0-9-]+$/)
    expect(res.agentDir).toBe(path.join(userDataDir, 'pi-accounts', res.id))
    expect(res.agentDir).toBe(piAccountDirFor(userDataDir, res.id))
    expect(statSync(res.agentDir).isDirectory()).toBe(true)
    if (process.platform !== 'win32') expect(statSync(res.agentDir).mode & 0o777).toBe(0o700)
    const ext = readFileSync(piExtensionPath(res.agentDir), 'utf8')
    expect(ext.startsWith(PI_EXTENSION_MARKER)).toBe(true)
    expect(readFileSync(skillFile(res.agentDir, 'manage-nodeterm-canvas'), 'utf8')).toContain('name: manage-nodeterm-canvas')
    expect(readFileSync(skillFile(res.agentDir, 'get-linked-context'), 'utf8')).toContain('name: get-linked-context')
  })

  it('without pi consent the account is still minted, but NOTHING of ours goes into it', async () => {
    // Undecided, declined, no lifecycle registered (fail-closed), and the Server Edition veto
    // (`installHooks: false`) even with pi enabled — upstream #744, the Claude add's gate.
    const cases: Array<() => void> = [
      () => consent(undefined),
      () => consent('declined'),
      () => registerIntegrationLifecycle(null),
      () => consent('enabled', { veto: true })
    ]
    register()
    for (const arrange of cases) {
      arrange()
      const res = await call(IPC.piAccountsAdd)
      expect(statSync(res.agentDir).isDirectory()).toBe(true)
      expect(rows()).toContain(res.id)
      expect(existsSync(path.join(res.agentDir, 'extensions'))).toBe(false)
      expect(existsSync(path.join(res.agentDir, 'skills'))).toBe(false)
    }
  })

  it('no canvas control on this edition: an enabled pi account gets the context skill only', async () => {
    consent('enabled', { canvas: false })
    register()
    const res = await call(IPC.piAccountsAdd)
    expect(existsSync(skillFile(res.agentDir, 'get-linked-context'))).toBe(true)
    expect(existsSync(skillFile(res.agentDir, 'manage-nodeterm-canvas'))).toBe(false)
  })

  it('a traversing id is refused on every verb that takes one, not resolved outside the root', async () => {
    register({ pollMs: 5 })
    await expect(call(IPC.piAccountsRemove, '../x')).rejects.toThrow(/invalid account id/)
    await expect(call(IPC.piAccountsWaitLogin, '../x')).rejects.toThrow(/invalid account id/)
    await expect(call(IPC.piAccountsRemove, 'a.b')).rejects.toThrow(/invalid account id/)
    await expect(call(IPC.piAccountsRemove, '')).rejects.toThrow(/invalid account id/)
  })
})

describe('pi-accounts wait-login — auth.json with >= 1 provider is a login', () => {
  it('does NOT resolve on the empty `{}` pi writes on first run, then resolves once a provider lands', async () => {
    register({ pollMs: 5 })
    const { id, agentDir } = await call(IPC.piAccountsAdd)
    writeAuth(agentDir, {})
    let settled = false
    const pending = call(IPC.piAccountsWaitLogin, id).then((v) => {
      settled = true
      return v
    })
    await new Promise((r) => setTimeout(r, 40))
    expect(settled).toBe(false)
    writeAuth(agentDir, { 'openai-codex': { type: 'oauth', access: 'x', refresh: 'y' } })
    await expect(pending).resolves.toEqual({ providers: ['openai-codex'] })
  })

  it('on capture the row flips out of pending and is labelled with the provider list (on disk too)', async () => {
    register({ pollMs: 5 })
    const { id, agentDir } = await call(IPC.piAccountsAdd)
    writeAuth(agentDir, {
      anthropic: { type: 'oauth' },
      'openai-codex': { type: 'oauth' }
    })
    await expect(call(IPC.piAccountsWaitLogin, id)).resolves.toEqual({
      providers: ['anthropic', 'openai-codex']
    })
    const row = settings.get().piAccounts.find((a) => a.id === id)
    expect(row).toMatchObject({ id, label: 'anthropic, openai-codex' })
    expect(row?.pending).toBeUndefined()
    expect(onDisk().find((a) => a.id === id)?.pending).toBeUndefined()
  })

  it('a label the user typed before the capture survives it', async () => {
    register({ pollMs: 5 })
    const { id, agentDir } = await call(IPC.piAccountsAdd)
    const snap = settings.get()
    await settings.save({
      ...snap,
      piAccounts: snap.piAccounts.map((a) => (a.id === id ? { ...a, label: 'work codex' } : a))
    })
    writeAuth(agentDir, { 'openai-codex': { type: 'oauth' } })
    await call(IPC.piAccountsWaitLogin, id)
    const row = settings.get().piAccounts.find((a) => a.id === id)
    expect(row?.label).toBe('work codex')
    expect(row?.pending).toBeUndefined()
  })

  it('a stale renderer snapshot (still pending, placeholder label) cannot un-resolve the capture', async () => {
    register({ pollMs: 5 })
    const { id, agentDir } = await call(IPC.piAccountsAdd)
    const stale = settings.get()
    writeAuth(agentDir, { 'openai-codex': { type: 'oauth' } })
    await call(IPC.piAccountsWaitLogin, id)
    await settings.save(stale)
    const row = settings.get().piAccounts.find((a) => a.id === id)
    expect(row?.label).toBe('openai-codex')
    expect(row?.pending).toBeUndefined()
  })

  it('a scalar provider value (a hand-edited file) is not a login', async () => {
    register({ pollMs: 5, timeoutMs: 60 })
    const { id, agentDir } = await call(IPC.piAccountsAdd)
    writeAuth(agentDir, { 'openai-codex': 'not-an-entry' })
    await expect(call(IPC.piAccountsWaitLogin, id)).resolves.toBeNull()
  })

  it('times out to null', async () => {
    register({ pollMs: 5, timeoutMs: 30 })
    const { id } = await call(IPC.piAccountsAdd)
    await expect(call(IPC.piAccountsWaitLogin, id)).resolves.toBeNull()
  })

  it('cancelWaitLogin cancels EVERY concurrent wait for one id, not just the newest', async () => {
    register({ pollMs: 5 })
    const { id } = await call(IPC.piAccountsAdd)
    const first = call(IPC.piAccountsWaitLogin, id)
    const second = call(IPC.piAccountsWaitLogin, id)
    await new Promise((r) => setTimeout(r, 20))
    await call(IPC.piAccountsCancelWait, id)
    await expect(Promise.all([first, second])).resolves.toEqual([null, null])
  })
})

describe('pi-accounts — the shell owns row membership', () => {
  it('add registers a pending placeholder row; the row is on disk before add resolves', async () => {
    register()
    const { id, agentDir, account } = await call(IPC.piAccountsAdd)
    expect(account).toMatchObject({ id, label: NEW_PI_ACCOUNT_LABEL, pending: true })
    expect(typeof account.createdAt).toBe('number')
    expect(settings.get().piAccounts).toEqual([account])
    expect(onDisk().map((a) => a.id)).toEqual([id])
    expect(existsSync(agentDir)).toBe(true)
  })

  it('two concurrent adds (two browser tabs) both keep their rows AND their dirs', async () => {
    register()
    const [a, b] = await Promise.all([call(IPC.piAccountsAdd), call(IPC.piAccountsAdd)])
    expect(rows().sort()).toEqual([a.id, b.id].sort())
    expect(onDisk().map((r) => r.id).sort()).toEqual([a.id, b.id].sort())
    expect(existsSync(a.agentDir) && existsSync(b.agentDir)).toBe(true)
  })

  it('a renderer snapshot can neither add nor drop a row', async () => {
    register()
    const { id } = await call(IPC.piAccountsAdd)
    const snap = settings.get()
    await settings.save({
      ...snap,
      piAccounts: [{ id: 'forged', label: 'x', createdAt: 1 }]
    })
    expect(rows()).toEqual([id])
  })

  it('add tears the minted dir down again when the row cannot be persisted (no orphan, no row)', async () => {
    consent('enabled') // so the extension leg runs, and must land before the row
    let minted: string | undefined
    const failing = {
      get: () => settings.get(),
      readAccountsFromDisk: async () => settings.get(),
      mutate: async (fn: (s: Settings) => Settings) => {
        minted = fn(settings.get()).piAccounts[0]?.id
        // The header's "register the row before minting the dir" mutation is caught HERE: at the
        // moment the row is registered, the dir and its status extension must already exist
        // (a row pointing at a not-yet-minted dir is a spawn-fallback window).
        const dir = piAccountDirFor(userDataDir, minted as string)
        if (!existsSync(dir)) throw new Error('row registered before its agent dir was minted')
        if (!existsSync(piExtensionPath(dir))) throw new Error('row registered before its extension was installed')
        throw new Error('disk full')
      }
    }
    registerWithDeps({ settings: failing })
    await expect(call(IPC.piAccountsAdd)).rejects.toThrow(/disk full/)
    expect(minted).toBeDefined()
    expect(existsSync(piAccountDirFor(userDataDir, minted as string))).toBe(false)
    expect(rows()).toEqual([])
  })

  it('remove deletes the dir (credentials included) and then the row', async () => {
    register()
    const { id, agentDir } = await call(IPC.piAccountsAdd)
    writeAuth(agentDir, { 'openai-codex': { type: 'oauth' } })
    await call(IPC.piAccountsRemove, id)
    expect(existsSync(agentDir)).toBe(false)
    expect(rows()).toEqual([])
    expect(onDisk()).toEqual([])
  })

  it('remove keeps the row when the teardown fails (row LAST, so it stays retryable)', async () => {
    if (process.platform === 'win32') return // chmod-based denial is POSIX semantics
    if (process.getuid?.() === 0) return // root ignores the permission bits this relies on
    register()
    const { id, agentDir } = await call(IPC.piAccountsAdd)
    const root = path.dirname(agentDir)
    const { chmodSync } = await import('fs')
    chmodSync(root, 0o500) // the parent refuses the unlink of <id>
    try {
      await expect(call(IPC.piAccountsRemove, id)).rejects.toThrow()
      expect(rows()).toEqual([id])
    } finally {
      chmodSync(root, 0o700)
    }
  })

  it('remove of an id with no row still tears its dir down (cleans a row-less orphan)', async () => {
    register()
    const orphan = piAccountDirFor(userDataDir, 'orphan-1')
    mkdirSync(orphan, { recursive: true })
    await call(IPC.piAccountsRemove, 'orphan-1')
    expect(existsSync(orphan)).toBe(false)
  })

  it('remove cancels an in-flight login wait for that account', async () => {
    register({ pollMs: 5 })
    const { id } = await call(IPC.piAccountsAdd)
    const waiting = call(IPC.piAccountsWaitLogin, id)
    await new Promise((r) => setTimeout(r, 15))
    await call(IPC.piAccountsRemove, id)
    await expect(waiting).resolves.toBeNull()
  })

  it('remove never deletes anything outside <userData>/pi-accounts', async () => {
    register()
    const sibling = path.join(userDataDir, 'claude-accounts', 'same-id')
    mkdirSync(sibling, { recursive: true })
    await call(IPC.piAccountsRemove, 'same-id')
    expect(existsSync(sibling)).toBe(true)
  })
})
