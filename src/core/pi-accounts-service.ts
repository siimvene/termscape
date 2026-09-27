// Impure lifecycle for managed pi accounts: agent-dir creation/deletion, the status-extension
// install into each dir, login capture (poll auth.json) — AND the account row.
//
// Same model as managed Claude accounts (`claude-accounts-service.ts`), with pi as the provider:
// one account = one isolated PI_CODING_AGENT_DIR (`<userData>/pi-accounts/<id>`), and pi owns
// login, credential storage and token refresh inside it. nodeterm never writes a credential; it
// only reads `auth.json`'s provider KEYS to learn that a login landed.
//
// MEMBERSHIP of `settings.piAccounts` is owned HERE, not by the renderer, for the reason spelled
// out in the Claude service's header: `add` appends the row and `remove` deletes it through
// `SettingsStore.mutate` (a read-modify-write on the store's chain, against the file), in the same
// verb that mints / tears down the dir, and a renderer snapshot save is reconciled field by field
// (settings-store.ts `reconcileOwnedAccountList`) so it can neither add nor drop a row. Unlike
// Claude and Codex, the login-capture FLIP (`pending` off, provider-list label) is also written
// here, inside `wait-login`: pi's `auth.json` carries no email for the renderer to promote, so the
// shell — which already read the file — is the one party that knows what to call the account.
//
// Local-only in v1: no SSH context anywhere. A pi node on an SSH project runs the host's system
// pi (pty-manager sets no PI_CODING_AGENT_DIR for it).
//
// Lives in core so BOTH shells serve it: `registerPiAccountsIpc` binds the table through
// `platform().handle` (Server Edition), `src/main/pi-accounts.ts` binds the SAME table through
// `ipcMain.handle` on the desktop — never `platform().handle` there, which is the peer-reachable
// table (INVARIANT 4c: a relay guest must not mint or delete accounts on the host).
import { randomUUID } from 'crypto'
import { existsSync, promises as fs } from 'fs'
import path from 'path'
import { IPC } from '../shared/ipc'
import { NEW_PI_ACCOUNT_LABEL, type PiAccount, type PiAccountAddResult, type PiLoginCapture } from '../shared/pi-account'
import type { Settings } from '../shared/types'
import { installPiExtensionInto } from './agents/hooks/pi'
import { PI_AUTH_FILE, parsePiLoginCapture, piAccountLabelFor } from './pi-accounts-core'
import { PI_ACCOUNTS_DIRNAME, piAccountDir } from './pi-config-dir'
import { platform } from './platform'
import type { AccountRowStore } from './settings-store'

const LOGIN_POLL_MS = 2000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

export interface PiAccountsDeps {
  /** Where the account ROW lives. Required: a shell that mints agent dirs without registering
   *  rows is the orphaned-credential bug the shell-owned membership exists to close. */
  settings: AccountRowStore
  /** Optional per-dir addition run after the status extension (e.g. a canvas-control skill into
   *  `<agentDir>/skills`, where pi discovers skills). Best-effort: a throw is logged, never fatal. */
  installSkill?: (agentDir: string) => void
  /** Login poll interval / deadline. Injectable so tests need not wait out the 2 s / 5 min cadence. */
  pollMs?: number
  timeoutMs?: number
}

// A SET per id, for the reason the Claude service keeps one: a launch heal and a Retry click can
// legitimately run two concurrent waits for one account, and a single-slot map lets one wait's
// cleanup deregister the other (cancel then reaches only the newest and the orphan polls to its
// deadline, uncancellable).
const waiters = new Map<string, Set<{ cancelled: boolean }>>()

function cancelWaits(id: string): void {
  for (const w of waiters.get(id) ?? []) w.cancelled = true
}

/** The row `add` registers: pending and placeholder-labelled until the login is captured. */
function mintPiAccountRow(id: string): PiAccount {
  return { id, label: NEW_PI_ACCOUNT_LABEL, pending: true, createdAt: Date.now() }
}

