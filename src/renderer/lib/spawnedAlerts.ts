/**
 * Alert routing for nodes an AGENT opened (canvas control: open-agent / open-claude / spawn-team /
 * verify). Pure — Canvas feeds it the ropes, the live node set and the agent-status map.
 *
 * WHY: every node a conductor opens is a first-class agent node, so each one's Stop fired the full
 * "finished" alert — chirp, unread badge, OS notification. A 20-station fan-out was 20 alerts,
 * each announcing a station whose result is read by the CONDUCTOR, not the human [measured
 * 2026-09-02: a release-gate run left 15 such nodes, every one having alerted]. The human's
 * interest is "the fan-out is done", once.
 *
 * LINEAGE = the "spawned by" ROPES (`project.ropes`, drawn by `connect()` in Canvas's control
 * effect: conductor → node it opened). No new node field: the rope already IS the record of who
 * opened what, it is persisted, and it is pruned when either endpoint goes. A rope also runs from
 * a browser popup to its opener, so the source must be a LIVE AGENT node for it to count — a
 * popup is nobody's worker. Ropes come from the git-shared project file, so a peer can forge one;
 * the worst that buys is a suppressed done-chirp on one node, and needs-you alerts are never
 * routed through here at all (see `decideDoneAlert`'s contract).
 */

import type { AgentState } from '@shared/agents/normalize'

export interface RopeLike {
  source: string
  target: string
}

export type DoneAlertDecision =
  /** Not a spawned node (or its spawner is gone / not an agent): alert as always. */
  | { kind: 'alert' }
  /** A spawned node finished while siblings are still live: say nothing. */
  | { kind: 'quiet'; spawner: string; outstanding: number }
  /** The LAST live spawned node of this conductor finished: one aggregate alert, on the conductor. */
  | { kind: 'aggregate'; spawner: string; finished: number; total: number }

/** The agent node that opened `nodeId` via canvas control, if any. */
export function spawnerOf(
  nodeId: string,
  ropes: readonly RopeLike[],
  isAgentNode: (id: string) => boolean
): string | undefined {
  // A node has at most one rope INTO it in practice (one opener); take the first live agent.
  for (const r of ropes) {
    if (r.target === nodeId && r.source !== nodeId && isAgentNode(r.source)) return r.source
  }
  return undefined
}

/** Every node `spawner` opened that still exists and is an agent node (plain terminals never
 *  report done, so they can neither be "outstanding" nor "finished"). */
export function spawnedBy(
  spawner: string,
  ropes: readonly RopeLike[],
  isAgentNode: (id: string) => boolean
): string[] {
  const out: string[] = []
  for (const r of ropes) {
    if (r.source === spawner && r.target !== spawner && isAgentNode(r.target) && !out.includes(r.target))
      out.push(r.target)
  }
  return out
}

/**
 * Decide what a `done` on `nodeId` should do. ONLY `done`: a spawned node that is `blocked` /
 * `waiting` needs a HUMAN, and that alert must never be quieted — callers route needs-you
 * straight to the alert path and never ask here.
 *
 * "Outstanding" = a sibling whose state is explicitly live (working/blocked/waiting), OR one that
 * is ARMED behind `--after` and has not launched yet (`pendingLaunch` present — a known "will run
 * later", so a sequential chain yields ONE aggregate at the end, not one per link; consort finding
 * 2026-09-02). A sibling with NO known state and no pending launch (a CLI that never started, a
 * station killed by hand) is not outstanding: counting "no news" as "still running" would let one
 * dead station hold the aggregate hostage forever — the same trap `pendingLaunch` documents for
 * `--after`. The residual cost: a station that dies silently mid-chain can let an aggregate fire
 * early; the next completion then fires its own, which is the honest count at that moment.
 */
export function decideDoneAlert(input: {
  nodeId: string
  ropes: readonly RopeLike[]
  stateOf: (id: string) => AgentState | undefined
  isAgentNode: (id: string) => boolean
  /** Does the node hold an un-fired `pendingLaunch` (armed behind `--after`)? Default: never. */
  isArmed?: (id: string) => boolean
}): DoneAlertDecision {
  const spawner = spawnerOf(input.nodeId, input.ropes, input.isAgentNode)
  if (!spawner) return { kind: 'alert' }
  const siblings = spawnedBy(spawner, input.ropes, input.isAgentNode)
  let outstanding = 0
  let finished = 0
  for (const id of siblings) {
    if (id === input.nodeId) {
      finished++
      continue
    }
    const st = input.stateOf(id)
    if (st === 'working' || st === 'blocked' || st === 'waiting') outstanding++
    else if (st === 'done') finished++
    else if (input.isArmed?.(id)) outstanding++
  }
  if (outstanding > 0) return { kind: 'quiet', spawner, outstanding }
  return { kind: 'aggregate', spawner, finished, total: siblings.length }
}

/**
 * `--auto-close`: a spawned node closes itself once (a) it is `done` and (b) its OWN spawner has
 * read it through a context link since. Both are required and the ORDER matters: a read while the
 * station was still working consumed partial output, and closing on `done` alone would destroy the
 * result before the conductor ever looked. The requester must be the spawner: any other linked
 * node reading it (a verify panel's reviewer, say) is not the consumer the flag was set for.
 *
 * This is the ONE place a status event becomes destructive (a session is killed with no dialog),
 * so two proofs are demanded that a display-only badge never needed (blind security pass, 2026-09-02):
 * - the `done` must be VERIFIED — set by a hook POST that carried this instance's per-node token.
 *   `/hook/*` is fail-open for legacy tokenless posts by contract, so an unverified `done` on a
 *   still-working station is forgeable, and before this flag existed a forged status was harmless.
 * - the `done` transition must PREDATE the read's start (`doneSince <= requestedAt`): a Stop that
 *   lands while the render is in flight makes the state read `done` on arrival although the
 *   conductor consumed partial output.
 * The reader's identity is proven upstream: core/context-link.ts emits the read only for a
 * verified caller, so a bearer holder POSTing `nodeId=<conductor>` never produces this event.
 * The reader must ALSO be the node that armed the flag (`armedBy`), recorded in memory at
 * `open-*` time: ropes are persisted and peer-writable, so a rope alone could be rewritten to
 * nominate a different verified node as "spawner" and hand it the kill (consort re-review).
 */
export function shouldAutoClose(input: {
  nodeId: string
  readerId: string
  /** When the read started (LinkedRead.requestedAt). */
  requestedAt: number
  /** The node that opened `id` with `--auto-close` THIS process, or undefined if not armed. */
  armedBy: (id: string) => string | undefined
  ropes: readonly RopeLike[]
  stateOf: (id: string) => AgentState | undefined
  /** Did a token-verified hook POST set the node's current state? */
  isVerified: (id: string) => boolean
  /**
   * When the current state was FIRST asserted VERIFIED (agentStatus `stateVerifiedAt`) — not the
   * transition time: a forgeable unverified `done` can record the transition early, and the real
   * Stop then re-asserts it verified without moving the transition clock. undefined ⇒ refuse.
   */
  verifiedSince: (id: string) => number | undefined
  isAgentNode: (id: string) => boolean
}): boolean {
  const opener = input.armedBy(input.nodeId)
  if (!opener || opener !== input.readerId) return false
  if (input.stateOf(input.nodeId) !== 'done') return false
  if (!input.isVerified(input.nodeId)) return false
  const since = input.verifiedSince(input.nodeId)
  if (since === undefined || since > input.requestedAt) return false
  return spawnerOf(input.nodeId, input.ropes, input.isAgentNode) === input.readerId
}
