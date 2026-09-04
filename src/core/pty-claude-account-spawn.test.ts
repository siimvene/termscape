/**
 * Issue #345 — a managed CLAUDE account must not be mistaken for a Codex one.
 *
 * `needsCodexAccountScope` used to answer `agentId === 'codex' || !!accountId`. The two account
 * lists share an id alphabet, so that `!!accountId` proxy also matched every managed CLAUDE id:
 * the spawn entered the fail-closed Codex gate, looked for `~/.nodeterm/cx/<digest>` (a namespace a
 * Claude account never populates), found nothing and REFUSED. Every node bound to a managed Claude
 * account — agent node and `claude /login` terminal alike — returned `unavailable: 'codex-account'`
 * and spawned nothing.
 *
 * MUTATION: make the resolver in pty-manager's two call sites answer `() => true` (i.e. restore the
 * old "any account id is a Codex one" proxy) → the two Claude cases below redden on both the
 * refusal and the spawn count.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import { DEFAULT_SETTINGS } from '../shared/types'
import type { PtyCreateOptions, PtyCreateResult, Settings } from '../shared/types'
import { codexAccountHome } from './codex-accounts-core'
import { accountConfigDir } from './claude-accounts-core'

const spawned: Array<{ file: string; args: string[]; env: Record<string, string> }> = []

vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[], options: { env: Record<string, string> }) => {
    spawned.push({ file, args, env: options?.env ?? {} })
    return {
      onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {},
      pause: () => {}, resume: () => {}, kill: () => {}, pid: 4321
    }
  }
}))
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

const ALICE = 1
const CODEX_ACCT = 'codexacct1'
const CLAUDE_ACCT = 'claudeacct1'

describe('a managed Claude account is not a Codex account (#345)', () => {
  let fake: FakePlatform
  let userDataDir: string

  beforeEach(async () => {
    spawned.length = 0
    userDataDir = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-claude-acct-'))
    fake = fakePlatform({ userDataDir })
    initPlatform(fake)
    const { PtyManager } = await import('./pty-manager')
    // Only the CODEX account is in codexAccounts — the Claude id is deliberately absent, which is
    // exactly what tells the two apart.
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      codexAccounts: [{ id: CODEX_ACCT, label: 'work' }]
    }
    const mgr = new PtyManager()
    mgr.init(() => settings)
    mgr.registerIpc()
  })
  afterEach(() => {
    resetPlatformForTests()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  const create = (options: Partial<PtyCreateOptions>) =>
    fake.handlers[IPC.ptyCreate](ALICE, {
      cols: 80, rows: 24, persistKey: 'node-1', cwd: '/srv/app', ...options
    }) as Promise<PtyCreateResult>

  it('a Claude AGENT node bound to a managed Claude account SPAWNS', async () => {
    // The Claude account's config dir exists — the Claude path falls back with a warning chip
    // when it does not, which would hide the refusal this test is about.
    mkdirSync(accountConfigDir(userDataDir, CLAUDE_ACCT), { recursive: true })
    const res = await create({ agentId: 'claude', accountId: CLAUDE_ACCT })
    expect(res.unavailable).toBeUndefined()
    expect(spawned).toHaveLength(1)
    // It is a Claude scope, not a Codex one.
    expect(spawned[0].env.CLAUDE_CONFIG_DIR).toContain(CLAUDE_ACCT)
    expect(spawned[0].env.CODEX_HOME).toBeUndefined()
  })

  it('the agent-less `claude /login` terminal SPAWNS', async () => {
    const res = await create({ accountId: CLAUDE_ACCT, persistKey: 'node-2' })
    expect(res.unavailable).toBeUndefined()
    expect(spawned).toHaveLength(1)
    expect(spawned[0].env.CODEX_HOME).toBeUndefined()
  })

  it('the agent-less `codex login` terminal STILL gets the managed Codex scope', async () => {
    mkdirSync(codexAccountHome(userDataDir, CODEX_ACCT), { recursive: true })
    const res = await create({ accountId: CODEX_ACCT, persistKey: 'node-3' })
    expect(res.unavailable).toBeUndefined()
    expect(spawned).toHaveLength(1)
    expect(spawned[0].env.CODEX_HOME).toBe(codexAccountHome(userDataDir, CODEX_ACCT))
    expect(spawned[0].env.NODETERM_CODEX_ACCOUNT_ID).toBe(CODEX_ACCT)
  })

  it('a Codex AGENT node still fails closed on a missing managed home', async () => {
    const res = await create({ agentId: 'codex', accountId: CODEX_ACCT, persistKey: 'node-4' })
    expect(res.unavailable).toBe('codex-account')
    expect(spawned).toHaveLength(0)
  })
})

/**
 * The `codex login` intent (`PtyCreateOptions.codexLogin`) carried by a Codex login node. The whole
 * point is the settings RACE: a freshly minted account id has not yet reached the `codexAccounts`
 * list the spawn consults (`isCodexAccount`), so the login node has no agentId AND no list match.
 * Without the intent, `needsCodexAccountScope` answered `false` and `codex login` spawned UNSCOPED,
 * writing the user's SYSTEM `~/.codex`. With it, scope is forced and REQUIRED.
 *
 * MUTATION: drop `options.codexLogin` from either pty-manager call site (i.e. stop honoring the
 * intent) → the "not yet in settings" cases below stop scoping and stop refusing, and the two
 * refusal assertions redden. Drop `requireManagedAccount` from resolveCodexSessionScope's no-id
 * branch → the "no account id" case spawns onto the system home instead of refusing.
 */
