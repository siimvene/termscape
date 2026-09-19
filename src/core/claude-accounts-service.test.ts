/**
 * Issue #313 — the managed-Claude-account LIFECYCLE lives in core, so both shells serve it.
 *
 * Every one of these cases drives the shipped registration through the platform seam
 * (`fakePlatform().handlers[...]`), i.e. exactly what `ipcMain.handle` / the server's WS dispatch
 * invoke. Registering with NO deps is the Server Edition's own configuration: no canvas skill
 * (canvas control is not wired there) and no SSH manager, so a ctx carrying a projectId must still
 * take the local path.
 *
 * MUTATION: drop the `installSkill` call, or let `remoteFor` treat a projectId alone as remote →
 * the skill case and the local-fallback case redden.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import {
  registerClaudeAccountsIpc as registerWithDeps,
  installHooksIntoLocalAccounts,
  type ClaudeAccountsDeps
} from './claude-accounts-service'
import { accountConfigDir } from './claude-accounts-core'
import { SettingsStore } from './settings-store'
import {
  registerClaudeAccountsSource,
  resetClaudeAccountsSourceForTests
} from './claude-config-dir'
import { NEW_CLAUDE_ACCOUNT_LABEL, type Settings, type ClaudeAccount } from '../shared/types'

// The hook + TUI writers are exercised by their own suites; here they only have to be OBSERVED,
// and a real write would touch the account dir this file then asserts about.
const installed: string[] = []
const tui: string[] = []
vi.mock('./agents/hooks/claude', () => ({
  installClaudeHooksInto: (dir: string) => {
    installed.push(dir)
  },
  ensureClaudeFullscreenTuiInto: async (dir: string) => {
    tui.push(dir)
  }
}))

// Same reason as the hook writers above, with one addition: the real applier resolves the SYSTEM
// skills dir from `os.homedir()`, so an unmocked sweep in this suite would read the developer's own
// `~/.claude/skills`. Its behaviour is covered against a real filesystem in
// `claude-skill-share.test.ts`; here we only assert the WIRING (issue #643).
const shared: { dir: string; enabled: boolean }[] = []
vi.mock('./claude-skill-share', () => ({
  EMPTY_SKILL_SHARE: { linked: 0, unlinked: 0, shared: 0, occupied: 0, failed: 0 },
  applySkillShare: async (dir: string, enabled: boolean) => {
    shared.push({ dir, enabled })
    return { linked: enabled ? 2 : 0, unlinked: 0, shared: enabled ? 2 : 0, occupied: 0, failed: 0 }
  }
}))

let fake: FakePlatform
let userDataDir: string
let settings: SettingsStore
/** Registers with the real settings store over the temp dir (the row's home) plus `deps`. */
const registerClaudeAccountsIpc = (deps: Omit<ClaudeAccountsDeps, 'settings'> = {}): void =>
  registerWithDeps({ settings, ...deps })

const call = (channel: string, ...args: unknown[]): Promise<any> =>
  Promise.resolve(fake.handlers[channel](...args))

