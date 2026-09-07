// The managed Claude accounts a CO-LOCATED desktop peer owns, as a read-only list for a spawn on
// this instance. Why: the phone's New Session sheet enumerates accounts from `settings:load`, and on
// the Mac phone-desktop topology the Server Edition's own settings list none — every managed account
// is the desktop's — so the sheet offered only the System account (Siim, 2026-09-07). The dirs are
// already resolvable here (`claudeConfigDirForSpawn` → `CorePlatform.peerUserDataDir`); this is the
// matching directory listing. Read-only and tolerant: the peer's `settings.json` is that app's file,
// never written here, and a row is offered only when it can actually be spawned — not pending, not
// pinned to an SSH host, and its config dir present under the peer's `claude-accounts/`.
import * as fs from 'fs'
import * as path from 'path'
import { accountConfigDir, isSafeAccountId } from './claude-accounts-core'

/** The subset of `ClaudeAccount` the sheet needs; nothing that would let a client mutate the peer. */
export interface PeerClaudeAccount {
  id: string
  label: string
  email?: string
  createdAt?: number
}

export function readPeerClaudeAccounts(peerUserDataDir: string): PeerClaudeAccount[] {
  let rows: unknown
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(peerUserDataDir, 'settings.json'), 'utf8'))
    rows = (raw as { claudeAccounts?: unknown } | null)?.claudeAccounts
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  const out: PeerClaudeAccount[] = []
  for (const r of rows) {
    if (typeof r !== 'object' || r === null || Array.isArray(r)) continue
    const a = r as Record<string, unknown>
    if (typeof a.id !== 'string' || !isSafeAccountId(a.id)) continue
    if (a.pending === true) continue
    if (typeof a.host === 'string' && a.host.length > 0) continue
    if (!fs.existsSync(accountConfigDir(peerUserDataDir, a.id))) continue
    const row: PeerClaudeAccount = {
      id: a.id,
      label: typeof a.label === 'string' ? a.label.slice(0, 200) : a.id
    }
    if (typeof a.email === 'string') row.email = a.email.slice(0, 320)
    if (typeof a.createdAt === 'number' && Number.isFinite(a.createdAt)) row.createdAt = a.createdAt
    out.push(row)
  }
  return out
}
