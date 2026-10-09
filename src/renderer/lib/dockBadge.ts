import type { Project } from '@shared/types'

/**
 * The Dock badge counts agent nodes with unread output. `useAgentStatus.byId` is a persisted table
 * that only loses an entry when a node is deleted through one of the app's own delete paths, so it
 * also holds nodes that no longer exist anywhere: removed by a git pull of project.json, by a peer,
 * by a project dropped from the workspace, or by an older build. Measured 2026-10-09: 263 entries
 * against ~20 live nodes, three of them orphans still flagged unread, so the Dock showed "3" for
 * sessions the user could not find, let alone open and clear.
 *
 * So the badge counts only ids that belong to a project this window knows. The table itself is
 * left alone: a node of a project that loads later (an SSH mirror, a relay tab) keeps its flag and
 * counts again the moment its project is back.
 */

/** A PRIMITIVE signature of every node id across all projects (closed ones included), so a store
 *  subscriber re-renders only when the set of nodes changes, never on a drag or a viewport move. */
export function knownNodeIdsSig(projects: readonly Project[]): string {
  const ids: string[] = []
  for (const p of projects) for (const n of p.nodes) ids.push(n.id)
  return ids.join('\0')
}

export function knownNodeIdsFromSig(sig: string): ReadonlySet<string> {
  return new Set(sig ? sig.split('\0') : [])
}

/** Unread nodes that still exist in some project. */
export function countKnownUnread(
  byId: Readonly<Record<string, { unread?: boolean } | undefined>>,
  known: ReadonlySet<string>
): number {
  let count = 0
  for (const [id, st] of Object.entries(byId)) if (st?.unread && known.has(id)) count++
  return count
}