beforeEach(() => {
  installed.length = 0
  tui.length = 0
  shared.length = 0
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'nt-accounts-'))
  fake = fakePlatform({ userDataDir })
  initPlatform(fake)
  settings = new SettingsStore()
  settings.init()
})
afterEach(() => {
  resetPlatformForTests()
  resetClaudeAccountsSourceForTests()
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('registerClaudeAccountsIpc — the six channels', () => {
  it('registers exactly the six claude-accounts channels', () => {
    registerClaudeAccountsIpc()
    expect(Object.keys(fake.handlers).sort()).toEqual(
      [
        IPC.claudeAccountsAdd,
        IPC.claudeAccountsCancelWait,
        IPC.claudeAccountsLink,
        IPC.claudeAccountsRemove,
        IPC.claudeAccountsSetSkillSharing,
        IPC.claudeAccountsWaitLogin
      ].sort()
    )
  })

  it('add() creates the config dir under userData, installs the hook and returns the id', async () => {
    const skilled: string[] = []
    registerClaudeAccountsIpc({ installSkill: (d) => skilled.push(d) })
    const res = await call(IPC.claudeAccountsAdd)
    expect(res.id).toMatch(/^[A-Za-z0-9-]+$/)
    expect(res.configDir).toBe(accountConfigDir(userDataDir, res.id))
    expect(existsSync(res.configDir)).toBe(true)
    expect(installed).toEqual([res.configDir])
    expect(skilled).toEqual([res.configDir])
    expect(tui).toEqual([res.configDir])
  })

  it('add() without an installSkill dep (the Server Edition) writes no skill', async () => {
    registerClaudeAccountsIpc()
    const res = await call(IPC.claudeAccountsAdd)
    expect(existsSync(res.configDir)).toBe(true)
    expect(installed).toEqual([res.configDir])
  })

  it('waitLogin resolves once .claude.json carries an oauthAccount email', async () => {
    registerClaudeAccountsIpc({ pollMs: 5 })
    const { id, configDir } = await call(IPC.claudeAccountsAdd)
    const pending = call(IPC.claudeAccountsWaitLogin, id)
    setTimeout(() => {
      writeFileSync(
        path.join(configDir, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'a@b.com' } })
      )
    }, 20)
    await expect(pending).resolves.toEqual({ email: 'a@b.com' })
  })

  it('cancelWaitLogin makes an in-flight wait resolve null', async () => {
    registerClaudeAccountsIpc({ pollMs: 5 })
    const { id } = await call(IPC.claudeAccountsAdd)
    const pending = call(IPC.claudeAccountsWaitLogin, id)
    await new Promise((r) => setTimeout(r, 20))
    await call(IPC.claudeAccountsCancelWait, id)
    await expect(pending).resolves.toBeNull()
  })

  // Consort finding (cross-vendor review of the upstream merge). The launch heal and a Retry
  // click legitimately run two concurrent waits for one account, so a single-slot waiters map is
  // reachable, not theoretical: the second `set(id, w)` overwrote the first, leaving cancel able
  // to reach only the newest — the orphan then polled the full LOGIN_TIMEOUT_MS (5 min),
  // uncancellable, and repeated calls accumulated pollers. Desktop carried the Set-per-id fix;
  // core — which is what the Server Edition serves — did not. Against the single-slot map the
  // first wait is never cancelled and this test times out rather than failing an assertion.
  it('cancelWaitLogin cancels EVERY concurrent wait for one id, not just the newest', async () => {
    registerClaudeAccountsIpc({ pollMs: 5 })
    const { id } = await call(IPC.claudeAccountsAdd)
    const first = call(IPC.claudeAccountsWaitLogin, id)
    const second = call(IPC.claudeAccountsWaitLogin, id)
    await new Promise((r) => setTimeout(r, 20))
    await call(IPC.claudeAccountsCancelWait, id)
    await expect(Promise.all([first, second])).resolves.toEqual([null, null])
  })

  it('remove() deletes the account dir', async () => {
    registerClaudeAccountsIpc()
    const { id, configDir } = await call(IPC.claudeAccountsAdd)
    writeFileSync(path.join(configDir, '.credentials.json'), '{}')
    await call(IPC.claudeAccountsRemove, id)
    expect(existsSync(configDir)).toBe(false)
  })

  it('a traversing id is refused, not resolved outside the accounts root', async () => {
    registerClaudeAccountsIpc({ pollMs: 5 })
    await expect(call(IPC.claudeAccountsRemove, '../x')).rejects.toThrow(/invalid account id/)
    await expect(call(IPC.claudeAccountsWaitLogin, '../x')).rejects.toThrow(/invalid account id/)
  })
})

