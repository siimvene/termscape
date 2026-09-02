import { describe, expect, it } from 'vitest'
import { decideDoneAlert, shouldAutoClose, spawnedBy, spawnerOf } from './spawnedAlerts'
import type { AgentState } from '@shared/agents/normalize'

const agents = new Set(['conductor', 'w1', 'w2', 'w3', 'other'])
const isAgentNode = (id: string): boolean => agents.has(id)
const ropes = [
  { source: 'conductor', target: 'w1' },
  { source: 'conductor', target: 'w2' },
  { source: 'conductor', target: 'w3' },
  { source: 'conductor', target: 'term' }, // plain terminal: never counts
  { source: 'popup-browser', target: 'other' } // browser popup → opener: not a worker
]
const states = (m: Record<string, AgentState | undefined>) => (id: string) => m[id]

describe('spawnerOf / spawnedBy', () => {
  it('resolves the conductor through a rope whose source is a live agent node', () => {
    expect(spawnerOf('w1', ropes, isAgentNode)).toBe('conductor')
  })
  it('ignores ropes from non-agent sources (browser popup lineage) and unknown nodes', () => {
    expect(spawnerOf('other', ropes, isAgentNode)).toBeUndefined()
    expect(spawnerOf('nobody', ropes, isAgentNode)).toBeUndefined()
  })
  it('lists only agent-node children, deduplicated', () => {
    expect(spawnedBy('conductor', [...ropes, ropes[0]], isAgentNode)).toEqual(['w1', 'w2', 'w3'])
  })
})

describe('decideDoneAlert', () => {
  it('alerts normally for a node nobody spawned', () => {
    expect(decideDoneAlert({ nodeId: 'conductor', ropes, stateOf: states({}), isAgentNode })).toEqual({
      kind: 'alert'
    })
  })
  it('is quiet while a sibling is still live (working / blocked / waiting all count)', () => {
    for (const live of ['working', 'blocked', 'waiting'] as const) {
      const d = decideDoneAlert({
        nodeId: 'w1',
        ropes,
        stateOf: states({ w1: 'done', w2: live, w3: 'done' }),
        isAgentNode
      })
      expect(d).toEqual({ kind: 'quiet', spawner: 'conductor', outstanding: 1 })
    }
  })
  it('aggregates once when the last live sibling finishes', () => {
    const d = decideDoneAlert({
      nodeId: 'w3',
      ropes,
      stateOf: states({ w1: 'done', w2: 'done', w3: 'done' }),
      isAgentNode
    })
    expect(d).toEqual({ kind: 'aggregate', spawner: 'conductor', finished: 3, total: 3 })
  })
  it('does not let a sibling with NO known state hold the aggregate hostage', () => {
    // w2 never reported (armed behind --after, or its CLI never launched).
    const d = decideDoneAlert({
      nodeId: 'w1',
      ropes,
      stateOf: states({ w1: 'done', w3: 'done' }),
      isAgentNode
    })
    expect(d).toEqual({ kind: 'aggregate', spawner: 'conductor', finished: 2, total: 3 })
  })
  it('falls back to a normal alert when the spawner node is gone', () => {
    const gone = (id: string): boolean => id !== 'conductor' && agents.has(id)
    expect(decideDoneAlert({ nodeId: 'w1', ropes, stateOf: states({}), isAgentNode: gone })).toEqual({
      kind: 'alert'
    })
  })
})

describe('shouldAutoClose', () => {
  const base = { nodeId: 'w1', readerId: 'conductor', ropes, isAgentNode }
  it('closes only an ARMED node that is done and was read by its own spawner', () => {
    expect(shouldAutoClose({ ...base, armed: new Set(['w1']), stateOf: states({ w1: 'done' }) })).toBe(true)
  })
  it('never closes a node that was not armed this session (a flag from disk is not consent)', () => {
    expect(shouldAutoClose({ ...base, armed: new Set(), stateOf: states({ w1: 'done' }) })).toBe(false)
  })
  it('does not close on a read that happened while the node was still working', () => {
    expect(shouldAutoClose({ ...base, armed: new Set(['w1']), stateOf: states({ w1: 'working' }) })).toBe(false)
    expect(shouldAutoClose({ ...base, armed: new Set(['w1']), stateOf: states({}) })).toBe(false)
  })
  it('ignores reads by anyone but the spawner (a reviewer reading the same node)', () => {
    expect(
      shouldAutoClose({ ...base, readerId: 'w2', armed: new Set(['w1']), stateOf: states({ w1: 'done' }) })
    ).toBe(false)
  })
})
