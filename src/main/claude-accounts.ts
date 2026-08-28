// Impure lifecycle for managed Claude accounts: config-dir creation/deletion, login
// capture (poll .claude.json), CLI version check, hook install. The account LIST lives in
// settings.json (renderer-owned via useSettings); this module only owns the filesystem.
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { ipcMain } from 'electron'
import { IPC } from '../shared/ipc'
import { isSupportedClaudeVersion, parseLoginCapture } from '../core/claude-accounts-core'
import { claudeConfigDirFor } from '../core/claude-config-dir'
import { installClaudeHooksInto, ensureClaudeFullscreenTuiInto } from '../core/agents/hooks/claude'
import { installCanvasSkillInto } from './canvas-control'
import { findInLoginPath } from '../core/pty-manager'
import type { SshProjectManager } from './remote-ssh/ssh-project'

const execFileP = promisify(execFile)
const LOGIN_POLL_MS = 2000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
/** Hard cap on how long `claude:accounts-add` may spend on the version probe before answering —
 *  the probe shells out and must never make the Add button appear hung (consort/field finding). */
const ADD_VERSION_PROBE_BUDGET_MS = 1500

// Re-exported for this module's other consumers (claude-usage.ts) so their import path is
// unchanged; the implementation now lives in core (../core/claude-config-dir).
export { claudeConfigDirFor } from '../core/claude-config-dir'

/**
 * Optional per-call SSH context. When `projectId` is present AND that project has a live
 * ControlMaster, the account is a REMOTE one: its config dir + login capture + removal happen on the
 * host over ssh instead of on the local filesystem. The renderer passes it only for accounts scoped
 * to an SSH project (`ClaudeAccount.host`); local accounts omit it entirely (unchanged behavior).
 */
interface AccountCtx {
  projectId?: string
}

// A SET per id: the launch heal + a Retry click legitimately run two concurrent waits for one
// account, and a single-slot map let one wait's cleanup deregister the other (review finding) —
// cancel then no-op'd and the orphan poll ran to its full deadline.
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

/**
 * @param getSshManager Lazily resolves the SSH project manager (created after this init in index.ts).
 * Returns undefined when SSH isn't wired — every remote path then falls back to local behavior.
 */
export function initClaudeAccounts(getSshManager?: () => SshProjectManager | undefined): void {
  // Resolve the live remote manager for a context, or null when the context is local / not connected.
  const remoteFor = (ctx?: AccountCtx): { mgr: SshProjectManager; projectId: string } | null => {
    const projectId = ctx?.projectId
    const mgr = getSshManager?.()
    return projectId && mgr ? { mgr, projectId } : null
  }

  ipcMain.handle(IPC.claudeAccountsAdd, async (_e, ctx?: AccountCtx) => {
    const id = randomUUID()
    const remote = remoteFor(ctx)
    if (remote) {
      // REMOTE account: create the config dir + install the status hook on the host. No local dir
      // and no local hook install — the session runs entirely on the remote host.
      const res = await remote.mgr.remoteAccountAdd(remote.projectId, id)
      // Null means the project wasn't connected / mkdir failed: still return the id so the renderer
      // can show the pending row; the login node will surface the connection error itself.
      return { id, configDir: res?.configDir ?? '', versionSupported: res?.versionSupported ?? true }
    }
    const configDir = claudeConfigDirFor(id)
    await fs.mkdir(configDir, { recursive: true })
    // Install the managed hook + canvas skill up front so the very first session in this
    // account already reports status (badges/notifications/subagent viz) and can control
    // the canvas (Claude resolves skills relative to CLAUDE_CONFIG_DIR, not ~/.claude).
    installClaudeHooksInto(configDir)
    installCanvasSkillInto(configDir)
    // Ensure fullscreen TUI in the new account dir (write-if-absent, version-gated). Best-effort,
    // off the response path — the memoized probe + write both fail open.
    void ensureClaudeFullscreenTuiInto(configDir)
    // The version probe must NEVER gate the response: it shells out to the login shell + `claude
    // --version`, and on a machine whose login shell is slow/interactive, or whose Claude CLI
    // isn't on the GUI PATH, that walk can take seconds — the Add button then spins as if hung
    // (real reports on a colleague's laptop). The account dir already exists and works; the only
    // thing the probe feeds is the < 2.1 keychain-scope WARNING, so bound it hard — a hung Add
    // button is not acceptable.
    //
    // The timeout resolves FALSE (= show the warning), not true. It used to assume "supported",
    // justified by the renderer re-probing via claude.cliCaps() later — but AccountsSection never
    // calls it, so that recovery does not exist, and the late probe result is discarded. The
    // effect was that the very machine this budget exists for (slow login shell) is the one where
    // a < 2.1 CLI's keychain-collision warning was silently suppressed. Failing safe costs a
    // dismissable notice when a modern CLI merely answered slowly; failing open costs account B's
    // login overwriting account A's shared unscoped Keychain credential. (Consort finding,
    // 2026-08-28 — verified: `isSupportedClaudeVersion` in core documents the collision, and the
    // renderer warns only on `!versionSupported`.)
    let probeTimer: NodeJS.Timeout | undefined
    try {
      const versionSupported = await Promise.race([
        checkClaudeVersion(),
        new Promise<boolean>((resolve) => {
          probeTimer = setTimeout(() => resolve(false), ADD_VERSION_PROBE_BUDGET_MS)
        })
      ])
      return { id, configDir, versionSupported }
    } finally {
      // The losing branch is never observed again; leaving the timer armed kept a handle alive per
      // Add. (The probe subprocess is separately bounded by its own timeout.)
      if (probeTimer) clearTimeout(probeTimer)
    }
  })

  ipcMain.handle(IPC.claudeAccountsWaitLogin, async (_e, id: string, ctx?: AccountCtx) => {
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
            ? await remote.mgr.remoteAccountReadLogin(remote.projectId, id)
            : await fs.readFile(path.join(configDir as string, '.claude.json'), 'utf-8')
          const captured = raw ? parseLoginCapture(raw) : null
          if (captured) return captured
        } catch {
          // not written yet — keep polling
        }
        await new Promise((r) => setTimeout(r, LOGIN_POLL_MS))
      }
      return null
    } finally {
      // Ownership-checked: remove only THIS wait; a concurrent wait for the same id survives.
      const live = waiters.get(id)
      live?.delete(w)
      if (live && live.size === 0) waiters.delete(id)
    }
  })

  ipcMain.handle(IPC.claudeAccountsCancelWait, (_e, id: string) => {
    for (const w of waiters.get(id) ?? []) w.cancelled = true
  })

  ipcMain.handle(IPC.claudeAccountsRemove, async (_e, id: string, ctx?: AccountCtx) => {
    const remote = remoteFor(ctx)
    if (remote) {
      // Best-effort remote cleanup; if the project isn't connected the manager no-ops and the
      // renderer still drops the account from its list (the dir is orphaned, harmless).
      await remote.mgr.remoteAccountRemove(remote.projectId, id)
      return
    }
    const configDir = claudeConfigDirFor(id) // id validation prevents traversal
    await fs.rm(configDir, { recursive: true, force: true })
  })
}