describe('the remote leg is resolved lazily, and its absence falls back to LOCAL', () => {
  it('a ctx with a projectId takes the remote leg when one is wired', async () => {
    const calls: string[] = []
    registerClaudeAccountsIpc({
      pollMs: 5,
      remote: () => ({
        add: async (projectId, id) => {
          calls.push(`add:${projectId}:${id}`)
          return { configDir: `~/.nodeterm/claude-accounts/${id}`, versionSupported: true }
        },
        readLogin: async () => JSON.stringify({ oauthAccount: { email: 'r@h.com' } }),
        remove: async (projectId, id) => {
          calls.push(`rm:${projectId}:${id}`)
          return true // teardown confirmed on the (connected) host
        },
        hostKey: (projectId) => (projectId === 'p1' ? 'me@box' : undefined)
      })
    })
    const res = await call(IPC.claudeAccountsAdd, { projectId: 'p1', host: 'renderer@says' })
    expect(res.configDir).toBe(`~/.nodeterm/claude-accounts/${res.id}`)
    // The row is pinned to the host the MANAGER names, not the one the renderer sent.
    expect(res.account.host).toBe('me@box')
    expect(settings.get().claudeAccounts).toEqual([res.account])
    // Nothing local was created or installed for a remote account.
    expect(existsSync(accountConfigDir(userDataDir, res.id))).toBe(false)
    expect(installed).toEqual([])
    await expect(call(IPC.claudeAccountsWaitLogin, res.id, { projectId: 'p1' })).resolves.toEqual({
      email: 'r@h.com'
    })
    await call(IPC.claudeAccountsRemove, res.id, { projectId: 'p1' })
    expect(calls).toEqual([`add:p1:${res.id}`, `rm:p1:${res.id}`])
    expect(settings.get().claudeAccounts).toEqual([])
  })

  it('a remote add whose project is not connected still registers the pending row under the renderer\'s host', async () => {
    registerClaudeAccountsIpc({
      remote: () => ({
        add: async () => null, // not connected: nothing minted anywhere
        readLogin: async () => null,
        remove: async () => false,
        hostKey: () => undefined
      })
    })
    const res = await call(IPC.claudeAccountsAdd, { projectId: 'p1', host: 'me@box' })
    expect(res.configDir).toBe('')
    expect(res.account).toMatchObject({ id: res.id, host: 'me@box', pending: true })
    expect(existsSync(accountConfigDir(userDataDir, res.id))).toBe(false)
  })

  it('a ctx with a projectId but NO wired remote takes the local path (Server Edition)', async () => {
    registerClaudeAccountsIpc({ remote: () => undefined })
    // A renderer `host` on a LOCAL add is ignored: the dir was minted here, so the row says so.
    const res = await call(IPC.claudeAccountsAdd, { projectId: 'p1', host: 'me@box' })
    expect(res.configDir).toBe(accountConfigDir(userDataDir, res.id))
    expect(existsSync(res.configDir)).toBe(true)
    expect(res.account.host).toBeUndefined()
  })
})

