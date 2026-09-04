// Impure lifecycle for managed Claude accounts: config-dir creation/deletion, login capture
// (poll .claude.json), CLI version check, per-account hook install — AND the account row.
//
// MEMBERSHIP of the account list (`settings.claudeAccounts`) is owned HERE, not by the renderer:
// `add` appends the row and `remove` deletes it through `SettingsStore.mutate`, a read-modify-write
// on the store's FIFO chain against the settings on disk, in the same verb that mints / tears down
// the config dir. The renderer keeps a row's display edits (label, color, the login-capture flip)
// through its ordinary snapshot save, and the store reconciles that snapshot against its own
// membership field by field (settings-store.ts `reconcileOwnedAccountList`) — so a snapshot can
// neither add nor drop a row, nor rewrite its `host`. Before this the renderer appended the row to
// ITS snapshot after `add` returned and full-saved it, so two Server Edition tabs adding at once
// (or an add racing a label edit in another tab) left the later snapshot the winner: one account's
// config dir with a captured credential stayed on disk with no row pointing at it — a credential
// nothing could list, pick, or remove. Same bug, same fix as `codex-accounts-service.ts`.
//
// Lives in core so BOTH shells serve it. Before this the four channels were registered only by
// src/main, so the Server Edition's bridge answered E_UNSUPPORTED for every one of them: a
// browser-only deployment could select a managed account (env injection, transcript readers,
// usage and the pickers are all core already) but could never CREATE, log into or remove one
// (issue #313). The desktop now binds the SAME handlers through `ipcMain` (`claudeAccountsHandlers`
// below, `src/main/claude-accounts.ts`) — see that file for why not `platform().handle`.
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { IPC } from '../shared/ipc'
import { NEW_CLAUDE_ACCOUNT_LABEL, type ClaudeAccount } from '../shared/types'
import { isSupportedClaudeVersion, parseLoginCapture } from './claude-accounts-core'
import { claudeConfigDirFor } from './claude-config-dir'
import { installClaudeHooksInto, ensureClaudeFullscreenTuiInto } from './agents/hooks/claude'
import { findInLoginPath } from './pty-manager'
import { platform } from './platform'
import type { AccountRowStore } from './settings-store'

const execFileP = promisify(execFile)
const LOGIN_POLL_MS = 2000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
// Wall-clock budget for the Add-account CLI version probe — see its use in the add handler.
const ADD_VERSION_PROBE_BUDGET_MS = 1500

/**
 * Optional per-call SSH context. When `projectId` is present AND that project has a live
 * ControlMaster, the account is a REMOTE one: its config dir + login capture + removal happen on the
 * host over ssh instead of on the local filesystem. The renderer passes it only for accounts scoped
 * to an SSH project (`ClaudeAccount.host`); local accounts omit it entirely (unchanged behavior).
 * `host` is the renderer's `user@host` key for that project, consulted for the ROW only when the
 * remote leg ran and the manager could not name the host itself (see `add`).
 */
export interface AccountCtx {
  projectId?: string
  host?: string
}

/** The three remote legs, as the shell implements them (desktop: SshProjectManager). */
export interface ClaudeAccountsRemote {
  add(
    projectId: string,
    id: string
  ): Promise<{ configDir: string; versionSupported: boolean } | null>
  readLogin(projectId: string, id: string): Promise<string | null>
  /**
   * Tear down the account's config dir ON THE HOST and REPORT whether it actually happened:
   * `true` only when the project was connected AND the remote `rm` confirmed removal, `false`
   * otherwise (not connected, or a non-zero exit). The service deletes the row ONLY on a `true`,
   * so a disconnected/failed teardown leaves the row visible and retryable instead of orphaning an
   * authenticated credential dir on the host under a removal the UI reported as complete.
   */
  remove(projectId: string, id: string): Promise<boolean>
  /** `user@host` of a CONNECTED project (matches `ClaudeAccount.host`); undefined otherwise. */
  hostKey?(projectId: string): string | undefined
}

