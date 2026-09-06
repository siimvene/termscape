// `accountFallback` means "the node's account dir could not be found when THIS client attached".
// It is a dir re-check on every path, warm reattach included (a fresh-only version hid a genuine
// fallback after a process restart and was reverted — see `spawnNew`). What fixes the phone
// topology (the Server Edition beside the desktop resolved account dirs under ITS data dir, where
// the desktop's accounts do not live, so every attach to a desktop node raised the flag) is
// `claudeConfigDirForSpawn`: a co-located peer's account dir is used when this instance has none.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import { DEFAULT_SETTINGS } from '../shared/types'
import { sessionName } from './tmux-naming'

/** The env each node-pty spawn received, in order — the observable side of the account choice. */
const spawnEnvs: Array<Record<string, string | undefined>> = []

vi.mock('./session-host-backend', async () =>
  (await import('./__fixtures__/no-session-host')).noSessionHost()
)

vi.mock('node-pty', () => ({
  spawn: (_file: string, _args: string[], opts: { env?: Record<string, string | undefined> }) => {
    spawnEnvs.push({ ...(opts.env ?? {}) })
    return {
      onData: () => {},
      onExit: () => {},
      write: () => {},
      resize: () => {},
      pause: () => {},
      resume: () => {},
      kill: () => {},
      pid: 1
    }
  }
}))

const liveTmuxSessions = new Set<string>()

vi.mock('child_process', () => {
  type Cb = (err: Error | null, res?: { stdout: string; stderr: string }) => void
  const execFile = (_file: string, args: string[], a?: unknown, b?: unknown): unknown => {
    const cb = (typeof a === 'function' ? a : b) as Cb | undefined
    const ok = (stdout: string): void => cb?.(null, { stdout, stderr: '' })
    if (args.includes('has-session')) {
      const target = args[args.indexOf('-t') + 1]
      if (liveTmuxSessions.has(target)) ok('')
      else cb?.(Object.assign(new Error('no such session'), { code: 1 }))
    } else if (args[0] === '-ilc') {
      ok('__NT_PATH_START__/usr/bin:/bin__NT_PATH_END__')
    } else if (args.includes('display-message') && args.includes('#{pane_current_path}')) {
      ok(os.tmpdir())
    } else if (args.some((x) => x.includes('pane_current_command'))) {
      ok('0\tzsh')
    } else {
      ok('')
    }
    return {}
  }
  return { execFile, execFileSync: (): string => '' }
})

vi.mock('./tmux-hint', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tmux-hint')>()),
  findFixedTmux: () => '/usr/bin/tmux'
}))

vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

const CLIENT = 7
const NODE = 'node-account-fallback-1'
const ACCOUNT = 'acct-11111111-2222-3333-4444-555555555555'

describe('accountFallback: a dir re-check at every attach, resolved through the peer', () => {
  let fake: FakePlatform
  let userDataDir: string
  let peerDir: string
  let managers: Array<{ killAll(): Promise<void> }> = []

  beforeEach(() => {
    spawnEnvs.length = 0
    liveTmuxSessions.clear()
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-acct-fb-'))
    peerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-acct-peer-'))
  })
  afterEach(async () => {
    for (const m of managers) await m.killAll()
    managers = []
    vi.restoreAllMocks()
    resetPlatformForTests()
    for (const d of [userDataDir, peerDir]) {
      try {
        fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
      } catch {
        /* a temp dir we could not remove is not a test result */
      }
    }
  })

  async function manager(peerUserDataDir?: string) {
    fake = fakePlatform({ userDataDir, ...(peerUserDataDir ? { peerUserDataDir } : {}) })
    initPlatform(fake)
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager()
    m.init(() => DEFAULT_SETTINGS)
    m.registerIpc()
    managers.push(m)
    return m
  }

  const create = () =>
    fake.handlers[IPC.ptyCreate](CLIENT, {
      cols: 80,
      rows: 24,
      persistKey: NODE,
      agentId: 'claude',
      accountId: ACCOUNT
    }) as Promise<{ sessionId: string; fresh: boolean; accountFallback?: boolean }>

  it('a fresh spawn whose account dir is missing reports the fallback (and does not point at the dead dir)', async () => {
    await manager()
    const r = await create()
    expect(r.fresh).toBe(true)
    expect(r.accountFallback).toBe(true)
    expect(spawnEnvs).toHaveLength(1)
    // Not `toBeUndefined()`: a test process launched from inside a managed-account terminal
    // inherits that account's CLAUDE_CONFIG_DIR, and a system-default spawn leaves the inherited
    // client env alone (the tmux leg strips it; see ACCOUNT_SCOPE_UPDATE_ENV). What must hold is
    // that the fallback did not aim the session at the missing dir.
    expect(spawnEnvs[0].CLAUDE_CONFIG_DIR).not.toBe(path.join(userDataDir, 'claude-accounts', ACCOUNT))
  })

  it('a warm reattach still reports a dir that is missing everywhere (a genuine fallback survives a restart)', async () => {
    await manager()
    liveTmuxSessions.add(sessionName(NODE))
    const r = await create()
    expect(r.fresh).toBe(false)
    expect(r.accountFallback).toBe(true)
  })

  it("a warm reattach reports NOTHING when the dir exists in the co-located peer's userData", async () => {
    fs.mkdirSync(path.join(peerDir, 'claude-accounts', ACCOUNT), { recursive: true })
    await manager(peerDir)
    liveTmuxSessions.add(sessionName(NODE))
    const r = await create()
    expect(r.fresh).toBe(false)
    expect(r.accountFallback).toBeUndefined()
    expect('accountFallback' in r).toBe(false)
  })

  it('a same-process co-attach reports what the attach it joined found (the record is the source)', async () => {
    fs.mkdirSync(path.join(peerDir, 'claude-accounts', ACCOUNT), { recursive: true })
    await manager(peerDir)
    liveTmuxSessions.add(sessionName(NODE))
    const first = await create()
    expect(first.fresh).toBe(false)
    const second = (await fake.handlers[IPC.ptyCreate](CLIENT + 1, {
      cols: 80,
      rows: 24,
      persistKey: NODE,
      agentId: 'claude',
      accountId: ACCOUNT
    })) as { sessionId: string; fresh: boolean; accountFallback?: boolean }
    expect(second.sessionId).toBe(first.sessionId)
    expect(second.fresh).toBe(false)
    expect(second.accountFallback).toBeUndefined()
  })

  it("a fresh spawn resolves the account under a co-located PEER's userData when this instance has none", async () => {
    const peerAccount = path.join(peerDir, 'claude-accounts', ACCOUNT)
    fs.mkdirSync(peerAccount, { recursive: true })
    await manager(peerDir)
    const r = await create()
    expect(r.fresh).toBe(true)
    expect(r.accountFallback).toBeUndefined()
    expect(spawnEnvs).toHaveLength(1)
    expect(spawnEnvs[0].CLAUDE_CONFIG_DIR).toBe(peerAccount)
  })

  it("this instance's OWN account dir wins over the peer's when both exist", async () => {
    const own = path.join(userDataDir, 'claude-accounts', ACCOUNT)
    fs.mkdirSync(own, { recursive: true })
    fs.mkdirSync(path.join(peerDir, 'claude-accounts', ACCOUNT), { recursive: true })
    await manager(peerDir)
    const r = await create()
    expect(r.accountFallback).toBeUndefined()
    expect(spawnEnvs[0].CLAUDE_CONFIG_DIR).toBe(own)
  })
})