// Row MEMBERSHIP is this module's, written through the store's read-modify-write inside the same
// verb that mints / tears down the config dir — the same ownership `codex-accounts-service.ts`
// has. Before this the renderer appended the row to its OWN snapshot and full-saved it, so two
// browser tabs adding at once left the later save the winner: one logged-in config dir on disk
// with no row pointing at it.
//
// MUTATIONS:
//  - return from `add` before the `mutate` ⇒ the two-tabs case reddens (a dir with no row).
//  - drop the rollback in `add`'s catch ⇒ the failed-persist case reddens (an orphan is left).
//  - delete the row before the dir in `remove` ⇒ the row-last case reddens.
//  - let a snapshot rewrite `host` in the store ⇒ the relay-host case reddens (dir survives).
describe('claude-accounts — the shell owns row membership', () => {
  const rows = (): string[] => settings.get().claudeAccounts.map((a) => a.id)
  const onDisk = (): string[] =>
    (JSON.parse(readFileSync(path.join(userDataDir, 'settings.json'), 'utf-8')) as Settings)
      .claudeAccounts.map((a) => a.id)

  it('add registers a pending row in settings and returns it; the row is on disk before add resolves', async () => {
    registerClaudeAccountsIpc()
    const { id, configDir, account } = await call(IPC.claudeAccountsAdd)
    expect(account).toMatchObject({ id, label: NEW_CLAUDE_ACCOUNT_LABEL, pending: true })
    expect(typeof account.createdAt).toBe('number')
    expect(account.host).toBeUndefined()
    expect(settings.get().claudeAccounts).toEqual([account])
    expect(onDisk()).toEqual([id])
    expect(existsSync(configDir)).toBe(true)
  })

  it('two concurrent adds (two browser tabs) both keep their rows AND their dirs', async () => {
    registerClaudeAccountsIpc()
    const [a, b] = await Promise.all([call(IPC.claudeAccountsAdd), call(IPC.claudeAccountsAdd)])
    expect(rows().sort()).toEqual([a.id, b.id].sort())
    expect(onDisk().sort()).toEqual([a.id, b.id].sort())
    expect(existsSync(a.configDir)).toBe(true)
    expect(existsSync(b.configDir)).toBe(true)
  })

  it('a label edit from a snapshot taken before a concurrent add does not drop the added row', async () => {
    registerClaudeAccountsIpc()
    const { id: first } = await call(IPC.claudeAccountsAdd)
    const staleSnapshot = settings.get()
    const { id: second } = await call(IPC.claudeAccountsAdd)
    await settings.save({
      ...staleSnapshot,
      claudeAccounts: staleSnapshot.claudeAccounts.map((a) => ({ ...a, label: 'work' }))
    })
    expect(rows()).toEqual([first, second])
    expect(onDisk()).toEqual([first, second])
    expect(settings.get().claudeAccounts[0].label).toBe('work')
  })

  it('add tears the minted dir down again when the row cannot be persisted (no orphan, no row)', async () => {
    let minted: string | undefined
    const failing = {
      get: () => settings.get(),
      readAccountsFromDisk: async () => settings.get(),
      mutate: async (fn: (s: Settings) => Settings) => {
        minted = fn(settings.get()).claudeAccounts[0]?.id
        throw new Error('disk full')
      }
    }
    registerWithDeps({ settings: failing })
    await expect(call(IPC.claudeAccountsAdd)).rejects.toThrow(/disk full/)
    expect(minted).toBeDefined()
    expect(existsSync(accountConfigDir(userDataDir, minted as string))).toBe(false)
    expect(rows()).toEqual([])
  })

  it('remove deletes the row LAST: the row is gone only once the dir is', async () => {
    registerClaudeAccountsIpc()
    const { id, configDir } = await call(IPC.claudeAccountsAdd)
    await call(IPC.claudeAccountsRemove, id)
    expect(existsSync(configDir)).toBe(false)
    expect(rows()).toEqual([])
    expect(onDisk()).toEqual([])
  })

  // CRITICAL: a remote row can only be removed once teardown on its host is CONFIRMED. With no
  // remote leg wired (disconnected / SSH not available), removal must KEEP the row (visible +
  // retryable) and error — never delete the row while an authenticated dir survives on the host —
  // and it must never touch the local fs for a host-bearing row.
  it('remove of a REMOTE row (host set) with no remote leg keeps the row, errors, and never deletes a local dir', async () => {
    registerClaudeAccountsIpc()
    await settings.mutate((s) => ({
      ...s,
      claudeAccounts: [
        ...s.claudeAccounts,
        { id: 'remote-1', label: 'box', host: 'me@box', pending: true, createdAt: 1 }
      ]
    }))
    // A local dir under that id would belong to someone else's mint; it must survive.
    const stray = accountConfigDir(userDataDir, 'remote-1')
    mkdirSync(stray, { recursive: true })
    await expect(call(IPC.claudeAccountsRemove, 'remote-1')).rejects.toThrow(/remote host/)
    expect(existsSync(stray)).toBe(true)
    expect(rows()).toEqual(['remote-1'])
  })

  // CRITICAL: a remote leg that reports teardown UNCONFIRMED (`remove(...) === false`, which the SSH
  // primitive returns for BOTH "not connected" AND a non-zero remote `rm`) must leave the row and
  // surface a reach-the-host error. The pre-fix code deleted the row regardless, stranding the
  // credential dir on the host with no retry path.
  it('a remote remove whose teardown is unconfirmed keeps the row and errors', async () => {
    let tornDownConfirms = false
    registerClaudeAccountsIpc({
      remote: () => ({
        add: async (_p, id) => ({ configDir: `~/.nodeterm/claude-accounts/${id}`, versionSupported: true }),
        readLogin: async () => null,
        // First a disconnected/failed teardown (false), then a confirmed one (true).
        remove: async () => tornDownConfirms,
        hostKey: () => 'me@box'
      })
    })
    const res = await call(IPC.claudeAccountsAdd, { projectId: 'p1', host: 'me@box' })
    await expect(call(IPC.claudeAccountsRemove, res.id, { projectId: 'p1' })).rejects.toThrow(
      /Could not reach me@box/
    )
    expect(rows()).toEqual([res.id]) // row kept — the removal is retryable
    // Reconnect / the host answers: a confirmed teardown now deletes the row.
    tornDownConfirms = true
    await call(IPC.claudeAccountsRemove, res.id, { projectId: 'p1' })
    expect(rows()).toEqual([])
  })

  // SERIOUS: provenance is the ROW's shell-owned `host`, never the renderer ctx. A forged/buggy ctx
  // that routes a LOCAL row's removal through a connected SSH project must be REFUSED — never skip
  // the local home (which would delete the row and orphan an authenticated dir on THIS machine).
  it('a remove ctx claiming a remote project for a LOCAL row is refused; the local dir is not skipped', async () => {
    registerClaudeAccountsIpc({
      remote: () => ({
        add: async () => null,
        readLogin: async () => null,
        remove: async () => true,
        hostKey: () => 'me@box' // ctx.projectId 'p1' resolves to a connected remote host
      })
    })
    const { id, configDir } = await call(IPC.claudeAccountsAdd) // LOCAL add (no ctx): row.host unset
    await expect(call(IPC.claudeAccountsRemove, id, { projectId: 'p1' })).rejects.toThrow(
      /local but its project is remote/
    )
    expect(existsSync(configDir)).toBe(true)
    expect(rows()).toEqual([id])
  })

  it('remove of an id with no row still tears its local dir down (cleans a pre-fix orphan)', async () => {
    registerClaudeAccountsIpc()
    const orphan = accountConfigDir(userDataDir, 'orphan-1')
    mkdirSync(orphan, { recursive: true })
    await call(IPC.claudeAccountsRemove, 'orphan-1')
    expect(existsSync(orphan)).toBe(false)
  })

  // The SERIOUS finding: `settings:save` is relay-reachable, so a peer's snapshot that stamps a
  // `host` onto a local row would make this verb skip the local dir on removal — a logged-in
  // credential left on disk while the UI reports the account gone. The store keeps `host` from
  // its own row, so the snapshot changes nothing and the dir is deleted.
  it('a snapshot cannot dress a local row up as remote to make remove skip its dir', async () => {
    registerClaudeAccountsIpc()
    const { id, configDir } = await call(IPC.claudeAccountsAdd)
    await settings.save({
      ...settings.get(),
      claudeAccounts: settings.get().claudeAccounts.map((a) => ({ ...a, host: 'evil@peer' }))
    })
    expect(settings.get().claudeAccounts[0].host).toBeUndefined()
    await call(IPC.claudeAccountsRemove, id)
    expect(existsSync(configDir)).toBe(false)
    expect(rows()).toEqual([])
  })
})