export interface ClaudeAccountsDeps {
  /** Where the account ROW lives. Required: a shell that mints config dirs without registering
   *  rows is the orphaned-credential bug this module exists to close. */
  settings: AccountRowStore
  /**
   * Install the canvas-control skill into a freshly created account dir. Claude Code resolves
   * skills relative to CLAUDE_CONFIG_DIR, so a managed account needs its own copy. DESKTOP ONLY:
   * canvas control is not wired on the Server Edition at all (its hook server answers
   * `control unavailable` by name), so there is nothing for a skill file to reach there.
   */
  installSkill?: (configDir: string) => void
  /**
   * Resolves the live remote legs, or undefined when SSH is not wired / not yet created. A THUNK
   * rather than a plain object because that is the fact the local fallback turns on: desktop
   * creates its SshProjectManager after this registration, and an `AccountCtx` carrying a
   * projectId while no manager exists must degrade to the LOCAL path (pre-existing behavior).
   * The Server Edition passes none, so every call takes that same local path.
   */
  remote?: () => ClaudeAccountsRemote | undefined
  /** Login poll interval. Injectable so tests need not wait out the 2 s production cadence. */
  pollMs?: number
}

// A SET per id: the launch heal + a Retry click legitimately run two concurrent waits for one
// account, and a single-slot map let one wait's cleanup deregister the other — cancel then
// no-op'd and the orphan poll ran to its full LOGIN_TIMEOUT_MS deadline, uncancellable, with
// repeated calls accumulating pollers.
const waiters = new Map<string, Set<{ cancelled: boolean }>>()

async function checkClaudeVersion(): Promise<boolean> {
  // The < 2.1 warning is about the shared macOS Keychain service; on Linux/Windows
  // credentials are files inside each config dir, so no version collides.
  if (process.platform !== 'darwin') return true
  try {
    const claude = await findInLoginPath('claude')
    if (!claude) return false
    const { stdout } = await execFileP(claude, ['--version'], { timeout: 5000 })
    return isSupportedClaudeVersion(stdout.trim())
  } catch {
    return false
  }
}

/** The row `add` registers: pending, placeholder-labelled, pinned to `host` when minted there. */
function mintClaudeAccountRow(id: string, host: string | undefined): ClaudeAccount {
  return {
    id,
    label: NEW_CLAUDE_ACCOUNT_LABEL,
    pending: true,
    createdAt: Date.now(),
    ...(host ? { host } : {})
  }
}

/** Tear down a remote account dir minted by an add that then failed (its host could not be recorded,
 *  or its row could not be persisted). Logs LOUDLY if the teardown does not confirm — a false return
 *  or a throw both leave a row-less config dir on the host, which no fresh-id add/remove can reclaim,
 *  so it must never vanish silently (mirrors the local add's rollback). */
async function rollbackRemoteAdd(
  remote: ClaudeAccountsRemote,
  projectId: string,
  id: string
): Promise<void> {
  try {
    const torndown = await remote.remove(projectId, id)
    if (!torndown) {
      console.error(
        `[claude-accounts] rollback of remote add ${id} did not confirm teardown; a config dir may remain on the host`
      )
    }
  } catch (e) {
    console.error(
      `[claude-accounts] rollback of remote add ${id} failed; a config dir may remain on the host`,
      e
    )
  }
}

/**
 * The four `claude-accounts:*` handlers, keyed by channel, with NO registrar baked in. Two callers:
 *  - `registerClaudeAccountsIpc` below binds them through `platform().handle` — the Server Edition.
 *  - `src/main/claude-accounts.ts` binds the SAME table through `ipcMain.handle` on the desktop.
 *    Not `platform().handle` there: that registers into the peer-reachable handler table
 *    (platform-electron.ts, "THE INVARIANT (4c)"), which would newly let a paired relay GUEST mint
 *    and delete managed accounts on the HOST. Only the registrar differs; the logic is shared.
 */
