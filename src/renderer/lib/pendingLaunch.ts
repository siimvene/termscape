// Pure logic for ARMED terminal nodes — the canvas-control `--after` dependency edge. A node
// opened with `--after <ids>` holds its launch command (see PendingLaunch in @shared/types)
// until every station it waits on has gone idle; this module decides when that is, and which
// dependency edges to draw meanwhile. Kept free of React/store imports so the satisfaction
// matrix is unit-testable — Canvas.tsx only wraps these in an effect and a setState.
import type { AgentState } from '@shared/agents/normalize'
import type { PendingLaunch } from '@shared/types'

/** The subset of a canvas node this module reads. */
export interface ArmedNode {
  id: string
  data: { pendingLaunch?: PendingLaunch }
}

/** The subset of the agentStatus store this module reads. */
export type StatusById = Record<string, { state?: AgentState } | undefined>

/**
 * May a freshly-mounted agent node run its cold-restore `--resume` (or any in-place relaunch)?
 *
 * NO while it still holds a `pendingLaunch`. An armed node (canvas-control `--after`, or a
 * cold-opened node) has NEVER launched its agent: its `agentSessionId` was MINTED at creation and
 * names a conversation that does not exist yet — the held launch (`--session-id <id> …`, delivered
 * by the "Fire armed nodes" effect) is what creates it. Resuming first types `claude --resume <id>`
 * into the fresh shell, which prints "No conversation found with session ID: …", wastes a CLI start,
 * and then has the real launch delivered on top. Once the fire effect delivers and clears
 * `pendingLaunch`, a later cold restore resumes normally — so the gate is exactly the pending flag,
 * nothing more. Three cases: armed (`pendingLaunch` set) ⇒ false; delivered / plain restore (no
 * `pendingLaunch`) ⇒ true.
 */
export function mayRelaunchAgent(data: { pendingLaunch?: PendingLaunch }): boolean {
  return !data.pendingLaunch
}

export interface LaunchToFire {
  id: string
  command: string
}

/**
 * Is one dependency satisfied?
 *
 * `done` is the agent's busy→idle edge — the same signal that drives the completion badge and
 * notification. It means "this station has produced something and stopped", which is exactly
 * when a downstream station should start reading it. It does NOT mean "this station will never
 * run again": an agent that finishes turn 1 and awaits more input is also `done`. That is the
 * intended semantics for a station given one self-contained prompt, and it is documented as
 * such rather than being papered over with a turn counter that would guess differently.
 *
 * A dep that is no longer on the canvas counts as satisfied — a deleted node can never report,
 * so treating it as pending would strand the dependent forever. An UNKNOWN state (the dep
 * exists but has reported nothing yet) is deliberately NOT satisfied: right after a fan-out the
 * upstream stations have not emitted a hook event yet, and reading "no news" as "finished"
 * would fire every dependent immediately — the exact bug that makes a dependency edge useless.
 */
function depSatisfied(depId: string, status: StatusById, live: ReadonlySet<string>): boolean {
  if (!live.has(depId)) return true
  return status[depId]?.state === 'done'
}

/**
 * Which armed nodes are ready to launch, given the live canvas and the current agent states.
 * `live` is passed in (rather than derived from `nodes`) because the caller already holds the
 * full node list while `nodes` here may be pre-filtered.
 *
 * `setupDone` is the SECOND gate, for a node opened into a worktree frame whose project runs a
 * setup script with `waitForSetup`: the node's command must not race an `npm ci` that is still
 * writing node_modules underneath it. It answers per group id, and the two gates are ANDed —
 * a node can be waiting on both its upstream stations and its checkout being ready.
 *
 * An ABSENT probe (`setupDone` not passed) means the gate is open. That is the honest default,
 * not laxness: the run store is rebuilt from live events, so after an app restart a node armed
 * with `awaitSetupGroup` has no run to hear from ever again, and reading "nothing known" as
 * "still running" would strand it forever — the same reasoning as a deleted dependency counting
 * as satisfied. (The caller's probe applies the same rule to a group with no entry.)
 */
/**
 * Node ids whose `pendingLaunch` was armed BY THIS PROCESS (canvas-control `--after`, `verify`,
 * `armForColdOpen`). Only these may auto-fire. A `pendingLaunch` that arrived from disk
 * (`.nodeterm/project.json` is git-shared, hostile input) or from a canvas-sync peer is displayed —
 * QUEUED badge, ▶ Run now — but never typed into a shell without a click: before this gate a cloned
 * project.json carrying `{after:[],command:"curl … | sh"}` executed the moment the canvas opened
 * (consort security CRITICAL, 2026-09-02). Module-level and in-memory on purpose: forgetting on
 * reload is exactly what "loaded launches need consent" means. Applied at the ONE fire site in
 * Canvas (`launchesToFire(...).filter(f => wasArmedThisSession(f.id))`), so `launchesToFire` itself
 * stays a pure dependency-satisfaction function.
 */
const armedThisSession = new Set<string>()
export function markArmedThisSession(id: string): void {
  armedThisSession.add(id)
}
export function wasArmedThisSession(id: string): boolean {
  return armedThisSession.has(id)
}
/** Test hook only. */
export function resetArmedThisSession(): void {
  armedThisSession.clear()
}

export function launchesToFire(
  nodes: readonly ArmedNode[],
  status: StatusById,
  live: ReadonlySet<string>,
  setupDone?: (groupId: string) => boolean
): LaunchToFire[] {
  const out: LaunchToFire[] = []
  for (const n of nodes) {
    const p = n.data.pendingLaunch
    if (!p || !p.command) continue
    if (p.awaitSetupGroup && !(setupDone?.(p.awaitSetupGroup) ?? true)) continue
    if (p.after.every((d) => depSatisfied(d, status, live))) out.push({ id: n.id, command: p.command })
  }
  return out
}

/** The deps an armed node is still waiting on — what the node badge and tooltip report. */
export function unmetDeps(
  node: ArmedNode,
  status: StatusById,
  live: ReadonlySet<string>
): string[] {
  const p = node.data.pendingLaunch
  if (!p) return []
  return p.after.filter((d) => !depSatisfied(d, status, live))
}

export interface DependencyEdge {
  id: string
  source: string
  target: string
}

/**
 * The dashed dep→node edges to draw for everything still waiting. Derived from node data on
 * every render rather than persisted as edges: a pending dependency is a STATE, not a durable
 * relation, and it disappears when the launch fires. (The durable relation `--after` also
 * creates is an ordinary context bridge, so the downstream node can still read its upstream
 * long after the arrow is gone.)
 */
export function dependencyEdges(
  nodes: readonly ArmedNode[],
  live: ReadonlySet<string>
): DependencyEdge[] {
  const out: DependencyEdge[] = []
  for (const n of nodes) {
    for (const dep of n.data.pendingLaunch?.after ?? []) {
      // A dep that is gone draws nothing — it is already satisfied, and an edge to a node that
      // isn't there would be dropped by React Flow anyway.
      if (live.has(dep)) out.push({ id: `dep-${dep}-${n.id}`, source: dep, target: n.id })
    }
  }
  return out
}
