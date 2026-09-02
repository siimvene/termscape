import type { SubagentViz } from '../state/agentNodes'

/**
 * A large in-process fan-out (Agent/Task tool, Workflow/ultracode) used to render one ephemeral
 * SubagentNode card per agent, tiled in a grid under the parent and edged one-per-card. A 17-agent
 * workflow put 17 cards over the real nodes with 17 edges fanning out — unarrangeable (they live
 * outside React Flow's `nodes` state by design) and unreadable. Above this many LIVE cards for one
 * parent, Canvas collapses the whole fan-out into a single aggregate card (parent → aggregate, one
 * edge) that expands into a scrollable list of the individual cards, each still openable to its live
 * transcript. At or below the threshold, cards render individually exactly as before.
 *
 * MORE THAN 6 → aggregate; 6 or fewer → individual. Six keeps a hand-sized parallel fan-out
 * (the common `parallel()` width) untouched while catching the grid-of-17 that motivated this.
 */
export const FANOUT_COMPACT_THRESHOLD = 6

export function isCompactFanout(count: number): boolean {
  return count > FANOUT_COMPACT_THRESHOLD
}

/** One row in the aggregate's expanded list. A flat summary of a child's `SubagentViz`, carrying the
 *  child's real id so the row can still subscribe to its live transcript (`activityById[id]`). */
export interface FanoutChild {
  id: string
  type?: string
  label?: string
  state: 'working' | 'done'
  startedAt: number
  durationMs?: number
  tokens?: number
  toolUses?: number
  result?: string
  /** Not sourced yet — the agentNodes store only tracks working|done (a subagent that errors still
   *  finishes as `done`). Kept so the count below has a home the day an error state is wired. */
  error?: boolean
}

export interface FanoutCounts {
  total: number
  working: number
  done: number
  errored: number
}

/** Build the aggregate's child rows from the store map, in the given id order. One definition,
 *  shared by Canvas (to fill the aggregate's data) and the tests. */
export function buildFanoutChildren(
  childIds: string[],
  byId: Record<string, SubagentViz>
): FanoutChild[] {
  const out: FanoutChild[] = []
  for (const id of childIds) {
    const v = byId[id]
    if (!v) continue
    out.push({
      id,
      type: v.type,
      label: v.label,
      state: v.state,
      startedAt: v.startedAt,
      durationMs: v.durationMs,
      tokens: v.tokens,
      toolUses: v.toolUses,
      result: v.result
    })
  }
  return out
}

export function fanoutCounts(children: FanoutChild[]): FanoutCounts {
  let working = 0
  let errored = 0
  for (const c of children) {
    if (c.error) errored++
    else if (c.state === 'working') working++
  }
  return {
    total: children.length,
    working,
    errored,
    done: children.length - working - errored
  }
}

/** Elapsed span of the fan-out: while any child is still working, wall time since the earliest
 *  start; once all are done, the span from the earliest start to the latest finish. 0 when empty. */
export function fanoutElapsed(children: FanoutChild[], now: number): number {
  if (!children.length) return 0
  let earliest = Infinity
  let latestEnd = 0
  let anyWorking = false
  for (const c of children) {
    if (c.startedAt) earliest = Math.min(earliest, c.startedAt)
    if (c.state === 'working') anyWorking = true
    else latestEnd = Math.max(latestEnd, c.startedAt + (c.durationMs ?? 0))
  }
  if (!isFinite(earliest)) return 0
  return anyWorking ? now - earliest : Math.max(0, latestEnd - earliest)
}