describe('installHooksIntoLocalAccounts', () => {
  it('installs into every LOCAL account dir and skips host-scoped ones', () => {
    const extra: string[] = []
    installHooksIntoLocalAccounts(
      [{ id: 'aaa' }, { id: 'bbb', host: 'user@example' }, { id: 'ccc' }],
      (d) => extra.push(d)
    )
    const dirs = ['aaa', 'ccc'].map((id) => accountConfigDir(userDataDir, id))
    expect(installed).toEqual(dirs)
    expect(extra).toEqual(dirs)
    expect(tui).toEqual(dirs)
  })

  it('one failing account never stops the rest (boot must not be blocked)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mkdirSync(path.join(userDataDir, 'claude-accounts'), { recursive: true })
    installHooksIntoLocalAccounts([{ id: 'aaa' }, { id: '../evil' }, { id: 'ccc' }])
    expect(installed).toEqual(
      ['aaa', 'ccc'].map((id) => accountConfigDir(userDataDir, id))
    )
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  // Issue #643. The launch sweep re-links (a skill added to ~/.claude/skills since the last run)
  // and NEVER removes: ownership is inferred from a link's shape, so an OFF pass here could delete
  // an identical link the user made by hand in their own linked-account dir. Removal happens only
  // where the user asked for it, in `setSkillSharing`.
  it('re-links shared skills for local accounts that opted in, and touches no other account', () => {
    installHooksIntoLocalAccounts([
      { id: 'aaa', shareSystemSkills: true },
      { id: 'bbb', host: 'user@example', shareSystemSkills: true },
      { id: 'ccc' },
      { id: 'ddd', shareSystemSkills: false }
    ])
    expect(shared).toEqual([{ dir: accountConfigDir(userDataDir, 'aaa'), enabled: true }])
  })
})

describe('claudeAccounts.setSkillSharing', () => {
  it('reconciles the account dir and reports what happened', async () => {
    registerClaudeAccountsIpc()
    const res = await call(IPC.claudeAccountsSetSkillSharing, 'aaa', true)
    expect(shared).toEqual([{ dir: accountConfigDir(userDataDir, 'aaa'), enabled: true }])
    expect(res).toMatchObject({ linked: 2, shared: 2 })
  })

  // A remote account's config dir is on its HOST; reconciling the local one would link this
  // machine's skills into a directory the session never reads. v1 refuses instead of guessing.
  it('refuses a remote (SSH) account and touches no filesystem', async () => {
    registerClaudeAccountsSource(() => [
      { id: 'aaa', label: 'r', host: 'user@example', createdAt: 0 } as ClaudeAccount
    ])
    registerClaudeAccountsIpc()
    const res = await call(IPC.claudeAccountsSetSkillSharing, 'aaa', true)
    expect(res.refused).toBe('remote-account')
    expect(shared).toEqual([])
  })

  it('refuses an id that could traverse out of the accounts root', async () => {
    registerClaudeAccountsIpc()
    await expect(call(IPC.claudeAccountsSetSkillSharing, '../evil', true)).rejects.toThrow()
    expect(shared).toEqual([])
  })
})

// ---- Linked accounts (adopting a config dir the user already drives) -------------------------
//
// A linked account is a config dir the USER already owns (`~/.claude-2` driven by their own
// `CLAUDE_CONFIG_DIR` shell function). Two properties matter more than the rest and are pinned
// against REAL temp directories rather than mocks: the validation actually refuses each bad shape,
// and removing a linked account never deletes anything.
describe('claudeAccounts.link', () => {
  let linkDir = ''
  beforeEach(() => {
    linkDir = mkdtempSync(path.join(os.tmpdir(), 'nt-linked-'))
    registerClaudeAccountsIpc()
  })
  afterEach(() => rmSync(linkDir, { recursive: true, force: true }))

  it('links an existing dir: id + normalized path + email, hook and TUI installed into it', async () => {
    writeFileSync(
      path.join(linkDir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'second@example.com' } })
    )
    const res = await call(IPC.claudeAccountsLink, `${linkDir}/`)
    expect(res.id).toMatch(/^[A-Za-z0-9-]+$/)
    expect(res.configDir).toBe(linkDir) // trailing slash normalized away
    expect(res.email).toBe('second@example.com')
    // The same two writes an ADDED account gets — or the linked identity reports no agent status.
    expect(installed).toEqual([linkDir])
    expect(tui).toEqual([linkDir])
  })

  it('is email: null — not a failure — when the dir is not signed in yet', async () => {
    await expect(call(IPC.claudeAccountsLink, linkDir)).resolves.toMatchObject({ email: null })
    writeFileSync(path.join(linkDir, '.claude.json'), 'not json at all')
    await expect(call(IPC.claudeAccountsLink, linkDir)).resolves.toMatchObject({ email: null })
    writeFileSync(path.join(linkDir, '.claude.json'), JSON.stringify({ oauthAccount: {} }))
    await expect(call(IPC.claudeAccountsLink, linkDir)).resolves.toMatchObject({ email: null })
  })

  it('expands a leading ~ (the value is typed, not shell-expanded by anything else)', async () => {
    // Proved through the REFUSAL rather than by linking something inside the real home: the
    // message names the path we actually resolved, so an unexpanded `~` would read as
    // `No such directory: ~/nodeterm-link-probe` and this assertion would fail.
    await expect(call(IPC.claudeAccountsLink, '~/nodeterm-link-probe-does-not-exist')).rejects.toThrow(
      `No such directory: ${path.join(os.homedir(), 'nodeterm-link-probe-does-not-exist')}`
    )
    // A bare `~` is the home dir itself; `~evil` is NOT a home-relative path and stays literal
    // (so it is refused as relative, never resolved against $HOME).
    await expect(call(IPC.claudeAccountsLink, '~notauser/.claude-2')).rejects.toThrow(
      /Not an absolute path/
    )
  })

  it('refuses a relative path, a `..` path, and a non-string', async () => {
    for (const bad of ['.claude-2', '../.claude-2', 'claude', '', '   ']) {
      await expect(call(IPC.claudeAccountsLink, bad)).rejects.toThrow()
    }
    await expect(call(IPC.claudeAccountsLink, 42 as unknown as string)).rejects.toThrow()
    expect(installed).toEqual([]) // nothing was written for any refusal
  })

  it('refuses the system ~/.claude by name, without stat-ing anything', async () => {
    await expect(call(IPC.claudeAccountsLink, path.join(os.homedir(), '.claude'))).rejects.toThrow(
      /system Claude config dir/
    )
    // Same dir spelled differently must give the same refusal — both sides go through one
    // normalizer (CONTRIBUTING: normalize BOTH sides of a path comparison).
    await expect(
      call(IPC.claudeAccountsLink, path.join(os.homedir(), 'x', '..', '.claude') + '/')
    ).rejects.toThrow(/system Claude config dir/)
  })

  it('refuses a nodeterm-managed account dir (one dir must not have two account ids)', async () => {
    const managed = accountConfigDir(userDataDir, 'abc')
    mkdirSync(managed, { recursive: true })
    await expect(call(IPC.claudeAccountsLink, managed)).rejects.toThrow(/nodeterm-managed/)
    await expect(call(IPC.claudeAccountsLink, path.join(userDataDir, 'claude-accounts'))).rejects.toThrow(
      /nodeterm-managed/
    )
  })

  it('refuses a dir already linked — by NORMALIZED path, not by the string typed', async () => {
    registerClaudeAccountsSource(() => [
      { id: 'existing', label: 'first', configDir: linkDir, createdAt: 0 } as ClaudeAccount
    ])
    await expect(call(IPC.claudeAccountsLink, `${linkDir}/`)).rejects.toThrow(/already linked/)
    await expect(call(IPC.claudeAccountsLink, path.join(linkDir, 'x', '..'))).rejects.toThrow(
      /already linked/
    )
  })

  it('refuses a path that does not exist, and a path that is a FILE', async () => {
    await expect(call(IPC.claudeAccountsLink, path.join(linkDir, 'nope'))).rejects.toThrow(
      /No such directory/
    )
    const file = path.join(linkDir, 'a-file')
    writeFileSync(file, 'x')
    await expect(call(IPC.claudeAccountsLink, file)).rejects.toThrow(/Not a directory/)
    expect(installed).toEqual([])
  })
})

