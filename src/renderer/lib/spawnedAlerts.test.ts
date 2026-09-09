import { describe, expect, it } from 'vitest'
import {
  decideDoneAlert,
  resolveAutoClose,
  shouldAutoClose,
  spawnedBy,
  spawnerOf,
  stationHoldsWork,
  sweepFinishedStations
} from './spawnedAlerts'
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
    armedBy: (id: string) => (id === 'w1' ? 'conductor' : undefined),
    stateOf: states({ w1: 'done' }),
    isVerified: (id: string) => id === 'w1',
    verifiedSince: (id: string) => (id === 'w1' ? T0 : undefined)
  }
  it('closes only an ARMED node that is verifiably done, verified BEFORE the read began, read by its own opener', () => {
    expect(shouldAutoClose(base)).toBe(true)
  })
  it('never closes a node that was not armed this session (a flag from disk is not consent)', () => {
    expect(shouldAutoClose({ ...base, armedBy: () => undefined })).toBe(false)
  })
  it('does not close on a read that happened while the node was still working / unknown', () => {
    expect(shouldAutoClose({ ...base, stateOf: states({ w1: 'working' }) })).toBe(false)
    expect(shouldAutoClose({ ...base, stateOf: states({}) })).toBe(false)
  })
  it('refuses an UNVERIFIED done — a legacy tokenless hook POST can forge one on a working station', () => {
    expect(shouldAutoClose({ ...base, isVerified: () => false })).toBe(false)
  })
  it('refuses when the VERIFIED done arrived after the read started (mid-render Stop, or a forged early done later confirmed)', () => {
    expect(shouldAutoClose({ ...base, verifiedSince: () => T0 + 501 })).toBe(false)
    expect(shouldAutoClose({ ...base, verifiedSince: () => T0 + 500 })).toBe(true) // same instant counts
    expect(shouldAutoClose({ ...base, verifiedSince: () => undefined })).toBe(false) // unknown ⇒ refuse
  })
  it('ignores reads by anyone but the spawner (a reviewer reading the same node)', () => {
    expect(shouldAutoClose({ ...base, readerId: 'w2' })).toBe(false)
  })
  it('refuses while the station still OWNS work — a kill is not an /exit', () => {
    expect(shouldAutoClose({ ...base, holdsWork: () => true })).toBe(false)
    expect(shouldAutoClose({ ...base, holdsWork: () => false })).toBe(true)
  })
  it('binds consent to the node that ARMED it: a rewritten rope nominating another verified reader gets nothing', () => {
    // Peer rewrote the rope so `other` now looks like w1's spawner; `other` reads it. The in-memory
    // arming still names `conductor`, so the read does not close.
    const rewritten = [{ source: 'other', target: 'w1' }]
    expect(shouldAutoClose({ ...base, readerId: 'other', ropes: rewritten })).toBe(false)
    // And the opener without its rope (user deleted the edge) closes nothing either.
    expect(shouldAutoClose({ ...base, ropes: rewritten })).toBe(false)
  })
})

describe('resolveAutoClose', () => {
  it('defaults to the SETTING when the flag is absent, and says so (no capability refusal owed)', () => {
    expect(resolveAutoClose(undefined, true)).toEqual({ wanted: true, explicit: false })
    expect(resolveAutoClose(undefined, false)).toEqual({ wanted: false, explicit: false })
  })
  it('an explicit no/false/off/0 opts a station out even when the setting is on', () => {
    for (const v of ['no', 'false', 'off', '0', ' No ']) {
      expect(resolveAutoClose(v, true)).toEqual({ wanted: false, explicit: true })
    }
  })
  it('an explicit yes forces it on even when the setting is off', () => {
    for (const v of ['yes', 'true', 'on']) {
      expect(resolveAutoClose(v, false)).toEqual({ wanted: true, explicit: true })
    }
  })
  it('a bare flag (empty value) is "not passed" — the shim-wide contract — and reads as the setting', () => {
    expect(resolveAutoClose('', true)).toEqual({ wanted: true, explicit: false })
    expect(resolveAutoClose('  ', false)).toEqual({ wanted: false, explicit: false })
  })
})

