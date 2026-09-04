/**
 * The browser half of the managed-Codex-account split.
 *
 * The five parity verbs moved into `src/core/codex-accounts-service.ts` and are registered on the server
 * (src/core/codex-accounts-service.test.ts proves that half), so the bridge must actually REQUEST
 * them instead of leaving the whole namespace on the E_UNSUPPORTED stub. The switch quartet and the
 * SSH transfer leg stay stubbed: the server registers no such channel, because every switch phase
 * is authorized against the Electron WebContents that reserved it and auto-releases on that
 * renderer's `destroyed` event — neither exists on a WS connection. Routing them here would swap a
 * legible refusal for an E_NO_HANDLER at the far end.
 *
 * MUTATIONS:
 *  - drop `codexAccounts: buildCodexAccountsApi(...)` from installWsBridge ⇒ the spread case
 *    reddens (the compiler cannot catch it: `buildStubApi()` already satisfies the namespace, so
 *    the stub would silently win in every browser session).
 *  - point `switchThread` at `client.request` ⇒ the still-refused case reddens.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildCodexAccountsApi } from './ws-bridge'
import { buildStubApi } from './stubs'
import { E_UNSUPPORTED } from '../../shared/rpc'
import { IPC } from '../../shared/ipc'

function fakeClient() {
  const calls: Array<{ kind: string; method: string; args: unknown[] }> = []
  return {
    calls,
    request: (method: string, ...args: unknown[]) => {
      calls.push({ kind: 'request', method, args })
      return Promise.resolve('R')
    },
    cast: () => {},
    subscribe: () => () => {}
  }
}

describe('buildCodexAccountsApi', () => {
  it('every ported member requests its real channel', async () => {
    const c = fakeClient()
    const api = buildCodexAccountsApi(c as never, buildStubApi().codexAccounts)
    await api.add()
    await api.waitLogin('a1')
    await api.cancelWaitLogin('a1')
    await api.identity('a1')
    await api.systemIdentity()
    await api.systemIdentity({ projectId: 'p1' })
    await api.remove('a1')
    expect(c.calls).toEqual([
      { kind: 'request', method: IPC.codexAccountsAdd, args: [] },
      { kind: 'request', method: IPC.codexAccountsWaitLogin, args: ['a1'] },
      { kind: 'request', method: IPC.codexAccountsCancelWait, args: ['a1'] },
      { kind: 'request', method: IPC.codexAccountsIdentity, args: ['a1'] },
      { kind: 'request', method: IPC.codexAccountsSystemIdentity, args: [undefined] },
      { kind: 'request', method: IPC.codexAccountsSystemIdentity, args: [{ projectId: 'p1' }] },
      { kind: 'request', method: IPC.codexAccountsRemove, args: ['a1'] }
    ])
  })

  // Desktop-only, and it must REFUSE with the code rather than reach a channel nobody registered.
  it('the switch protocol and the SSH transfer leg still refuse E_UNSUPPORTED in the browser', async () => {
    const c = fakeClient()
    const api = buildCodexAccountsApi(c as never, buildStubApi().codexAccounts)
    await expect(api.switchThread('t1', '/cwd', 'a1', 'a2')).rejects.toMatchObject({
      code: E_UNSUPPORTED
    })
    await expect(api.commitSwitch('tok')).rejects.toMatchObject({ code: E_UNSUPPORTED })
    await expect(api.finishSwitch('tok')).rejects.toMatchObject({ code: E_UNSUPPORTED })
    await expect(api.rollbackSwitch('tok')).rejects.toMatchObject({ code: E_UNSUPPORTED })
    await expect(api.transferThreadToSsh('t1', '/cwd', 'p1')).rejects.toMatchObject({
      code: E_UNSUPPORTED
    })
    // A refusal is not a request: nothing must have travelled over the socket.
    expect(c.calls).toEqual([])
  })

  // Same trap as buildClaudeAccountsApi's: buildStubApi() already satisfies `codexAccounts`, so a
  // dropped assignment compiles and the stub silently wins in every browser session.
  it('is assigned into the assembled window.nodeTerminal', () => {
    const src = readFileSync(join(__dirname, 'ws-bridge.ts'), 'utf8')
    const install = src.slice(src.indexOf('export async function installWsBridge'))
    expect(install).toContain('codexAccounts: buildCodexAccountsApi(client, stubApi.codexAccounts)')
  })
})

/**
 * The DESKTOP half stays where it was. `src/main/codex-accounts.ts` must keep registering the
 * switch protocol + the transfer leg on `ipcMain` (its own suites drive those handlers), and must
 * keep binding the five shared verbs through `ipcMain.handle` rather than `platform().handle` —
 * the seam would additionally expose them to relay GUESTS (platform-electron.ts, "THE INVARIANT
 * (4c)"), which is a reach change, not a port. Pinned by source text because neither fact is
 * expressible in the type system.
 */
describe('desktop registration is unchanged by the split', () => {
  const src = readFileSync(join(__dirname, '../../main/codex-accounts.ts'), 'utf8')

  it('still registers the four switch verbs and the transfer leg on ipcMain', () => {
    for (const channel of [
      'IPC.codexAccountsSwitchThread',
      'IPC.codexAccountsCommitSwitch',
      'IPC.codexAccountsFinishSwitch',
      'IPC.codexAccountsRollbackSwitch',
      'IPC.codexAccountsTransferThreadToSsh'
    ]) {
      expect(src, channel).toContain(channel)
    }
    // Anchored to a statement, not to the prose: the file's header explains at length WHY it does
    // not use the seam, and a bare substring check would match that explanation.
    expect(src).not.toMatch(/^\s*platform\(\)\.handle/m)
  })

  it('binds the shared five through ipcMain, not the peer-reachable platform seam', () => {
    expect(src).toMatch(/codexAccountsHandlers\(\{\s*isSwitchReserved,\s*settings\s*\}\)/)
    expect(src).toContain('ipcMain.handle(channel,')
  })
})