export function claudeAccountsHandlers(
  deps: ClaudeAccountsDeps
): Record<string, (...args: any[]) => unknown> {
  const pollMs = deps.pollMs ?? LOGIN_POLL_MS
  const { settings } = deps
  // Resolve the live remote legs for a context, or null when the context is local / not connected.
  const remoteFor = (ctx?: AccountCtx): { r: ClaudeAccountsRemote; projectId: string } | null => {
    const projectId = ctx?.projectId
    const r = deps.remote?.()
    return projectId && r ? { r, projectId } : null
  }
  // Register the row on the store's chain, against the settings on disk. Idempotent on the id (a
  // freshly minted UUID is never present, but a retry must not duplicate it either).
  const registerRow = (account: ClaudeAccount): Promise<unknown> =>
    settings.mutate((s) =>
      s.claudeAccounts.some((a) => a.id === account.id)
        ? s
        : { ...s, claudeAccounts: [...s.claudeAccounts, account] }
    )
  const deleteRow = (id: string): Promise<unknown> =>
    settings.mutate((s) =>
      s.claudeAccounts.some((a) => a.id === id)
        ? { ...s, claudeAccounts: s.claudeAccounts.filter((a) => a.id !== id) }
        : s
    )

  return {
    // Mint the dir, THEN register the row — inside the store's chain, against the latest list, so
    // a concurrent add (another tab) or a concurrent label edit can neither drop nor duplicate it.
    // The row is what makes the dir reachable (the pickers, the launch heal, usage and removal all
    // read the list), so a dir whose row could not be persisted is torn down again before the
    // error reaches the caller: the failure leaves nothing behind, rather than exactly the orphan
    // this verb exists to prevent. Resolves only once the row is on disk.
    [IPC.claudeAccountsAdd]: async (ctx?: AccountCtx) => {
      const id = randomUUID()
      const remote = remoteFor(ctx)
      if (remote) {
        // REMOTE account: create the config dir + install the status hook on the host. No local
        // dir and no local hook install — the session runs entirely on the remote host.
        const res = await remote.r.add(remote.projectId, id)
        // Provenance for the row's `host` is the MANAGER's word for the project's host, with the
        // renderer's `ctx.host` only as a fallback KEY (never authoritative over a minted dir).
        const hostKey = remote.r.hostKey?.(remote.projectId)
        if (res) {
          // A dir WAS minted on the host, so the row MUST record a host — otherwise a later removal
          // reads it as local, runs the local teardown, and orphans the authenticated dir on the
          // host. Prefer the manager's host; fall back to `ctx.host` only if the project
          // disconnected between the mint and this call. If NEITHER can name the host, we minted a
          // credential dir we can no longer attribute: roll it back and fail, rather than persist a
          // REMOTE dir under a host-less (local-looking) row.
          const host = hostKey ?? ctx?.host
          if (!host) {
            await rollbackRemoteAdd(remote.r, remote.projectId, id)
            throw new Error(
              'Created a remote account dir but its project disconnected before its host could be recorded; rolled it back. Reconnect the project and try again.'
            )
          }
          const account = mintClaudeAccountRow(id, host)
          try {
            await registerRow(account)
          } catch (error) {
            // Persist failed — roll the minted remote dir back, LOUDLY on a failed teardown (a
            // swallowed failure here is the orphan this verb exists to prevent).
            await rollbackRemoteAdd(remote.r, remote.projectId, id)
            throw error
          }
          return { id, configDir: res.configDir, versionSupported: res.versionSupported, account }
        }
        // `res` is null: the project wasn't connected / mkdir failed — NOTHING was minted, so there
        // is nothing to roll back. Still return the id and a pending row (under the host the user
        // chose, or none) so the renderer can show it; the login node surfaces the connection error.
        const account = mintClaudeAccountRow(id, hostKey ?? ctx?.host)
        await registerRow(account)
        return { id, configDir: '', versionSupported: true, account }
      }
      const configDir = claudeConfigDirFor(id)
      await fs.mkdir(configDir, { recursive: true })
      // Install the managed hook (+ the canvas skill where the shell has one) up front so the very
      // first session in this account already reports status (badges/notifications/subagent viz)
      // and can control the canvas (Claude resolves both relative to CLAUDE_CONFIG_DIR, not
      // ~/.claude).
      installClaudeHooksInto(configDir)
      deps.installSkill?.(configDir)
      // Ensure fullscreen TUI in the new account dir (write-if-absent, version-gated). AWAITED
      // before the row is persisted, not fire-and-forget: its writer recreates the parent dir when
      // absent (claude-tui.ts), so an un-awaited probe finishing AFTER the rollback rm below would
      // recreate a row-less orphan the rollback just removed. Awaiting sequences it before the
      // persist so the rollback is the last writer to touch this dir. It fails open internally
      // (memoized probe + write both swallow errors), so awaiting never turns a cosmetic write into
      // an add failure.
      await ensureClaudeFullscreenTuiInto(configDir)
      const account = mintClaudeAccountRow(id, undefined)
      try {
        await registerRow(account)
      } catch (error) {
        // Roll the minted dir back so a failed persist leaves no row-less credential dir. If the
        // teardown ALSO fails, do not swallow it silently: a row-less dir is left behind, which a
        // later add/remove of this id reclaims (remove tears down a row-less local dir). Surface it
        // loudly beside the persist error rather than reporting only one.
        try {
          await fs.rm(configDir, { recursive: true, force: true })
        } catch (cleanupError) {
          console.error(
            `[claude-accounts] add of ${id} failed to persist and its config dir could not be removed; a later add/remove will reclaim it`,
            cleanupError
          )
        }
        throw error
      }
      // Bound the probe: it shells out through a LOGIN shell, which on a slow machine can take
      // ~10 s, and Add-account is a button — an unbounded await leaves it spinning with no
      // signal. The timeout resolves FALSE (= show the < 2.1 keychain-collision warning), not
      // true: failing safe costs a dismissable notice when a modern CLI merely answered slowly,
      // while failing open costs account B's login overwriting account A's shared unscoped
      // Keychain credential.
      let probeTimer: NodeJS.Timeout | undefined
      try {
        const versionSupported = await Promise.race([
          checkClaudeVersion(),
          new Promise<boolean>((resolve) => {
            probeTimer = setTimeout(() => resolve(false), ADD_VERSION_PROBE_BUDGET_MS)
          })
        ])
        return { id, configDir, versionSupported, account }
      } finally {
        // The losing branch is never observed again; leaving the timer armed keeps a handle
        // alive per Add. (The probe subprocess is separately bounded by its own execFile timeout.)
        if (probeTimer) clearTimeout(probeTimer)
      }
    },

    [IPC.claudeAccountsWaitLogin]: async (id: string, ctx?: AccountCtx) => {
      const remote = remoteFor(ctx)
      // Local path: `claudeConfigDirFor` also validates the id shape (rejects traversal).
      const configDir = remote ? null : claudeConfigDirFor(id)
      const w = { cancelled: false }
      const set = waiters.get(id) ?? new Set()
      set.add(w)
      waiters.set(id, set)
      const deadline = Date.now() + LOGIN_TIMEOUT_MS
      try {
        while (!w.cancelled && Date.now() < deadline) {
          try {
            const raw = remote
              ? await remote.r.readLogin(remote.projectId, id)
              : await fs.readFile(path.join(configDir as string, '.claude.json'), 'utf-8')
            const captured = raw ? parseLoginCapture(raw) : null
            if (captured) return captured
          } catch {
            // not written yet — keep polling
          }
          await new Promise((r) => setTimeout(r, pollMs))
        }
        return null
      } finally {
        // Ownership-checked: remove only THIS wait; a concurrent wait for the same id survives.
        const live = waiters.get(id)
        live?.delete(w)
        if (live && live.size === 0) waiters.delete(id)
      }
    },

    [IPC.claudeAccountsCancelWait]: (id: string) => {
      for (const w of waiters.get(id) ?? []) w.cancelled = true
    },

    // Tear the config dir down, THEN delete the row — on the chain, against the latest list. Dir
    // first so a failed teardown leaves a row the user can see and retry, never a dir nothing
    // points at; and once the row is gone no later renderer snapshot can bring it back (the store
    // keeps membership from its own list, not from the snapshot).
    //
    // PROVENANCE is the ROW's stored `host`, read from DISK under the store's RMW lock
    // (`readAccountsFromDisk`), NOT this process's cache: across processes sharing one --data-dir a
    // stale cache would let one process delete another's remote row down the LOCAL path, skipping
    // the SSH teardown and orphaning an authenticated dir on the host. A shell-owned `host` is also
    // unwritable by a renderer snapshot (see settings-store), so a forged/buggy ctx can neither
    // route a LOCAL row through ssh nor a REMOTE row through the local fs.
    [IPC.claudeAccountsRemove]: async (id: string, ctx?: AccountCtx) => {
      const onDisk = await settings.readAccountsFromDisk()
      const row = onDisk.claudeAccounts.find((a) => a.id === id)
      const remote = remoteFor(ctx)
      if (row?.host) {
        // REMOTE account: its credential dir is on `row.host`, so removal must CONFIRM teardown over
        // ssh BEFORE the row goes. A disconnected/failed teardown that still deleted the row would
        // strand an authenticated dir on the host with no retry path (the "row-last = retryable"
        // guarantee was false for remote).
        if (!remote) {
          throw new Error(
            'This account lives on a remote host; open its project (and connect) to remove it.'
          )
        }
        // The ctx's project must resolve to the SAME host as the row. A mismatch means the renderer
        // routed us at the wrong machine — refuse rather than act on the forged route.
        const ctxHost = remote.r.hostKey?.(remote.projectId)
        if (ctxHost && ctxHost !== row.host) {
          throw new Error('Account host does not match its project; refusing to remove.')
        }
        const torndown = await remote.r.remove(remote.projectId, id)
        if (!torndown) {
          throw new Error(
            `Could not reach ${row.host} to remove this account; it is still listed. Reconnect the project and try again.`
          )
        }
      } else {
        // LOCAL account (host-less), or a row-less orphan id. A ctx resolving to a CONNECTED SSH
        // project is a forged/buggy provenance for a LOCAL row — refuse rather than skip the local
        // home. A row-less orphan (no row to consult) takes the local teardown unconditionally:
        // that is how a dir orphaned by the pre-fix renderer race gets cleaned up.
        // `claudeConfigDirFor` validates the id (rejects traversal).
        if (row && remote && remote.r.hostKey?.(remote.projectId)) {
          throw new Error('Account is local but its project is remote; refusing to remove.')
        }
        const configDir = claudeConfigDirFor(id)
        await fs.rm(configDir, { recursive: true, force: true })
      }
      await deleteRow(id)
    }
  }
}