describe('sweepFinishedStations', () => {
  const NOW = 10_000_000
  const IDLE = 30 * 60_000
  const base = {
    ropes,
    isAgentNode,
    onCanvas: () => true,
    stateOf: states({ conductor: 'done', w1: 'done', w2: 'done', w3: 'done' }),
    idleSince: () => NOW - IDLE - 1,
    isArmed: () => false,
    declined: new Set<string>(),
    now: NOW,
    idleMs: IDLE,
    firstSeenAt: () => NOW - IDLE - 1
  }
  it('collects every finished, idle station under an idle conductor, grouped by conductor', () => {
    expect(sweepFinishedStations(base)).toEqual([{ spawner: 'conductor', ids: ['w1', 'w2', 'w3'] }])
  })
  it('never lists a station that is live, armed behind --after, or not idle long enough', () => {
    expect(sweepFinishedStations({ ...base, stateOf: states({ conductor: 'done', w1: 'working', w2: 'done', w3: 'blocked' }) }))
      .toEqual([{ spawner: 'conductor', ids: ['w2'] }])
    expect(sweepFinishedStations({ ...base, isArmed: (id) => id === 'w2' }))
      .toEqual([{ spawner: 'conductor', ids: ['w1', 'w3'] }])
    expect(sweepFinishedStations({ ...base, idleSince: (id) => (id === 'w1' ? NOW - 1000 : NOW - IDLE - 1) }))
      .toEqual([{ spawner: 'conductor', ids: ['w2', 'w3'] }])
  })
  it('lists nothing while the CONDUCTOR is live or freshly idle — it may still be reading its stations', () => {
    expect(sweepFinishedStations({ ...base, stateOf: states({ conductor: 'working', w1: 'done', w2: 'done', w3: 'done' }) })).toEqual([])
    expect(sweepFinishedStations({ ...base, idleSince: (id) => (id === 'conductor' ? NOW - 1000 : NOW - IDLE - 1) })).toEqual([])
  })
  it('treats an UNKNOWN state as idle from when the sweep FIRST SAW the node — the restart case, where no state survives', () => {
    const fresh = { ...base, stateOf: states({}), idleSince: () => undefined, firstSeenAt: () => NOW - IDLE }
    expect(sweepFinishedStations(fresh)).toEqual([{ spawner: 'conductor', ids: ['w1', 'w2', 'w3'] }])
    expect(sweepFinishedStations({ ...fresh, firstSeenAt: () => NOW - IDLE + 1 })).toEqual([])
    // Per node, not per sweep: a member that arrived a minute ago is not "idle 30 min" because the
    // app launched an hour ago.
    expect(sweepFinishedStations({ ...fresh, firstSeenAt: (id) => (id === 'w2' ? NOW - 60_000 : NOW - IDLE) }))
      .toEqual([{ spawner: 'conductor', ids: ['w1', 'w3'] }])
  })
  it('skips declined ids, nodes off the active canvas, and non-agent lineage', () => {
    expect(sweepFinishedStations({ ...base, declined: new Set(['w2']) })).toEqual([{ spawner: 'conductor', ids: ['w1', 'w3'] }])
    expect(sweepFinishedStations({ ...base, onCanvas: (id) => id !== 'w3' })).toEqual([{ spawner: 'conductor', ids: ['w1', 'w2'] }])
    // `term` (plain terminal) and `other` (browser-popup lineage) never appear.
    expect(sweepFinishedStations(base).flatMap((g) => g.ids)).not.toContain('term')
  })
})

describe('stationHoldsWork', () => {
  // w1 is itself a conductor of two nested stations.
  const nested = [...ropes, { source: 'w1', target: 'n1' }, { source: 'w1', target: 'n2' }]
  const isAgent = (id: string): boolean => isAgentNode(id) || id === 'n1' || id === 'n2'
  const base = { nodeId: 'w1', ropes: nested, isAgentNode: isAgent, stateOf: states({ n1: 'done', n2: 'done' }), hasInFlight: () => false }
  it('is false for a finished station with finished children and nothing in flight', () => {
    expect(stationHoldsWork(base)).toBe(false)
  })
  it('is true for the three Eco facts the caller folds into hasInFlight', () => {
    expect(stationHoldsWork({ ...base, hasInFlight: (id) => id === 'w1' })).toBe(true)
  })
  it('is true while any spawned child of its own is live or armed — a nested conductor waits for its stations', () => {
    for (const live of ['working', 'blocked', 'waiting'] as const) {
      expect(stationHoldsWork({ ...base, stateOf: states({ n1: 'done', n2: live }) })).toBe(true)
    }
    expect(stationHoldsWork({ ...base, isArmed: (id) => id === 'n2' })).toBe(true)
  })
  it('ignores children that are not agent nodes, and unknown children are not live (the --after rule)', () => {
    expect(stationHoldsWork({ ...base, stateOf: states({}) })).toBe(false)
    expect(stationHoldsWork({ ...base, ropes: [...nested, { source: 'w1', target: 'term' }], stateOf: states({ term: 'working' }) })).toBe(false)
  })
})

describe('sweepFinishedStations — holdsWork', () => {
  const NOW = 10_000_000
  const IDLE = 30 * 60_000
  const base = {
    ropes,
    isAgentNode,
    onCanvas: () => true,
    stateOf: states({ conductor: 'done', w1: 'done', w2: 'done', w3: 'done' }),
    idleSince: () => NOW - IDLE - 1,
    isArmed: () => false,
    declined: new Set<string>(),
    now: NOW,
    idleMs: IDLE,
    firstSeenAt: () => NOW - IDLE - 1
  }
  it('treats a station that still owns work as live, and a conductor that does as not idle', () => {
    expect(sweepFinishedStations({ ...base, holdsWork: (id) => id === 'w2' })).toEqual([{ spawner: 'conductor', ids: ['w1', 'w3'] }])
    expect(sweepFinishedStations({ ...base, holdsWork: (id) => id === 'conductor' })).toEqual([])
  })
})
