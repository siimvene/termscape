// Desktop wiring for the managed-Claude-account lifecycle: config-dir creation/deletion, login
// capture (poll .claude.json), CLI version check, per-account hook install, and the account ROW
// (`settings.claudeAccounts`, written through the settings store's read-modify-write — see the
// header of src/core/claude-accounts-service.ts).
//
// The logic is core's `claudeAccountsHandlers` (the same table the Server Edition registers through
// `platform().handle`); this file only BINDS it through `ipcMain.handle` and supplies the two
// desktop-only deps: the canvas skill (canvas control is not wired on the server) and the SSH legs
// (the server has no SSH-project manager). `ipcMain.handle`, NOT `platform().handle`: the latter
// registers into the peer-reachable handler table (platform-electron.ts, "THE INVARIANT (4c)"),
// which would newly let a paired relay GUEST mint and delete managed accounts on the HOST while the
// guest's own settings.json records them as its own. Binding through ipcMain keeps desktop reach
// byte-identical to what it was before the two shells shared one implementation.
import { ipcMain } from 'electron'
import {
  claudeAccountsHandlers,
  type ClaudeAccountsRemote
} from '../core/claude-accounts-service'
import type { AccountRowStore } from '../core/settings-store'
import { installCanvasSkillInto } from './canvas-control'
import type { SshProjectManager } from './remote-ssh/ssh-project'

// Re-exported for this module's other consumers (claude-usage.ts) so their import path is
// unchanged; the implementation now lives in core (../core/claude-config-dir).
export { claudeConfigDirFor } from '../core/claude-config-dir'

/**
 * @param settings The settings store; account ROW membership is written through its `mutate`.
 * @param getSshManager Lazily resolves the SSH project manager (created after this init in index.ts).
 * Returns undefined when SSH isn't wired — every remote path then falls back to local behavior.
 */
export function initClaudeAccounts(
  settings: AccountRowStore,
  getSshManager?: () => SshProjectManager | undefined
): void {
  const remote = (): ClaudeAccountsRemote | undefined => {
    const mgr = getSshManager?.()
    if (!mgr) return undefined
    return {
      add: (projectId, id) => mgr.remoteAccountAdd(projectId, id),
      readLogin: (projectId, id) => mgr.remoteAccountReadLogin(projectId, id),
      remove: (projectId, id) => mgr.remoteAccountRemove(projectId, id),
      hostKey: (projectId) => mgr.hostKeyFor(projectId)
    }
  }
  // The event is stripped exactly as the core seam would strip it: none of the four reads a sender.
  for (const [channel, fn] of Object.entries(
    claudeAccountsHandlers({ settings, installSkill: installCanvasSkillInto, remote })
  )) {
    ipcMain.handle(channel, (_event, ...args: any[]) => fn(...args))
  }
}
