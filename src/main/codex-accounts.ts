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
  ensureCodexAccountDaemon,
  isCodexAccountRemoving,
  localCodexSocket,
  migrateManagedCodexHomes
} from '../core/codex-accounts-service'
import { readCodexThreadAt } from '../core/codex-session-name'
import { ensureCodexRelayRoot } from './codex-relay-daemon'
import { platform } from '../core/platform'
import type { SshProjectManager } from './remote-ssh/ssh-project'

const SWITCH_RESERVATION_TTL_MS = 60_000
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
 *    projects). Managed Codex logins **on an SSH host driven from the desktop** remain PR 6's work:
 *    the host runs the relay + import, not its own copy of the switch protocol.
 *  - **Mobile (phone)** — never originates an add/switch/copy; it drives via relay→IPC and reads
 *    state. No mint here.
 *
 * @param getSshManager Lazily resolves the SSH project manager (created after this init in
 * index.ts). Only the local→SSH transfer SOURCE leg uses it today; local account ops never do.
 */
export function initCodexAccounts(getSshManager?: () => SshProjectManager | undefined): void {
  // Ensure `~/.nodeterm` exists before any relay/daemon reach (carried PR-4 obligation: only the
  // relay's detached serve() created it before, so a first reach from this process could race a
  // missing root). Desktop-only: the Server Edition has no relay daemon to root.
  ensureCodexRelayRoot()
  // Synchronous, BEFORE renderer hydration / PTY restore — see core's `migrateManagedCodexHomes`.
  migrateManagedCodexHomes()

  // The shared five. `ipcMain.handle`, not `platform().handle` — the file header explains why. The
  // event is stripped exactly as the seam would strip it: none of the five reads a sender.
  for (const [channel, fn] of Object.entries(codexAccountsHandlers({ isSwitchReserved }))) {
    ipcMain.handle(channel, (_event, ...args: any[]) => fn(...args))
  }

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
        await ensureCodexAccountDaemon(sourceAccountId)
        await ensureCodexAccountDaemon(targetAccountId)
        const source = await readCodexThreadAt(localCodexSocket(sourceAccountId), threadId, 5000)
        if (!source?.path) throw new Error('Source Codex conversation is unavailable')
        const exposure = planCodexRolloutExposure(
          codexHomeForAccount(platform().userDataDir, sourceAccountId),
          codexHomeForAccount(platform().userDataDir, targetAccountId),
          source.path,
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
      await ensureCodexAccountDaemon(sourceAccountId)
      const source = await readCodexThreadAt(localCodexSocket(sourceAccountId), threadId, 5000)
      if (!source?.path) throw new Error('Source Codex conversation is unavailable')
      // STRICT SOURCE CONTAINMENT before any upload: reuse PR 3's `planCodexRolloutExposure`
      // (source-side half) rather than re-implementing the guards. It refuses a source that is not a
      // regular file, whose basename does not end `<threadId>.jsonl`, or that escapes
      // `<sourceHome>/sessions/` (realpath + containment + no symlinked segment). Passing the source
      // home as the target home is safe: only the SOURCE fields are read here, the local rollout is
      // never linked/moved (it stays fully usable — §4.2 step 6).
      const sourceHome = codexHomeForAccount(platform().userDataDir, sourceAccountId)
      const plan = planCodexRolloutExposure(sourceHome, sourceHome, source.path, threadId)
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
