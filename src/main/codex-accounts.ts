// Desktop wiring for machine-scoped managed Codex accounts (S6 PR 5) — the leg that makes
// account-scoping REACHABLE for LOCAL accounts.
//
// The five PARITY verbs (add / wait-login / cancel-wait / identity + system-identity / remove) no
// longer live here: they moved to `src/core/codex-accounts-service.ts` so BOTH shells serve them,
// exactly the move `claude-accounts-service.ts` made for managed Claude accounts. This file binds
// that shared implementation to `ipcMain.handle` — NOT `platform().handle` — on purpose: on desktop
// `platform().handle` also enters a channel into the peer-reachable handler table
// (platform-electron.ts, "THE INVARIANT (4c)"), so routing account minting/removal through the seam
// would newly hand a paired relay GUEST the ability to create and delete managed accounts on the
// HOST while its own settings.json records them as its own — the same hazard `claudeAccounts` is
// kept out of `relay-api.ts` for. Registering through ipcMain keeps the desktop's reach
// byte-identical to what it was before the split.
//
// What is still IMPLEMENTED here, and why it could not move:
//  - the three-phase, owner-authorized, TTL-bounded SAME-MACHINE switch (§4.1 / Properties 5, 10):
//    every phase must be driven by the SAME renderer, and the reservation auto-releases on that
//    renderer's `destroyed` event. Both key off a live `WebContents` object. `CorePlatform` offers
//    only `handleWithSender` (a numeric id) and no lifecycle signal, so the server seam cannot
//    express either half. Desktop keeps the feature; the Server Edition does not get it, and the
//    browser bridge keeps answering E_UNSUPPORTED for those four verbs.
//  - the SOURCE side of moving an idle conversation to an SSH account, which needs the desktop's
//    `SshProjectManager` (the Server Edition has no SSH projects at all).
//
// The copy primitives are NOT re-implemented here: `planCodexRolloutExposure` /
// `commitCodexRolloutExposure` (src/core/codex-accounts-core.ts, PR 3) are the atomic, never-
// overwrite hardlink. Based on @Corvin's `codex-accounts.ts` in PR #112, re-sliced onto the PR 3/4
// primitives with the SSH transfer source leg (its remote landing is PR 6).
import { randomUUID } from 'crypto'
import path from 'path'
import { ipcMain, type WebContents } from 'electron'
import { IPC } from '../shared/ipc'
import {
  assertCodexAccountId,
  commitCodexRolloutExposure,
  codexHomeForAccount,
  planCodexRolloutExposure,
  type CodexRolloutExposurePlan
} from '../core/codex-accounts-core'
import {
  codexAccountsHandlers,
  codexThreadRolloutPath,
  type CodexAccountRowStore,
  ensureCodexAccountDaemon,
  isCodexAccountRemoving,
  migrateManagedCodexHomes,
  NEW_CODEX_ACCOUNT_LABEL
} from '../core/codex-accounts-service'
import type { CodexAccount } from '../shared/codex-account'
import { ensureCodexRelayRoot } from './codex-relay-daemon'
import { platform } from '../core/platform'
import type { SshProjectManager } from './remote-ssh/ssh-project'

const SWITCH_RESERVATION_TTL_MS = 60_000
/** The SSH login wait's cadence and budget — core's local wait uses the same 2 s / 5 min. */
const REMOTE_LOGIN_POLL_MS = 2000
const REMOTE_LOGIN_TIMEOUT_MS = 5 * 60 * 1000
/** A threadId that could reach the filesystem as a path component. Same shape as ACCOUNT_ID_RE. */
const SAFE_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** PR 6 provides this on the SSH manager. Typed structurally here so PR 5 can hand the source leg
 *  off without depending on PR 6's implementation. */
type CodexSshImporter = {
  remoteCodexImportThread?(
    projectId: string,
    accountId: string | undefined,
    threadId: string,
    sessionsRelativePath: string,
    localRolloutPath: string
  ): Promise<{ imported: boolean }>
}

