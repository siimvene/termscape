// Impure lifecycle for machine-scoped managed Codex accounts: private CODEX_HOME creation, the
// per-account app-server daemon, the device-login poll, identity reads and race/use-safe removal.
// The account LIST is renderer-owned in `settings.json` (`codexAccounts`); this module owns only
// the filesystem and the daemon.
//
// Lives in core so BOTH shells serve it — the same move `claude-accounts-service.ts` made for
// issue #313. Before this the five verbs were registered only by src/main, so the Server Edition's
// bridge answered E_UNSUPPORTED for every one of them: a browser-only deployment could SELECT a
// managed Codex account (env injection, the usage fan-out and the pickers are all core already)
// but could never create, log into or remove one.
//
// WHAT DID NOT MOVE, and why: the three-phase owner-authorized switch (`switch-thread` /
// `commit-switch` / `finish-switch` / `rollback-switch`) and the local→SSH transfer leg stay in
// `src/main/codex-accounts.ts`. The switch authorizes every phase against the WebContents that
// reserved it (`event.sender.id`) and auto-releases on that renderer's `destroyed` event — a live
// Electron object, not a number. `CorePlatform.handleWithSender` hands over a numeric id and has no
// lifecycle signal at all, so there is nothing on the server seam to key ownership or auto-release
// off. Porting it needs a connection-identity/lifecycle design, not a re-registration.
//
// The copy primitives are NOT re-implemented here: `planCodexRolloutExposure` /
// `commitCodexRolloutExposure` (codex-accounts-core.ts) are the atomic, never-overwrite hardlink,
// and only the switch/transfer legs in src/main use them.
import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { IPC } from '../shared/ipc'
import {
  assertCodexAccountId,
  codexAccountHome,
  codexSessionEnv,
  codexSocketForAccount,
  ensureSharedCodexDaemon,
  legacyCodexAccountHome,
  migrateLegacyCodexAccountHome,
  migrateLegacyCodexAccountHomes
} from './codex-accounts-core'
import { readCodexAccountAt } from './codex-session-name'
import { platform } from './platform'
import { findInLoginPath } from './pty-manager'

const execFileP = promisify(execFile)
const LOGIN_POLL_MS = 2000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
/** Non-secret runtime assets symlinked from the system home into each managed home: shared
 *  installation, never a credential or the thread SQLite DB. */
const SHARED_ENTRIES = ['config.toml', 'AGENTS.md', 'skills', 'plugins', 'packages', 'rules', 'hooks.json']

const waiters = new Map<string, { cancelled: boolean }>()
const removingCodexAccounts = new Set<string>()

/** True while `codex-accounts:remove` is tearing this account down. The desktop's switch leg reads
 *  it to refuse a switch onto an account that is mid-removal (the other half of Property 10 — the
 *  removal side reads `deps.isSwitchReserved` for the same reason). */
export function isCodexAccountRemoving(accountId: string): boolean {
  return removingCodexAccounts.has(accountId)
}

export interface CodexAccountsDeps {
  /**
   * DESKTOP ONLY: does an in-flight switch reservation currently pin this account? Removal must
   * refuse while one does (Property 10), and the reservation table lives with the switch protocol
   * in src/main because it is keyed by WebContents. The Server Edition passes none — it never
   * registers the switch verbs, so nothing there can hold a reservation.
   */
  isSwitchReserved?: (accountId: string) => boolean
  /** Login poll interval. Injectable so tests need not wait out the 2 s production cadence. */
  pollMs?: number
}

export function localCodexAccountHome(accountId: string): string {
  return codexAccountHome(platform().userDataDir, accountId)
}

export function localCodexSocket(accountId?: string): string {
  return codexSocketForAccount(platform().userDataDir, accountId)
}

/**
 * Reuse the account's shared app-server if it is already answering on its control socket, else boot
 * one exactly once (§2.2). The managed home is migrated to its short form first so the app-server
 * Unix socket stays under `SUN_LEN`. UNVERIFIED against a real Codex CLI headless (probe U4/U6) —
 * device-verification owed; the control flow (probe → start-once) is pure and tested via injection.
 */
