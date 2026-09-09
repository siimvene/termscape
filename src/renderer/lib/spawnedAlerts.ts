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
  /** Does the station still OWN work past its foreground `done` (`stationHoldsWork`)? A close is
   *  a kill, so a background task, a recurring job, a live subagent or a live spawned child of its
   *  own all refuse it — the read is kept and retried (Codex panel, 2026-09-09). */
  holdsWork?: (id: string) => boolean
}): boolean {
  const opener = input.armedBy(input.nodeId)
  if (!opener || opener !== input.readerId) return false
  if (input.stateOf(input.nodeId) !== 'done') return false
  if (!input.isVerified(input.nodeId)) return false
  const since = input.verifiedSince(input.nodeId)
  if (since === undefined || since > input.requestedAt) return false
  if (input.holdsWork?.(input.nodeId)) return false
  return spawnerOf(input.nodeId, input.ropes, input.isAgentNode) === input.readerId
}

/**
 * Work a station can own past a foreground `done`, i.e. what a teardown would silently kill. The
 * first three are the facts Eco's hibernation refuses on (renderer/lib/hibernationCandidates.ts,
 * where each is argued): a recurring job (`agentStatus.loop`), a background shell launched with no
 * turn since (`backgroundTaskAt`), a subagent card not done — the caller folds those into
 * `hasInFlight`. The fourth only a teardown (not an `/exit`) creates: LIVE SPAWNED STATIONS of the
 * node's own. A nested conductor A (opened by C, opener of B) that finishes while B still runs
 * must not be closed on C's read: deleting A prunes A→B's rope and bridge, and B keeps running
 * with no reader, no lineage, and no way into the aggregate alert or the sweep (Codex panel,
 * 2026-09-09). A child that is armed behind `--after` is live too (a known "will run later").
 */
export function stationHoldsWork(input: {
  nodeId: string
  ropes: readonly RopeLike[]
  isAgentNode: (id: string) => boolean
  stateOf: (id: string) => AgentState | undefined
  isArmed?: (id: string) => boolean
  hasInFlight: (id: string) => boolean
}): boolean {
  if (input.hasInFlight(input.nodeId)) return true
  for (const child of spawnedBy(input.nodeId, input.ropes, input.isAgentNode)) {
    const st = input.stateOf(child)
    if (st === 'working' || st === 'blocked' || st === 'waiting' || input.isArmed?.(child)) return true
  }
  return false
}

/**
 * `--auto-close` resolution. The flag used to be opt-in per open, and the measured result was a
 * canvas of finished stations nobody closed (2026-09-09: 23 idle CLIs from one conductor over 8
 * cycles, 120–270 MB each, 2 to 42 h old): the rule text told the opener to tear down and the
 * opener moved on to its next cycle. So the DEFAULT is the setting (`autoCloseSpawnedNodes`, on
 * unless the user turns it off) and the flag is the per-open override: `--auto-close no` keeps a
 * station the agent intends to converse with (`done` is the end of a TURN — a closed station
 * cannot take a follow-up `send`). A bare `--auto-close` (empty value) is "not passed", the
 * shim-wide contract every flag follows (`projectTargetFlagRefusal`), so it reads as the setting.
 * `explicit` tells the caller whether a capability refusal is owed: an explicit yes on an agent
 * that could never close is an error the agent should hear; a defaulted arm on such an agent is
 * simply not armed.
 */
export function resolveAutoClose(
  raw: string | undefined,
  defaultOn: boolean
): { wanted: boolean; explicit: boolean } {
  if (raw === undefined || raw.trim() === '') return { wanted: defaultOn, explicit: false }
  const v = raw.trim().toLowerCase()
  const off = v === 'no' || v === 'false' || v === 'off' || v === '0'
  return { wanted: !off, explicit: true }
}

/** How long a finished station (and its conductor) must sit idle before the app offers to close
 *  it: long enough that a conductor reading its stations one by one between turns is never
 *  interrupted, short enough that a pile does not survive a working day. */
export const SPAWNED_IDLE_SWEEP_MS = 30 * 60_000

export interface SweepGroup {
  spawner: string
  ids: string[]
}

/**
 * The idle sweep: finished stations auto-close cannot reach. Auto-close fires on ONE signal —
 * the opener's linked read after a verified `done` — and two real cases never produce it: an app
 * RESTART (the arming is in-memory by design, tmux continuity keeps every session), and a
 * conductor that consumed results some other way (git, files, a brief the station wrote). This
 * sweep is the backstop for both, and it is NOT destructive on its own: the caller shows ONE
 * confirm dialog listing every candidate by title and id, and the user's click is the consent —
 * so, unlike `shouldAutoClose`, no verified-done proof is demanded here.
 *
 * A candidate is a spawned agent node (rope from a live agent conductor) that is not live (state
 * neither working/blocked/waiting nor armed behind `--after`), idle for `idleMs`, whose
 * conductor is likewise not live and idle for `idleMs`, and that the user has not declined this
 * session. "Idle since" is the node's own clock when it has one, else `firstSeenAt` — when the
 * sweep first saw THAT node on a canvas: a node that has reported nothing since launch is measured
 * from launch (the restart case, where every state is unknown until the next hook fires), and a
 * node that appeared hours later (a cold-open member before its first hook) from its own arrival,
 * never from the sweep's start (blind security pass, 2026-09-09). A conductor that was
 * deleted has had its ropes pruned, so its orphans are not "spawned" any more and are not seen
 * here — `close --node` or the UI, as before.
 */
export function sweepFinishedStations(input: {
  ropes: readonly RopeLike[]
  isAgentNode: (id: string) => boolean
  /** Nodes the sweep may act on — the ACTIVE canvas (a delete must run where the project is on screen). */
  onCanvas: (id: string) => boolean
  stateOf: (id: string) => AgentState | undefined
  /** When the node's current state was last asserted, if known. */
  idleSince: (id: string) => number | undefined
  /** Does the node hold an un-fired `pendingLaunch` (armed behind `--after`)? */
  isArmed: (id: string) => boolean
  declined: ReadonlySet<string>
  now: number
  idleMs: number
  /** When the sweep first observed the node (per node), for nodes with no status clock at all. */
  firstSeenAt: (id: string) => number
  /** `stationHoldsWork`: a station that still owns work is live for the sweep too. */
  holdsWork?: (id: string) => boolean
}): SweepGroup[] {
  const live = (id: string): boolean => {
    const st = input.stateOf(id)
    return (
      st === 'working' || st === 'blocked' || st === 'waiting' || input.isArmed(id) || !!input.holdsWork?.(id)
    )
  }
  const idle = (id: string): boolean =>
    !live(id) && input.now - (input.idleSince(id) ?? input.firstSeenAt(id)) >= input.idleMs
  const groups = new Map<string, string[]>()
  for (const r of input.ropes) {
    const id = r.target
    if (id === r.source || !input.isAgentNode(r.source) || !input.isAgentNode(id)) continue
    if (!input.onCanvas(id) || input.declined.has(id)) continue
    if (spawnerOf(id, input.ropes, input.isAgentNode) !== r.source) continue
    if (!idle(id) || !idle(r.source)) continue
    const list = groups.get(r.source) ?? []
    if (!list.includes(id)) list.push(id)
    groups.set(r.source, list)
  }
  return Array.from(groups, ([spawner, ids]) => ({ spawner, ids }))
}