/**
 * One in-flight switch reservation. Holds the planned (but maybe not yet committed) exposure, the
 * two account ids it pins (so removal refuses while it holds them — Property 10), the owning
 * WebContents (every phase must be driven by the SAME renderer — Property owner-authorized), and
 * the auto-release wiring (owner `destroyed` or the TTL).
 */
type PendingSwitchExposure = {
  exposure?: CodexRolloutExposurePlan
  sourceAccountId?: string
  targetAccountId?: string
  committed: boolean
  owner: WebContents
  ownerDestroyed: () => void
  timer: ReturnType<typeof setTimeout>
}
const pendingSwitchExposures = new Map<string, PendingSwitchExposure>()

function releasePendingSwitch(token: string): void {
  const pending = pendingSwitchExposures.get(token)
  if (!pending) return
  pendingSwitchExposures.delete(token)
  clearTimeout(pending.timer)
  if (!pending.owner.isDestroyed()) pending.owner.removeListener('destroyed', pending.ownerDestroyed)
}

/** The removal side of Property 10, handed to core's `remove` handler as `deps.isSwitchReserved`:
 *  an account pinned by a live reservation must not be deleted out from under the switch. The
 *  reservation table cannot live in core (it is keyed by WebContents), so the predicate crosses the
 *  boundary instead — and the Server Edition, which has no switch, passes none. */
function isSwitchReserved(accountId: string): boolean {
  return [...pendingSwitchExposures.values()].some(
    (pending) => pending.sourceAccountId === accountId || pending.targetAccountId === accountId
  )
}

/**
 * THREE SURFACES (global-constraint 5), stated explicitly:
 *
 *  - **Desktop (Electron)** — the full feature. The five parity verbs come from core (bound to
 *    `ipcMain` here, see the file header); the switch protocol and the SSH transfer source leg are
 *    registered below and are desktop-only.
 *  - **Server Edition (headless / an SSH host)** — serves the five PARITY verbs from the same core
 *    module via `registerCodexAccountsIpc()` (src/server/handlers/index.ts), so a browser-only
 *    deployment can create, log into, identify and remove managed Codex accounts exactly as it
 *    already does managed Claude accounts. It deliberately does NOT get the switch verbs (no
 *    WebContents-shaped owner identity or lifecycle on that seam) or the SSH transfer leg (no SSH
 *    projects). Managed Codex logins **on an SSH host driven from the desktop** are this file's
 *    SSH legs (a `{ projectId }` ctx on the parity verbs, wrapped around core's table below).
 *  - **Mobile (phone)** — never originates an add/switch/copy; it drives via relay→IPC and reads
 *    state. No mint here.
 *
 * @param settings The settings store; account ROW membership is written through its `mutate`.
 * @param getSshManager Lazily resolves the SSH project manager (created after this init in
 * index.ts). Only the local→SSH transfer SOURCE leg uses it today; local account ops never do.
 */