/**
 * The account dir for a DESTRUCTIVE or login operation, proven to sit directly under this
 * instance's `<userData>/pi-accounts`. `piAccountDir` already validates the id alphabet; the parent
 * check is the second, independent fence on the one recursive delete in this file, so that no
 * future change to the path builder can quietly widen what `remove` is able to name.
 */
function ownedAccountDir(id: string): string {
  const dir = piAccountDir(id)
  const root = path.join(platform().userDataDir, PI_ACCOUNTS_DIRNAME)
  if (path.dirname(dir) !== root) throw new Error(`invalid account id: ${JSON.stringify(id)}`)
  return dir
}

/** Plant the status extension (and the shell's optional extra) into one account dir. Fail-open:
 *  a dir without the extension still logs in and runs pi, it only reports no agent status until
 *  the next launch-time pass re-installs it. */
function installInto(agentDir: string, extra?: (agentDir: string) => void): void {
  try {
    installPiExtensionInto(agentDir)
  } catch (e) {
    console.warn(`[pi-accounts] status extension install failed for ${agentDir}`, e)
  }
  if (!extra) return
  try {
    extra(agentDir)
  } catch (e) {
    console.warn(`[pi-accounts] per-account install failed for ${agentDir}`, e)
  }
}

/**
 * The four `pi-accounts:*` handlers, keyed by channel, with NO registrar baked in (see the file
 * header for the two registrars and why the desktop's is `ipcMain`).
 */
