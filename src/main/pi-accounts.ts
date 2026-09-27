// Desktop wiring for the managed-pi-account lifecycle. The logic is core's `piAccountsHandlers`
// (the same table the Server Edition registers through `platform().handle`); this file only BINDS
// it through `ipcMain.handle`. `ipcMain`, NOT `platform().handle`: the latter registers into the
// peer-reachable handler table (platform-electron.ts, "THE INVARIANT (4c)"), which would let a
// paired relay GUEST mint and delete managed pi accounts on the HOST — the same reason
// `main/claude-accounts.ts` binds the Claude table here.
import { ipcMain } from 'electron'
import { piAccountsHandlers, type PiAccountsDeps } from '../core/pi-accounts-service'
import type { AccountRowStore } from '../core/settings-store'

/**
 * @param settings The settings store; account ROW membership is written through its `mutate`.
 * @param installSkill Optional per-account addition (a pi canvas-control skill), when the shell has one.
 */
export function initPiAccounts(
  settings: AccountRowStore,
  installSkill?: PiAccountsDeps['installSkill']
): void {
  // The event is stripped exactly as the core seam would strip it: none of the four reads a sender.
  for (const [channel, fn] of Object.entries(piAccountsHandlers({ settings, installSkill }))) {
    ipcMain.handle(channel, (_event, ...args: any[]) => fn(...args))
  }
}
