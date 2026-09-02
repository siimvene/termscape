import { describe, expect, it } from 'vitest'
import type { SubagentViz } from '../state/agentNodes'
import {
  FANOUT_COMPACT_THRESHOLD,
  buildFanoutChildren,
  fanoutCounts,
  fanoutElapsed,
  isCompactFanout
} from './fanoutGroup'

const viz = (over: Partial<SubagentViz> = {}): SubagentViz => ({
  parentNodeId: 'n1',
  state: 'working',
  startedAt: 1000,
  ...over
})

function storeOf(n: number, over: (i: number) => Partial<SubagentViz> = () => ({})): {
  ids: string[]
  byId: Record<string, SubagentViz>
} {
  const ids: string[] = []
  const byId: Record<string, SubagentViz> = {}
  for (let i = 0; i < n; i++) {
    const id = `tu${i}`
    ids.push(id)
    byId[id] = viz(over(i))
  }
  return { ids, byId }
}

describe('isCompactFanout', () => {
  it('renders individual cards at or below the threshold (6)', () => {
    expect(FANOUT_COMPACT_THRESHOLD).toBe(6)
    expect(isCompactFanout(1)).toBe(false)
    expect(isCompactFanout(6)).toBe(false)
  })

  it('collapses to the aggregate above the threshold (7+)', () => {
    expect(isCompactFanout(7)).toBe(true)
    expect(isCompactFanout(17)).toBe(true)
  })
})

describe('buildFanoutChildren', () => {
  it('expanding the aggregate yields ALL N children, in order, each with its real id', () => {
    const { ids, byId } = storeOf(17)
    const children = buildFanoutChildren(ids, byId)
    expect(children).toHaveLength(17)
    expect(children.map((c) => c.id)).toEqual(ids)
  })

  it('skips ids not present in the store (a card cleared mid-build)', () => {
    const { ids, byId } = storeOf(3)
    const children = buildFanoutChildren([...ids, 'ghost'], byId)
    expect(children.map((c) => c.id)).toEqual(ids)
  })
})

describe('fanoutCounts', () => {
  it('splits total into working / done', () => {
    const { ids, byId } = storeOf(10, (i) => ({ state: i < 4 ? 'working' : 'done' }))
    const counts = fanoutCounts(buildFanoutChildren(ids, byId))
    expect(counts).toEqual({ total: 10, working: 4, done: 6, errored: 0 })
  })

  it('counts errored children separately from done', () => {
    const children = [
      { id: 'a', state: 'working' as const, startedAt: 0 },
      { id: 'b', state: 'done' as const, startedAt: 0 },
      { id: 'c', state: 'done' as const, startedAt: 0, error: true }
    ]
    expect(fanoutCounts(children)).toEqual({ total: 3, working: 1, done: 1, errored: 1 })
  })
})

describe('fanoutElapsed', () => {
  it('is wall time since the earliest start while any child works', () => {
    const children = buildFanoutChildren(
      ['a', 'b'],
      {
        a: viz({ startedAt: 1000, state: 'working' }),
        b: viz({ startedAt: 3000, state: 'done', durationMs: 500 })
      }
    )
    expect(fanoutElapsed(children, 6000)).toBe(5000)
  })

  it('is the earliest-start-to-latest-finish span once all are done', () => {
    const children = buildFanoutChildren(
      ['a', 'b'],
      {
        a: viz({ startedAt: 1000, state: 'done', durationMs: 2000 }),
        b: viz({ startedAt: 2000, state: 'done', durationMs: 3000 })
      }
    )
    // earliest start 1000, latest finish 2000+3000=5000 → span 4000. `now` is ignored when done.
    expect(fanoutElapsed(children, 9_999_999)).toBe(4000)
  })

  it('is 0 for an empty fan-out', () => {
    expect(fanoutElapsed([], 5000)).toBe(0)
  })
})