describe('the codex login intent scopes fail-closed against the settings race', () => {
  let fake: FakePlatform
  let userDataDir: string
  // Deliberately NOT in the codexAccounts settings list below — the registration race the intent
  // exists to survive.
  const RACY_ACCT = 'racycodexid1'

  beforeEach(async () => {
    spawned.length = 0
    userDataDir = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-codex-login-'))
    fake = fakePlatform({ userDataDir })
    initPlatform(fake)
    const { PtyManager } = await import('./pty-manager')
    // The account being logged in is absent from settings on purpose (the debounce/relay/two-tab
    // race). Only an UNRELATED account is present, to prove the list is not what unlocks scope.
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      codexAccounts: [{ id: CODEX_ACCT, label: 'other' }]
    }
    const mgr = new PtyManager()
    mgr.init(() => settings)
    mgr.registerIpc()
  })
  afterEach(() => {
    resetPlatformForTests()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  const create = (options: Partial<PtyCreateOptions>) =>
    fake.handlers[IPC.ptyCreate](ALICE, {
      cols: 80, rows: 24, persistKey: 'login-1', cwd: '/srv/app', ...options
    }) as Promise<PtyCreateResult>

  it('scopes to the managed home even though the id is not yet in settings (home exists)', async () => {
    // The home is created at add-time (initializeAccountHome mkdir), BEFORE the login node opens.
    mkdirSync(codexAccountHome(userDataDir, RACY_ACCT), { recursive: true })
    const res = await create({ codexLogin: true, accountId: RACY_ACCT })
    expect(res.unavailable).toBeUndefined()
    expect(spawned).toHaveLength(1)
    expect(spawned[0].env.CODEX_HOME).toBe(codexAccountHome(userDataDir, RACY_ACCT))
    expect(spawned[0].env.NODETERM_CODEX_ACCOUNT_ID).toBe(RACY_ACCT)
  })

  it('REFUSES and spawns nothing when the managed home cannot be resolved', async () => {
    // The short home was deliberately NOT created — an unresolvable scope. The intent turns this
    // into a visible refusal rather than an unscoped `codex login` onto ~/.codex.
    const res = await create({ codexLogin: true, accountId: RACY_ACCT })
    expect(res.unavailable).toBe('codex-account')
    expect(spawned).toHaveLength(0)
  })

  it('REFUSES a login intent with no account id rather than spawn onto the system ~/.codex', async () => {
    const res = await create({ codexLogin: true })
    expect(res.unavailable).toBe('codex-account')
    expect(spawned).toHaveLength(0)
  })

  it('WITHOUT the intent the same unregistered login spawns UNSCOPED (the bug it fixes)', async () => {
    // No intent, no agentId, id not in settings ⇒ the old behaviour: it spawns, and nothing scopes
    // CODEX_HOME, so `codex login` would land on the user's system home. This is the hazard the
    // intent closes — pinned here so a regression that silently drops scope is visible.
    const res = await create({ accountId: RACY_ACCT })
    expect(res.unavailable).toBeUndefined()
    expect(spawned).toHaveLength(1)
    expect(spawned[0].env.CODEX_HOME).toBeUndefined()
  })
})