export async function ensureCodexAccountDaemon(accountId?: string): Promise<void> {
  if (accountId) migrateLegacyCodexAccountHome(platform().userDataDir, accountId)
  const socket = localCodexSocket(accountId)
  await ensureSharedCodexDaemon(
    async () => (await readCodexAccountAt(socket, 1000)) !== null,
    async () => {
      const codex = await findInLoginPath('codex')
      if (!codex) throw new Error('Codex CLI unavailable')
      await execFileP(codex, ['app-server', 'daemon', 'start'], {
        cwd: os.homedir(),
        env: { ...process.env, ...codexSessionEnv(platform().userDataDir, accountId) },
        timeout: 15_000,
        maxBuffer: 1024 * 1024
      })
    }
  )
}

/**
 * Create a managed account's private home (0700) and symlink the shared, NON-secret runtime assets
 * from the system home in. Credentials (`auth.json`) and the thread DB are never shared — only
 * installation assets. A missing source asset is skipped; an existing target link is left as-is.
 */
async function initializeAccountHome(id: string): Promise<string> {
  migrateLegacyCodexAccountHome(platform().userDataDir, id)
  const home = localCodexAccountHome(id)
  await fs.mkdir(home, { recursive: true, mode: 0o700 })
  await fs.chmod(home, 0o700)
  const sourceHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex')
  for (const name of SHARED_ENTRIES) {
    const source = path.join(sourceHome, name)
    const target = path.join(home, name)
    try {
      await fs.lstat(source)
      await fs.symlink(source, target)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'EEXIST') throw error
    }
  }
  return home
}

async function accountIdentity(accountId?: string): Promise<{ email: string | null } | null> {
  await ensureCodexAccountDaemon(accountId)
  return readCodexAccountAt(localCodexSocket(accountId), 5000)
}

/**
 * Read an already-logged-in managed account's identity. The login GATE is a REAL non-symlink
 * `auth.json`: a symlinked or absent credential is "not logged in" and returns null (Property 10 /
 * §2.1 — a managed account acts only as its OWN login, never a symlink into the system jar).
 */
async function existingManagedIdentity(id: string): Promise<{ email: string | null } | null> {
  assertCodexAccountId(id)
  try {
    migrateLegacyCodexAccountHome(platform().userDataDir, id)
    const auth = await fs.lstat(path.join(localCodexAccountHome(id), 'auth.json'))
    if (!auth.isFile() || auth.isSymbolicLink()) return null
    return await accountIdentity(id)
  } catch {
    return null
  }
}

/**
 * Synchronous, and both shells run it BEFORE renderer hydration / PTY restore: a legacy long
 * CODEX_HOME cannot host the app-server Unix socket, and an already-persisted managed node must see
 * its migrated home on its very first spawn.
 */
export function migrateManagedCodexHomes(): void {
  migrateLegacyCodexAccountHomes(platform().userDataDir)
}

/**
 * The five parity verbs, as plain functions keyed by channel — the SAME implementation both shells
 * serve, differing only in how they are registered:
 *
 *  - **Server Edition** — `registerCodexAccountsIpc()` below binds them to `platform().handle`, so
 *    a browser tab reaches them over the WS bridge. That is the whole point of the move.
 *  - **Desktop (Electron)** — `src/main/codex-accounts.ts` binds them to `ipcMain.handle` instead
 *    of `platform().handle`, DELIBERATELY. On desktop `platform().handle` also enters the channel
 *    into the peer-reachable handler table (platform-electron.ts, "THE INVARIANT (4c)"), which
 *    would newly let a paired relay GUEST mint and delete managed accounts on the HOST while the
 *    guest's own settings.json records them as its own — the exact hazard `claudeAccounts` is kept
 *    out of `relay-api.ts` for. Registering through ipcMain keeps desktop reach byte-identical to
 *    what it was before this split. Only the registrar differs; the logic below is shared.
 */
