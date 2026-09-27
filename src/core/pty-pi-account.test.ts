/**
 * Managed pi accounts at SPAWN: a pi node bound to a pi account runs pi under that account's
 * PI_CODING_AGENT_DIR — in the client env AND as a local tmux `-e` (the shared server is
 * long-lived, so session env comes from creation args). A missing dir falls back to the system pi
 * with the same `accountFallback` flag the Claude path raises; a pi LOGIN node refuses instead. The
 * name rides ACCOUNT_SCOPE_UPDATE_ENV so a server seeded by one pi account cannot leak it (#419).
 *
 * MUTATION: route a pi node's account through the Claude resolver again → the "no Claude scope"
 * and "no spurious fallback" assertions redden; drop PI_CODING_AGENT_DIR from
 * ACCOUNT_SCOPE_UPDATE_ENV → the update-environment cases redden; delete PRE-FLIGHT 3 → the login
 * refusals spawn onto the system pi instead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import { DEFAULT_SETTINGS, type PtyCreateOptions, type Settings } from '../shared/types'
import { piAccountDirFor } from './pi-config-dir'

/** Every node-pty spawn, in order — the observable side of the account choice. */
const spawns: Array<{ file: string; args: string[]; env: Record<string, string | undefined> }> = []
/** Every tmux CLI call the manager made through execFile (update-environment retrofit etc.). */
const execCalls: string[][] = []

vi.mock('./session-host-backend', async () =>
  (await import('./__fixtures__/no-session-host')).noSessionHost()
)

vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[], opts: { env?: Record<string, string | undefined> }) => {
    spawns.push({ file, args: [...args], env: { ...(opts.env ?? {}) } })
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

vi.mock('child_process', () => {
  type Cb = (err: Error | null, res?: { stdout: string; stderr: string }) => void
  const execFile = (_file: string, args: string[], a?: unknown, b?: unknown): unknown => {
    execCalls.push([...args])
    const cb = (typeof a === 'function' ? a : b) as Cb | undefined
    const ok = (stdout: string): void => cb?.(null, { stdout, stderr: '' })
    if (args.includes('has-session')) {
      cb?.(Object.assign(new Error('no such session'), { code: 1 }))
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
  const execFileSync = (_file: string, args: string[]): string => {
    execCalls.push([...args])
    return ''
  }
  return { execFile, execFileSync }
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
const PI_ACCT = 'pi-11111111-2222-3333-4444-555555555555'

/** The `-e KEY=VALUE` pairs of a tmux new-session argv. */
function tmuxEnvPairs(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length - 1; i++) if (args[i] === '-e') out.push(args[i + 1])
  return out
}

describe('managed pi account env at spawn', () => {
  let fake: FakePlatform
  let userDataDir: string
  let peerDir: string
  let managers: Array<{ killAll(): Promise<void> }> = []

  beforeEach(() => {
    spawns.length = 0
    execCalls.length = 0
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-pi-acct-'))
    peerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-pi-peer-'))
  })
  afterEach(async () => {
    for (const m of managers) await m.killAll()
    managers = []
    resetPlatformForTests()
    for (const d of [userDataDir, peerDir]) fs.rmSync(d, { recursive: true, force: true })
  })

  async function manager(opts: { peer?: string; settings?: Partial<Settings> } = {}) {
    fake = fakePlatform({ userDataDir, ...(opts.peer ? { peerUserDataDir: opts.peer } : {}) })
    initPlatform(fake)
    const { PtyManager } = await import('./pty-manager')
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      piAccounts: [{ id: PI_ACCT, label: 'openai-codex', createdAt: 1 }],
      ...opts.settings
    }
    const m = new PtyManager()
    m.init(() => settings)
    m.registerIpc()
    managers.push(m)
    return m
  }

  const create = (options: Partial<PtyCreateOptions>) =>
    fake.handlers[IPC.ptyCreate](CLIENT, {
      cols: 80,
      rows: 24,
      persistKey: 'node-pi-1',
      cwd: os.tmpdir(),
      ...options
    }) as Promise<{ sessionId: string; fresh: boolean; accountFallback?: boolean }>

  it('a pi node bound to a pi account gets PI_CODING_AGENT_DIR in the env AND as tmux -e', async () => {
    const dir = piAccountDirFor(userDataDir, PI_ACCT)
    fs.mkdirSync(dir, { recursive: true })
    await manager()
    const r = await create({ agentId: 'pi', accountId: PI_ACCT })
    expect(r.accountFallback).toBeUndefined()
    expect(spawns).toHaveLength(1)
    expect(spawns[0].env.PI_CODING_AGENT_DIR).toBe(dir)
    expect(tmuxEnvPairs(spawns[0].args)).toContain(`PI_CODING_AGENT_DIR=${dir}`)
    // A pi id is never looked up as a Claude account: no Claude scope, no Claude `-e`.
    expect(spawns[0].env.CLAUDE_CONFIG_DIR).not.toBe(path.join(userDataDir, 'claude-accounts', PI_ACCT))
    expect(tmuxEnvPairs(spawns[0].args).some((p) => p.startsWith('CLAUDE_CONFIG_DIR='))).toBe(false)
  })

  it('a missing account dir falls back to the system pi and raises accountFallback', async () => {
    await manager()
    const r = await create({ agentId: 'pi', accountId: PI_ACCT })
    expect(r.accountFallback).toBe(true)
    expect(spawns).toHaveLength(1)
    expect(spawns[0].env.PI_CODING_AGENT_DIR).not.toBe(piAccountDirFor(userDataDir, PI_ACCT))
    expect(tmuxEnvPairs(spawns[0].args).some((p) => p.startsWith('PI_CODING_AGENT_DIR='))).toBe(false)
  })

  it("resolves a co-located desktop PEER's account dir when this instance has none", async () => {
    const peerAccount = piAccountDirFor(peerDir, PI_ACCT)
    fs.mkdirSync(peerAccount, { recursive: true })
    await manager({ peer: peerDir })
    const r = await create({ agentId: 'pi', accountId: PI_ACCT })
    expect(r.accountFallback).toBeUndefined()
    expect(spawns[0].env.PI_CODING_AGENT_DIR).toBe(peerAccount)
  })

  it('a traversing (hand-edited) account id resolves nothing and falls back, never a path', async () => {
    await manager()
    const r = await create({ agentId: 'pi', accountId: '../../etc' })
    expect(r.accountFallback).toBe(true)
    expect(tmuxEnvPairs(spawns[0].args).some((p) => p.startsWith('PI_CODING_AGENT_DIR='))).toBe(false)
  })

  it('an UNBOUND pi node sets no account dir (the update-environment strip handles leaks)', async () => {
    await manager()
    const r = await create({ agentId: 'pi' })
    expect(r.accountFallback).toBeUndefined()
    expect(tmuxEnvPairs(spawns[0].args).some((p) => p.startsWith('PI_CODING_AGENT_DIR='))).toBe(false)
  })

  it('a CLAUDE node is untouched by pi scope (its account still resolves as Claude)', async () => {
    const claudeDir = path.join(userDataDir, 'claude-accounts', 'claude-1')
    fs.mkdirSync(claudeDir, { recursive: true })
    await manager()
    await create({ agentId: 'claude', accountId: 'claude-1' })
    expect(spawns[0].env.CLAUDE_CONFIG_DIR).toBe(claudeDir)
    expect(tmuxEnvPairs(spawns[0].args).some((p) => p.startsWith('PI_CODING_AGENT_DIR='))).toBe(false)
  })

  it('a pi LOGIN node (agent-less, piLogin) scopes to the account dir', async () => {
    const dir = piAccountDirFor(userDataDir, PI_ACCT)
    fs.mkdirSync(dir, { recursive: true })
    await manager()
    await create({ piLogin: true, accountId: PI_ACCT })
    expect(spawns).toHaveLength(1)
    expect(spawns[0].env.PI_CODING_AGENT_DIR).toBe(dir)
    expect(tmuxEnvPairs(spawns[0].args)).toContain(`PI_CODING_AGENT_DIR=${dir}`)
  })

  it('a pi LOGIN node REFUSES (spawns nothing) when its dir is missing or no id was given', async () => {
    await manager()
    await expect(create({ piLogin: true, accountId: PI_ACCT })).rejects.toThrow(/pi login/)
    await expect(create({ piLogin: true, persistKey: 'node-pi-2' })).rejects.toThrow(/pi login/)
    expect(spawns).toHaveLength(0)
  })

  // The #419 case proper: a PLAIN terminal (no agent, no account) is the session a seeded server
  // would leak a pi account into, and its client env has no PI_CODING_AGENT_DIR — so the name must
  // reach the server's update-environment from ACCOUNT_SCOPE_UPDATE_ENV itself (a long-lived
  // pre-fix server only learns it from this retrofit), not incidentally from some env key.
  it("retrofits PI_CODING_AGENT_DIR into a long-lived server's update-environment for a PLAIN terminal", async () => {
    const saved = process.env.PI_CODING_AGENT_DIR
    delete process.env.PI_CODING_AGENT_DIR
    try {
      await manager()
      await create({})
      const updateEnv = execCalls.filter((a) => a.includes('set-option') && a.includes('update-environment'))
      expect(updateEnv.some((a) => a.at(-1) === 'PI_CODING_AGENT_DIR')).toBe(true)
      expect(spawns[0].env.PI_CODING_AGENT_DIR).toBeUndefined()
    } finally {
      if (saved !== undefined) process.env.PI_CODING_AGENT_DIR = saved
    }
  })
})

describe('ACCOUNT_SCOPE_UPDATE_ENV carries the pi account name (#419)', () => {
  it('lists PI_CODING_AGENT_DIR, and the LOCAL tmux conf copies/strips it', async () => {
    const { ACCOUNT_SCOPE_UPDATE_ENV, tmuxConf } = await import('./pty-manager')
    expect(ACCOUNT_SCOPE_UPDATE_ENV).toContain('PI_CODING_AGENT_DIR')
    const line = tmuxConf(10000)
      .split('\n')
      .find((l) => !l.startsWith('#') && l.includes('update-environment'))
    expect(line).toContain('PI_CODING_AGENT_DIR')
  })
})