/** Register the four `claude-accounts:*` channels on the core platform seam (Server Edition). */
export function registerClaudeAccountsIpc(deps: ClaudeAccountsDeps): void {
  for (const [channel, fn] of Object.entries(claudeAccountsHandlers(deps))) {
    platform().handle(channel, fn)
  }
}

/**
 * Install the managed hook + fullscreen-TUI setting into every LOCAL managed account dir. Managed
 * accounts each carry their own settings.json (Claude Code resolves it relative to
 * CLAUDE_CONFIG_DIR), so an app update's new hook version must reach them too. Best-effort per
 * account: one failing account must never block launch (matches installManagedAgentHooks'
 * fail-open). `extra` is the shell's per-account addition — desktop installs the canvas skill.
 */
export function installHooksIntoLocalAccounts(
  accounts: readonly { id: string; host?: string }[],
  extra?: (configDir: string) => void
): void {
  for (const acct of accounts) {
    if (acct.host) continue // remote accounts live on another host; nothing to install locally
    try {
      const configDir = claudeConfigDirFor(acct.id)
      installClaudeHooksInto(configDir)
      extra?.(configDir)
      // Off the critical path: it awaits the memoized CLI probe, then writes fail-open. (The
      // system ~/.claude is handled by installManagedAgentHooks, which covers both shells.)
      void ensureClaudeFullscreenTuiInto(configDir)
    } catch (e) {
      console.warn(`[agent-hooks] account ${acct.id} hook install failed`, e)
    }
  }
}