export function codexAccountsHandlers(
  deps: CodexAccountsDeps = {}
): Record<string, (...args: any[]) => unknown> {
  const pollMs = deps.pollMs ?? LOGIN_POLL_MS
  return {
    [IPC.codexAccountsAdd]: async () => {
      const id = randomUUID()
      return { id, home: await initializeAccountHome(id) }
    },

    [IPC.codexAccountsWaitLogin]: async (id: string) => {
      assertCodexAccountId(id)
      const home = localCodexAccountHome(id)
      const waiter = { cancelled: false }
      waiters.set(id, waiter)
      const deadline = Date.now() + LOGIN_TIMEOUT_MS
      try {
        while (!waiter.cancelled && Date.now() < deadline) {
          try {
            // The login gate: a REAL file, never a symlink. A device login writes auth.json into the
            // managed home; a symlink here would mean the account is riding the system credential.
            const auth = await fs.lstat(path.join(home, 'auth.json'))
            if (auth.isFile() && !auth.isSymbolicLink()) {
              const identity = await accountIdentity(id)
              if (identity) return identity
            }
          } catch {
            // No credential file yet, or its daemon is not ready — keep polling.
          }
          await new Promise((resolve) => setTimeout(resolve, pollMs))
        }
        return null
      } finally {
        waiters.delete(id)
      }
    },

    [IPC.codexAccountsCancelWait]: (id: string) => {
      // Symmetry, not a hole being closed: this id only ever indexes a Map whose keys were created
      // by an already-validated `wait-login`, and it never reaches a path. But it was the ONE verb
      // of the six that took an id without checking it (blind security review, 2026-09-04), and a
      // validated-everywhere rule is worth more than the line it costs — the next person to reach
      // for `id` here should find the guard already standing.
      assertCodexAccountId(id)
      const waiter = waiters.get(id)
      if (waiter) waiter.cancelled = true
    },

    [IPC.codexAccountsIdentity]: (id: string) => existingManagedIdentity(id),

    // No ctx ⇒ THIS machine's system identity. A `{ projectId }` ctx asks for a remote HOST's system
    // identity, which this build does not yet resolve — fail closed to `null` rather than returning
    // this machine's login, so a remote machine panel never fabricates/borrows a local identity
    // (§5 "system-account discovery must not fabricate an account"). Remote resolution is a
    // follow-up. The Server Edition has no SSH projects at all, so it always takes the null branch
    // for a projectId, which is also the honest answer there.
    [IPC.codexAccountsSystemIdentity]: (ctx?: { projectId?: string }) =>
      ctx?.projectId ? Promise.resolve(null) : accountIdentity(),

    [IPC.codexAccountsRemove]: async (id: string) => {
      assertCodexAccountId(id)
      // Property 10 — race/use-safe removal. Refuse while a switch reservation holds this account
      // (desktop only; the Server Edition registers no switch and passes no predicate), or while a
      // concurrent removal is already in flight.
      if (deps.isSwitchReserved?.(id)) {
        throw new Error('Codex account is reserved by an account switch')
      }
      if (removingCodexAccounts.has(id)) throw new Error('Codex account removal is already in progress')
      removingCodexAccounts.add(id)
      try {
        const waiter = waiters.get(id)
        if (waiter) waiter.cancelled = true
        try {
          const codex = await findInLoginPath('codex')
          if (codex) {
            await execFileP(codex, ['app-server', 'daemon', 'stop'], {
              cwd: os.homedir(),
              env: { ...process.env, CODEX_HOME: localCodexAccountHome(id) },
              timeout: 10_000,
              maxBuffer: 1024 * 1024
            })
          }
        } catch {
          // A stopped/missing daemon is already the desired state.
        }
        const home = localCodexAccountHome(id)
        const legacy = legacyCodexAccountHome(platform().userDataDir, id)
        await fs.rm(home, { recursive: true, force: true })
        if (legacy !== home) await fs.rm(legacy, { recursive: true, force: true })
      } finally {
        removingCodexAccounts.delete(id)
      }
    }
  }
}

/**
 * Register the five `codex-accounts:*` parity channels on the core platform seam. This is the
 * SERVER EDITION's entry point; the desktop registers the same handlers through `ipcMain` (see
 * `codexAccountsHandlers`' note) and adds the switch + transfer verbs on top.
 */
export function registerCodexAccountsIpc(deps: CodexAccountsDeps = {}): void {
  migrateManagedCodexHomes()
  for (const [channel, fn] of Object.entries(codexAccountsHandlers(deps))) {
    platform().handle(channel, fn)
  }
}