describe('removing a LINKED account never deletes the directory', () => {
  it('forgets the record and leaves a REAL directory (and its contents) on disk', async () => {
    const linkDir = mkdtempSync(path.join(os.tmpdir(), 'nt-linked-rm-'))
    const credentials = path.join(linkDir, '.credentials.json')
    writeFileSync(credentials, '{"token":"the user\'s own login"}')
    try {
      registerClaudeAccountsIpc()
      const res = await call(IPC.claudeAccountsLink, linkDir)
      registerClaudeAccountsSource(() => [
        { id: res.id, label: 'second', configDir: linkDir, createdAt: 0 } as ClaudeAccount
      ])
      await call(IPC.claudeAccountsRemove, res.id)
      // THE assertion of this whole work package: the dir is the user's, and it is still there.
      expect(existsSync(linkDir)).toBe(true)
      expect(existsSync(credentials)).toBe(true)
      // …and no managed dir was invented and deleted in its place either.
      expect(existsSync(accountConfigDir(userDataDir, res.id))).toBe(false)
    } finally {
      rmSync(linkDir, { recursive: true, force: true })
    }
  })

  it('still deletes a MANAGED dir — the rm path is unchanged for the accounts nodeterm created', async () => {
    registerClaudeAccountsIpc()
    const { id, configDir } = await call(IPC.claudeAccountsAdd)
    // A settings list that mentions the id but carries NO configDir must not turn off the delete.
    registerClaudeAccountsSource(() => [{ id, label: 'm', createdAt: 0 } as ClaudeAccount])
    await call(IPC.claudeAccountsRemove, id)
    expect(existsSync(configDir)).toBe(false)
  })
})

describe('installHooksIntoLocalAccounts covers linked accounts', () => {
  it('installs into the linked dir, not into a managed dir that does not exist', () => {
    registerClaudeAccountsSource(() => [
      { id: 'linked', label: 'l', configDir: '/home/u/.claude-2', createdAt: 0 } as ClaudeAccount
    ])
    installHooksIntoLocalAccounts([{ id: 'linked' }, { id: 'managed' }])
    expect(installed).toEqual(['/home/u/.claude-2', accountConfigDir(userDataDir, 'managed')])
  })
})