export function piAccountsHandlers(deps: PiAccountsDeps): Record<string, (...args: any[]) => unknown> {
  const pollMs = deps.pollMs ?? LOGIN_POLL_MS
  const timeoutMs = deps.timeoutMs ?? LOGIN_TIMEOUT_MS
  const { settings } = deps
  // Idempotent on the id: a fresh UUID is never present, but a retry must not duplicate it.
  const registerRow = (account: PiAccount): Promise<unknown> =>
    settings.mutate((s) =>
      s.piAccounts.some((a) => a.id === account.id)
        ? s
        : { ...s, piAccounts: [...s.piAccounts, account] }
    )
  const deleteRow = (id: string): Promise<unknown> =>
    settings.mutate((s) =>
      s.piAccounts.some((a) => a.id === id)
        ? { ...s, piAccounts: s.piAccounts.filter((a) => a.id !== id) }
        : s
    )
  // The capture flip, on the store's chain against the file. Only a still-PENDING row changes
  // (resolution is monotonic, and a second capture must not re-label an account), and the label is
  // replaced only while it is still the mint placeholder — a name the user typed in the meantime
  // survives the capture.
  const resolveRow = (id: string, providers: readonly string[]): Promise<unknown> =>
    settings.mutate((s: Settings) => {
      if (!s.piAccounts.some((a) => a.id === id && a.pending)) return s
      return {
        ...s,
        piAccounts: s.piAccounts.map((a) => {
          if (a.id !== id || !a.pending) return a
          const { pending: _pending, ...rest } = a
          return {
            ...rest,
            label: a.label === NEW_PI_ACCOUNT_LABEL ? piAccountLabelFor(providers) : a.label
          }
        })
      }
    })

  return {
    // Mint the dir (+ extension), THEN register the row. A dir whose row could not be persisted is
    // torn down again before the error reaches the caller, so a failure leaves nothing behind.
    // Everything that writes into the dir is synchronous and runs BEFORE the persist, so the
    // rollback's `rm` is the last writer to touch it. Resolves only once the row is on disk.
    [IPC.piAccountsAdd]: async (): Promise<PiAccountAddResult> => {
      const id = randomUUID()
      const agentDir = ownedAccountDir(id)
      // 0700: pi writes `auth.json` 0600 itself, but the dir also holds sessions and settings.
      await fs.mkdir(agentDir, { recursive: true, mode: 0o700 })
      installInto(agentDir, deps.installSkill)
      const account = mintPiAccountRow(id)
      try {
        await registerRow(account)
      } catch (error) {
        try {
          await fs.rm(agentDir, { recursive: true, force: true })
        } catch (cleanupError) {
          // Never swallowed: a row-less dir is left behind, which a later remove of this id
          // reclaims (remove tears down a row-less dir). Report it beside the persist error.
          console.error(
            `[pi-accounts] add of ${id} failed to persist and its agent dir could not be removed; a later remove will reclaim it`,
            cleanupError
          )
        }
        throw error
      }
      return { id, agentDir, account }
    },

    // Poll `<agentDir>/auth.json` until it names at least one provider (pi creates the file as `{}`
    // on first run, so existence alone is not a login). On capture, flip the row and resolve with
    // the provider list. A failed flip is logged, not thrown: the login DID land, and the renderer's
    // snapshot save can still resolve the pending row.
    [IPC.piAccountsWaitLogin]: async (id: string): Promise<PiLoginCapture | null> => {
      const agentDir = ownedAccountDir(id) // validates the id (rejects traversal) before any wait
      const w = { cancelled: false }
      const set = waiters.get(id) ?? new Set()
      set.add(w)
      waiters.set(id, set)
      const deadline = Date.now() + timeoutMs
      try {
        while (!w.cancelled && Date.now() < deadline) {
          let captured: { providers: string[] } | null = null
          try {
            captured = parsePiLoginCapture(await fs.readFile(path.join(agentDir, PI_AUTH_FILE), 'utf-8'))
          } catch {
            // not written yet — keep polling
          }
          if (captured) {
            try {
              await resolveRow(id, captured.providers)
            } catch (e) {
              console.error(`[pi-accounts] login for ${id} landed but its row could not be updated`, e)
            }
            return { providers: captured.providers }
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

    [IPC.piAccountsCancelWait]: (id: string): void => {
      cancelWaits(id)
    },

    // Tear the dir down, THEN delete the row. Dir first so a failed teardown leaves a row the user
    // can see and retry, never a credential dir nothing points at; once the row is gone no stale
    // renderer snapshot can bring it back. A row-less id still has its dir torn down — that is how
    // an orphan from a failed add's failed rollback is reclaimed. The delete is confined to
    // `<userData>/pi-accounts/<id>` by `ownedAccountDir` (id alphabet + parent check).
    [IPC.piAccountsRemove]: async (id: string): Promise<void> => {
      const agentDir = ownedAccountDir(id)
      cancelWaits(id)
      await fs.rm(agentDir, { recursive: true, force: true })
      await deleteRow(id)
    }
  }
}

/** Register the four `pi-accounts:*` channels on the core platform seam (Server Edition). */
export function registerPiAccountsIpc(deps: PiAccountsDeps): void {
  for (const [channel, fn] of Object.entries(piAccountsHandlers(deps))) {
    platform().handle(channel, fn)
  }
}

/**
 * Re-install the status extension into every managed pi account dir at launch, so an app update's
 * new extension reaches each account (pi loads extensions per agent dir; the system `~/.pi/agent`
 * is covered by `installManagedAgentHooks`). Called by BOTH shells. Best-effort per account: one
 * failing account never blocks boot.
 *
 * A dir that no longer EXISTS is skipped, not recreated: the installer `mkdir -p`s its
 * `extensions/` folder, which would resurrect a deleted account as an empty logged-out dir and
 * hide the spawn's honest missing-dir fallback behind a node that silently asks to log in again.
 */
export function installPiExtensionIntoLocalAccounts(
  accounts: readonly { id: string }[],
  extra?: (agentDir: string) => void
): void {
  for (const acct of accounts) {
    let agentDir: string
    try {
      agentDir = piAccountDir(acct.id)
    } catch (e) {
      console.warn(`[agent-hooks] pi account ${JSON.stringify(acct.id)} skipped: invalid id`, e)
      continue
    }
    if (!existsSync(agentDir)) continue
    installInto(agentDir, extra)
  }
}