export function initCodexAccounts(
  settings: CodexAccountRowStore,
  getSshManager?: () => SshProjectManager | undefined
): void {
  // Ensure `~/.nodeterm` exists before any relay/daemon reach (carried PR-4 obligation: only the
  // relay's detached serve() created it before, so a first reach from this process could race a
  // missing root). Desktop-only: the Server Edition has no relay daemon to root.
  ensureCodexRelayRoot()
  // Synchronous, BEFORE renderer hydration / PTY restore — see core's `migrateManagedCodexHomes`.
  migrateManagedCodexHomes()

  /**
   * The SSH leg of every account verb (upstream 3886f9a9): a `{ projectId }` ctx names a CONNECTED
   * SSH project, and the account's home lives on that host. Resolved here, once, so each handler
   * either takes the remote path or core's local one — never both, and never the local one for a
   * ctx it could not resolve (that would mint, poll or delete a home on the wrong machine).
   *
   * Fork shape: the LOCAL legs are core's shared `codexAccountsHandlers` (both shells serve them,
   * and the SHELL owns row membership through `settings.mutate`). The SSH legs need the desktop's
   * SshProjectManager, which core cannot reach, so they wrap core's table here instead of forking
   * it: a ctx with a projectId takes the remote path below, everything else falls through to core
   * unchanged. The remote add registers its row (pinned to the host) on the same store chain, so
   * the "a snapshot can neither add nor drop a row, nor rewrite its host" guarantee holds for SSH
   * accounts too.
   */
  const remoteFor = (ctx?: { projectId?: string }): { mgr: SshProjectManager; projectId: string } | null => {
    const projectId = typeof ctx?.projectId === 'string' && ctx.projectId ? ctx.projectId : undefined
    if (!projectId) return null
    const mgr = getSshManager?.()
    if (!mgr) throw new Error('SSH is not available in this build')
    return { mgr, projectId }
  }
  // The two READS fail closed to `null` when a remote ctx cannot be served (no SSH manager): an
  // unknown identity is an answer, and it must never be THIS machine's.
  const remoteForRead = (ctx?: { projectId?: string }): ReturnType<typeof remoteFor> | 'unservable' => {
    try {
      return remoteFor(ctx)
    } catch {
      return 'unservable'
    }
  }
  // Remote login waits, per id — a SET, the same ownership-checked shape core uses for local waits,
  // so a cancel/remove reaches every poll and each poll removes only itself.
  const remoteWaiters = new Map<string, Set<{ cancelled: boolean }>>()
  const cancelRemoteWaiters = (id: string): void => {
    for (const w of remoteWaiters.get(id) ?? []) w.cancelled = true
  }

  const core = codexAccountsHandlers({ isSwitchReserved, settings })
  const handlers: Record<string, (...args: any[]) => unknown> = {
    ...core,

    [IPC.codexAccountsAdd]: async (ctx?: { projectId?: string; host?: string }) => {
      const remote = remoteFor(ctx)
      if (!remote) return core[IPC.codexAccountsAdd]()
      const id = randomUUID()
      // Creates the isolated home ON the host (umask 077, shared non-secret assets symlinked in).
      // The credential is written there by the device login the renderer opens next — it never
      // travels. Throws with the failed phase, which the Settings row shows.
      const res = await remote.mgr.remoteCodexAccountAdd(remote.projectId, id)
      if (!res) throw new Error('The SSH project is not connected')
      const host = remote.mgr.hostKeyFor(remote.projectId) ?? ctx?.host
      const rollback = async (): Promise<void> => {
        const torndown = await remote.mgr
          .remoteCodexAccountRemove(remote.projectId, id)
          .catch(() => false)
        if (!torndown) {
          console.error(
            `[codex-accounts] rollback of remote add ${id} did not confirm teardown; a Codex home may remain on the host`
          )
        }
      }
      if (!host) {
        // A row without its host would be read as a LOCAL account (wrong env, wrong removal).
        await rollback()
        throw new Error('Could not identify the SSH host for this Codex account')
      }
      const account: CodexAccount = { id, label: NEW_CODEX_ACCOUNT_LABEL, pending: true, host }
      try {
        await settings.mutate((s) =>
          s.codexAccounts.some((a) => a.id === id)
            ? s
            : { ...s, codexAccounts: [...s.codexAccounts, account] }
        )
      } catch (error) {
        await rollback()
        throw error
      }
      return { id, home: res.home, account }
    },

    [IPC.codexAccountsWaitLogin]: async (id: string, ctx?: { projectId?: string }) => {
      const remote = remoteFor(ctx)
      if (!remote) return core[IPC.codexAccountsWaitLogin](id)
      assertCodexAccountId(id)
      const waiter = { cancelled: false }
      const live = remoteWaiters.get(id) ?? new Set()
      live.add(waiter)
      remoteWaiters.set(id, live)
      const deadline = Date.now() + REMOTE_LOGIN_TIMEOUT_MS
      try {
        while (!waiter.cancelled && Date.now() < deadline) {
          // Same gate as locally (a real, non-symlink auth.json), asked ON the host. The email comes
          // from the account's own app-server; a host that cannot run one (no node/curl for the
          // relay) still completes the login, just without an email to name the row by.
          if (await remote.mgr.remoteCodexAuthPresent(remote.projectId, id)) {
            const identity = await remote.mgr
              .remoteCodexAccountIdentity(remote.projectId, id)
              .catch(() => null)
            return identity ?? { email: null }
          }
          await new Promise((resolve) => setTimeout(resolve, REMOTE_LOGIN_POLL_MS))
        }
        return null
      } finally {
        const set = remoteWaiters.get(id)
        set?.delete(waiter)
        if (set && set.size === 0) remoteWaiters.delete(id)
      }
    },

    [IPC.codexAccountsCancelWait]: (id: string) => {
      core[IPC.codexAccountsCancelWait](id) // validates the id
      cancelRemoteWaiters(id)
    },

    [IPC.codexAccountsIdentity]: async (id: string, ctx?: { projectId?: string }) => {
      const remote = remoteForRead(ctx)
      if (remote === 'unservable') return null
      if (!remote) return core[IPC.codexAccountsIdentity](id)
      // `remoteCodexAccountIdentity` refuses (null) a home with no REAL auth.json of its own, so a
      // not-yet-logged-in remote account never reports the host's system identity.
      return remote.mgr.remoteCodexAccountIdentity(remote.projectId, id).catch(() => null)
    },

    // No ctx ⇒ this machine's system identity. A `{ projectId }` ctx asks the connected HOST's own
    // `~/.codex`, through its app-server. Every failure is `null` — a remote machine panel shows no
    // email rather than borrowing this machine's login (§5 "system-account discovery must not
    // fabricate").
    [IPC.codexAccountsSystemIdentity]: async (ctx?: { projectId?: string }) => {
      const remote = remoteForRead(ctx)
      if (remote === 'unservable') return null
      if (!remote) return core[IPC.codexAccountsSystemIdentity]()
      return remote.mgr.remoteCodexAccountIdentity(remote.projectId, undefined).catch(() => null)
    },

    [IPC.codexAccountsRemove]: async (id: string, ctx?: { projectId?: string }) => {
      const remote = remoteFor(ctx)
      if (!remote) return core[IPC.codexAccountsRemove](id)
      assertCodexAccountId(id)
      // The ctx's project must be the row's own host: a mismatch means the renderer routed us at
      // the wrong machine, and a LOCAL row must never be "removed" on a remote host (its local home
      // would survive with no row pointing at it).
      const onDisk = await settings.readAccountsFromDisk()
      const row = onDisk.codexAccounts.find((a) => a.id === id)
      const ctxHost = remote.mgr.hostKeyFor(remote.projectId)
      if (row && !row.host) throw new Error('Account is local but its project is remote; refusing to remove.')
      if (row?.host && ctxHost && ctxHost !== row.host) {
        throw new Error('Account host does not match its project; refusing to remove.')
      }
      cancelRemoteWaiters(id)
      // Stops the account's app-server and deletes its home ON the host (credential included).
      // Home-then-row, like core: a failed teardown leaves the row visible and retryable.
      if (!(await remote.mgr.remoteCodexAccountRemove(remote.projectId, id))) {
        throw new Error('Could not remove the Codex account on the SSH host — is it connected?')
      }
      await settings.mutate((s) =>
        s.codexAccounts.some((a) => a.id === id)
          ? { ...s, codexAccounts: s.codexAccounts.filter((a) => a.id !== id) }
          : s
      )
    }
  }

  // `ipcMain.handle`, not `platform().handle` — the file header explains why. The event is stripped
  // exactly as the seam would strip it: none of the parity verbs reads a sender.
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, ...args: any[]) => fn(...args))
  }

  // ---- The SSH switch: one host-side exposure --------------------------------------------------
  // A node on an SSH host keeps its conversation in that host's account homes, so the three-phase
  // LOCAL reservation below has nothing to plan. The host primitive is already atomic and
  // self-verifying (hardlink + discover-or-roll-back), and the credentials never move: only the
  // rollout's directory entry does. Refused while this build is removing either account.
  ipcMain.handle(
    IPC.codexAccountsSwitchThreadRemote,
    async (
      _event,
      threadId: string,
      targetAccountId: string | undefined,
      hostAccountIds: unknown,
      ctx?: { projectId?: string }
    ) => {
      if (typeof threadId !== 'string' || !SAFE_THREAD_ID.test(threadId)) {
        throw new Error('Invalid Codex account switch request')
      }
      if (targetAccountId) assertCodexAccountId(targetAccountId)
      if (!Array.isArray(hostAccountIds) || hostAccountIds.some((id) => typeof id !== 'string')) {
        throw new Error('Invalid Codex account switch request')
      }
      for (const id of hostAccountIds as string[]) assertCodexAccountId(id)
      if (targetAccountId && !(hostAccountIds as string[]).includes(targetAccountId)) {
        throw new Error('The target Codex account is not on this host')
      }
      if (targetAccountId && isCodexAccountRemoving(targetAccountId)) {
        throw new Error('Codex account removal is in progress')
      }
      const remote = remoteFor(ctx)
      if (!remote) throw new Error('An SSH project is required for a remote Codex switch')
      await remote.mgr.remoteCodexSwitchThread(
        remote.projectId,
        threadId,
        targetAccountId,
        hostAccountIds as string[]
      )
    }
  )

  // ---- The three-phase, owner-authorized, TTL-bounded switch (§4.1 / Properties 5, 10) ----------
  // DESKTOP ONLY. Owner authorization is `event.sender`, a live WebContents.

  ipcMain.handle(
    IPC.codexAccountsSwitchThread,
    async (
      event,
      threadId: string,
      cwd: string,
      sourceAccountId?: string,
      targetAccountId?: string
    ) => {
      if (!SAFE_THREAD_ID.test(threadId) || !path.isAbsolute(cwd)) {
        throw new Error('Invalid Codex account switch request')
      }
      if (sourceAccountId) assertCodexAccountId(sourceAccountId)
      if (targetAccountId) assertCodexAccountId(targetAccountId)
      if (sourceAccountId === targetAccountId) return { threadId }
      if (
        (sourceAccountId && isCodexAccountRemoving(sourceAccountId)) ||
        (targetAccountId && isCodexAccountRemoving(targetAccountId))
      ) {
        throw new Error('Codex account removal is in progress')
      }
      const rollbackToken = randomUUID()
      const ownerDestroyed = (): void => releasePendingSwitch(rollbackToken)
      const timer = setTimeout(() => releasePendingSwitch(rollbackToken), SWITCH_RESERVATION_TTL_MS)
      timer.unref?.()
      event.sender.once('destroyed', ownerDestroyed)
      // Reserve BEFORE planning so a concurrent removal of either account is already blocked while
      // we read the app-server and plan the exposure.
      pendingSwitchExposures.set(rollbackToken, {
        sourceAccountId,
        targetAccountId,
        committed: false,
        owner: event.sender,
        ownerDestroyed,
        timer
      })
      try {
        const sourcePath = await codexThreadRolloutPath(sourceAccountId, threadId)
        if (!sourcePath) throw new Error('Source Codex conversation is unavailable')
        // The target's app-server is a convenience for the resumed pane, never a precondition: the
        // daemon runs only on the standalone Codex build, and the exposure below is a hardlink.
        await ensureCodexAccountDaemon(targetAccountId).catch(() => {})
        const exposure = planCodexRolloutExposure(
          codexHomeForAccount(platform().userDataDir, sourceAccountId),
          codexHomeForAccount(platform().userDataDir, targetAccountId),
          sourcePath,
          threadId
        )
        const pending = pendingSwitchExposures.get(rollbackToken)
        if (!pending) throw new Error('Codex account switch preparation expired')
        pending.exposure = exposure
        return { threadId, rollbackToken }
      } catch (error) {
        releasePendingSwitch(rollbackToken)
        throw error
      }
    }
  )

  ipcMain.handle(IPC.codexAccountsCommitSwitch, (event, token: string) => {
    const pending = pendingSwitchExposures.get(token)
    // Owner-authorized: only the WebContents that reserved the switch may commit it.
    if (!pending?.exposure || pending.owner.id !== event.sender.id) {
      throw new Error('Codex account switch preparation expired')
    }
    commitCodexRolloutExposure(pending.exposure)
    pending.committed = true
  })

  ipcMain.handle(IPC.codexAccountsFinishSwitch, (event, token: string) => {
    const pending = pendingSwitchExposures.get(token)
    if (!pending?.committed || pending.owner.id !== event.sender.id) {
      throw new Error('Codex account switch was not committed')
    }
    releasePendingSwitch(token)
  })

  ipcMain.handle(IPC.codexAccountsRollbackSwitch, (event, token: string) => {
    const pending = pendingSwitchExposures.get(token)
    if (pending?.owner.id === event.sender.id) releasePendingSwitch(token)
  })

  // ---- Local → SSH transfer SOURCE leg (§4.2b, Task 5.3). The remote landing is PR 6 ------------

  ipcMain.handle(
    IPC.codexAccountsTransferThreadToSsh,
    async (
      _event,
      threadId: string,
      cwd: string,
      projectId: string,
      targetAccountId?: string,
      sourceAccountId?: string
    ) => {
      if (!SAFE_THREAD_ID.test(threadId) || !path.isAbsolute(cwd) || !projectId) {
        throw new Error('Invalid Codex transfer request')
      }
      if (sourceAccountId) assertCodexAccountId(sourceAccountId)
      if (targetAccountId) assertCodexAccountId(targetAccountId)
      const sourcePath = await codexThreadRolloutPath(sourceAccountId, threadId)
      if (!sourcePath) throw new Error('Source Codex conversation is unavailable')
      // STRICT SOURCE CONTAINMENT before any upload: reuse PR 3's `planCodexRolloutExposure`
      // (source-side half) rather than re-implementing the guards. It refuses a source that is not a
      // regular file, whose basename does not end `<threadId>.jsonl`, or that escapes
      // `<sourceHome>/sessions/` (realpath + containment + no symlinked segment). Passing the source
      // home as the target home is safe: only the SOURCE fields are read here, the local rollout is
      // never linked/moved (it stays fully usable — §4.2 step 6).
      const sourceHome = codexHomeForAccount(platform().userDataDir, sourceAccountId)
      const plan = planCodexRolloutExposure(sourceHome, sourceHome, sourcePath, threadId)
      const sessionsRelativePath = path.posix.join('sessions', plan.targetRelativePath.split(path.sep).join('/'))
      // Hand the actual upload + atomic remote install to PR 6's importer. Absent (not yet wired /
      // no live SSH manager) fails closed with a named error rather than silently succeeding.
      const importer = getSshManager?.() as (SshProjectManager & CodexSshImporter) | undefined
      if (!importer?.remoteCodexImportThread) {
        throw new Error('Remote Codex import is unavailable')
      }
      const result = await importer.remoteCodexImportThread(
        projectId,
        targetAccountId,
        threadId,
        sessionsRelativePath,
        plan.sourcePath
      )
      return { threadId, imported: result.imported }
    }
  )
}
