// Resolve a managed Claude account's config dir under this app's persistent state root.
// The account LIST + login lifecycle live in main/claude-accounts.ts; this is just the
// impure path resolution (needs the platform seam for userDataDir) split out so core
// modules (pty-manager, etc.) can use it without importing electron.
import * as fs from 'fs'
import { platform } from './platform'
import { accountConfigDir } from './claude-accounts-core'

export function claudeConfigDirFor(accountId: string): string {
  return accountConfigDir(platform().userDataDir, accountId)
}

/**
 * The config dir a SPAWN should run under for a managed account: this instance's own dir when it
 * exists, else the co-located desktop peer's (`CorePlatform.peerUserDataDir`) when THAT exists,
 * else the own path (absent — the caller's missing-dir fallback then applies and is reported
 * honestly). Spawn-side only: adding, logging into and removing accounts keep using
 * `claudeConfigDirFor`, so a server never creates or deletes a dir in the peer's tree. Id validation
 * is `claudeConfigDirFor`'s (traversal rejected before any path is built).
 */
export function claudeConfigDirForSpawn(accountId: string): string {
  const own = claudeConfigDirFor(accountId)
  const peerRoot = platform().peerUserDataDir
  if (!peerRoot || fs.existsSync(own)) return own
  const peer = accountConfigDir(peerRoot, accountId)
  return fs.existsSync(peer) ? peer : own
}
