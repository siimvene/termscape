// Resolve a managed pi account's agent dir (its PI_CODING_AGENT_DIR) under this app's persistent
// state root. Sibling of `claude-config-dir.ts` / `codex-config-dir.ts`: the account LIST and the
// login lifecycle live in `pi-accounts-service.ts`; this is only path resolution, split out so core
// modules (pty-manager, the service, the launch-time extension loop) share ONE answer to "where
// does this pi account live?".
//
// The layout `<userData>/pi-accounts/<id>` is not free to change: the raw listeners' transcript
// jail (`isSafeLocalTranscriptPath` in claude-accounts-core.ts) already admits exactly
// `<userData>/pi-accounts/<id>/sessions/**` with the id validated by the same alphabet, and a
// session running under any other dir would post transcript paths that jail refuses.
import * as fs from 'fs'
import path from 'path'
import { isSafeAccountId } from './claude-accounts-core'
import { platform } from './platform'

/** The directory under userData that holds every managed pi account dir. */
export const PI_ACCOUNTS_DIRNAME = 'pi-accounts'

/**
 * `<userData>/pi-accounts/<id>` for a managed pi account. The id is validated with the SAME
 * account-id rule managed Claude accounts use (`isSafeAccountId`: `[A-Za-z0-9_-]+`, so `.`/`..`
 * and separators are barred) — it comes from a hand-editable settings.json and from renderer IPC,
 * and it becomes both a spawn env value and a recursive-delete target. Throws on a bad id.
 */
export function piAccountDirFor(userDataPath: string, accountId: string): string {
  if (typeof accountId !== 'string' || !isSafeAccountId(accountId)) {
    throw new Error(`invalid account id: ${JSON.stringify(accountId)}`)
  }
  return path.join(userDataPath, PI_ACCOUNTS_DIRNAME, accountId)
}

/**
 * Fork (Termscape): is `dir` a managed pi account dir of `userDataPath` (`<userData>/pi-accounts/<id>`,
 * exactly one level below the root)? Writes into such a dir are ANCHORED (`mkdirBelow`) so a deleted
 * account is never recreated. Decided by LOCATION, not by the account list, because the same dir can
 * also arrive as the "system" pi dir: an app launched from a managed pi terminal inherits that
 * session's PI_CODING_AGENT_DIR, and `piAgentDir()` then names the account.
 */
export function isManagedPiAccountDir(dir: string, userDataPath: string): boolean {
  const rel = path.relative(path.join(userDataPath, PI_ACCOUNTS_DIRNAME), path.resolve(dir))
  return rel !== '' && !path.isAbsolute(rel) && !rel.startsWith('..') && !rel.includes(path.sep)
}

/** `isManagedPiAccountDir` against `userDataPath` OR the co-located peer's userData
 *  (`CorePlatform.peerUserDataDir`, the Server Edition beside a desktop): an instance launched from
 *  the PEER's managed pi terminal inherits a PI_CODING_AGENT_DIR under the peer's root, and that
 *  account is just as deletable underneath it. */
export function isAnyManagedPiAccountDir(dir: string, userDataPath: string): boolean {
  if (isManagedPiAccountDir(dir, userDataPath)) return true
  let peer: string | undefined
  try {
    peer = platform().peerUserDataDir
  } catch {
    return false
  }
  return !!peer && isManagedPiAccountDir(dir, peer)
}

/** `piAccountDirFor` against this instance's own userData (the platform seam). */
export function piAccountDir(accountId: string): string {
  return piAccountDirFor(platform().userDataDir, accountId)
}

/**
 * The agent dir a SPAWN should run under: this instance's own dir when it exists, else the
 * co-located desktop peer's (`CorePlatform.peerUserDataDir`, the Server Edition beside a desktop)
 * when THAT exists, else the own path (absent — the caller's missing-dir fallback then applies and
 * is reported honestly). Same shape as `claudeConfigDirForSpawn`, and the jail already admits the
 * peer's `pi-accounts/<id>/sessions` for exactly this case. Spawn-side only: add, login capture and
 * removal keep using `piAccountDir`, so a server never creates or deletes a dir in the peer's tree.
 */
export function piAccountDirForSpawn(accountId: string): string {
  const own = piAccountDir(accountId)
  const peerRoot = platform().peerUserDataDir
  if (!peerRoot || fs.existsSync(own)) return own
  const peer = piAccountDirFor(peerRoot, accountId)
  return fs.existsSync(peer) ? peer : own
}
