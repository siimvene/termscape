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
  it('does not let a sibling with NO known state and no pending launch hold the aggregate hostage', () => {
    // w2 never reported and is not armed (its CLI never launched, or it was killed by hand).
    const d = decideDoneAlert({
      nodeId: 'w1',
      ropes,
      stateOf: states({ w1: 'done', w3: 'done' }),
      isAgentNode,
      isArmed: () => false
    })
    expect(d).toEqual({ kind: 'aggregate', spawner: 'conductor', finished: 2, total: 3 })
  })
  it('treats a sibling ARMED behind --after as outstanding, so a sequential chain aggregates once at the end', () => {
    // w1 done, w2 armed (pendingLaunch, no state yet), w3 armed behind w2.
    const armed = new Set(['w2', 'w3'])
    const first = decideDoneAlert({
      nodeId: 'w1',
      ropes,
      stateOf: states({ w1: 'done' }),
      isAgentNode,
      isArmed: (id) => armed.has(id)
    })
    expect(first).toEqual({ kind: 'quiet', spawner: 'conductor', outstanding: 2 })
    armed.delete('w2')
    const second = decideDoneAlert({
      nodeId: 'w2',
      ropes,
      stateOf: states({ w1: 'done', w2: 'done' }),
      isAgentNode,
      isArmed: (id) => armed.has(id)
    })
    expect(second).toEqual({ kind: 'quiet', spawner: 'conductor', outstanding: 1 })
    armed.delete('w3')
    const last = decideDoneAlert({
      nodeId: 'w3',
      ropes,
      stateOf: states({ w1: 'done', w2: 'done', w3: 'done' }),
      isAgentNode,
      isArmed: (id) => armed.has(id)
    })
    expect(last).toEqual({ kind: 'aggregate', spawner: 'conductor', finished: 3, total: 3 })
  })
  it('falls back to a normal alert when the spawner node is gone', () => {
    const gone = (id: string): boolean => id !== 'conductor' && agents.has(id)
    expect(decideDoneAlert({ nodeId: 'w1', ropes, stateOf: states({}), isAgentNode: gone })).toEqual({
      kind: 'alert'
    })
  })
})

describe('shouldAutoClose', () => {
  const T0 = 1_000_000
  const base = {
    nodeId: 'w1',
    readerId: 'conductor',
    requestedAt: T0 + 500,
    ropes,
    isAgentNode,
    armed: new Set(['w1']),
    stateOf: states({ w1: 'done' }),
    isVerified: (id: string) => id === 'w1',
    stateSince: (id: string) => (id === 'w1' ? T0 : undefined)
  }
  it('closes only an ARMED node that is verifiably done, done BEFORE the read began, read by its own spawner', () => {
    expect(shouldAutoClose(base)).toBe(true)
  })
  it('never closes a node that was not armed this session (a flag from disk is not consent)', () => {
    expect(shouldAutoClose({ ...base, armed: new Set() })).toBe(false)
  })
  it('does not close on a read that happened while the node was still working / unknown', () => {
    expect(shouldAutoClose({ ...base, stateOf: states({ w1: 'working' }) })).toBe(false)
    expect(shouldAutoClose({ ...base, stateOf: states({}) })).toBe(false)
  })
  it('refuses an UNVERIFIED done — a legacy tokenless hook POST can forge one on a working station', () => {
    expect(shouldAutoClose({ ...base, isVerified: () => false })).toBe(false)
  })
  it('refuses when the done transition happened AFTER the read started (Stop landed mid-render)', () => {
    expect(shouldAutoClose({ ...base, stateSince: () => T0 + 501 })).toBe(false)
    expect(shouldAutoClose({ ...base, stateSince: () => T0 + 500 })).toBe(true) // same instant counts
    expect(shouldAutoClose({ ...base, stateSince: () => undefined })).toBe(false) // unknown ⇒ refuse
  })
  it('ignores reads by anyone but the spawner (a reviewer reading the same node)', () => {
    expect(shouldAutoClose({ ...base, readerId: 'w2' })).toBe(false)
  })
})
